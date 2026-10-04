// The body of GET /api/command-center/ai, split out of the route so it is tested offline (same
// pattern as jira/status-response.ts). Model ids, the cap and where it is counted — never a
// secret. K4 — the server AI policy (AI_ALLOWED_PROJECT_KEYS) is only returned to an
// authorized (paired) caller; an unauthenticated one doesn't learn project keys.

import { aiModelStatus, type AiModelEnv } from "./model-config";
import { parseAiAllowedProjectKeys } from "./server-policy";
import { resolveDailyTokenCap } from "./usage-ledger";

export interface AiStatusEnv extends AiModelEnv {
  AI_DAILY_TOKEN_CAP?: string;
  AI_ALLOWED_PROJECT_KEYS?: string;
}

export interface AiStatusResponse extends ReturnType<typeof aiModelStatus> {
  available: boolean;
  dailyTokenCap: number;
  /** K6 — "memory": the daily cap and usage are per server instance (no Vercel KV). */
  capStorage: "kv" | "memory";
  /** K4 — authorized callers only. null = no server restriction. */
  aiAllowedProjectKeys?: string[] | null;
}

export function buildAiStatusResponse(env: AiStatusEnv, facts: { available: boolean; kvConfigured: boolean; authorized: boolean }): AiStatusResponse {
  return {
    available: facts.available,
    ...aiModelStatus(env),
    dailyTokenCap: resolveDailyTokenCap(env.AI_DAILY_TOKEN_CAP),
    capStorage: facts.kvConfigured ? "kv" : "memory",
    ...(facts.authorized ? { aiAllowedProjectKeys: parseAiAllowedProjectKeys(env.AI_ALLOWED_PROJECT_KEYS) } : {}),
  };
}
