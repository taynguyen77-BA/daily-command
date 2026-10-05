// V2.15 §3 — client sync lifecycle for Cross-Device Sync. Kept separate from store.ts (which
// stays a plain, side-effect-free persistence layer) the same way jira-source.ts/
// notify-client.ts keep fetch/network logic out of it — this is the one place that knows the
// /api/command-center/state endpoint exists.
//
// Split into pure decision logic (decideInitialSync, mergeSyncedAppState, looksUnused,
// extractSyncedAppState — directly testable, no fetch/timer/window involved) and an impure
// orchestrator (initAppStateSync, the debounced push-on-change watcher) that calls it. This
// mirrors jira/http.ts's own fetchXWith(fetchImpl, ...) dependency-injection discipline: the
// decision of WHAT to do is pure and tested directly; the network mechanics are a thin, mostly
// untested (matching this codebase's existing precedent for localStorage/fetch IO — see
// store.ts's own hydrate()/persist()) wrapper around it.

import type { CommandCenterStore, StoreState } from "./store";
import { mergeById } from "./store";
import type { SyncedAppState } from "./app-state";
import { mergeMentionReplies } from "./mention-replies";
import { emptyTombstones, maxIso, mergeDailyCommandState, mergeReviewAcks, type DailyCommandState } from "./execution-state-merge";
import { pairedAuthHeader, isDevicePaired } from "./device-pairing";
import type { ServerDailyStandup } from "./server-report-merge";
import { deriveLegacyDailyCommandState, mergeTicketWorkStates, migrateLegacyIntoTicketStates } from "./ticket-work-state";

const STATE_ENDPOINT = "/api/command-center/state";

// ===== Pure logic ===================================================================

/** Extracts the synced slice from local StoreState. `updatedAtIso` is supplied by the caller
 *  (never computed here) so this stays pure and reusable for both "what would we push right
 *  now" and "what does local currently look like" comparisons. */
export function extractSyncedAppState(state: StoreState, updatedAtIso: string): SyncedAppState {
  return {
    personalIdentity: state.personalIdentity,
    jiraWorkRelevancePolicy: state.jiraWorkRelevancePolicy,
    attentionState: state.attentionState,
    decisions: state.data.decisions,
    actionPlanState: { actions: state.data.actions, personalPlan: state.personalPlan },
    memoryEvents: state.memoryEvents,
    dailyReports: state.dailyReports,
    ticketWorkStates: state.ticketWorkStates,
    dailyCommandCompletions: state.dailyCommandCompletions,
    dailyCommandSkips: state.dailyCommandSkips,
    dailyCommandBlocks: state.dailyCommandBlocks,
    dailyCommandTombstones: state.dailyCommandTombstones,
    syncLog: state.syncLog,
    dailyReviewLastVisitAt: state.dailyReviewLastVisitAt,
    dailyReviewAcks: state.dailyReviewAcks,
    dailyReviewBaselineAt: state.dailyReviewBaselineAt,
    mentionReplies: state.mentionReplies,
    uiPreferences: {
      showAdvancedSettings: state.showAdvancedSettings,
      myActionItemsOnly: state.myActionItemsOnly,
      jiraProjectScope: state.jiraProjectScope,
    },
    updatedAtIso,
  };
}

/** V2.15 §2 (merge case) — "never meaningfully used" heuristic: default/empty attentionState,
 *  no decisions, no planned Action Plan / Close Day interaction — i.e. this device has never
 *  really been used yet, so adopting the server's copy wholesale is safe (nothing local to
 *  lose). Deliberately conservative: ANY real interaction on ANY of the three signals means
 *  "not unused" — a merge (never a silent overwrite) is used instead. */
