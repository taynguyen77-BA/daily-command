// D3 — logic of POST /api/command-center/ai/selftest (route.ts only does auth + wiring). No key -> 409; 3 runs / day / principal;
// refuses BEFORE any call when the daily cap could not cover the run; every ledger entry is marked selftest:true.

import type { AiServerDeps } from "./server-runner";
import { RateLimiter } from "./provider-handlers";
import { DEFAULT_SELFTEST_MAX_TOKENS, estimateSelfTestTokens, runSelfTest } from "./selftest";
import { lastSevenDays, resolveDailyTokenCap, summarizeUsage } from "./usage-ledger";

export const SELFTEST_RUNS_PER_DAY = 3;
const DAY = 86_400_000;

export async function handleSelfTestRequest(args: {
  body: unknown;
  hasKey: boolean;
  principalId: string;
  limiter: RateLimiter;
  deps: Omit<AiServerDeps, "cache" | "selftest">;
  maxTokens?: number;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const mode = args.body && typeof args.body === "object" ? (args.body as { mode?: unknown }).mode : undefined;
  if (mode !== "quick" && mode !== "full") return { status: 400, body: { ok: false, error: "mode must be “quick” or “full”." } };
  if (!args.hasKey) return { status: 409, body: { ok: false, error: "Configure a key first.", errorKind: "no-key" } };
  const estimate = estimateSelfTestTokens(mode);
  const now = args.deps.now();
  const cap = resolveDailyTokenCap(args.deps.env.AI_DAILY_TOKEN_CAP);
  const summary = summarizeUsage(await args.deps.ledger.listDays(lastSevenDays(now)), cap, now, args.deps.ledger.storage);
  if (summary.remainingToday < estimate) {
    return { status: 429, body: { ok: false, error: `Today's AI budget has ${summary.remainingToday.toLocaleString("en-US")} tokens left; this run needs about ${estimate.toLocaleString("en-US")}. Nothing was called.`, errorKind: "budget-too-low", estimate } };
  }
  if (!args.limiter.take(`selftest:${args.principalId}`, SELFTEST_RUNS_PER_DAY, DAY, now.getTime())) {
    return { status: 429, body: { ok: false, error: `Self-test is limited to ${SELFTEST_RUNS_PER_DAY} runs per day.`, errorKind: "rate-limited" } };
  }
  const report = await runSelfTest({ mode, deps: args.deps, maxTokens: args.maxTokens ?? (Number(process.env.AI_SELFTEST_MAX_TOKENS) || DEFAULT_SELFTEST_MAX_TOKENS) });
  return { status: 200, body: { ok: true, report, estimate } };
}
