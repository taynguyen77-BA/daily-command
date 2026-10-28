// V2.13 §1 — the small persisted-state contract for server-side (cron-driven) notify
// checking: "what did the last check already know about" for the configured personal Jira
// account. Deliberately pure/no env-var access (unlike src/lib/server/notify-store.ts, which
// wraps this same contract around the real Vercel KV client and IS server-only) so the
// in-memory fake below — and cron-notify.ts, which depends only on this file's types — can be
// imported directly by the offline test suite, matching this app's existing FetchLike
// dependency-injection discipline (see jira/http.ts) rather than a mocked module boundary.

import { isKvConfigured } from "./kv/kv-credentials";

export interface PersonalNotifyState {
  assignedIssueKeys: string[];
  notifiedCommentIds: string[];
  lastCheckedAtIso: string;
  /** P1.1 — issues whose comment fetch failed last run; fetched again next run even when the
   *  JQL no longer returns them (<= 50, FIFO). Optional: blobs written before V2.41 lack it. */
  retryIssueKeys?: string[];
  /** P3.5 — mentions announced and not yet answered (<= 100); only kept when escalation is switched on. */
  pendingMentions?: { commentId: string; issueKey: string; mentionedAt: string; author?: string; excerpt: string; url?: string }[];
  /** P3.5 — comment ids already escalated, so each mention is re-announced at most once (<= 500, FIFO). */
  escalatedCommentIds?: string[];
  /** C1 — failed Slack posts per undelivered signal (<= 100, FIFO); a signal is dropped after too many. Optional: older blobs lack it. */
  deliveryAttempts?: { id: string; n: number }[];
  /** C1 — when the current Slack failure streak began (cleared by a fully delivered run). */
  undeliveredSince?: string;
  /** C1 — the Jira user's IANA zone learned from /myself (single-user mode), re-checked weekly. */
  jiraTimeZone?: string;
  jiraTimeZoneCheckedAt?: string;
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
  return isKvConfigured(process.env);
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