export function looksUnused(state: StoreState): boolean {
  // A1 — a device whose only use so far is Complete/Skip/Block is NOT unused: adopting the
  // server wholesale would otherwise drop those records.
  const hasExecutionState =
    Object.keys(state.ticketWorkStates ?? {}).length > 0 ||
    Object.keys(state.dailyCommandCompletions).length > 0 || Object.keys(state.dailyCommandSkips).length > 0 || Object.keys(state.dailyCommandBlocks).length > 0;
  return Object.keys(state.attentionState).length === 0 && state.data.decisions.length === 0 && state.personalPlan.length === 0 && !hasExecutionState;
}

const MAX_SYNC_LOG = 30; // mirrors store.ts's own MAX_SYNC_LOG cap

/** A1 — syncLog entries are immutable facts about one sync: union by completedAt (oldest
 *  first), capped like store.ts caps it. */
function mergeSyncLogs(local: SyncedAppState["syncLog"], server: SyncedAppState["syncLog"]): NonNullable<SyncedAppState["syncLog"]> {
  const byCompletedAt = new Map((local ?? []).map((e) => [e.completedAt, e]));
  for (const e of server ?? []) if (!byCompletedAt.has(e.completedAt)) byCompletedAt.set(e.completedAt, e);
  return Array.from(byCompletedAt.values())
    .sort((a, b) => a.completedAt.localeCompare(b.completedAt))
    .slice(-MAX_SYNC_LOG);
}

function dailyCommandStateOf(s: SyncedAppState): DailyCommandState {
  return {
    dailyCommandCompletions: s.dailyCommandCompletions ?? {},
    dailyCommandSkips: s.dailyCommandSkips ?? {},
    dailyCommandBlocks: s.dailyCommandBlocks ?? {},
    dailyCommandTombstones: s.dailyCommandTombstones ?? emptyTombstones(),
  };
}

/** The canonical ticket state merges per ticket (newest updatedAt wins); a blob from a client
 *  that predates TicketWorkState contributes through its legacy maps (migrated in, strictly-newer
 *  only), and the deprecated maps are re-derived from the result. Legacy tombstones from both
 *  sides are kept so an even older device can't resurrect a cleared record. */
function mergeTicketState(local: SyncedAppState, server: SyncedAppState): Pick<SyncedAppState, "ticketWorkStates" | "dailyCommandCompletions" | "dailyCommandSkips" | "dailyCommandBlocks" | "dailyCommandTombstones"> {
  const legacyMerged = mergeDailyCommandState(dailyCommandStateOf(local), dailyCommandStateOf(server));
  let states = mergeTicketWorkStates(local.ticketWorkStates, server.ticketWorkStates);
  states = migrateLegacyIntoTicketStates(states, dailyCommandStateOf(local));
  states = migrateLegacyIntoTicketStates(states, dailyCommandStateOf(server));
  return { ticketWorkStates: states, ...deriveLegacyDailyCommandState(states, undefined, legacyMerged.dailyCommandTombstones) };
}

const MAX_MEMORY_EVENTS = 200; // mirrors store.ts's own MAX_MEMORY_EVENTS cap

/** Id-union of two MemoryEvent arrays: every local event is kept, plus any server event whose
 *  id isn't already present — never drops a locally-recorded event just because the server's
 *  overall blob is newer. Capped the same way store.ts caps memoryEvents everywhere else. */
function mergeMemoryEvents(local: SyncedAppState["memoryEvents"], server: SyncedAppState["memoryEvents"]): SyncedAppState["memoryEvents"] {
  const seen = new Set(local.map((e) => e.id));
  const merged = [...local, ...server.filter((e) => !seen.has(e.id))];
  return merged.slice(-MAX_MEMORY_EVENTS);
}

