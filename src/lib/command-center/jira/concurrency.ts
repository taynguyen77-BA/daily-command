// P2.1 — bounded concurrency for Jira enrichment calls (changelogs, comments). Replaces the
// unbounded Promise.all that fired one request per prioritized/mentioned issue at once.

export const DEFAULT_JIRA_CONCURRENCY = 5;

/** JIRA_CONCURRENCY (1-10, default 5). Anything else falls back to the default. */
export function jiraConcurrency(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.JIRA_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 && n <= 10 && env.JIRA_CONCURRENCY?.trim() !== "" ? n : DEFAULT_JIRA_CONCURRENCY;
}

export interface MapWithConcurrencyResult<R> {
  /** Same length and order as the input; `undefined` where an item was skipped or its fn threw. */
  results: (R | undefined)[];
  /** Indexes never started because the deadline had passed. */
  skipped: number[];
  /** Indexes whose fn threw (the error is swallowed: callers treat enrichments as best-effort). */
  failed: number[];
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving result order. Once
 *  `now() >= deadline` no further item is started (those indexes are returned in `skipped`);
 *  already-running calls are allowed to finish. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  options: { deadline?: number; now?: () => number } = {}
): Promise<MapWithConcurrencyResult<R>> {
  const now = options.now ?? Date.now;
  const results: (R | undefined)[] = new Array(items.length).fill(undefined);
  const skipped: number[] = [];
  const failed: number[] = [];
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      if (options.deadline !== undefined && now() >= options.deadline) {
        skipped.push(i);
        continue;
      }
      try {
        results[i] = await fn(items[i], i);
      } catch {
        failed.push(i);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(Math.floor(limit), items.length || 1)) }, worker));
  return { results, skipped: skipped.sort((a, b) => a - b), failed: failed.sort((a, b) => a - b) };
}

/** JIRA_BOOTSTRAP_DAYS: how many days of closed history the FIRST sync includes (default 90, 0 disables). */
export const DEFAULT_JIRA_BOOTSTRAP_DAYS = 90;
export function jiraBootstrapDays(env: Record<string, string | undefined> = process.env): number {
  const raw = env.JIRA_BOOTSTRAP_DAYS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_JIRA_BOOTSTRAP_DAYS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 3650 ? n : DEFAULT_JIRA_BOOTSTRAP_DAYS;
}
