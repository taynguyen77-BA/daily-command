// V2.13 §1 — the small persisted-state contract for server-side (cron-driven) notify
// checking: "what did the last check already know about" for the configured personal Jira
// account. Deliberately pure/no env-var access (unlike src/lib/server/notify-store.ts, which
// wraps this same contract around the real Vercel KV client and IS server-only) so the
// in-memory fake below — and cron-notify.ts, which depends only on this file's types — can be
// imported directly by the offline test suite, matching this app's existing FetchLike
// dependency-injection discipline (see jira/http.ts) rather than a mocked module boundary.

export interface PersonalNotifyState {
  assignedIssueKeys: string[];
  notifiedCommentIds: string[];
  lastCheckedAtIso: string;
}

export interface NotifyStateStore {
  get(): Promise<PersonalNotifyState | null>;
  set(state: PersonalNotifyState): Promise<void>;
}

/** V2.13 §3 — a boolean-only presence check (never the actual token value), so it's safe to
 *  live outside the server-only boundary and be shared, unduplicated, by both
 *  src/lib/server/notify-store.ts's real KV-backed store AND
 *  src/app/api/command-center/notify/route.ts's `serverSideNotifyActive` status field — the
 *  latter is imported directly by the offline test suite, which would otherwise transitively
 *  crash on notify-store.ts's `import "server-only"` (the same reason getJiraConfig() itself,
 *  which DOES return real secret values, stays server-only and is never imported by tests). */
export function isNotifyStoreConfigured(): boolean {
  return !!process.env.KV_REST_API_URL && !!process.env.KV_REST_API_TOKEN;
}

/** Testability (§1 Task 1) — the test suite must stay fully offline; this fake is what's
 *  actually exercised by every test of the detection/notify logic in cron-notify.ts. */
export function createInMemoryNotifyStore(initial: PersonalNotifyState | null = null): NotifyStateStore {
  let state: PersonalNotifyState | null = initial;
  return {
    async get() {
      return state;
    },
    async set(next: PersonalNotifyState) {
      state = next;
    },
  };
}