/** V2.15 §3 point 2 — the actual field-level merge for "both sides have real content and the
 *  server is newer". Record collections (decisions/actions/personalPlan/memoryEvents) are
 *  unioned by id via the existing mergeById (server's copy wins for a shared id — the server
 *  is the side deemed newer here — but any id that only exists locally, e.g. a decision just
 *  added on this device a moment before this sync ran, is never discarded). attentionState
 *  (a Record, not an array) gets the same treatment via object spread: a key present on both
 *  sides takes the server's value, a key present only locally survives untouched. Scalar
 *  preference blocks (uiPreferences) and the identity singleton take the server's whole value
 *  — the single shared `updatedAtIso` on the blob makes true per-field freshness for THOSE
 *  impossible to detect any more precisely than "the whole server blob is newer", so this is
 *  the honest, documented boundary of "per-field where reasonable" rather than a fabricated
 *  finer-grained merge (see the dev prompt's own §2 point 2 escape hatch for this). */
export function mergeSyncedAppState(local: SyncedAppState, server: SyncedAppState): SyncedAppState {
  return {
    personalIdentity: server.personalIdentity ?? local.personalIdentity,
    jiraWorkRelevancePolicy: { ...local.jiraWorkRelevancePolicy, ...server.jiraWorkRelevancePolicy },
    attentionState: { ...local.attentionState, ...server.attentionState },
    decisions: mergeById(local.decisions, server.decisions),
    actionPlanState: {
      actions: mergeById(local.actionPlanState.actions, server.actionPlanState.actions),
      personalPlan: mergeById(local.actionPlanState.personalPlan, server.actionPlanState.personalPlan),
    },
    memoryEvents: mergeMemoryEvents(local.memoryEvents, server.memoryEvents),
    // V2.17 Task 2 point 5 — same treatment as attentionState/jiraWorkRelevancePolicy above:
    // a Record keyed by date, unioned by key, server wins on a shared date. A date-level
    // conflict (both devices generated a report for the same day independently) is rare and,
    // per DailyReportSnapshot's own immutability contract, both sides' events for that day
    // are already identical in practice (memoryEvents themselves are unioned above) — server
    // winning is a safe, deterministic tie-break, not a real data-loss risk.
    dailyReports: { ...local.dailyReports, ...server.dailyReports },
    // A1 — per-record LWW with tombstones (execution-state-merge.ts), NOT "server wins": the
    // blob-level recency above says nothing about which device touched a given ticket last.
    // A field missing from a pre-A1 server blob merges as empty — local records survive.
    ...mergeTicketState(local, server),
    syncLog: mergeSyncLogs(local.syncLog, server.syncLog),
    dailyReviewLastVisitAt: maxIso(local.dailyReviewLastVisitAt, server.dailyReviewLastVisitAt),
    dailyReviewAcks: mergeReviewAcks(local.dailyReviewAcks ?? {}, server.dailyReviewAcks ?? {}),
    dailyReviewBaselineAt: maxIso(local.dailyReviewBaselineAt, server.dailyReviewBaselineAt),
    mentionReplies: mergeMentionReplies(local.mentionReplies ?? {}, server.mentionReplies),
    uiPreferences: server.uiPreferences,
    updatedAtIso: server.updatedAtIso,
  };
}

export type InitialSyncDecision =
  | { kind: "push-as-baseline" } // Task 4 — server has no state yet; local becomes the baseline
  | { kind: "adopt-server" } // local looks unused; overwrite with server's copy wholesale
  | { kind: "merge"; merged: SyncedAppState } // both sides have real content, server is newer
  | { kind: "push-local-forward" }; // local is at least as fresh as the server already knows

/** V2.15 §3 point 2 + Task 4 — the full on-load decision tree, pure and directly testable
 *  (no fetch/timer involved). `lastKnownSyncedIso` is this device's own bookkeeping (see
 *  store.ts's lastAppStateSyncIso): the updatedAtIso this device last confirmed matches the
 *  server, either by pulling it or by successfully pushing it. */
export function decideInitialSync(local: SyncedAppState, localState: StoreState, server: SyncedAppState | null, lastKnownSyncedIso: string | undefined): InitialSyncDecision {
  if (server === null) return { kind: "push-as-baseline" };
  if (looksUnused(localState)) return { kind: "adopt-server" };
  if (server.updatedAtIso > (lastKnownSyncedIso ?? "")) return { kind: "merge", merged: mergeSyncedAppState(local, server) };
  return { kind: "push-local-forward" };
}

