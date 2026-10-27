// P1.1 — bounded, order-preserving helpers for the server-side notify / daily-report baselines.
// Pure; shared by cron-notify.ts and server-daily-report.ts so the two never diverge.

/** Notified-comment-id baseline cap (oldest ids fall off first). */
export const MAX_NOTIFIED_COMMENT_IDS = 1000;
/** Issues whose comment fetch failed and must be fetched again next run. */
export const MAX_RETRY_ISSUE_KEYS = 50;

/** FIFO union: `previous` order first, then not-yet-seen `current` ids, newest kept when over `cap`. */
export function fifoUnion(previous: readonly string[], current: readonly string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...previous, ...current]) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.length > cap ? out.slice(out.length - cap) : out;
}

/** Next retry list: a key stays only while its fetch keeps failing (a key fetched successfully
 *  this run is dropped); newly failed keys are appended. Capped FIFO. */
export function nextRetryKeys(previousRetry: readonly string[] | undefined, failedKeys: readonly string[], cap: number = MAX_RETRY_ISSUE_KEYS): string[] {
  const failed = new Set(failedKeys);
  return fifoUnion(
    (previousRetry ?? []).filter((k) => failed.has(k)),
    failedKeys,
    cap
  );
}

/** Issue keys to fetch comments for this run: the JQL hits plus any pending retries. */
export function keysToFetch(jqlKeys: readonly string[], retryKeys: readonly string[] | undefined): string[] {
  return Array.from(new Set([...jqlKeys, ...(retryKeys ?? [])]));
}
