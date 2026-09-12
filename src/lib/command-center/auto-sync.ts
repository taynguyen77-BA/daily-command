// V2.24 — Automatic Jira Sync Reliability.
//
// PHASE 2 AUDIT FINDING (see the dev prompt this pass implements): the scheduled server-side
// cron (vercel.json's Vercel Cron entry, .github/workflows/sync.yml's GitHub Actions
// fallback) genuinely reaches jira/sync/route.ts's GET handler, genuinely calls Jira with
// real server credentials, and genuinely gets a real response back — but that route is, by
// its own top-of-file comment, "stateless per request": it returns the freshly normalized
// dataset as a JSON HTTP response body and persists nothing. Nobody is listening on the other
// end of a cron-triggered request to read that body and write it anywhere durable. The ONLY
// durable effect an unattended cron run can have today is the narrow, already-documented
// V2.13 server-side notify-store (assignedIssueKeys/notifiedCommentIds for Slack diffing) —
// and only when PERSONAL_JIRA_ACCOUNT_ID + Vercel KV are both configured. The main dataset
// (workItems/dependencies/clients/mentionEvents — everything the Attention Queue, Work
// Relevance, and Priorities actually read) is NOT part of that store and never has been.
//
// This is why "manual Sync Now" always worked and "automatic sync" never did: manual sync
// runs INSIDE the browser tab (data-settings/page.tsx -> store.syncJira()), which merges the
// result directly into this app's one real persistent store — the browser's own IndexedDB/
// localStorage (see store.ts's own "Local-only V1: no auth, no multi-tenant, no backend"
// contract, unchanged by this pass). A cron job has no browser tab and nowhere of its own to
// write that main dataset without inventing a second, server-side Jira data store — which
// section 1 of the dev prompt explicitly forbids ("Do NOT create another Jira data store").
//
// THE FIX: move "automatic" to the one place the persistent store already lives — the
// browser — by calling store.syncJira() itself, automatically, on the schedule below. This is
// not a second sync implementation (§13 "do NOT duplicate the sync implementation"): it is
// the EXACT SAME method the manual "Sync Now" button already calls, with the exact same
// merge/freshness/failure-handling guarantees, so every existing safety property (never
// destructive on failure, safe incremental cursor, safe truncation handling — see store.ts's
// own syncJira) applies identically to an automatic run.
//
// The scheduled cron path itself is NOT removed or replaced — it remains the one legitimate
// mechanism for a genuinely unattended (no browser ever open) Slack notify-diff check (V2.13),
// which this client-side fix cannot reach by construction. See this pass's own final report
// for the honest scope boundary between the two.
//
// Split the same way app-state-sync.ts already is: a pure, directly-testable decision
// function with every input explicit (no hidden Date.now()/module state), and a thin runtime
// orchestrator around it (interval timer, module-level once-per-session guard) that is not
// unit-tested directly — matching this codebase's existing precedent for that boundary.

import { computeFreshness } from "./freshness";
import type { CommandCenterStore } from "./store";
import type { DataSourceType, JiraSyncState } from "./types";

/**
 * Pure eligibility check for one automatic-sync tick.
 *
 * - `isSyncing` — never overlap with an in-flight sync (manual or automatic).
 * - `dataSource !== "jira"` — auto-sync only ever applies once this install has real Jira
 *   data flowing at all; it is a complete no-op for Demo/Local Import, exactly like every
 *   other Jira-only capability in this app.
 * - `lastSyncStatus === "never"` — the FIRST-EVER sync against a real Jira instance is, by
 *   deliberate existing product design (data-settings/page.tsx's requestSync/pendingFirstSync
 *   gate, V2.1 §8), always an explicit, confirmed user action. Automatic sync must never be
 *   the thing that first contacts a real Jira instance — it only ever keeps an
 *   already-consented connection fresh. This is a hard boundary, not a tunable default.
 * - freshness — reuses freshness.ts's existing LIVE/AGING/STALE thresholds (never a second,
 *   invented cadence): a tick is a no-op while the data is still "fresh" (<30min old, per
 *   FRESHNESS_THRESHOLDS_MINUTES), so a long-lived open tab does not hammer the Jira API more
 *   than roughly once per fresh-window.
 */
export function shouldAutoSyncJira(dataSource: DataSourceType, jiraSync: JiraSyncState, isSyncing: boolean, nowMs: number): boolean {
  if (isSyncing) return false;
  if (dataSource !== "jira") return false;
  if (jiraSync.lastSyncStatus === "never") return false;
  return computeFreshness(jiraSync.lastSyncCompletedAt, nowMs) !== "fresh";
}

// ===== Orchestration: run once per app session, then re-check on a fixed interval =========
// Mirrors app-state-sync.ts's initAppStateSync module-level `initialized` guard exactly, so
// this is safe to call from every page mount (e.g. Nav.tsx, the one place already mounted
// exactly once app-wide) without risking a second concurrent timer/sync.

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // re-check eligibility every 5 minutes

let initialized = false;
let isSyncing = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

async function tick(store: CommandCenterStore): Promise<void> {
  const state = store.getSnapshot();
  if (!shouldAutoSyncJira(state.dataSource, state.jiraSync, isSyncing, Date.now())) return;
  isSyncing = true;
  try {
    // Deliberately incremental (no `full`), the exact same call data-settings/page.tsx's
    // "Sync Now" button makes for every sync after the first — never destructive on failure
    // (store.syncJira's own §12 guarantee), silent by design here (no toast/banner): this is
    // a background refresh, not a user-initiated action needing feedback. A failure still
    // updates state.jiraSync bookkeeping (lastSyncError/lastSyncStatus) exactly as a manual
    // sync failure would, so Data & Settings' existing sync-status panel reports it honestly
    // — this module invents no second failure-reporting surface.
    await store.syncJira();
  } finally {
    isSyncing = false;
  }
}

/** Called once per app session (idempotent — safe to call from every page mount, matching
 *  initAppStateSync's own contract). Runs an eligibility check immediately (covers "the user
 *  opens the tab this morning and yesterday's data is stale") and then every
 *  CHECK_INTERVAL_MS while the tab stays open (covers a long-lived session crossing the
 *  freshness threshold again later in the day) — both paths call the identical
 *  store.syncJira(), so there is exactly one sync implementation in this app, used by three
 *  triggers (manual button, on-load check, interval check). */
export function initAutoJiraSync(store: CommandCenterStore): void {
  if (initialized) return;
  initialized = true;

  void tick(store);
  intervalHandle = setInterval(() => void tick(store), CHECK_INTERVAL_MS);
}

/** Test-only reset — mirrors no direct equivalent in app-state-sync.ts (which resets on
 *  re-pairing instead) but this module has no analogous re-trigger event, so this exists
 *  purely so the offline test suite can exercise initAutoJiraSync's guard/interval wiring
 *  without cross-contaminating other test cases via leftover module state. */
export function resetAutoJiraSyncForTests(): void {
  initialized = false;
  isSyncing = false;
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
