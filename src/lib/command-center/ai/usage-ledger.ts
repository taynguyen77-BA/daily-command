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
  outcome: "ok" | "grounding-retry" | "grounding-rejected" | "invalid-output" | "refused" | "truncated" | "error";
  /** L4 — the signed-in member who made the call (team sign-in on); absent otherwise. */
  uid?: string;
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
  private async kv() {
    return (await import("@vercel/kv")).kv;
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
