// D3 — POST { mode: "quick" | "full" }: runs the synthetic AI fixtures against the real model for THIS installation.
import { NextResponse } from "next/server";
import { handleSelfTestRequest } from "@/lib/command-center/ai/selftest-handler";
import { effectiveCap, modelEnvFor } from "@/lib/command-center/ai/provider-config";
import type { ModelCallParams, ModelCallResult } from "@/lib/command-center/ai/server-runner";
import { getUsageLedger } from "@/lib/command-center/ai/usage-ledger";
import { anthropicClient, credentialsFor, providerEnv, sharedLimiter, toRunnerError } from "@/lib/server/ai-provider-store";
import { providerContext } from "@/lib/server/ai-provider-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const c = await providerContext(req, { mutating: true });
  if ("response" in c) return c.response;
  const principal = c.ctx.principal;
  const { creds } = await credentialsFor(principal);
  let body: unknown;
  try { body = await req.json(); } catch { body = undefined; }
  const env = { ...providerEnv(), ...(creds ? modelEnvFor(providerEnv(), creds) : {}), AI_DAILY_TOKEN_CAP: String(effectiveCap(providerEnv(), creds)) };
  const callModel = async (p: ModelCallParams): Promise<ModelCallResult> => {
    const client = anthropicClient(creds!);
    try {
      const r = await client.beta.messages.create({
        model: p.model, max_tokens: p.maxTokens,
        system: [{ type: "text", text: p.system, cache_control: { type: "ephemeral" } }],
        messages: p.messages,
        ...(p.useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
      const t = r.content.find((b) => b.type === "text");
      return { stopReason: r.stop_reason, text: t && t.type === "text" ? t.text : undefined, usage: { inputTokens: r.usage.input_tokens ?? 0, outputTokens: r.usage.output_tokens ?? 0, cacheReadTokens: r.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: r.usage.cache_creation_input_tokens ?? 0 } };
    } catch (err) {
      throw toRunnerError(err);
    }
  };
  const user = principal.kind === "user" ? { uid: principal.uid, cap: null } : undefined;
  const r = await handleSelfTestRequest({ body, hasKey: creds !== null, principalId: principal.kind === "user" ? principal.uid : "paired-device", limiter: sharedLimiter, deps: { env, callModel, ledger: getUsageLedger(), now: () => new Date(), ...(user ? { user } : {}) } });
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
