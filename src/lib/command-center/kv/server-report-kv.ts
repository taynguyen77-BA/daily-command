// V2.53 fix 2 — the server-side daily-report store, split per day.
//
// The legacy layout is ONE blob (`daily-command:server-reports:v1`) holding up to 60 days of standups plus the
// notify baseline; the cron read and rewrote all of it on every tick after the snapshot hour. v2 keeps:
//   daily-command:server-reports:v2:baseline      the small run baseline
//   daily-command:server-reports:v2:<YYYY-MM-DD>  one day's standup
//   daily-command:server-reports:v2:index         set of the day keys present
// (all scoped per member by scopedKey). Reads fall back to the legacy blob while no v2 index exists; the first write
// fans the legacy blob out (index LAST, so a crash mid-way leaves the legacy blob authoritative) and deletes it.
// The store keeps the old get()/set() contract, so every existing caller works unchanged.

import { scopedKey } from "../auth/auth-config";
import type { ServerDailyStandup, ServerReportBaseline, ServerReportState, ServerReportStore } from "../server-daily-report";
import { MAX_SERVER_REPORT_DAYS } from "../server-daily-report";
import { kvMget, type KvLike } from "./kv";

export const SERVER_REPORTS_V2_PREFIX = "daily-command:server-reports:v2";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isBaseline = (v: unknown): v is ServerReportBaseline => isObj(v);
const isDay = (v: unknown): v is ServerDailyStandup => isObj(v);

export function createKvServerReportStoreV2(kv: KvLike, uid: string | undefined, legacyKey: string, isLegacyState: (v: unknown) => v is ServerReportState): ServerReportStore {
  const key = (suffix: string) => scopedKey(`${SERVER_REPORTS_V2_PREFIX}:${suffix}`, uid);
  const legacy = scopedKey(legacyKey, uid);
  const INDEX = key("index");
  const BASELINE = key("baseline");

  const readLegacy = async (): Promise<ServerReportState | null> => {
    const raw = await kv.get(legacy);
    return isLegacyState(raw) ? raw : null;
  };
  const indexDays = async (): Promise<string[]> => (await kv.smembers(INDEX)).filter((d) => DATE_RE.test(d)).sort();

  /** The day list once the data is in the v2 layout (migrating the legacy blob first if one exists). */
  async function ensureV2(): Promise<string[]> {
    const days = await indexDays();
    if (days.length > 0) return days;
    const old = await readLegacy();
    if (!old) return [];
    if (old.baseline) await kv.set(BASELINE, old.baseline);
    const entries = Object.entries(old.reports).filter(([d]) => DATE_RE.test(d));
    for (const [d, r] of entries) await kv.set(key(d), r);
    for (const [d] of entries) await kv.sadd(INDEX, d); // index last: until now the legacy blob is still authoritative
    await kv.del(legacy);
    return entries.map(([d]) => d).sort();
  }

  async function readDays(days: string[]): Promise<Record<string, ServerDailyStandup>> {
    const raws = await kvMget(kv, days.map(key));
    const out: Record<string, ServerDailyStandup> = {};
    raws.forEach((raw, i) => {
      if (isDay(raw)) out[days[i]] = raw;
    });
    return out;
  }

  async function trim(days: string[]): Promise<void> {
    const excess = days.length - MAX_SERVER_REPORT_DAYS;
    if (excess <= 0) return;
    for (const old of days.slice(0, excess)) {
      await kv.del(key(old));
      await kv.srem(INDEX, old);
    }
  }

  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };

  return {
    async get() {
      return safe(async () => {
        const days = await indexDays();
        if (days.length === 0) return readLegacy();
        const [baseline, reports] = await Promise.all([kv.get(BASELINE), readDays(days)]);
        return { baseline: isBaseline(baseline) ? baseline : null, reports };
      }, null);
    },
    async set(state) {
      await safe(async () => {
        const existing = await indexDays();
        const incoming = Object.keys(state.reports).filter((d) => DATE_RE.test(d));
        if (state.baseline) await kv.set(BASELINE, state.baseline);
        else await kv.del(BASELINE);
        for (const d of incoming) await kv.set(key(d), state.reports[d]);
        for (const d of incoming) await kv.sadd(INDEX, d);
        for (const d of existing) if (!incoming.includes(d)) {
          await kv.del(key(d));
          await kv.srem(INDEX, d);
        }
        await kv.del(legacy);
        await trim(incoming.sort());
      }, undefined);
    },
    async getSince(since) {
      return safe(async () => {
        const days = await indexDays();
        if (days.length === 0) {
          const old = await readLegacy();
          if (!old) return {};
          return Object.fromEntries(Object.entries(old.reports).filter(([d]) => !since || d >= since));
        }
        return readDays(since ? days.filter((d) => d >= since) : days);
      }, {});
    },
    async getBaseline() {
      return safe(async () => {
        const days = await indexDays();
        if (days.length === 0) return (await readLegacy())?.baseline ?? null;
        const b = await kv.get(BASELINE);
        return isBaseline(b) ? b : null;
      }, null);
    },
    async getDay(date) {
      return safe(async () => {
        if (!DATE_RE.test(date)) return null;
        const days = await indexDays();
        if (days.length === 0) return (await readLegacy())?.reports[date] ?? null;
        const d = await kv.get(key(date));
        return isDay(d) ? d : null;
      }, null);
    },
    async putDay(date, report) {
      await safe(async () => {
        if (!DATE_RE.test(date)) return;
        const days = await ensureV2();
        await kv.set(key(date), report);
        await kv.sadd(INDEX, date);
        await trim(Array.from(new Set([...days, date])).sort());
      }, undefined);
    },
    async putBaseline(baseline) {
      await safe(async () => {
        await ensureV2();
        await kv.set(BASELINE, baseline);
      }, undefined);
    },
  };
}
