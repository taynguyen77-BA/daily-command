// Server-side AI service layer (BUILD REQUEST V1.1 §5). The Anthropic API key lives only
// in process.env on this server route — it is never sent to, or readable by, the browser.
//
// V2.36 H3 — the browser POSTs { task, input }; the SERVER builds the prompt from ai/prompts/*
// (task-registry.ts); the free-form { task, prompt } path is gone (V2.39 K5). Everything
// between the request and the response — the daily token cap, dedupe, prompt caching, the grounding guard and
// usage logging — lives in ai/server-runner.ts so it is tested offline. This file only wires
// auth, env and the real SDK in.

import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { checkSyncRequestAuth } from "@/lib/command-center/jira/sync-auth";
import { buildAiStatusResponse } from "@/lib/command-center/ai/status-response";
import { isNotifyStoreConfigured } from "@/lib/command-center/notify-state";
import { isAuthEnabled } from "@/lib/command-center/auth/auth-config";
import { principalError, requestPrincipal } from "@/lib/server/auth";
import { handleAiRequest, type AiServerEnv, type ModelCallParams, type ModelCallResult } from "@/lib/command-center/ai/server-runner";
import { getUsageLedger, resolveUserDailyTokenCap } from "@/lib/command-center/ai/usage-ledger";

export const runtime = "nodejs";

function serverEnv(): AiServerEnv {
  return {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    ANTHROPIC_MODEL_FAST: process.env.ANTHROPIC_MODEL_FAST,
    ANTHROPIC_MODEL_DEEP: process.env.ANTHROPIC_MODEL_DEEP,
    AI_DAILY_TOKEN_CAP: process.env.AI_DAILY_TOKEN_CAP,
  };
}

export async function GET(req: Request) {
  const auth = checkSyncRequestAuth(req.headers.get("authorization"), process.env.CRON_SECRET, process.env.APP_STATE_SECRET);
  // Sign-in on: signed-in members only (401 / 503 otherwise, like every route).
  const p = await requestPrincipal(req, { legacy: auth });
  if (p.kind === "error" && isAuthEnabled(process.env)) return principalError(p);
  // Model ids, the cap and its storage (never a secret) — Setup Health / Data & Settings show
  // them; the server AI policy only to a paired caller (status-response.ts).
  return NextResponse.json(
    buildAiStatusResponse({ ...serverEnv(), AI_ALLOWED_PROJECT_KEYS: process.env.AI_ALLOWED_PROJECT_KEYS }, { available: Boolean(process.env.ANTHROPIC_API_KEY), kvConfigured: isNotifyStoreConfigured(), authorized: auth.ok || p.kind === "user" })
  );
}

function anthropicCaller(apiKey: string) {
  // V2.2.1 §4 — an explicit, sane timeout so a slow/hung model call fails fast.
  const client = new Anthropic({ apiKey, timeout: 55_000 });
  return async (p: ModelCallParams): Promise<ModelCallResult> => {
    const response = await client.beta.messages.create({
      model: p.model,
      max_tokens: p.maxTokens,
      // H4 — the system prompt is identical on every call, so it is marked for prompt caching.
      // (It only takes effect once the cached prefix reaches the model's minimum cacheable
      // length; usage.cache_read_input_tokens in the ledger shows whether it did.)
      system: [{ type: "text", text: p.system, cache_control: { type: "ephemeral" } }],
      messages: p.messages,
      ...(p.useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    const textBlock = response.content.find((b) => b.type === "text");
    return {
      stopReason: response.stop_reason,
      text: textBlock && textBlock.type === "text" ? textBlock.text : undefined,
      usage: {
        inputTokens: response.usage.input_tokens ?? 0,
        outputTokens: response.usage.output_tokens ?? 0,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
    };
  };
}

export async function POST(req: Request) {
  // V2.18 §4 — this route spends the account owner's Anthropic budget on every call. Same
  // gate/contract as jira/sync (see sync-auth.ts).
  const auth = checkSyncRequestAuth(req.headers.get("authorization"), process.env.CRON_SECRET, process.env.APP_STATE_SECRET);
  const p = await requestPrincipal(req, { legacy: auth });
  if (p.kind === "error") return NextResponse.json({ ok: false, error: p.error, ...(p.missing ? { missing: p.missing } : {}) }, { status: p.status });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "AI provider unavailable: no API key configured on the server." }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Malformed request body." }, { status: 400 });
  }

  // L4 — sign-in on: usage is recorded per member, and AI_USER_DAILY_TOKEN_CAP applies to each.
  const user = p.kind === "user" ? { uid: p.user.uid, cap: resolveUserDailyTokenCap(process.env.AI_USER_DAILY_TOKEN_CAP) } : undefined;
  const result = await handleAiRequest(body, { env: serverEnv(), callModel: anthropicCaller(apiKey), ledger: getUsageLedger(), now: () => new Date(), ...(user ? { user } : {}) });
  return NextResponse.json(result.body, { status: result.status });
}
