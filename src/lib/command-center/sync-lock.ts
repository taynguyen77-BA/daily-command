// Jira sync mutual exclusion. store.ts's syncJira() awaits a network fetch and then commits
// with a full this.set() built from whatever this.state looked like when the fetch resolved.
// Before this lock existed, two overlapping calls (the auto-sync tick, the header Sync Jira
// button, Data & Settings' Sync Now — or two tabs of the same origin) could both run: the one
// whose fetch resolved LAST overwrote the other's memoryEvents/dailyReports/snapshotHistory/
// workItems, including a freshly-detected JIRA_STATUS_COMPLETED event, which is how a
// completed ticket could reappear as open between syncs.
//
// The Web Locks API is the primary mechanism because it's the only one that also covers
// multiple tabs of the same origin. Where it isn't available, a module-level boolean still
// serializes callers within this tab. Either way the lock is non-blocking (`ifAvailable`): a
// second caller is refused immediately rather than queued, since a queued sync would just
// re-fetch what the running one is already fetching.

export const JIRA_SYNC_LOCK_NAME = "daily-command-jira-sync";

/** The subset of the Web Locks LockManager this module uses — injectable so tests can
 *  exercise both the real API and the fallback path in one process. */
export interface JiraSyncLockManager {
  request<T>(name: string, options: { ifAvailable: true }, callback: (lock: unknown) => Promise<T> | T): Promise<T>;
}

export const LOCK_UNAVAILABLE: unique symbol = Symbol("jira-sync-lock-unavailable");

/** navigator.locks when the environment has it, otherwise null — never throws. */
export function defaultJiraSyncLockManager(): JiraSyncLockManager | null {
  try {
    const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: JiraSyncLockManager }).locks : undefined;
    return locks && typeof locks.request === "function" ? locks : null;
  } catch {
    return null;
  }
}

let fallbackHeld = false;

/**
 * Runs `task` while holding the Jira sync lock, or returns LOCK_UNAVAILABLE without running
 * it when another sync (this tab or, with Web Locks, another tab) already holds it. The lock
 * is released when `task` settles, whether it resolves or rejects — a failed sync must never
 * leave every future sync locked out.
 */
export async function withJiraSyncLock<T>(task: () => Promise<T>, locks: JiraSyncLockManager | null = defaultJiraSyncLockManager()): Promise<T | typeof LOCK_UNAVAILABLE> {
  if (locks) {
    return locks.request(JIRA_SYNC_LOCK_NAME, { ifAvailable: true }, async (lock) => (lock ? task() : LOCK_UNAVAILABLE));
  }
  if (fallbackHeld) return LOCK_UNAVAILABLE;
  fallbackHeld = true;
  try {
    return await task();
  } finally {
    fallbackHeld = false;
  }
}
