// Server-side AI service layer (BUILD REQUEST V1.1 §5). The Anthropic API key lives only
// in process.env on this server route — it is never sent to, or readable by, the browser.
//
// V2.36 H3 — the browser POSTs { task, input }; the SERVER builds the prompt from ai/prompts/*
// (task-registry.ts). Everything between the request and the response — the deprecated
// free-form path flag, the daily token cap, dedupe, prompt caching, the grounding guard and
// usage logging — lives in ai/server-runner.ts so it is tested offline. This file only wires
// auth, env and the real SDK in.

import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { checkSyncRequestAuth } from "@/lib/command-center/jira/sync-auth";
import { aiModelStatus } from "@/lib/command-center/ai/model-config";
import { handleAiRequest, legacyPromptPathEnabled, type AiServerEnv, type ModelCallParams, type ModelCallResult } from "@/lib/command-center/ai/server-runner";
import { getUsageLedger, resolveDailyTokenCap } from "@/lib/command-center/ai/usage-ledger";

export const runtime = "nodejs";

function serverEnv(): AiServerEnv {
  return {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    ANTHROPIC_MODEL_FAST: process.env.ANTHROPIC_MODEL_FAST,
    ANTHROPIC_MODEL_DEEP: process.env.ANTHROPIC_MODEL_DEEP,
    AI_DAILY_TOKEN_CAP: process.env.AI_DAILY_TOKEN_CAP,
    AI_LEGACY_PROMPT_PATH: process.env.AI_LEGACY_PROMPT_PATH,
  };
}

export async function GET() {
  const available = Boolean(process.env.ANTHROPIC_API_KEY);
  const env = serverEnv();
  // Model ids and the cap only (never a secret) — Setup Health / Data & Settings show them.
  return NextResponse.json({
    available,
    ...aiModelStatus(env),
    dailyTokenCap: resolveDailyTokenCap(env.AI_DAILY_TOKEN_CAP),
    legacyPromptPath: legacyPromptPathEnabled(env),
  });
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
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

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

  const result = await handleAiRequest(body, { env: serverEnv(), callModel: anthropicCaller(apiKey), ledger: getUsageLedger(), now: () => new Date() });
  return NextResponse.json(result.body, { status: result.status });
}