// ===== Network I/O (thin; not unit-tested directly — same precedent as store.ts's own
// hydrate()/persist() localStorage wrappers) =========================================

type FetchOutcome<T> = { ok: true; value: T } | { ok: false; reason: "not-paired" | "unavailable" | "unauthorized" | "network" | "malformed" };

// Sign-in on: the session cookie authenticates and pairedAuthHeader() is deliberately empty, so
// "paired" must be asked of isDevicePaired() — gating on the header alone silently disabled sync
// for every signed-in member.
async function getServerState(): Promise<FetchOutcome<SyncedAppState | null>> {
  if (!isDevicePaired()) return { ok: false, reason: "not-paired" };
  try {
    const res = await fetch(STATE_ENDPOINT, { method: "GET", headers: { ...pairedAuthHeader() } });
    if (res.status === 401) return { ok: false, reason: "unauthorized" };
    if (res.status === 503) return { ok: false, reason: "unavailable" };
    if (!res.ok) return { ok: false, reason: "network" };
    const json = (await res.json()) as { ok: boolean; state?: SyncedAppState | null };
    if (!json.ok) return { ok: false, reason: "malformed" };
    return { ok: true, value: json.state ?? null };
  } catch {
    return { ok: false, reason: "network" };
  }
}

async function pushServerState(state: SyncedAppState): Promise<FetchOutcome<void>> {
  if (!isDevicePaired()) return { ok: false, reason: "not-paired" };
  try {
    const res = await fetch(STATE_ENDPOINT, { method: "POST", headers: { ...pairedAuthHeader(), "Content-Type": "application/json" }, body: JSON.stringify(state) });
    if (res.status === 401) return { ok: false, reason: "unauthorized" };
    if (res.status === 503) return { ok: false, reason: "unavailable" };
    if (!res.ok) return { ok: false, reason: "network" };
    return { ok: true, value: undefined };
  } catch {
    return { ok: false, reason: "network" };
  }
}

/** Data & Settings' Cross-Device Sync panel status line — reuses the state endpoint's own
 *  auth semantics (503 = not configured server-side at all; 401 = configured but this device
 *  isn't paired/holds a stale secret; 200 = configured and this device is paired) rather than
 *  a second status endpoint. */
export async function checkAppStateSyncStatus(): Promise<{ configured: boolean; paired: boolean }> {
  const paired = isDevicePaired();
  try {
    const res = await fetch(STATE_ENDPOINT, { method: "GET", headers: pairedAuthHeader() });
    if (res.status === 503) return { configured: false, paired };
    if (res.status === 401) return { configured: true, paired: false };
    if (res.ok) return { configured: true, paired: true };
    return { configured: false, paired };
  } catch {
    return { configured: false, paired };
  }
}

// ===== Orchestration: run once on app load, then watch for local mutations ==========

const DEBOUNCE_MS = 2500;
const MAX_BACKOFF_MS = 30000;
const INITIAL_BACKOFF_MS = 2000;

let initialized = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let backoffAttempt = 0;
// The synced-slice JSON (minus updatedAtIso) most recently confirmed pushed/pulled — used to
// detect whether a store mutation actually touched a synced field at all, so this doesn't
// schedule a push for every unrelated local-only mutation (jiraSync bookkeeping, a new Jira
// work item, etc).
let lastKnownSliceJson: string | null = null;

function comparableJson(state: StoreState): string {
  const slice = extractSyncedAppState(state, "");
  return JSON.stringify(slice);
}

/** A1 — before pushing, fold in anything another device pushed since this device last
 *  synced, so a push never overwrites the server's newer records with this device's stale
 *  copy (previously only the on-load decision merged; every later push was a blind
 *  whole-blob overwrite, so a ticket completed on device A was erased by device B's next
 *  unrelated edit). The local side is passed as the "newer" argument here: it holds the
 *  pending edit that triggered this push, so for the id-union fields local wins a shared id;
 *  the Daily Command maps are symmetric LWW either way. Returns the slice to push, or null
 *  when the server is unreachable (the push itself will then fail and back off as before). */
