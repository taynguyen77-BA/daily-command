// V2.36 H4 — AI cost control. Every model call the server makes is logged here (task, model,
// tier, input/output/cache tokens, whether it was served from the dedupe cache), and the daily
// token cap is enforced against the same log, server-side, before any model call.
//
// Storage: Vercel KV when it is configured (KV_REST_API_URL + KV_REST_API_TOKEN — the same store
// the notify check uses), so the cap holds across serverless instances. Without KV the log is
// in this server instance's memory: the cap still applies per instance and resets on a cold
// start — Data & Settings says which one is in use. Never logs a prompt, an input or an output.

import { isNotifyStoreConfigured } from "../notify-state";
import type { AITask } from "./schemas";
import type { AiModelTier } from "./model-config";

export interface AiUsageRecord {
  id: string;
  at: string;
  /** UTC day, YYYY-MM-DD — the cap resets at midnight UTC. */
  day: string;
  task: AITask;
  model: string;
  tier: AiModelTier;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Served from the server's dedupe cache — no model call, zero tokens. */
  cached: boolean;
  outcome: "ok" | "grounding-retry" | "grounding-rejected" | "invalid-output" | "schema-retry" | "refused" | "truncated" | "truncated-retry" | "error";
  /** L4 — the signed-in member who made the call (team sign-in on); absent otherwise. */
  uid?: string;
  /** D2 telemetry (all optional — old records load unchanged). Never contains model text. */
  errorKind?: string;
  httpStatus?: number;
  /** Which grounding rules fired on this call. */
  violationKinds?: ("key" | "date" | "number" | "person")[];
  /** This call answered a repair request (grounding or schema). */
  repaired?: boolean;
  /** D3 — a self-test call (kept apart from real usage in the displays). */
  selftest?: boolean;
}

export interface AiUsageTotals {
  calls: number;
  cachedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** What counts against the cap: input + output + cache writes + cache reads. */
  totalTokens: number;
}

export interface AiUsageSummary {
  cap: number;
  today: AiUsageTotals;
  last7Days: AiUsageTotals;
  byDay: { day: string; totals: AiUsageTotals }[];
  remainingToday: number;
  storage: "kv" | "memory";
  /** D3 — tokens today that came from self-test runs (they count against the cap, and are shown apart from real usage). */
  selftestTokensToday?: number;
}

export interface UsageLedger {
  readonly storage: "kv" | "memory";
  append(record: AiUsageRecord): Promise<void>;
  /** Records for the given UTC days. */
  listDays(days: string[]): Promise<AiUsageRecord[]>;
}

export const DEFAULT_AI_DAILY_TOKEN_CAP = 400_000;

/** AI_DAILY_TOKEN_CAP (a positive integer) or the default. "0" disables AI calls entirely. */
export function resolveDailyTokenCap(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_AI_DAILY_TOKEN_CAP;
  const n = Number(raw.trim().replace(/_/g, ""));
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_AI_DAILY_TOKEN_CAP;
}

/** L4 — AI_USER_DAILY_TOKEN_CAP: each signed-in member's own daily budget, on top of the
 *  global cap. Unset/invalid → no per-member cap (null). */
export function resolveUserDailyTokenCap(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw.trim().replace(/_/g, ""));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** One member's records. */
export const recordsOfUser = (records: AiUsageRecord[], uid: string) => records.filter((r) => r.uid === uid);

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** The 7 UTC days ending with `now`'s day, oldest first. */
export function lastSevenDays(now: Date): string[] {
  return Array.from({ length: 7 }, (_, i) => utcDay(new Date(now.getTime() - (6 - i) * 86_400_000)));
}

export function recordTokens(r: Pick<AiUsageRecord, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">): number {
  return r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
}

