// P2.3 — fair scheduling for the team cron: when each member was last processed, so the next run
// starts with whoever has waited longest instead of always restarting from the first member.

export interface CronProgressStore {
  /** ISO time the member was last processed (success OR failure), or null if never. */
  get(): Promise<string | null>;
  set(processedAtIso: string): Promise<void>;
}

export function createInMemoryCronProgressStore(initial: string | null = null): CronProgressStore {
  let v = initial;
  return { get: async () => v, set: async (iso) => { v = iso; } };
}

/** Never-processed first, then oldest lastProcessedAt first; ties (and all never-processed) by uid. */
export function orderByLongestWaiting<T extends { uid: string; lastProcessedAt?: string | null }>(plans: readonly T[]): T[] {
  const key = (p: T) => {
    const t = p.lastProcessedAt ? new Date(p.lastProcessedAt).getTime() : Number.NaN;
    return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
  };
  return [...plans].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return x < y ? -1 : x > y ? 1 : a.uid.localeCompare(b.uid);
  });
}

/** Whole minutes the longest-waiting KNOWN member had waited at `now` (members never processed have no known wait). */
export function oldestWaitMinutes(plans: readonly { lastProcessedAt?: string | null }[], now: Date): number | undefined {
  let oldest: number | undefined;
  for (const p of plans) {
    if (!p.lastProcessedAt) continue;
    const t = new Date(p.lastProcessedAt).getTime();
    if (!Number.isFinite(t)) continue;
    const m = Math.max(0, Math.floor((now.getTime() - t) / 60_000));
    if (oldest === undefined || m > oldest) oldest = m;
  }
  return oldest;
}