async function reconcileWithServer(store: CommandCenterStore, now: string): Promise<SyncedAppState> {
  const local = extractSyncedAppState(store.getSnapshot(), now);
  const server = await getServerState();
  if (!server.ok || server.value === null) return local;
  const lastKnown = store.getSnapshot().lastAppStateSyncIso ?? "";
  if (server.value.updatedAtIso <= lastKnown) return local;
  const merged = { ...mergeSyncedAppState(server.value, local), updatedAtIso: now };
  store.applySyncedAppState(merged);
  return merged;
}

async function flushPendingPush(store: CommandCenterStore) {
  if (!isDevicePaired()) return;
  const now = new Date().toISOString();
  const slice = await reconcileWithServer(store, now);
  const result = await pushServerState(slice);
  if (result.ok) {
    backoffAttempt = 0;
    lastKnownSliceJson = comparableJson(store.getSnapshot());
    store.setLastAppStateSyncIso(now);
    // A merge applied by reconcileWithServer above re-triggered the change watcher; that
    // follow-up push is redundant once the merged slice itself has been pushed.
    if (pushTimer && comparableJson(store.getSnapshot()) === lastKnownSliceJson) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }
    return;
  }
  if (result.reason === "not-paired" || result.reason === "unauthorized" || result.reason === "unavailable") {
    // Not a transient condition — retrying on a timer would just spin. The user has to fix
    // pairing/configuration; the next real local edit (or reconnect, for "network") will
    // naturally retry via the mutation watcher below.
    return;
  }
  // §4 — genuine offline/network failure: retry with exponential backoff. The pending write
  // itself is never lost in the meantime — it's already sitting in local StoreState (persisted
  // to localStorage by every store.set() call), so a page reload before the retry fires simply
  // re-derives the same pending slice and tries again on next load.
  backoffAttempt += 1;
  const delay = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** (backoffAttempt - 1));
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => flushPendingPush(store), delay);
}

async function pullIfServerNewer(store: CommandCenterStore) {
  if (!isDevicePaired()) return;
  const server = await getServerState();
  if (!server.ok || server.value === null) return;
  if (server.value.updatedAtIso <= (store.getSnapshot().lastAppStateSyncIso ?? "")) return;
  const now = new Date().toISOString();
  const merged = { ...mergeSyncedAppState(extractSyncedAppState(store.getSnapshot(), now), server.value), updatedAtIso: now };
  store.applySyncedAppState(merged);
  lastKnownSliceJson = comparableJson(store.getSnapshot());
  await pushServerState(merged);
}

function scheduleDebouncedPush(store: CommandCenterStore) {
  if (pushTimer) clearTimeout(pushTimer);
  backoffAttempt = 0;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void flushPendingPush(store);
  }, DEBOUNCE_MS);
}

/** V2.15 §3 point 3 — watches every store mutation; when a mutation actually touched one of
 *  the seven synced fields (cheap JSON comparison against the last known-pushed/pulled slice,
 *  so an unrelated mutation like a fresh Jira sync never schedules a push), (re)schedules a
 *  single debounced POST — rapid successive edits coalesce into one write, never one KV write
 *  per keystroke. Returns an unsubscribe function. */
function watchForLocalChanges(store: CommandCenterStore): () => void {
  return store.subscribe(() => {
    if (!isDevicePaired()) return;
    const json = comparableJson(store.getSnapshot());
    if (json === lastKnownSliceJson) return;
    scheduleDebouncedPush(store);
  });
}