export function totalsOf(records: AiUsageRecord[]): AiUsageTotals {
  const t: AiUsageTotals = { calls: 0, cachedCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
  for (const r of records) {
    t.calls++;
    if (r.cached) t.cachedCalls++;
    t.inputTokens += r.inputTokens;
    t.outputTokens += r.outputTokens;
    t.cacheReadTokens += r.cacheReadTokens;
    t.cacheWriteTokens += r.cacheWriteTokens;
  }
  t.totalTokens = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  return t;
}

export function summarizeUsage(records: AiUsageRecord[], cap: number, now: Date, storage: "kv" | "memory"): AiUsageSummary {
  const days = lastSevenDays(now);
  const today = days[days.length - 1];
  const inWindow = records.filter((r) => days.includes(r.day));
  const todayTotals = totalsOf(inWindow.filter((r) => r.day === today));
  return {
    cap,
    today: todayTotals,
    last7Days: totalsOf(inWindow),
    byDay: days.map((day) => ({ day, totals: totalsOf(inWindow.filter((r) => r.day === day)) })),
    remainingToday: Math.max(0, cap - todayTotals.totalTokens),
    storage,
    selftestTokensToday: inWindow.filter((r) => r.day === today && r.selftest).reduce((n, r) => n + recordTokens(r), 0),
  };
}

// ----- implementations -----

export class MemoryUsageLedger implements UsageLedger {
  readonly storage = "memory" as const;
  private records: AiUsageRecord[] = [];
  async append(record: AiUsageRecord): Promise<void> {
    this.records.push(record);
    // keep ~8 days
    const cutoff = utcDay(new Date(Date.parse(record.at) - 8 * 86_400_000));
    this.records = this.records.filter((r) => r.day >= cutoff);
  }
  async listDays(days: string[]): Promise<AiUsageRecord[]> {
    const set = new Set(days);
    return this.records.filter((r) => set.has(r.day));
  }
}

const KV_PREFIX = "daily-command:ai-usage:v1:";

class KvUsageLedger implements UsageLedger {
  readonly storage = "kv" as const;
  // Loaded lazily so nothing imports the KV client unless KV is actually configured.
  // P2.4 — through the one seam (server/kv-client.ts), never the Redis SDK directly.
  private async kv() {
    return (await import("../../server/kv-client")).vercelKv;
  }
  async append(record: AiUsageRecord): Promise<void> {
    const kv = await this.kv();
    const key = KV_PREFIX + record.day;
    await kv.rpush(key, JSON.stringify(record));
    await kv.expire(key, 9 * 86_400);
  }
  async listDays(days: string[]): Promise<AiUsageRecord[]> {
    const kv = await this.kv();
    const lists = await Promise.all(days.map((d) => kv.lrange<unknown>(KV_PREFIX + d, 0, -1)));
    return lists.flat().flatMap((raw) => {
      try {
        const r = typeof raw === "string" ? JSON.parse(raw) : raw;
        return r && typeof r === "object" && typeof (r as AiUsageRecord).day === "string" ? [r as AiUsageRecord] : [];
      } catch {
        return [];
      }
    });
  }
}

let ledger: UsageLedger | null = null;

export function getUsageLedger(): UsageLedger {
  if (!ledger) ledger = isNotifyStoreConfigured() ? new KvUsageLedger() : new MemoryUsageLedger();
  return ledger;
}

/** Test-only: swap the process-wide ledger. */
export function setUsageLedgerForTests(next: UsageLedger | null): void {
  ledger = next;
}

// ---- D2: AI health (per task, last 7 days) -------------------------------------------------------------------------
export interface AiTaskDayHealth {
  day: string;
  calls: number;
  truncated: number;
  groundingRejected: number;
  schemaRetry: number;
  error: number;
}
export interface AiTaskHealth {
  task: AITask;
  calls: number;
  byOutcome: Record<string, number>;
  /** Top grounding violation kinds, most frequent first. */
  topViolations: { kind: string; count: number }[];
  repaired: number;
  /** V2.52 A4 — share of calls (0-1) that were truncated / rejected by the fact check / needed a schema repair / errored. */
  rates?: { truncated: number; groundingRejected: number; schemaRetry: number; error: number };
  /** V2.52 A4 — calls that did not produce a usable answer first time. */
  failures?: number;
  /** V2.52 A4 — set when more than 10% of at least 10 calls failed: what to do about it. */
  alert?: { failRate: number; nextStep: string };
  /** V2.52 A4 — the same counts per UTC day (oldest first). */
  byDay?: AiTaskDayHealth[];
}

export const HEALTH_ALERT_MIN_CALLS = 10;
export const HEALTH_ALERT_FAIL_RATE = 0.1;
/** Outcomes that mean "this call did not give a usable answer" (a schema repair that then worked is not one). */
const FAILED_OUTCOMES = new Set(["truncated", "truncated-retry", "grounding-rejected", "invalid-output", "refused", "error"]);

const ALERT_STEP: Record<string, string> = {
  truncated: "Raise the output budget, or pick a different model for this tier (Data & Settings → AI provider).",
  "grounding-rejected": "The model keeps using facts that are not in your data — pick a different model for this tier.",
  "invalid-output": "The model's JSON often fails the schema — pick a different model for this tier.",
  refused: "The model declines these requests — pick a different model for this tier.",
  error: "The provider keeps failing — run Test in Data & Settings → AI provider.",
};

/** Counts by outcome and top violation kinds per task. Cached answers are not model calls and are left out. */
export function healthByTask(records: readonly AiUsageRecord[]): AiTaskHealth[] {
  type Acc = { calls: number; byOutcome: Record<string, number>; v: Map<string, number>; repaired: number; days: Map<string, AiTaskDayHealth> };
  const byTask = new Map<AITask, Acc>();
  for (const r of records) {
    if (r.cached || r.selftest) continue;
    const e = byTask.get(r.task) ?? { calls: 0, byOutcome: {}, v: new Map<string, number>(), repaired: 0, days: new Map<string, AiTaskDayHealth>() };
    e.calls += 1;
    e.byOutcome[r.outcome] = (e.byOutcome[r.outcome] ?? 0) + 1;
    for (const k of r.violationKinds ?? []) e.v.set(k, (e.v.get(k) ?? 0) + 1);
    if (r.repaired && r.outcome === "ok") e.repaired += 1;
    const d = e.days.get(r.day) ?? { day: r.day, calls: 0, truncated: 0, groundingRejected: 0, schemaRetry: 0, error: 0 };
    d.calls += 1;
    if (r.outcome === "truncated" || r.outcome === "truncated-retry") d.truncated += 1;
    if (r.outcome === "grounding-rejected") d.groundingRejected += 1;
    if (r.outcome === "schema-retry") d.schemaRetry += 1;
    if (r.outcome === "error") d.error += 1;
    e.days.set(r.day, d);
    byTask.set(r.task, e);
  }
  return Array.from(byTask, ([task, e]): AiTaskHealth => {
    const o = e.byOutcome;
    const failures = Object.entries(o).filter(([k]) => FAILED_OUTCOMES.has(k)).reduce((n, [, c]) => n + c, 0);
    const failRate = e.calls > 0 ? failures / e.calls : 0;
    const dominant = Object.entries(o).filter(([k]) => FAILED_OUTCOMES.has(k)).map(([k, c]) => [k === "truncated-retry" ? "truncated" : k, c] as const).reduce<Record<string, number>>((m, [k, c]) => ({ ...m, [k]: (m[k] ?? 0) + c }), {});
    const top = Object.entries(dominant).sort((a, b) => b[1] - a[1])[0]?.[0];
    return {
      task,
      calls: e.calls,
      byOutcome: o,
      topViolations: Array.from(e.v, ([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
      repaired: e.repaired,
      rates: { truncated: ((o.truncated ?? 0) + (o["truncated-retry"] ?? 0)) / e.calls, groundingRejected: (o["grounding-rejected"] ?? 0) / e.calls, schemaRetry: (o["schema-retry"] ?? 0) / e.calls, error: (o.error ?? 0) / e.calls },
      failures,
      ...(e.calls >= HEALTH_ALERT_MIN_CALLS && failRate > HEALTH_ALERT_FAIL_RATE ? { alert: { failRate, nextStep: ALERT_STEP[top ?? "error"] ?? ALERT_STEP.error } } : {}),
      byDay: Array.from(e.days.values()).sort((a, b) => a.day.localeCompare(b.day)),
    };
  }).sort((a, b) => b.calls - a.calls);
}