/** V2.15 §3 point 1-2, Task 4 — runs once per app session (idempotent — safe to call from
 *  every page mount): renders from local state immediately (unchanged — this function is
 *  called from a useEffect, never blocks first paint), then in the background pulls the
 *  server's copy (if this device is paired) and applies the decideInitialSync verdict. A
 *  failed/unreachable GET (not paired, KV/secret unconfigured, offline) leaves local state
 *  completely untouched — the app simply stays local-only for this session, same
 *  graceful-degradation contract as every other optional capability here. */
export async function initAppStateSync(store: CommandCenterStore): Promise<void> {
  if (initialized) return;
  initialized = true;

  lastKnownSliceJson = comparableJson(store.getSnapshot());
  watchForLocalChanges(store);

  // §4 — retry immediately on reconnect rather than waiting out the current backoff delay.
  // No-op when there's nothing pending (flushPendingPush returns early when unpaired).
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => {
      backoffAttempt = 0;
      if (pushTimer) {
        clearTimeout(pushTimer);
        pushTimer = null;
      }
      void flushPendingPush(store);
    });
    // A1 — pick up records another device pushed mid-session (the on-load merge below only
    // runs once): a GET on return to the tab, merging + converging only when the server moved.
    const pullOnReturn = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void pullIfServerNewer(store);
    };
    window.addEventListener("focus", pullOnReturn);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", pullOnReturn);
  }

  if (!isDevicePaired()) return;

  // E4 — days the cron recorded while the app was closed (best-effort, independent of the
  // state round-trip below).
  void pullServerDailyReports(store);

  const result = await getServerState();
  if (!result.ok) return; // best-effort — see comment above

  const state = store.getSnapshot();
  const local = extractSyncedAppState(state, state.lastAppStateSyncIso ?? new Date(0).toISOString());
  const decision = decideInitialSync(local, state, result.value, state.lastAppStateSyncIso);

  switch (decision.kind) {
    case "push-as-baseline": {
      const now = new Date().toISOString();
      const push = await pushServerState({ ...local, updatedAtIso: now });
      if (push.ok) {
        store.setLastAppStateSyncIso(now);
        lastKnownSliceJson = comparableJson(store.getSnapshot());
      }
      return;
    }
    case "adopt-server": {
      store.applySyncedAppState(result.value!);
      lastKnownSliceJson = comparableJson(store.getSnapshot());
      return;
    }
    case "merge": {
      const now = new Date().toISOString();
      const merged = { ...decision.merged, updatedAtIso: now };
      store.applySyncedAppState(merged);
      lastKnownSliceJson = comparableJson(store.getSnapshot());
      // Converge the server with the merge result so other devices see the union too.
      await pushServerState(merged);
      return;
    }
    case "push-local-forward": {
      const now = new Date().toISOString();
      const push = await pushServerState({ ...local, updatedAtIso: now });
      if (push.ok) {
        store.setLastAppStateSyncIso(now);
        lastKnownSliceJson = comparableJson(store.getSnapshot());
      }
      return;
    }
  }
}

const SERVER_REPORTS_ENDPOINT = "/api/command-center/reports/server";

/** E4 — fetches the cron-written daily standup snapshots and merges them into dailyReports.
 *  Silent on any failure (unpaired, not configured, offline): reports just stay client-only. */
export async function pullServerDailyReports(store: CommandCenterStore): Promise<void> {
  try {
    const res = await fetch(SERVER_REPORTS_ENDPOINT, { method: "GET", headers: pairedAuthHeader() });
    if (!res.ok) return;
    const json = (await res.json()) as { ok?: boolean; reports?: unknown };
    if (json.ok && json.reports && typeof json.reports === "object") store.mergeServerDailyReports(json.reports as Record<string, ServerDailyStandup>);
  } catch {
    // best-effort
  }
}

/** Called once immediately after a successful pairing (Data & Settings) so the very first
 *  sync round-trip happens right away rather than waiting for the next full page load. Resets
 *  the one-shot `initialized` guard so initAppStateSync runs its full decision tree again. */
export function resetAppStateSyncForNewPairing(): void {
  initialized = false;
  lastKnownSliceJson = null;
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  backoffAttempt = 0;
}
