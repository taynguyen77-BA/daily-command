// Local persistence layer (BUILD REQUEST §15 local persistence, §10 session learning;
// extended in V1.2 §2 for inspectable, deletable project memory; extended in V1.3 for
// Jira as a data source). No backend, no auth — a plain external store, consumed via React's
// useSyncExternalStore (see components/command-center/use-command-center.ts).
//
// V2.16 — backed by IndexedDB (see local-db.ts), not localStorage: a real Jira-scale dataset
// can exceed localStorage's ~5-10MB per-origin quota, which silently stopped every sync from
// persisting once crossed. Falls back to the original synchronous localStorage behavior when
// IndexedDB genuinely isn't available (old browsers, some private-browsing modes, this app's
// own Node test environment) — see hydrate()/persist() below — and migrates any existing
// localStorage data into IndexedDB once, the first time a device with IndexedDB loads.

import { buildDemoData } from "./demo-data";
import { slug } from "./attention-queue";
import { detectChanges, toSnapshot } from "./change-detection";
import { getAIProvider } from "./ai";
import { addDays, todayLocalIso, toLocalIso } from "./date-utils";
import { buildDailySnapshot } from "./memory";
import { JiraDataSource } from "./datasource/jira-source";
import type { DataSourceProvider, DataSourceSyncResult } from "./datasource/types";
import { LOCK_UNAVAILABLE, withJiraSyncLock, type JiraSyncLockManager } from "./sync-lock";
import { idbGet, idbUpdate } from "./local-db";
import { browserStateChannel, createLocalStorageStateStorage, readRevFromRaw, rebaseState, serializeWithRev, type StateChannel, type StateChannelFactory, type StateStorage } from "./state-persistence";
import { applyProjectScope, DEFAULT_JIRA_PROJECT_SCOPE, parseJiraProjectScope, scopeMentionEvents } from "./jira/project-scope";
import { buildStandupState, type StandupState } from "./reports";
import { buildDailyReview, type DailyReview } from "./daily-review";
import { buildMyWork, type MyWork } from "./my-work";
import { buildWorkRelevanceIndex, DEFAULT_WORK_RELEVANCE_POLICY_MAP, parseWorkRelevancePolicyMap, withStatusRelevance } from "./jira/work-relevance";
import { updateWorkItemCalibrationHistory, type WorkItemCalibrationHistory } from "./jira/work-relevance-history";
import { computeActionEffectiveness } from "./action-effectiveness";
import { computeDecisionRadar } from "./decision-radar";
import { computeDeliveryDrift } from "./delivery-drift";
import { computeDeliveryLoops } from "./delivery-loops";
import { computeDependencyRadar } from "./dependency-radar";
import { detectJiraScopeRemovals, detectJiraStatusCompletions, type JiraStatusCompletionEvent } from "./jira-completion-detection";
import { detectNewAssignments } from "./assignment-detection";
import { closePausedTicketsFinishedInJira } from "./task-execution";
import { DEFAULT_STALE_ASSIGNED_TICKET_THRESHOLDS, type StaleAssignedTicketThresholds } from "./personal-staleness";
import { computeRiskEscalations } from "./risk-escalation";
import { selectAllReleaseHealth } from "./release-health";
import { computeReleaseDrift } from "./release-drift";
import { deriveMemoryEvents } from "./memory-events";
import { detectRisks } from "./risk-detection";
import { dedupeRisks } from "./selectors";
import { USAGE_KEYS } from "./usage";
import { emptyTombstones, mergeReviewAcks } from "./execution-state-merge";
import {
  applyTicketStatus,
  asTicketWorkStates,
  backfillPlanTicketKeys,
  deriveLegacyDailyCommandState,
  isNoopTransition,
  canTransition,
  mergeTicketWorkStates,
  migrateLegacyIntoTicketStates,
  planStatusForTicket,
  ticketEventKind,
  ticketKeyForPlanItem,
  ticketStateMaps,
  ticketStatusOf,
  ticketExclusionSets,
  type DailyCommandMapsView,
  type SetTicketStatusOptions,
} from "./ticket-work-state";
import type {
  Action,
  ActionOutcomeStatus,
  ArtifactDraft,
  ArtifactRecord,
  AttentionItem,
  AttentionItemState,
  AttentionLifecycle,
  CommandCenterData,
  Communication,
  DailyCommandCompletion,
  DailyCommandSkip,
  DailyCommandBlock,
  DailyCommandTombstone,
  DailyCommandTombstones,
  DailyReportSnapshot,
  DailySyncSummary,
  FeatureToggles,
  MentionReply,
  MyTicketActivity,
  DailyReviewAck,
  DailySnapshot,
  DataSourceType,
  Decision,
  DecisionEffectivenessClass,
  DecisionOption,
  GlobalFilters,
  JiraErrorKind,
  JiraProjectScope,
  JiraSyncState,
  JiraWorkRelevancePolicyMap,
  MemoryEvent,
  MentionEvent,
  MyActionItemsOnlyByPage,
  PersonalFocusCandidate,
  PersonalIdentity,
  PersonalPlanItem,
  PersonalPlanItemSnapshot,
  PersonalPlanItemStatus,
  PilotFeedbackContext,
  PilotFeedbackEntry,
  PlanItemOrigin,
  SkipReason,
  SyncLogEntry,
  TicketStatusSurface,
  TicketWorkState,
  TicketWorkStatus,
  WorkItem,
  WorkRelevance,
  WorkRelevancePolicyMigrationNotice,
} from "./types";
import { DATA_SCHEMA_VERSION, DEFAULT_FEATURE_TOGGLES, emptyData } from "./types";
import { rollDailySyncSummary } from "./sync-history";
import { mergeMyTicketActivity } from "./mention-replies";
import type { ImportResult } from "./import";
import type { SyncedAppState } from "./app-state";
export type { MyActionItemsOnlyByPage };

const STORAGE_KEY = "command-center:v1";
const MAX_SNAPSHOT_HISTORY = 60; // ~2 months of daily closes — plenty for trend/pattern/weekly-review, bounded
const MAX_MEMORY_EVENTS = 200;
const MAX_BLOCK_REASON_LENGTH = 200;
/** C2 — routes a user may pick as the landing page (every primary nav destination). */
export const LANDING_PAGES = ["/", "/my-work", "/daily-review", "/focus", "/priorities", "/action-plan", "/attention", "/risks", "/dependencies", "/changes", "/loops", "/decisions", "/meeting", "/reports", "/weekly-review"];
const MAX_KNOWN_TICKETS = 20000;
/** Bounded like every other history-shaped field: past the cap, the oldest-first-seen keys go
 *  first (unknown-provenance "" sorts oldest). */
function capKnownTickets(known: Record<string, string>): Record<string, string> {
  const entries = Object.entries(known);
  if (entries.length <= MAX_KNOWN_TICKETS) return known;
  return Object.fromEntries(entries.sort((a, b) => a[1].localeCompare(b[1])).slice(-MAX_KNOWN_TICKETS));
}
const MAX_SYNC_LOG = 30; // most recent successful Jira syncs kept for provenance (oldest evicted first)
const MAX_PERSONAL_PLAN_ITEMS = 400; // bounded personal-plan history, same philosophy as above
// V2.2 §16 — Artifact History, NOT a second memory architecture: same bounded-array/
// oldest-evicted-first pattern as snapshotHistory/memoryEvents above, just for a different
// record shape. §22-23 — usage counters are a fixed, small key space (surface names,
// ArtifactType values, QueryIntent values); this cap is a defensive backstop only.
const MAX_ARTIFACTS = 30;
const MAX_USAGE_COUNTER_KEYS = 200;
// V2.17 §1a point 1 — mentionEvents is now keyed per-COMMENT, not per-issue (see
// MentionEvent.commentId's own comment), so a ticket with a long comment history can
// accumulate many more entries than before. Global cap, oldest-RESOLVED-first eviction (see
// capMentionEvents below) — a mention the user hasn't dealt with yet is only ever dropped if
// there's truly nothing already-resolved left to evict instead.
const MAX_MENTION_EVENTS = 500;
// V2.17 Task 2 — at most one entry per calendar day; ~2 years of daily reports is generous
// headroom while still bounded, same philosophy as MAX_SNAPSHOT_HISTORY above.
const MAX_DAILY_REPORTS = 730;
// V2.22 §3 — one feedback entry per day is the expected cadence (a Close-Day-adjacent
// prompt); ~1.5 years of daily entries is generous bounded headroom, same philosophy as
// MAX_SNAPSHOT_HISTORY/MAX_DAILY_REPORTS above.
const MAX_PILOT_FEEDBACK = 500;

export interface EodEntry {
  date: string;
  summary: string;
}

export interface StoreState {
  schemaVersion: number;
  data: CommandCenterData;
  // V1.2 §2-3: ordered oldest→newest. The single "previous state" V1.1 used for change
  // detection is just the most recent entry here — no more duplicate storage of it.
  snapshotHistory: DailySnapshot[];
  loaded: boolean; // false = pristine, show empty state
  isDemo: boolean; // true = current data is the labeled demo dataset (§16, §23)
  eodHistory: EodEntry[];
  // V1.3
  dataSource: DataSourceType;
  jiraSync: JiraSyncState;
  filters: GlobalFilters;
  // V2.3 — Focus Project Scope. ALL (the default, matching pre-V2.3 behavior) means every
  // discoverable Jira project is synced/analyzed; FOCUSED restricts to `projectKeys`. See
  // jira/project-scope.ts for the enforcement and parsing logic.
  jiraProjectScope: JiraProjectScope;
  // V2.5 — Work Relevance & Jira Status Policy. V2.11 §1 — GLOBAL: keyed directly by raw
  // Jira status name, shared across every project/site (explicit product decision,
  // overriding the V2.6/V2.7 per-project design). Empty map (the default) means no status
  // has been classified yet — every Jira status is conservatively UNKNOWN until the user
  // classifies it in Data & Settings. See jira/work-relevance.ts.
  jiraWorkRelevancePolicy: JiraWorkRelevancePolicyMap;
  // V2.11 §1 — set once when an existing per-project policy map is migrated into the new
  // global shape on load; cleared by dismissWorkRelevancePolicyMigrationNotice() once the
  // user has seen the one-time "policy was consolidated" notice in Data & Settings.
  workRelevancePolicyMigrationNotice?: WorkRelevancePolicyMigrationNotice;
  // V1.4 §39-41 — attention lifecycle (deliberately separate from any Jira status) and a
  // small set of meaningful proactive-intelligence events. Both additive/optional-safe.
  attentionState: Record<string, AttentionItemState>;
  memoryEvents: MemoryEvent[];
  // V1.6 §5, §28 — the only source of "who am I" for explicit-ownership matching. Never
  // set automatically; undefined means every ownership factor reads "not explicit" (§27-28).
  // V1.7 §11 kept this field (rather than removing it) so every existing ownership-matching
  // call site keeps working unchanged; `personalIdentity` below is the new canonical, richer
  // record, and `ownerName` is kept in sync with `personalIdentity.displayName` by
  // setPersonalIdentity()/setOwnerName() — never diverges.
  ownerName?: string;
  // V1.7 §11 — a lightweight local identity, not an account/auth system.
  personalIdentity?: PersonalIdentity;
  // V1.6 §13-14 — minimal personal planning metadata. References existing Decision/Action/
  // Attention/Risk/Dependency/WorkItem records via sourceType+sourceId; never a copy (§12).
  personalPlan: PersonalPlanItem[];
  // V2.2 §16 — Artifact History. Bounded to MAX_ARTIFACTS, oldest evicted first.
  artifacts: ArtifactRecord[];
  // V2.2 §22-23 — local, deterministic usage counters. Never credentials/payloads/prompts.
  usageCounters: Record<string, number>;
  // V2.10 §2 — "who mentioned me in a comment?", one entry per issue (see attention-queue.ts,
  // which dedupes multiple mentions on the same issue into one MENTION attention item).
  // Populated only when a Jira sync ran with a configured accountId (see syncJira below);
  // otherwise stays empty, same "safe when unconfigured" contract as every other optional
  // Jira capability.
  mentionEvents: MentionEvent[];
  // V2.11 §3B — "Show advanced/rarely-used sections" toggle in Data & Settings. Hides
  // dev/pilot-oriented panels (Pilot Readiness, Real Jira Data Protection, AI Trust (dev))
  // that a BA/PO managing live client projects wouldn't open in a normal week — never
  // deletes them, always one toggle away. Defaults to false (hidden) since these are the
  // confidently-identified sections from the V2.11 nav/section audit; see that audit's
  // report for sections still marked as open questions.
  showAdvancedSettings: boolean;
  // V2.12 — first-observed timestamps for "how long has this status been ACTIONABLE" and
  // "did this item ever enter the candidate pool", updated on every real Jira sync. Neither
  // question is answerable from any other persisted field (see jira/work-relevance-history.ts)
  // — this is additive-only history, never backfilled, never mutated by anything else.
  workItemCalibrationHistory: WorkItemCalibrationHistory;
  // V2.14 §4 — "My action items only" toggle (relation is ASSIGNED/ASSIGNED_AND_MENTIONED/
  // MENTIONED), independently settable per page and persisted like `showAdvancedSettings`
  // above. Defaults to false (Everything) on every page for a first-time user — never a
  // surprising silent-hide default; see setMyActionItemsOnly() below.
  myActionItemsOnly: MyActionItemsOnlyByPage;
  // V2.15 §3 — local-only bookkeeping (never sent to the server, never part of
  // SyncedAppState itself): the `updatedAtIso` of the synced-app-state blob this device last
  // confirmed matches the server (either just pulled, or just pushed). Used purely to decide,
  // on the next load, whether the server has moved on since this device last knew about it —
  // see app-state-sync.ts's decideInitialSync. undefined means this device has never
  // completed a sync round-trip yet.
  lastAppStateSyncIso?: string;
  // V2.17 Task 2 — immutable, point-in-time Daily Reports, keyed by ISO date. Built once
  // (generateDailyReport, below) from that day's already-recorded memoryEvents and never
  // silently recomputed afterward — see DailyReportSnapshot's own comment for the full "why".
  // Bounded like snapshotHistory (oldest evicted first), same discipline as every other
  // history-shaped field in this file.
  dailyReports: Record<string, DailyReportSnapshot>;
  /** THE canonical per-ticket work state (single source of truth — see ticket-work-state.ts
   *  and AUDIT_TASK_STATE.md). Keyed by Jira issue KEY; a missing key means TODO. Written only
   *  through setTicketStatus (and Jira closing a paused ticket). */
  ticketWorkStates: Record<string, TicketWorkState>;
  /** @deprecated Derived from ticketWorkStates on every write (ticketStateMaps) and kept for one
   *  version so code / older devices that still read them see the same truth. Never write.
   *  Engines read the today-aware projection via selectDailyCommandMaps(state, today). */
  // V2.19 — Daily Command Completion. Keyed by Jira issue KEY (see DailyCommandCompletion's
  // own comment for why), local-only (deliberately not added to app-state.ts's SyncedAppState
  // in this pass — see completeTicketInDailyCommand/reopenTicketInDailyCommand below). A
  // ticket present here is suppressed from active personal-work surfaces regardless of its
  // Jira status; removed only by an explicit reopen.
  dailyCommandCompletions: Record<string, DailyCommandCompletion>;
  // V2.23 — Daily Command Skip. Keyed by Jira issue KEY, same local-only-not-synced contract
  // as dailyCommandCompletions above (see DailyCommandSkip's own comment in types.ts). A
  // ticket present here is suppressed from active personal-execution surfaces (never from
  // portfolio-level engines like scoring/risk-detection/release-health — see
  // personal-focus.ts's evaluateWorkRelevanceGate for the enforcement point) until an explicit
  // Reactivate (skipTicketInDailyCommand/reactivateSkippedTicket below).
  dailyCommandSkips: Record<string, DailyCommandSkip>;
  // V2.26 — Daily Command Block. Keyed by Jira issue KEY, same local-only contract as the two
  // maps above (see DailyCommandBlock in types.ts). Mutually exclusive with both: a ticketKey
  // is in at most one of dailyCommandCompletions/dailyCommandSkips/dailyCommandBlocks.
  dailyCommandBlocks: Record<string, DailyCommandBlock>;
  // A1 — removals from the three maps above, so a cross-device merge never resurrects a
  // record removed here (see execution-state-merge.ts). Written only through
  // applyDailyCommandChange; synced with the maps.
  dailyCommandTombstones: DailyCommandTombstones;
  // V2.22 §3-4 — Pilot Trust Model + Pilot Observability. Local-only, bounded like every
  // other history-shaped field above; never synced (not part of SyncedAppState), never sent
  // anywhere. See PilotFeedbackEntry's own comment (types.ts) for the full reasoning.
  pilotFeedback: PilotFeedbackEntry[];
  // V2.25 Task 3 — Stale Assigned Ticket detector thresholds (personal-staleness.ts),
  // user-configurable in Data & Settings rather than hardcoded — a BA/PO covering fast-moving
  // vs. slow-moving projects needs different tolerances for "how long is too long with no
  // activity". Defaults to DEFAULT_STALE_ASSIGNED_TICKET_THRESHOLDS.
  staleAssignedTicketThresholds: StaleAssignedTicketThresholds;
  // Sync provenance — one entry per successful Jira sync, newest last, capped at MAX_SYNC_LOG
  // (same cap-and-slice discipline as memoryEvents). See SyncLogEntry in types.ts.
  syncLog: SyncLogEntry[];
  // V2.26 — when the user last opened Daily Review. Read BEFORE being updated on each visit
  // (see daily-review/page.tsx), so "New since your last visit" compares against the previous
  // visit, not this one. Local-only, like the Daily Command maps.
  dailyReviewLastVisitAt?: string;
  // A3 — explicit Daily Review acknowledgments ("Seen" per row / "Mark all reviewed"), keyed
  // by ticket KEY. Synced (grow-only per-key max). Replaces visit-on-mount, which emptied
  // "New" on a mere page refresh.
  dailyReviewAcks: Record<string, DailyReviewAck>;
  // A3 — the stable cutoff "New" is computed against. Pinned once by runJiraSync (from the
  // legacy last visit, else the previous sync) and advanced only by "Mark all reviewed" —
  // never by visiting the page, never by a later sync.
  dailyReviewBaselineAt?: string;
  // A3 — every ticket key ever seen by a Jira sync → its original firstSeenAt ("" when its
  // provenance predates firstSeenAt). Lets a ticket that leaves the synced dataset and comes
  // back keep its first-seen time instead of being re-stamped as new. Local-only.
  knownTicketFirstSeen: Record<string, string>;
  // B4 — the Jira custom field id holding the sprint (e.g. "customfield_10020"), configured in
  // Data & Settings; never hardcoded (it differs per Jira instance). Undefined = no sprints.
  jiraSprintFieldId?: string;
  // B4 — what a "week" means in the Weekly Report: Mon–Fri (default) or 7 calendar days.
  weeklyReportMode?: "workweek" | "calendar";
  // C2 — where the app opens ("/" = Command Center). Only ever one of the nav routes.
  defaultLandingPage?: string;
  // ===== V2.30 (Prompt D) =====
  /** Feature switches (Data & Settings). */
  features: FeatureToggles;
  /** D3 — per-day sync roll-up, 90 days. */
  dailySyncSummary: Record<string, DailySyncSummary>;
  /** D4 — mentions answered (by hand, or detected), keyed by comment id. Synced. */
  mentionReplies: Record<string, MentionReply>;
  /** D4/D6 — my own latest comment / activity per ticket key, as seen by syncs. */
  myTicketActivity: Record<string, MyTicketActivity>;
  /** D5 — ticket key → the ping date already sent to Slack (send once per date). */
  followUpNotified: Record<string, string>;
  /** D1 — local day the one-click morning flow last ran. */
  morningBriefLastRunDay?: string;
}

function initialMyActionItemsOnly(): MyActionItemsOnlyByPage {
  return { attention: false, myDay: false, priorities: false };
}

function initialJiraSync(): JiraSyncState {
  return { lastSyncStatus: "never" };
}

function initialState(): StoreState {
  return {
    schemaVersion: DATA_SCHEMA_VERSION,
    data: emptyData(),
    snapshotHistory: [],
    loaded: false,
    isDemo: false,
    eodHistory: [],
    dataSource: "demo", // §30 — demo is the default when Jira is not configured
    jiraSync: initialJiraSync(),
    filters: {},
    jiraProjectScope: { ...DEFAULT_JIRA_PROJECT_SCOPE },
    jiraWorkRelevancePolicy: { ...DEFAULT_WORK_RELEVANCE_POLICY_MAP },
    attentionState: {},
    memoryEvents: [],
    ownerName: undefined,
    personalIdentity: undefined,
    personalPlan: [],
    artifacts: [],
    usageCounters: {},
    mentionEvents: [],
    showAdvancedSettings: false,
    workItemCalibrationHistory: {},
    myActionItemsOnly: initialMyActionItemsOnly(),
    lastAppStateSyncIso: undefined,
    dailyReports: {},
    ticketWorkStates: {},
    dailyCommandCompletions: {},
    dailyCommandSkips: {},
    dailyCommandBlocks: {},
    dailyCommandTombstones: emptyTombstones(),
    dailyReviewAcks: {},
    knownTicketFirstSeen: {},
    features: { ...DEFAULT_FEATURE_TOGGLES },
    dailySyncSummary: {},
    mentionReplies: {},
    myTicketActivity: {},
    followUpNotified: {},
    pilotFeedback: [],
    staleAssignedTicketThresholds: { ...DEFAULT_STALE_ASSIGNED_TICKET_THRESHOLDS },
    syncLog: [],
  };
}

export function getTodayIso(): string {
  return todayLocalIso();
}

export function previousSnapshotOf(state: StoreState): DailySnapshot | null {
  return state.snapshotHistory[state.snapshotHistory.length - 1] ?? null;
}

export function mergeById<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
  const byId = new Map(existing.map((r) => [r.id, r]));
  for (const row of incoming) byId.set(row.id, row);
  return Array.from(byId.values());
}

type Listener = () => void;

/** Which UI/runtime path started a Jira sync — lets each button tell "my own sync" apart
 *  from "a sync started elsewhere" (see getJiraSyncActivity). */
export type JiraSyncTrigger = "auto" | "header" | "settings";

/** Transient, in-memory only — deliberately NOT part of StoreState, so it is never persisted
 *  and never survives a reload (a sync can't survive a reload either). */
export interface JiraSyncActivity {
  inProgress: boolean;
  trigger?: JiraSyncTrigger;
}

/** "sync-in-progress" is a refusal, not a sync failure: it never touches jiraSync
 *  bookkeeping, which is why it's kept out of the persisted JiraErrorKind union. */
export type JiraSyncErrorKind = JiraErrorKind | "sync-in-progress";

export interface JiraSyncResult {
  ok: boolean;
  error?: string;
  errorKind?: JiraSyncErrorKind;
}

export interface CommandCenterStoreDeps {
  /** Defaults to the real client-side JiraDataSource. */
  createJiraDataSource?: () => DataSourceProvider;
  /** undefined → navigator.locks when available (resolved per sync); null → force the
   *  in-memory fallback lock. */
  jiraSyncLockManager?: JiraSyncLockManager | null;
  /** A2 — undefined → the browser default (IndexedDB, else localStorage; none server-side);
   *  null → no persistence at all. Tests inject a shared in-memory storage per "origin". */
  stateStorage?: StateStorage | null;
  /** A2 — undefined → BroadcastChannel("daily-command-state") when the browser has it;
   *  null → none (forces the focus/visibilitychange fallback). */
  stateChannel?: StateChannelFactory | null;
  /** A2 — where the no-BroadcastChannel fallback listens for "focus"/"visibilitychange".
   *  undefined → window + document. */
  stateFocusTargets?: Pick<EventTarget, "addEventListener">[];
}

const IDLE_JIRA_SYNC_ACTIVITY: JiraSyncActivity = { inProgress: false };

/**
 * Pure parse + migration step, split out of the store so it's directly testable without
 * a DOM/localStorage shim. Never throws: malformed JSON or an unrecognized shape falls
 * back to a pristine state (V1.2 §19, V1.3 §43-44 "malformed old data must not crash the
 * app"). Migrates every prior schema losslessly:
 *   V1/V1.1 (`previousSnapshot`) -> V1.2 (`snapshotHistory`) -> V1.3 (dataSource/jiraSync/
 *   filters/schemaVersion, all additive with safe defaults).
 */
// V1.8 §21 — a wrong primitive type (a string/number/array where an object is expected)
// must fall back to a safe default, never be trusted as-is: downstream code assumes these
// fields are real objects/arrays and would crash on a malformed shape.
function asPlainObject<T>(v: unknown, fallback: T): T {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as T) : fallback;
}

// V2.2 §16 — a corrupted/malformed entry in `artifacts` must never crash the app; it's
// simply dropped, same discipline as every other bounded array parsed above.
function isArtifactRecordShape(v: unknown): v is ArtifactRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Partial<ArtifactRecord>;
  return typeof r.id === "string" && typeof r.type === "string" && typeof r.createdAt === "string" && Array.isArray(r.sections) && typeof r.evidenceVersion === "string";
}

// V2.2 §22-23 — usage counters are always non-negative finite numbers keyed by a plain
// string; anything else in the stored object is dropped rather than trusted.
function asUsageCounters(v: unknown): Record<string, number> {
  const obj = asPlainObject<Record<string, unknown>>(v, {});
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return out;
}

// V2.11 §1 — defensive shape guard for the persisted one-time migration notice; a malformed
// value is dropped rather than trusted, same discipline as every other parsed field here.
function asMigrationNotice(v: unknown): WorkRelevancePolicyMigrationNotice | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const n = v as Partial<WorkRelevancePolicyMigrationNotice>;
  if (typeof n.fromProjectCount !== "number" || !Array.isArray(n.collapsedStatuses) || typeof n.migratedAt !== "string") return undefined;
  return { fromProjectCount: n.fromProjectCount, collapsedStatuses: n.collapsedStatuses.filter((s): s is string => typeof s === "string"), migratedAt: n.migratedAt };
}

// V2.12 — a malformed entry (or a corrupted map) is dropped rather than trusted, same
// discipline as every other parsed field here; a missing/invalid entry just means that
// item/status pair starts tracking fresh from today, never a crash.
function isCalibrationHistoryEntryShape(v: unknown): v is WorkItemCalibrationHistory[string] {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Partial<WorkItemCalibrationHistory[string]>;
  return typeof e.itemId === "string" && typeof e.statusName === "string" && typeof e.firstObservedAt === "string" && (e.firstSeenInCandidatePoolAt === undefined || typeof e.firstSeenInCandidatePoolAt === "string");
}

function asWorkItemCalibrationHistory(v: unknown): WorkItemCalibrationHistory {
  const obj = asPlainObject<Record<string, unknown>>(v, {});
  const out: WorkItemCalibrationHistory = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isCalibrationHistoryEntryShape(value)) out[key] = value;
  }
  return out;
}

// V2.17 §1a — a pre-existing persisted MentionEvent (from before `commentId` existed) is
// backfilled with a deterministic id derived from what it does have (issueKey+mentionedAt) —
// never dropped outright, since that would silently lose real, possibly-unresolved mention
// history on the very upgrade this task exists to fix. A structurally malformed entry (missing
// even the pre-existing required fields) is dropped, same discipline as every other parsed
// array here.
function normalizeMentionEvents(v: unknown): MentionEvent[] {
  if (!Array.isArray(v)) return [];
  const out: MentionEvent[] = [];
  for (const raw of v) {
    if (typeof raw !== "object" || raw === null) continue;
    const m = raw as Partial<MentionEvent>;
    if (typeof m.issueKey !== "string" || typeof m.excerpt !== "string" || typeof m.mentionedAt !== "string") continue;
    out.push({
      issueKey: m.issueKey,
      commentId: typeof m.commentId === "string" && m.commentId.length > 0 ? m.commentId : `${m.issueKey}:legacy:${m.mentionedAt}`,
      commentAuthor: typeof m.commentAuthor === "string" ? m.commentAuthor : undefined,
      excerpt: m.excerpt,
      commentUrl: typeof m.commentUrl === "string" ? m.commentUrl : undefined,
      mentionedAt: m.mentionedAt,
    });
  }
  return out;
}

// V2.17 §1a point 1 — global cap on mentionEvents, oldest-RESOLVED-first eviction: a comment
// whose MENTION attention item has already reached RESOLVED is safe to forget (its evidence
// stays available via memoryEvents/history where relevant); only once every resolved entry is
// exhausted does this fall back to evicting the oldest still-open entries, so a genuinely
// unactioned mention is the last thing ever dropped, not the first.
export function capMentionEvents(events: MentionEvent[], attentionState: Record<string, AttentionItemState>, max: number): MentionEvent[] {
  if (events.length <= max) return events;
  const isResolved = (m: MentionEvent) => attentionState[`MENTION:${slug(m.issueKey)}:${slug(m.commentId)}`]?.lifecycle === "RESOLVED";
  const byAge = (a: MentionEvent, b: MentionEvent) => (a.mentionedAt < b.mentionedAt ? -1 : a.mentionedAt > b.mentionedAt ? 1 : 0);
  const evictionOrder = [...events.filter(isResolved).sort(byAge), ...events.filter((m) => !isResolved(m)).sort(byAge)];
  const drop = new Set(evictionOrder.slice(0, events.length - max).map((m) => m.commentId));
  return events.filter((m) => !drop.has(m.commentId));
}

// V2.17 Task 2 — a malformed entry (or a corrupted map) is dropped rather than trusted, same
// discipline as every other parsed field here; a missing/invalid report just means that day
// has no report yet, never a crash. A minimally-shaped entry (right date/generatedAt, even an
// empty events array) is still accepted — an empty report for a day with no memoryEvents is a
// legitimate, real result, not a malformed one.
function isDailyReportSnapshotShape(v: unknown): v is DailyReportSnapshot {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Partial<DailyReportSnapshot>;
  return typeof r.date === "string" && typeof r.generatedAt === "string" && Array.isArray(r.events);
}

function asDailyReports(v: unknown): Record<string, DailyReportSnapshot> {
  const obj = asPlainObject<Record<string, unknown>>(v, {});
  const out: Record<string, DailyReportSnapshot> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isDailyReportSnapshotShape(value)) out[key] = value;
  }
  return out;
}

// V2.19 — same discipline as every other parsed field here: a malformed entry (or a corrupted
// map) is dropped rather than trusted; a missing/invalid entry just means that ticket has no
// Daily Command Completion recorded, never a crash.
function isDailyCommandCompletionShape(v: unknown): v is DailyCommandCompletion {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Partial<DailyCommandCompletion>;
  return (
    typeof c.ticketKey === "string" &&
    typeof c.completedAt === "string" &&
    (c.completedBy === undefined || typeof c.completedBy === "string") &&
    (c.updatedAt === undefined || typeof c.updatedAt === "string")
  );
}

function asDailyCommandCompletions(v: unknown): Record<string, DailyCommandCompletion> {
  const obj = asPlainObject<Record<string, unknown>>(v, {});
  const out: Record<string, DailyCommandCompletion> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isDailyCommandCompletionShape(value)) out[key] = value;
  }
  return out;
}

const VALID_SKIP_REASONS = new Set<SkipReason>(["Team is handling it", "Not my action", "Waiting on another team", "Not relevant right now", "Other"]);

// V2.23 — same discipline as isDailyCommandCompletionShape above: a malformed entry (or a
// corrupted map) is dropped rather than trusted; a missing/invalid entry just means that
// ticket has no Daily Command Skip recorded, never a crash.
function isDailyCommandSkipShape(v: unknown): v is DailyCommandSkip {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Partial<DailyCommandSkip>;
  return (
    typeof s.ticketKey === "string" &&
    typeof s.skippedAt === "string" &&
    (s.skippedBy === undefined || typeof s.skippedBy === "string") &&
    (s.reason === undefined || (typeof s.reason === "string" && VALID_SKIP_REASONS.has(s.reason))) &&
    (s.updatedAt === undefined || typeof s.updatedAt === "string") &&
    (s.revisitOn === undefined || typeof s.revisitOn === "string")
  );
}

function asDailyCommandSkips(v: unknown): Record<string, DailyCommandSkip> {
  const obj = asPlainObject<Record<string, unknown>>(v, {});
  const out: Record<string, DailyCommandSkip> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isDailyCommandSkipShape(value)) out[key] = value;
  }
  return out;
}

// V2.26 — same discipline as isDailyCommandSkipShape above.
function isDailyCommandBlockShape(v: unknown): v is DailyCommandBlock {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Partial<DailyCommandBlock>;
  return (
    typeof b.ticketKey === "string" &&
    typeof b.blockedAt === "string" &&
    (b.blockedBy === undefined || typeof b.blockedBy === "string") &&
    (b.reason === undefined || typeof b.reason === "string") &&
    (b.updatedAt === undefined || typeof b.updatedAt === "string") &&
    (b.revisitOn === undefined || typeof b.revisitOn === "string")
  );
}

// A1 — same drop-malformed-entries discipline; a missing/corrupt tombstone map is just empty.
function asTombstoneMap(v: unknown): Record<string, DailyCommandTombstone> {
  const obj = asPlainObject<Record<string, unknown>>(v, {});
  const out: Record<string, DailyCommandTombstone> = {};
  for (const [key, value] of Object.entries(obj)) {
    const t = value as Partial<DailyCommandTombstone> | null;
    if (t && typeof t === "object" && typeof t.ticketKey === "string" && typeof t.deletedAt === "string") out[key] = { ticketKey: t.ticketKey, deletedAt: t.deletedAt };
  }
  return out;
}

export function asDailyReviewAcks(v: unknown): Record<string, DailyReviewAck> {
  const obj = asPlainObject<Record<string, unknown>>(v, {});
  const out: Record<string, DailyReviewAck> = {};
  for (const [key, value] of Object.entries(obj)) {
    const a = value as Partial<DailyReviewAck> | null;
    if (a && typeof a === "object" && typeof a.ticketKey === "string" && typeof a.reviewedAt === "string") out[key] = { ticketKey: a.ticketKey, reviewedAt: a.reviewedAt };
  }
  return out;
}

function asStringRecord(v: unknown): Record<string, string> {
  const obj = asPlainObject<Record<string, unknown>>(v, {});
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => typeof value === "string")) as Record<string, string>;
}

// D — same drop-malformed discipline as every parser here.
function asFeatureToggles(v: unknown): FeatureToggles {
  const obj = asPlainObject<Record<string, unknown>>(v, {});
  const out = { ...DEFAULT_FEATURE_TOGGLES };
  for (const key of Object.keys(out) as (keyof FeatureToggles)[]) if (typeof obj[key] === "boolean") out[key] = obj[key] as boolean;
  return out;
}
function asDailySyncSummary(v: unknown): Record<string, DailySyncSummary> {
  const obj = asPlainObject<Record<string, unknown>>(v, {});
  const out: Record<string, DailySyncSummary> = {};
  for (const [k, raw] of Object.entries(obj)) {
    const d = raw as Partial<DailySyncSummary> | null;
    if (d && typeof d === "object" && typeof d.date === "string" && [d.syncs, d.newTickets, d.assignedToMe, d.closed].every((n) => typeof n === "number")) out[k] = d as DailySyncSummary;
  }
  return out;
}
export function asMentionReplies(v: unknown): Record<string, MentionReply> {
  const obj = asPlainObject<Record<string, unknown>>(v, {});
  const out: Record<string, MentionReply> = {};
  for (const [k, raw] of Object.entries(obj)) {
    const r = raw as Partial<MentionReply> | null;
    if (r && typeof r === "object" && typeof r.commentId === "string" && typeof r.issueKey === "string" && typeof r.repliedAt === "string" && (r.source === "manual" || r.source === "jira")) out[k] = r as MentionReply;
  }
  return out;
}
function asMyTicketActivity(v: unknown): Record<string, MyTicketActivity> {
  const obj = asPlainObject<Record<string, unknown>>(v, {});
  const out: Record<string, MyTicketActivity> = {};
  for (const [k, raw] of Object.entries(obj)) {
    const a = raw as MyTicketActivity | null;
    if (!a || typeof a !== "object") continue;
    const entry: MyTicketActivity = {};
    if (typeof a.lastCommentAt === "string") entry.lastCommentAt = a.lastCommentAt;
    if (typeof a.lastActivityAt === "string") entry.lastActivityAt = a.lastActivityAt;
    if (entry.lastCommentAt || entry.lastActivityAt) out[k] = entry;
  }
  return out;
}

export function asDailyCommandTombstones(v: unknown): DailyCommandTombstones {
  const obj = asPlainObject<Record<string, unknown>>(v, {});
  return { completions: asTombstoneMap(obj.completions), skips: asTombstoneMap(obj.skips), blocks: asTombstoneMap(obj.blocks) };
}

function asDailyCommandBlocks(v: unknown): Record<string, DailyCommandBlock> {
  const obj = asPlainObject<Record<string, unknown>>(v, {});
  const out: Record<string, DailyCommandBlock> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isDailyCommandBlockShape(value)) out[key] = value;
  }
  return out;
}

// Same discipline as every other parsed field here: a malformed entry is dropped rather than
// trusted or crashing the parse.
function isSyncLogEntryShape(v: unknown): v is SyncLogEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Partial<SyncLogEntry>;
  return (
    typeof e.startedAt === "string" &&
    typeof e.completedAt === "string" &&
    typeof e.recordsCreated === "number" &&
    typeof e.recordsUpdated === "number" &&
    Array.isArray(e.newTicketKeys) &&
    e.newTicketKeys.every((k) => typeof k === "string")
  );
}

function asSyncLog(v: unknown): SyncLogEntry[] {
  return Array.isArray(v) ? v.filter(isSyncLogEntryShape).slice(-MAX_SYNC_LOG) : [];
}

// V2.22 §3 — same discipline as every other parsed field here: a malformed entry is dropped
// rather than trusted or crashing the parse.
function isPilotScore(v: unknown): v is 0 | 1 | 2 {
  return v === 0 || v === 1 || v === 2;
}

function isPilotFeedbackContextShape(v: unknown): v is PilotFeedbackContext {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Partial<PilotFeedbackContext>;
  return (
    typeof c.freshness === "string" &&
    (c.projectScopeMode === "ALL" || c.projectScopeMode === "FOCUSED") &&
    typeof c.assignedWorkActiveCount === "number" &&
    typeof c.recentMentionsCount === "number" &&
    typeof c.waitingForCount === "number" &&
    typeof c.attentionQueueActiveCount === "number"
  );
}

function isPilotFeedbackEntryShape(v: unknown): v is PilotFeedbackEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Partial<PilotFeedbackEntry>;
  return (
    typeof e.id === "string" &&
    typeof e.date === "string" &&
    typeof e.submittedAt === "string" &&
    isPilotScore(e.usefulness) &&
    isPilotScore(e.nextActionClarity) &&
    isPilotScore(e.trust) &&
    (e.note === undefined || typeof e.note === "string") &&
    isPilotFeedbackContextShape(e.context)
  );
}

function asPilotFeedback(v: unknown): PilotFeedbackEntry[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isPilotFeedbackEntryShape);
}

// V2.25 Task 3 — same discipline as every other parsed field here: a malformed/missing value
// falls back to the safe default rather than being trusted as-is. escalateBusinessDays is
// additionally clamped to never be below warnBusinessDays — otherwise ESCALATE could fire
// before WARN, an invalid severity ordering no code path should ever have to handle.
function asStaleAssignedTicketThresholds(v: unknown): StaleAssignedTicketThresholds {
  const obj = asPlainObject<Partial<StaleAssignedTicketThresholds>>(v, {});
  const warnBusinessDays =
    typeof obj.warnBusinessDays === "number" && Number.isFinite(obj.warnBusinessDays) && obj.warnBusinessDays > 0
      ? Math.round(obj.warnBusinessDays)
      : DEFAULT_STALE_ASSIGNED_TICKET_THRESHOLDS.warnBusinessDays;
  const escalateBusinessDaysRaw =
    typeof obj.escalateBusinessDays === "number" && Number.isFinite(obj.escalateBusinessDays) && obj.escalateBusinessDays > 0
      ? Math.round(obj.escalateBusinessDays)
      : DEFAULT_STALE_ASSIGNED_TICKET_THRESHOLDS.escalateBusinessDays;
  return { warnBusinessDays, escalateBusinessDays: Math.max(escalateBusinessDaysRaw, warnBusinessDays) };
}

// V2.14 §4 — same discipline as every other parsed field here: a malformed/missing entry
// falls back to its safe default (false — "Everything") rather than being trusted as-is.
function asMyActionItemsOnly(v: unknown): MyActionItemsOnlyByPage {
  const obj = asPlainObject<Partial<MyActionItemsOnlyByPage>>(v, {});
  return { attention: obj.attention === true, myDay: obj.myDay === true, priorities: obj.priorities === true };
}

type TicketStateSlice = Pick<StoreState, "ticketWorkStates" | "dailyCommandCompletions" | "dailyCommandSkips" | "dailyCommandBlocks" | "dailyCommandTombstones">;

/** Migration + projection in one: folds legacy Daily Command records (and ticket-linked plan
 *  items) into ticketWorkStates, then re-derives the deprecated maps from the result. Run on
 *  parse, cross-tab rebase and cross-device sync — idempotent (see
 *  migrateLegacyIntoTicketStates). `nowIso` prunes old tombstones (local writes only). */
export function ticketStateFromLegacy(
  states: Record<string, TicketWorkState>,
  legacy: Pick<StoreState, "dailyCommandCompletions" | "dailyCommandSkips" | "dailyCommandBlocks" | "dailyCommandTombstones">,
  plan: PersonalPlanItem[],
  nowIso: string | undefined
): TicketStateSlice {
  const ticketWorkStates = migrateLegacyIntoTicketStates(states, legacy, plan);
  return { ticketWorkStates, ...deriveLegacyDailyCommandState(ticketWorkStates, nowIso, legacy.dailyCommandTombstones) };
}

/** The today-aware Daily Command maps every engine that still takes map-shaped input reads —
 *  a projection of ticketWorkStates (a DEFERRED ticket whose date has come is back to active). */
export function selectDailyCommandMaps(state: Pick<StoreState, "ticketWorkStates">, today: string = getTodayIso()): DailyCommandMapsView {
  return ticketStateMaps(state.ticketWorkStates, today);
}

export function parseStoredState(raw: string): StoreState {
  try {
    const parsed = JSON.parse(raw) as Partial<StoreState> & { previousSnapshot?: DailySnapshot | null };
    const snapshotHistory = parsed.snapshotHistory ?? (parsed.previousSnapshot ? [parsed.previousSnapshot] : []);
    const { policy: jiraWorkRelevancePolicy, migration } = parseWorkRelevancePolicyMap(parsed.jiraWorkRelevancePolicy);
    const parsedData = asPlainObject(parsed.data, emptyData());
    // Ticket links for plan items made before PersonalPlanItem.ticketKey existed.
    const personalPlan = backfillPlanTicketKeys(Array.isArray(parsed.personalPlan) ? (parsed.personalPlan as PersonalPlanItem[]) : [], {
      workItems: Array.isArray(parsedData.workItems) ? parsedData.workItems : [],
      actions: Array.isArray(parsedData.actions) ? parsedData.actions : [],
      dependencies: Array.isArray(parsedData.dependencies) ? parsedData.dependencies : [],
    });
    const dataSourceValue: StoreState["dataSource"] = ["demo", "local-import", "jira"].includes(parsed.dataSource as string)
      ? (parsed.dataSource as StoreState["dataSource"])
      : parsed.isDemo
      ? "demo"
      : parsed.loaded
      ? "local-import"
      : "demo";
    return {
      schemaVersion: DATA_SCHEMA_VERSION,
      data: parsedData,
      snapshotHistory: Array.isArray(snapshotHistory) ? snapshotHistory : [],
      loaded: parsed.loaded ?? false,
      isDemo: parsed.isDemo ?? false,
      eodHistory: Array.isArray(parsed.eodHistory) ? parsed.eodHistory : [],
      dataSource: dataSourceValue,
      jiraSync: asPlainObject(parsed.jiraSync, initialJiraSync()),
      filters: asPlainObject(parsed.filters, {}),
      jiraProjectScope: parseJiraProjectScope(parsed.jiraProjectScope),
      jiraWorkRelevancePolicy,
      workRelevancePolicyMigrationNotice: migration ?? asMigrationNotice(parsed.workRelevancePolicyMigrationNotice),
      attentionState: asPlainObject(parsed.attentionState, {}),
      memoryEvents: Array.isArray(parsed.memoryEvents) ? parsed.memoryEvents : [],
      ownerName: typeof parsed.ownerName === "string" ? parsed.ownerName : undefined,
      personalIdentity:
        parsed.personalIdentity && typeof parsed.personalIdentity === "object" && typeof (parsed.personalIdentity as Partial<PersonalIdentity>).displayName === "string"
          ? (parsed.personalIdentity as PersonalIdentity)
          : undefined,
      personalPlan,
      artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts.filter(isArtifactRecordShape) : [],
      usageCounters: asUsageCounters(parsed.usageCounters),
      mentionEvents: normalizeMentionEvents(parsed.mentionEvents),
      showAdvancedSettings: parsed.showAdvancedSettings === true,
      workItemCalibrationHistory: asWorkItemCalibrationHistory(parsed.workItemCalibrationHistory),
      myActionItemsOnly: asMyActionItemsOnly(parsed.myActionItemsOnly),
      lastAppStateSyncIso: typeof parsed.lastAppStateSyncIso === "string" ? parsed.lastAppStateSyncIso : undefined,
      dailyReports: asDailyReports(parsed.dailyReports),
      ...ticketStateFromLegacy(
        asTicketWorkStates(parsed.ticketWorkStates),
        {
          dailyCommandCompletions: asDailyCommandCompletions(parsed.dailyCommandCompletions),
          dailyCommandSkips: asDailyCommandSkips(parsed.dailyCommandSkips),
          dailyCommandBlocks: asDailyCommandBlocks(parsed.dailyCommandBlocks),
          dailyCommandTombstones: asDailyCommandTombstones(parsed.dailyCommandTombstones),
        },
        personalPlan,
        undefined
      ),
      pilotFeedback: asPilotFeedback(parsed.pilotFeedback),
      staleAssignedTicketThresholds: asStaleAssignedTicketThresholds(parsed.staleAssignedTicketThresholds),
      syncLog: asSyncLog(parsed.syncLog),
      dailyReviewLastVisitAt: typeof parsed.dailyReviewLastVisitAt === "string" ? parsed.dailyReviewLastVisitAt : undefined,
      dailyReviewAcks: asDailyReviewAcks(parsed.dailyReviewAcks),
      dailyReviewBaselineAt: typeof parsed.dailyReviewBaselineAt === "string" ? parsed.dailyReviewBaselineAt : undefined,
      knownTicketFirstSeen: asStringRecord(parsed.knownTicketFirstSeen),
      jiraSprintFieldId: typeof parsed.jiraSprintFieldId === "string" && /^customfield_\d{1,9}$/.test(parsed.jiraSprintFieldId) ? parsed.jiraSprintFieldId : undefined,
      features: asFeatureToggles(parsed.features),
      dailySyncSummary: asDailySyncSummary(parsed.dailySyncSummary),
      mentionReplies: asMentionReplies(parsed.mentionReplies),
      myTicketActivity: asMyTicketActivity(parsed.myTicketActivity),
      followUpNotified: asStringRecord(parsed.followUpNotified),
      morningBriefLastRunDay: typeof parsed.morningBriefLastRunDay === "string" ? parsed.morningBriefLastRunDay : undefined,
      defaultLandingPage: typeof parsed.defaultLandingPage === "string" && LANDING_PAGES.includes(parsed.defaultLandingPage) ? parsed.defaultLandingPage : undefined,
      weeklyReportMode: parsed.weeklyReportMode === "calendar" ? "calendar" : parsed.weeklyReportMode === "workweek" ? "workweek" : undefined,
    };
  } catch {
    return initialState();
  }
}

export class CommandCenterStore {
  private state: StoreState = initialState();
  private listeners = new Set<Listener>();
  private hydrated = false;
  private jiraSyncActivity: JiraSyncActivity = IDLE_JIRA_SYNC_ACTIVITY;

  constructor(private readonly deps: CommandCenterStoreDeps = {}) {}

  // ===== A2 — cross-tab-safe persistence (see state-persistence.ts for the full design) =====
  // `base` is the state exactly as this tab last read it from, or wrote it to, storage, and
  // `rev` its stateRev. `this.state !== this.base` therefore means "this tab has changes not
  // yet in storage"; every write is rebased onto storage when storage moved past `rev`.
  private base: StoreState = this.state;
  private rev = 0;
  private readonly tabId = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  private channel: StateChannel | null = null;
  private resolvedStorage: StateStorage | null | undefined = undefined;
  private usesDefaultIndexedDb = false;
  private persistInFlight = false;
  private persistQueued = false;

  private storage(): StateStorage | null {
    if (this.resolvedStorage !== undefined) return this.resolvedStorage;
    if (this.deps.stateStorage !== undefined) return (this.resolvedStorage = this.deps.stateStorage);
    if (typeof window === "undefined") return null; // server render — not cached, the client resolves its own
    if (typeof indexedDB === "undefined") {
      // No IndexedDB available (old browser, some locked-down private-browsing modes, or
      // this app's own Node-based offline test environment) — the original, fully
      // synchronous localStorage path.
      this.resolvedStorage = createLocalStorageStateStorage(() => window.localStorage, STORAGE_KEY);
    } else {
      this.usesDefaultIndexedDb = true;
      this.resolvedStorage = { read: () => idbGet(STORAGE_KEY), update: (fn) => idbUpdate(STORAGE_KEY, fn) };
    }
    return this.resolvedStorage;
  }

  private hydrate() {
    if (this.hydrated) return;
    const storage = this.storage();
    if (!storage) return;
    this.hydrated = true;
    this.connectCrossTab();
    if (this.usesDefaultIndexedDb) {
      // V2.16 — IndexedDB reads are inherently async, but getSnapshot() must return
      // synchronously for useSyncExternalStore — this kicks off the read in the background;
      // once it resolves, every subscribed component is notified, same as any other state
      // change. Until then, callers see the pristine initialState(), an unavoidable, brief
      // first-paint gap — the same one this app already accepts for getServerSnapshot().
      void this.hydrateFromIndexedDb();
      return;
    }
    let raw: string | null | Promise<string | null>;
    try {
      raw = storage.read();
    } catch {
      // Storage inaccessible (e.g. private browsing) — fall back to pristine state.
      this.state = initialState();
      this.base = this.state;
      return;
    }
    if (raw instanceof Promise) {
      void raw.then((r) => r && this.adoptStored(parseStoredState(r), readRevFromRaw(r)), () => undefined);
      return;
    }
    if (raw) {
      this.state = parseStoredState(raw);
      this.base = this.state;
      this.rev = readRevFromRaw(raw);
    }
  }

  /** V2.16 — one-time migration: a device that already has real data in the OLD localStorage
   *  key (every install from before this pass) must not appear to have "lost" it just
   *  because IndexedDB is empty on its first-ever read here. The legacy key is only cleared
   *  once its content has actually been confirmed written to IndexedDB — a failed migration
   *  write leaves the old copy in place so the next reload simply retries. A2 — the write is
   *  conditional (only into an empty IndexedDB), so a second tab migrating at the same moment
   *  can never overwrite a write the first tab already made. */
  private async hydrateFromIndexedDb() {
    try {
      const fromIdb = await idbGet(STORAGE_KEY);
      if (fromIdb) {
        this.adoptStored(parseStoredState(fromIdb), readRevFromRaw(fromIdb));
        return;
      }
    } catch {
      // IndexedDB read failed — fall through to the legacy-migration/pristine path below.
    }

    let legacyRaw: string | null = null;
    try {
      legacyRaw = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // localStorage inaccessible too — nothing to migrate from; stay pristine.
    }
    if (!legacyRaw) return; // genuinely nothing persisted anywhere yet

    const migrated = parseStoredState(legacyRaw);
    this.adoptStored(migrated, 0);
    try {
      await idbUpdate(STORAGE_KEY, (current) => (current ? null : serializeWithRev(migrated, 0)));
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Migration write failed — legacy copy stays in place; persist() below will keep
      // retrying the IndexedDB write on every subsequent mutation regardless.
    }
    void this.checkForNewerState();
  }

  /** A2 — take a newer stored state as this tab's own. Local changes not yet persisted are
   *  rebased on top (never dropped), then persisted. */
  private adoptStored(stored: StoreState, rev: number) {
    const pending = this.state !== this.base;
    this.state = pending ? this.rebase(this.base, this.state, stored) : stored;
    this.base = stored;
    this.rev = rev;
    this.listeners.forEach((l) => l());
    if (pending) this.persist();
  }

  /** A2 — the 3-way rebase (state-persistence.ts), then the execution-state LWW merge over the
   *  result, so per-ticket records, tombstones and Daily Review acks from BOTH sides survive
   *  even where the generic rebase took a whole sub-map from one side. */
  private rebase(prev: StoreState, next: StoreState, stored: StoreState): StoreState {
    const rebased = rebaseState(prev, next, stored);
    return {
      ...rebased,
      ...ticketStateFromLegacy(mergeTicketWorkStates(rebased.ticketWorkStates, stored.ticketWorkStates), stored, rebased.personalPlan, undefined),
      dailyReviewAcks: mergeReviewAcks(rebased.dailyReviewAcks, stored.dailyReviewAcks),
    };
  }

  private connectCrossTab() {
    const factory = this.deps.stateChannel !== undefined ? this.deps.stateChannel : browserStateChannel;
    this.channel = factory
      ? factory((m) => {
          if (m.writerTabId !== this.tabId && m.rev > this.rev) void this.checkForNewerState();
        })
      : null;
    if (this.channel) return;
    // Fallback (no BroadcastChannel): compare the stored rev whenever this tab regains focus.
    const targets =
      this.deps.stateFocusTargets ??
      [typeof window !== "undefined" ? window : undefined, typeof document !== "undefined" ? document : undefined].filter(
        (t): t is Window & Document => !!t && typeof (t as EventTarget).addEventListener === "function"
      );
    const check = () => void this.checkForNewerState();
    for (const t of targets) {
      t.addEventListener("focus", check);
      t.addEventListener("visibilitychange", check);
    }
  }

  /** A2 — re-hydrates from storage when another tab has written a newer rev. Called on a
   *  BroadcastChannel message, and on focus/visibilitychange where that channel is missing. */
  async checkForNewerState(): Promise<void> {
    const storage = this.storage();
    if (!storage) return;
    let raw: string | null;
    try {
      raw = await storage.read();
    } catch {
      return;
    }
    const rev = readRevFromRaw(raw);
    if (!raw || rev <= this.rev) return;
    this.adoptStored(parseStoredState(raw), rev);
  }

  /** Writes `this.state` through one atomic read-modify-write. When the stored rev is newer
   *  than `this.rev` (another tab wrote since this tab last saw storage), the write is rebased
   *  onto the stored state instead of overwriting it; the rebased result then becomes this
   *  tab's state too. Writes are serialized per tab (one in flight, the rest coalesced).
   *  Failures keep working in-memory, same contract as ever: localStorage quota errors are
   *  swallowed; IndexedDB ones are logged, since they are rare enough to be worth a trace. */
  private persist() {
    const storage = this.storage();
    if (!storage) return;
    if (this.persistInFlight) {
      this.persistQueued = true;
      return;
    }
    this.persistInFlight = true;
    const local = this.state;
    const base = this.base;
    const baseRev = this.rev;
    let written = local;
    let writtenRev = baseRev;
    const decide = (current: string | null): string => {
      const storedRev = readRevFromRaw(current);
      written = storedRev > baseRev && current ? this.rebase(base, local, parseStoredState(current)) : local;
      writtenRev = Math.max(storedRev, baseRev) + 1;
      return serializeWithRev(written, writtenRev);
    };
    const finish = (ok: boolean) => {
      this.persistInFlight = false;
      if (ok) {
        this.base = written;
        this.rev = writtenRev;
        if (written !== local) {
          this.state = this.state === local ? written : rebaseState(local, this.state, written);
          this.listeners.forEach((l) => l());
        }
        this.channel?.post({ rev: writtenRev, writerTabId: this.tabId });
      }
      if (this.persistQueued || (ok && this.state !== this.base)) {
        this.persistQueued = false;
        if (this.state !== this.base) this.persist();
      }
    };
    let result: void | Promise<void>;
    try {
      result = storage.update(decide);
    } catch {
      // Storage full/unavailable — keep working in-memory for this session.
      finish(false);
      return;
    }
    if (result instanceof Promise) {
      result.then(
        () => finish(true),
        (err) => {
          console.error("CommandCenterStore: failed to persist state", err);
          finish(false);
        }
      );
    } else {
      finish(true);
    }
  }

  private set(next: StoreState) {
    this.state = next;
    this.persist();
    this.listeners.forEach((l) => l());
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): StoreState => {
    this.hydrate();
    return this.state;
  };

  /** Whether a Jira sync is running in this tab right now, and which trigger started it.
   *  Referentially stable between changes, so it's safe as a useSyncExternalStore snapshot;
   *  subscribers are notified (via the same subscribe()) whenever it changes. */
  getJiraSyncActivity = (): JiraSyncActivity => this.jiraSyncActivity;
  getServerJiraSyncActivity = (): JiraSyncActivity => IDLE_JIRA_SYNC_ACTIVITY;

  private setJiraSyncActivity(next: JiraSyncActivity) {
    this.jiraSyncActivity = next;
    this.listeners.forEach((l) => l());
  }

  // Must return a referentially-stable value — useSyncExternalStore calls this on every
  // render, and a freshly-built object here trips React's "getServerSnapshot should be
  // cached" infinite-loop guard.
  private static readonly SERVER_SNAPSHOT: StoreState = initialState();
  getServerSnapshot = (): StoreState => (this.liveServerSnapshot ? this.state : CommandCenterStore.SERVER_SNAPSHOT);

  /** C3 — the offline page smoke test renders every page with react-dom/server, where React
   *  reads getServerSnapshot. This makes that return the live state, so pages render real data
   *  instead of the pristine first-paint state. Never enabled by the app itself. */
  private liveServerSnapshot = false;
  renderLiveStateOnServerForTests(on: boolean) {
    this.liveServerSnapshot = on;
  }

  loadDemoData() {
    const { snapshotHistory, current } = buildDemoData(getTodayIso());
    // V1.6 §5 — demo convenience default only (never inferred for real data): pre-fills
    // "your identity" with a real demo owner name so DO NOW ranking is visible immediately.
    // Explicit, editable in Data & Settings — never overwrites an identity already set.
    this.set({
      ...this.state,
      data: current,
      snapshotHistory,
      loaded: true,
      isDemo: true,
      dataSource: "demo",
      ownerName: this.state.ownerName ?? "Minh Tran",
      personalIdentity: this.state.personalIdentity ?? { id: "identity-demo-seed", displayName: "Minh Tran" },
    });
  }

  /** Import merges by id (existing rows are overwritten, new rows appended) and snapshots
   *  the pre-import state so "What Changed" reflects the delta this import introduced. */
  importData(result: ImportResult) {
    if (!result.ok) return;
    // V2.18 §7 — same deduped manual+auto risk set every other snapshot-producing call site
    // now persists (see syncJira/closeDay's own comments) — the pre-import snapshot's risks
    // must also match what detectRisks live-computes, so day-over-day risk history stays
    // consistent regardless of which action (sync, import, close day) produced a given entry.
    const today = getTodayIso();
    const prevSnapshot = toSnapshot(this.state.data, today, dedupeRisks(this.state.data.risks, detectRisks(this.state.data, today)));
    const merged: CommandCenterData = { ...this.state.data };
    (Object.keys(result.data) as (keyof CommandCenterData)[]).forEach((key) => {
      const incoming = result.data[key] as { id: string }[];
      if (!incoming || incoming.length === 0) return;
      const existing = (merged[key] as unknown as { id: string }[]) ?? [];
      (merged as unknown as Record<string, unknown>)[key] = mergeById(existing, incoming);
    });
    this.set({
      ...this.state,
      data: merged,
      snapshotHistory: this.state.loaded ? [...this.state.snapshotHistory, prevSnapshot].slice(-MAX_SNAPSHOT_HISTORY) : this.state.snapshotHistory,
      loaded: true,
      isDemo: false,
      dataSource: "local-import",
    });
  }

  resetAll() {
    this.set(initialState());
  }

  /** V1.2 §17 "No Hidden Memory" — memory must be deletable without wiping live data.
   *  V2.17 Task 2 — dailyReports is derived memory too (built from memoryEvents), so it's
   *  cleared alongside them; leaving old reports behind after "clear memory" would be exactly
   *  the kind of hidden memory §17 forbids. */
  clearMemory() {
    this.set({ ...this.state, snapshotHistory: [], eodHistory: [], memoryEvents: [], dailyReports: {} });
  }

  // ===== V1.4 §39-40, V1.5 §22-24 — Attention lifecycle =====
  // Persisted separately from any Jira/business status; never touches `data`.

  /** V2.4 §14 — an AttentionItem's project, resolved ONLY through its explicit
   *  `sourceRef` (risk/dependency/decision/action/communication each carry their own
   *  already-explicit project FK, reused via the resolvers above). A "release" sourceRef —
   *  or no sourceRef at all — is left undefined: a release can legitimately span multiple
   *  projects, so a single projectId would misrepresent it rather than help (§14 "must not
   *  be silently assigned"). */
  private projectIdForAttentionItem(item: AttentionItem): string | undefined {
    const ref = item.sourceRef;
    if (!ref) return undefined;
    switch (ref.type) {
      // A RISK sourceRef's `id` is the risk's TITLE, not its `Risk.id` — see
      // attention-queue.ts's buildRawItems (`sourceRef: { type: "risk", id: esc.riskTitle }`),
      // an existing pre-V2.4 quirk this resolver has to match, not invent.
      case "risk":
        return this.state.data.risks.find((r) => r.title === ref.id)?.projectId;
      case "dependency": {
        const dep = this.state.data.dependencies.find((d) => d.id === ref.id);
        return dep ? this.state.data.workItems.find((w) => w.id === dep.workItemId)?.projectId : undefined;
      }
      case "decision":
        return this.state.data.decisions.find((d) => d.id === ref.id)?.projectId;
      case "action":
        return this.projectIdForAction(this.state.data.actions.find((a) => a.id === ref.id));
      case "communication": {
        const comm = this.state.data.communications.find((c) => c.id === ref.id);
        return comm?.workItemId ? this.state.data.workItems.find((w) => w.id === comm.workItemId)?.projectId : undefined;
      }
      default:
        return undefined;
    }
  }

  /** Called after each recompute of the Attention Queue to persist any lifecycle
   *  transitions (NEW->ACTIVE, auto-RESOLVED, REOPENED, RE_ESCALATED, etc). No-op if
   *  unchanged. `items` (the freshly computed queue) is only used to build a readable
   *  RE_ESCALATED memory-event title — it is not itself persisted. */
  commitAttentionState(next: Record<string, AttentionItemState>, items: AttentionItem[] = []) {
    if (JSON.stringify(next) === JSON.stringify(this.state.attentionState)) return;

    const newlyReEscalated = items.filter((item) => item.lifecycle === "RE_ESCALATED" && this.state.attentionState[item.id]?.lifecycle !== "RE_ESCALATED");
    const reEscalationEvents: MemoryEvent[] = newlyReEscalated.map((item) => ({
      id: `memory-event-re-escalated-${item.id}-${Date.now()}`,
      date: getTodayIso(),
      kind: "RE_ESCALATED",
      title: `Re-escalated: ${item.what}`,
      impact: item.why,
      evidence: item.evidence,
      projectId: this.projectIdForAttentionItem(item),
    }));

    this.set({
      ...this.state,
      attentionState: next,
      memoryEvents: reEscalationEvents.length > 0 ? [...this.state.memoryEvents, ...reEscalationEvents].slice(-MAX_MEMORY_EVENTS) : this.state.memoryEvents,
    });
  }

  private setAttentionLifecycle(id: string, patch: Partial<AttentionItemState> & { lifecycle: AttentionLifecycle }) {
    const existing = this.state.attentionState[id];
    if (!existing) return;
    this.set({
      ...this.state,
      attentionState: { ...this.state.attentionState, [id]: { ...existing, ...patch } },
    });
  }

  acknowledgeAttentionItem(id: string) {
    this.setAttentionLifecycle(id, { lifecycle: "ACKNOWLEDGED", acknowledgedAt: getTodayIso() });
  }
  /** V1.5 §24 — snooze now records when and (optionally) why. */
  snoozeAttentionItem(id: string, untilIso: string, reason?: string) {
    this.setAttentionLifecycle(id, { lifecycle: "SNOOZED", snoozedUntil: untilIso, snoozedAt: getTodayIso(), snoozeReason: reason });
  }
  resolveAttentionItem(id: string) {
    this.setAttentionLifecycle(id, { lifecycle: "RESOLVED", resolvedManually: true });
  }

  /** Point-in-time memory event for a ticket transition — reports read only memoryEvents.
   *  Ticket title / project / client / assignee are captured NOW, same discipline as
   *  reportContextForWorkItem; a ticket not in the local data still gets an event with its key. */
  private ticketEvent(kind: MemoryEvent["kind"], ticketKey: string, reason?: string): MemoryEvent {
    const w = this.state.data.workItems.find((x) => x.key === ticketKey);
    const project = w ? this.state.data.projects.find((p) => p.id === w.projectId) : undefined;
    const client = w ? this.state.data.clients.find((c) => c.id === (w.clientId ?? project?.clientId)) : undefined;
    const verb: Partial<Record<MemoryEvent["kind"], string>> = {
      TICKET_COMPLETED: "Completed",
      TICKET_REOPENED: "Reopened",
      TICKET_SKIPPED: "Skipped",
      TICKET_BLOCKED: "Blocked",
      TICKET_UNBLOCKED: "Unblocked",
      TICKET_REACTIVATED: "Reactivated",
      TICKET_STARTED: "Started",
      TICKET_DEFERRED: "Deferred",
    };
    return {
      id: `memory-event-${kind}-${ticketKey}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      date: getTodayIso(),
      kind,
      title: `${verb[kind] ?? kind}: ${w ? `${ticketKey} — ${w.title}` : ticketKey}`,
      impact: "Recorded in the Command Center — Jira itself was not changed.",
      evidence: [],
      ticketKey,
      ...(w ? { projectId: w.projectId, ticketTitle: w.title } : {}),
      ...(w?.sourceUrl ? { ticketUrl: w.sourceUrl } : {}),
      ...(project ? { projectName: project.name } : {}),
      ...(client ? { clientName: client.name } : {}),
      ...(w?.ownerId ? { assigneeId: w.ownerId } : {}),
      ...(w?.owner ? { assigneeName: w.owner } : {}),
      ...(reason?.trim() ? { reason: reason.trim() } : {}),
      ...(w?.sprint ? { sprint: w.sprint } : {}),
    };
  }

  private actorName(): string | undefined {
    return this.state.personalIdentity?.displayName ?? this.state.ownerName;
  }

  /** The records linked to a ticket, brought in line with its new status (STEP 1 table):
   *  DONE → open plan items completed, open actions completed, open attention items resolved;
   *  BLOCKED / SKIPPED / DEFERRED / IN_PROGRESS → open plan items mirror it (BLOCKED keeps the
   *  reason; no Follow-up Action is ever created here); TODO → plan items dated today or later
   *  go back to planned. A plan item from a past day that is already finished is history and is
   *  never rewritten. */
  private linkedRecordsFor(ticketKey: string, record: TicketWorkState, today: string): Pick<StoreState, "personalPlan" | "data" | "attentionState"> {
    const data = this.state.data;
    const status = record.status;
    const workItemIds = new Set(data.workItems.filter((w) => w.key === ticketKey).map((w) => w.id));
    const isOpenPlan = (p: PersonalPlanItem) => p.plannedDate >= today || p.status === "planned" || p.status === "in-progress" || p.status === "blocked";
    let planChanged = false;
    const personalPlan = this.state.personalPlan.map((p) => {
      if (ticketKeyForPlanItem(p, data) !== ticketKey) return p;
      const linked: PersonalPlanItem = p.ticketKey ? p : { ...p, ticketKey };
      let next = linked;
      if (status === "TODO") {
        if (p.plannedDate >= today && p.status !== "planned") {
          next = { ...linked, status: "planned" };
          delete next.completedAt;
          delete next.blockedReason;
          delete next.blockedNote;
          delete next.deferredUntil;
        }
      } else if (isOpenPlan(p)) {
        next = {
          ...linked,
          status: planStatusForTicket(status),
          ...(status === "DONE" ? { completedAt: today } : {}),
          ...(status === "BLOCKED" ? { blockedReason: record.reason } : {}),
          ...(status === "DEFERRED" ? { deferredUntil: record.until } : {}),
        };
      }
      if (next !== p) planChanged = true;
      return next;
    });

    let actions = data.actions;
    let attentionState = this.state.attentionState;
    const from = record.history[record.history.length - 1]?.from;
    if (status === "TODO" && from === "DONE") {
      // Reopen: the ticket's most recently completed linked action comes back too (it is how
      // Action Plan represents the ticket); older completed attempts stay history.
      const latest = data.actions
        .filter((a) => a.status === "completed" && !!a.relatedWorkItemId && workItemIds.has(a.relatedWorkItemId))
        .sort((a, b) => (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt))[0];
      if (latest) actions = data.actions.map((a) => (a.id === latest.id ? { ...a, status: "open" as const } : a));
    }
    if (status === "DONE") {
      const done = new Set<string>();
      actions = data.actions.map((a) => {
        if (a.status === "completed" || !a.relatedWorkItemId || !workItemIds.has(a.relatedWorkItemId)) return a;
        done.add(a.id);
        return { ...a, status: "completed" as const, completedAt: a.completedAt ?? today };
      });
      if (done.size === 0) actions = data.actions;
      const ticketSlug = slug(ticketKey);
      const belongs = (id: string) =>
        id.startsWith(`MENTION:${ticketSlug}:`) ||
        Array.from(workItemIds).some((wid) => id === `ASSIGNMENT:${slug(wid)}` || id === `STALE:${slug(wid)}`) ||
        Array.from(done).some((aid) => id === `ACTION:${slug(aid)}`);
      const resolved = Object.entries(this.state.attentionState).filter(([id, s]) => s.lifecycle !== "RESOLVED" && belongs(id));
      if (resolved.length > 0) {
        attentionState = { ...this.state.attentionState };
        for (const [id, s] of resolved) attentionState[id] = { ...s, lifecycle: "RESOLVED", resolvedManually: true };
      }
    }
    return {
      personalPlan: planChanged ? personalPlan : this.state.personalPlan,
      data: actions === data.actions ? data : { ...data, actions },
      attentionState,
    };
  }

  /** THE one write path for a ticket's personal status (TicketWorkState). Enforces the
   *  transition table (ticket-work-state.ts canTransition — DONE only goes back to TODO, via an
   *  explicit Reopen), appends history, records the TICKET_* memory event reports read, updates
   *  every linked plan item / action / attention item, and re-derives the deprecated Daily
   *  Command maps — all in ONE set(). Never touches Jira or data.workItems. Returns false when
   *  nothing changed (rejected transition or no-op). */
  setTicketStatus(ticketKey: string, status: TicketWorkStatus, opts: Partial<SetTicketStatusOptions> = {}): boolean {
    const nowIso = new Date().toISOString();
    const today = getTodayIso();
    const result = applyTicketStatus(this.state.ticketWorkStates, ticketKey, status, { by: this.actorName(), ...opts, surface: opts.surface ?? "other" }, nowIso);
    if (!result.changed) return false;
    const record = result.states[ticketKey];
    const event = this.ticketEvent(ticketEventKind(result.from, status), ticketKey, record.reason);
    this.set({
      ...this.state,
      ...this.linkedRecordsFor(ticketKey, record, today),
      ticketWorkStates: result.states,
      ...deriveLegacyDailyCommandState(result.states, nowIso, this.state.dailyCommandTombstones),
      memoryEvents: [...this.state.memoryEvents, event].slice(-MAX_MEMORY_EVENTS),
    });
    // Keep an already-generated report for today current (events + standup), so the action
    // is in it even if memoryEvents later rolls past its cap before the next sync.
    if (this.state.dailyReports[event.date]) this.generateDailyReport(event.date, true);
    return true;
  }

  /** Whether a transition would be accepted (UI uses it to decide which buttons to show). */
  canSetTicketStatus(ticketKey: string, status: TicketWorkStatus): boolean {
    const from = ticketStatusOf(this.state.ticketWorkStates, ticketKey);
    return canTransition(from, status) && !isNoopTransition(from, status);
  }

  // ===== Ticket actions — thin, named wrappers over setTicketStatus =====
  // Kept under their V2.19-V2.26 names so every existing caller keeps working; `surface` is
  // recorded in the ticket's history only.

  /** V2.19 — "I'm done with this ticket here", independent of Jira's own status. */
  completeTicketInDailyCommand(ticketKey: string, surface: TicketStatusSurface = "command-center") {
    this.setTicketStatus(ticketKey, "DONE", { surface });
  }

  /** The only way back from DONE — never automatic (a new mention only shows a reactivation
   *  label; it never clears the record). */
  reopenTicketInDailyCommand(ticketKey: string, surface: TicketStatusSurface = "command-center") {
    if (ticketStatusOf(this.state.ticketWorkStates, ticketKey) !== "DONE") return;
    this.setTicketStatus(ticketKey, "TODO", { surface });
  }

  /** V2.23 — "relevant, but I'm intentionally not executing it right now". `reason` optional;
   *  A4 `revisitOn` only schedules a re-check, it never un-skips anything by itself. */
  skipTicketInDailyCommand(ticketKey: string, reason?: SkipReason | string, revisitOn?: string, surface: TicketStatusSurface = "command-center") {
    this.setTicketStatus(ticketKey, "SKIPPED", { surface, reason, until: revisitOn });
  }

  /** Explicit Reactivate — SKIPPED/DEFERRED → TODO. Never automatic. */
  reactivateSkippedTicket(ticketKey: string, surface: TicketStatusSurface = "command-center") {
    const status = ticketStatusOf(this.state.ticketWorkStates, ticketKey);
    if (status !== "SKIPPED" && status !== "DEFERRED") return;
    this.setTicketStatus(ticketKey, "TODO", { surface });
  }

  /** V2.26 — "not done, paused on something outside my control". Free-text reason (trimmed,
   *  bounded); optional re-check and D5 ping dates. */
  blockTicketInDailyCommand(ticketKey: string, reason?: string, revisitOn?: string, pingOn?: string, surface: TicketStatusSurface = "command-center") {
    this.setTicketStatus(ticketKey, "BLOCKED", { surface, reason: reason?.slice(0, MAX_BLOCK_REASON_LENGTH), until: revisitOn, pingOn });
  }

  /** Explicit Unblock — BLOCKED → TODO. Never automatic. */
  unblockTicketInDailyCommand(ticketKey: string, surface: TicketStatusSurface = "command-center") {
    if (ticketStatusOf(this.state.ticketWorkStates, ticketKey) !== "BLOCKED") return;
    this.setTicketStatus(ticketKey, "TODO", { surface });
  }

  /** Start — → IN_PROGRESS. */
  startTicket(ticketKey: string, surface: TicketStatusSurface = "command-center") {
    this.setTicketStatus(ticketKey, "IN_PROGRESS", { surface });
  }

  /** Stop working on an in-progress ticket without finishing it — IN_PROGRESS → TODO. */
  stopTicket(ticketKey: string, surface: TicketStatusSurface = "command-center") {
    if (ticketStatusOf(this.state.ticketWorkStates, ticketKey) !== "IN_PROGRESS") return;
    this.setTicketStatus(ticketKey, "TODO", { surface });
  }

  /** Defer — → DEFERRED until `until` (default: tomorrow), when it comes back to Today. */
  deferTicket(ticketKey: string, until?: string, reason?: string, surface: TicketStatusSurface = "command-center") {
    this.setTicketStatus(ticketKey, "DEFERRED", { surface, reason, until: until ?? addDays(getTodayIso(), 1) });
  }

  /** V2.26 — records a Daily Review visit. `at` is injectable for tests. A3 — no longer
   *  called by the page (visiting must not clear "New"); kept for compatibility. */
  markDailyReviewVisited(at: string = new Date().toISOString()) {
    this.set({ ...this.state, dailyReviewLastVisitAt: at });
  }

  /** A3 — the user explicitly acknowledged these Daily Review "New" rows (one row's "Seen",
   *  or "Mark all reviewed" with every listed key). Only ever moves an acknowledgment
   *  forward. `at` is injectable for tests. */
  markDailyReviewSeen(ticketKeys: string[], at: string = new Date().toISOString()) {
    if (ticketKeys.length === 0) return;
    const dailyReviewAcks = { ...this.state.dailyReviewAcks };
    for (const ticketKey of ticketKeys) {
      if (!dailyReviewAcks[ticketKey] || dailyReviewAcks[ticketKey].reviewedAt < at) dailyReviewAcks[ticketKey] = { ticketKey, reviewedAt: at };
    }
    this.set({ ...this.state, dailyReviewAcks });
  }

  /** V2.22 §3-4 — records one lightweight pilot-feedback entry (3 questions, 0-2 each, plus
   *  an optional note) alongside a deterministic snapshot of already-computed state, never a
   *  new instrumentation/analytics mechanism — the caller (CloseDayModal) is responsible for
   *  building `context` from engines it already has in scope. Bounded like every other
   *  history array in this store, oldest evicted first. */
  submitPilotFeedback(input: Omit<PilotFeedbackEntry, "id" | "submittedAt">) {
    const entry: PilotFeedbackEntry = { ...input, id: `pilot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, submittedAt: new Date().toISOString() };
    this.set({ ...this.state, pilotFeedback: [...this.state.pilotFeedback, entry].slice(-MAX_PILOT_FEEDBACK) });
  }

  setFilters(patch: Partial<GlobalFilters>) {
    this.set({ ...this.state, filters: { ...this.state.filters, ...patch } });
  }

  /** V2.25 Task 3 — Data & Settings' Stale Assigned Ticket thresholds control. Same clamp as
   *  asStaleAssignedTicketThresholds (parse-time): escalateBusinessDays is never allowed below
   *  warnBusinessDays, so a user can't accidentally configure ESCALATE to fire before WARN. */
  setStaleAssignedTicketThresholds(warnBusinessDays: number, escalateBusinessDays: number) {
    const safeWarn = Number.isFinite(warnBusinessDays) && warnBusinessDays > 0 ? Math.round(warnBusinessDays) : this.state.staleAssignedTicketThresholds.warnBusinessDays;
    const safeEscalateRaw = Number.isFinite(escalateBusinessDays) && escalateBusinessDays > 0 ? Math.round(escalateBusinessDays) : this.state.staleAssignedTicketThresholds.escalateBusinessDays;
    this.set({ ...this.state, staleAssignedTicketThresholds: { warnBusinessDays: safeWarn, escalateBusinessDays: Math.max(safeEscalateRaw, safeWarn) } });
  }

  /** B4 — Data & Settings: the sprint custom field id. Blank clears it; anything that is not
   *  Jira's `customfield_<digits>` form is refused (returns false) rather than stored. */
  setJiraSprintFieldId(id: string | undefined): boolean {
    const trimmed = id?.trim();
    if (trimmed && !/^customfield_\d{1,9}$/.test(trimmed)) return false;
    this.set({ ...this.state, jiraSprintFieldId: trimmed || undefined });
    return true;
  }

  /** V2.30 — Data & Settings feature switches. */
  setFeatureToggle(feature: keyof FeatureToggles, on: boolean) {
    if (!(feature in DEFAULT_FEATURE_TOGGLES)) return;
    this.set({ ...this.state, features: { ...this.state.features, [feature]: on } });
  }

  /** D4 — "Replied": the mention leaves "awaiting my reply". `at` injectable for tests. */
  markMentionReplied(commentId: string, issueKey: string, at: string = new Date().toISOString()) {
    this.set({ ...this.state, mentionReplies: { ...this.state.mentionReplies, [commentId]: { commentId, issueKey, repliedAt: at, source: "manual" } } });
  }

  /** D5 — remembers which ping dates were already sent, so each reminder goes out once. */
  recordFollowUpsNotified(sent: { ticketKey: string; pingOn: string }[]) {
    if (sent.length === 0) return;
    const followUpNotified = { ...this.state.followUpNotified };
    for (const s of sent) followUpNotified[s.ticketKey] = s.pingOn;
    this.set({ ...this.state, followUpNotified });
  }

  /** D1 — the one-click morning flow ran today. */
  recordMorningBriefRun(day: string) {
    this.set({ ...this.state, morningBriefLastRunDay: day });
  }

  /** C2 — Data & Settings: the page the app opens on. Unknown routes are refused. */
  setDefaultLandingPage(route: string) {
    if (!LANDING_PAGES.includes(route)) return;
    this.set({ ...this.state, defaultLandingPage: route === "/" ? undefined : route });
  }

  /** C2 — Daily Review over the same scoped data the page uses (badge counts, standup). */
  computeDailyReview(now: Date = new Date()): DailyReview {
    const data = applyProjectScope(this.state.data, this.state.jiraProjectScope);
    return buildDailyReview({
      workItems: data.workItems,
      identity: { displayName: this.state.personalIdentity?.displayName ?? this.state.ownerName, accountId: this.state.personalIdentity?.accountId },
      workRelevanceIndex: buildWorkRelevanceIndex(this.state.jiraWorkRelevancePolicy),
      ...selectDailyCommandMaps(this.state, toLocalIso(now)),
      memoryEvents: this.state.memoryEvents,
      mentionEvents: scopeMentionEvents(this.state.mentionEvents, data.workItems, this.state.jiraProjectScope),
      attentionState: this.state.attentionState,
      syncLog: this.state.syncLog,
      baselineAt: this.state.dailyReviewBaselineAt,
      lastVisitAt: this.state.dailyReviewLastVisitAt,
      reviewAcks: this.state.dailyReviewAcks,
      now,
    });
  }

  /** My Work over the same scoped data the page uses (no focus candidates — they only rank
   *  Today, never move a ticket between views). Its badge is unreviewed New + due re-checks. */
  computeMyWork(now: Date = new Date()): MyWork {
    const data = applyProjectScope(this.state.data, this.state.jiraProjectScope);
    return buildMyWork({
      workItems: data.workItems,
      identity: { displayName: this.state.personalIdentity?.displayName ?? this.state.ownerName, accountId: this.state.personalIdentity?.accountId },
      workRelevanceIndex: buildWorkRelevanceIndex(this.state.jiraWorkRelevancePolicy),
      ticketWorkStates: this.state.ticketWorkStates,
      today: toLocalIso(now),
      personalPlan: this.state.personalPlan,
      review: this.computeDailyReview(now),
    });
  }

  computeMyWorkBadge(now: Date = new Date()): number {
    return this.computeMyWork(now).badge;
  }

  /** B4 — Data & Settings: Mon–Fri weeks (default) or 7 calendar days. */
  setWeeklyReportMode(mode: "workweek" | "calendar") {
    this.set({ ...this.state, weeklyReportMode: mode });
  }

  /** V2.11 §3B — the ONLY place the advanced-settings visibility toggle is ever set. Purely
   *  a UI display preference (never deletes or gates any underlying computation). */
  setShowAdvancedSettings(value: boolean) {
    this.set({ ...this.state, showAdvancedSettings: value });
  }

  /** V2.14 §4 — the ONLY place the "My action items only" toggle is ever set. Purely a UI
   *  display preference (never gates any underlying computation), independently persisted
   *  per page — same pattern as setShowAdvancedSettings() above. */
  setMyActionItemsOnly(page: keyof MyActionItemsOnlyByPage, value: boolean) {
    this.set({ ...this.state, myActionItemsOnly: { ...this.state.myActionItemsOnly, [page]: value } });
  }

  // ===== V2.15 — Cross-Device Sync =====
  // The actual network/merge logic lives in app-state-sync.ts (a client module, kept out of
  // this file the same way jira-source.ts/notify-client.ts keep fetch/network logic out of
  // it); the store only ever exposes a plain, side-effect-free way to (a) apply an
  // already-decided synced-state blob onto local state and (b) record the bookkeeping
  // timestamp that decision-making reads on the next load. Neither method here ever performs
  // a network call itself.

  /** Applies a synced-state blob (already decided/merged by app-state-sync.ts) onto local
   *  state. Touches ONLY the seven synced fields (see the V2.15 dev prompt's scope decision)
   *  — never `data.workItems`/`jiraSync`/`snapshotHistory`/etc, which stay purely local and
   *  re-derived from Jira on every device independently. `ownerName` is kept in sync with
   *  `personalIdentity.displayName` via the same rule setPersonalIdentity() already enforces,
   *  rather than being set independently and risking the two diverging. */
  applySyncedAppState(synced: SyncedAppState) {
    this.set({
      ...this.state,
      personalIdentity: synced.personalIdentity,
      ownerName: synced.personalIdentity?.displayName,
      jiraWorkRelevancePolicy: synced.jiraWorkRelevancePolicy,
      attentionState: synced.attentionState,
      data: { ...this.state.data, decisions: synced.decisions, actions: synced.actionPlanState.actions },
      personalPlan: synced.actionPlanState.personalPlan,
      memoryEvents: synced.memoryEvents.slice(-MAX_MEMORY_EVENTS),
      dailyReports: synced.dailyReports,
      // A1 — every execution-state field is optional on a synced blob (pre-A1 writers never
      // sent them): absent means "keep local", never "clear". The synced ticketWorkStates (or,
      // from a pre-TicketWorkState writer, its legacy maps) are folded into the canonical
      // state and the deprecated maps re-derived from it.
      ...ticketStateFromLegacy(
        synced.ticketWorkStates ? asTicketWorkStates(synced.ticketWorkStates) : this.state.ticketWorkStates,
        {
          dailyCommandCompletions: synced.dailyCommandCompletions ?? {},
          dailyCommandSkips: synced.dailyCommandSkips ?? {},
          dailyCommandBlocks: synced.dailyCommandBlocks ?? {},
          dailyCommandTombstones: synced.dailyCommandTombstones ?? this.state.dailyCommandTombstones,
        },
        synced.actionPlanState.personalPlan,
        undefined
      ),
      syncLog: synced.syncLog ?? this.state.syncLog,
      dailyReviewLastVisitAt: synced.dailyReviewLastVisitAt ?? this.state.dailyReviewLastVisitAt,
      dailyReviewAcks: synced.dailyReviewAcks ?? this.state.dailyReviewAcks,
      dailyReviewBaselineAt: synced.dailyReviewBaselineAt ?? this.state.dailyReviewBaselineAt,
      mentionReplies: synced.mentionReplies ? asMentionReplies(synced.mentionReplies) : this.state.mentionReplies,
      showAdvancedSettings: synced.uiPreferences.showAdvancedSettings,
      myActionItemsOnly: synced.uiPreferences.myActionItemsOnly,
      jiraProjectScope: synced.uiPreferences.jiraProjectScope,
      lastAppStateSyncIso: synced.updatedAtIso,
    });
  }

  /** Records that this device's local synced slice is now known to match the server as of
   *  `iso` (either just pulled from it, or just pushed to it) — the comparison basis for
   *  app-state-sync.ts's decideInitialSync on the next load. Never touches any other field. */
  setLastAppStateSyncIso(iso: string) {
    this.set({ ...this.state, lastAppStateSyncIso: iso });
  }

  /** V2.3 §3-4, §32 — the ONLY place Focus Project Scope is ever set. Always explicit and
   *  user-driven (no inference from owner/assignee/recent activity/labels — §32); switching
   *  ALL -> FOCUSED or narrowing an existing focused set never deletes any already-synced
   *  data (§10) — it only changes what the derived view (use-command-center.ts) shows.
   *  `projectKeys` is de-duplicated defensively even though the UI never produces
   *  duplicates itself. */
  setJiraProjectScope(mode: JiraProjectScope["mode"], projectKeys?: string[]) {
    const nextKeys = projectKeys ? Array.from(new Set(projectKeys.filter((k) => k.trim().length > 0))) : this.state.jiraProjectScope.projectKeys;
    this.set({
      ...this.state,
      jiraProjectScope: { mode, projectKeys: mode === "FOCUSED" ? nextKeys : this.state.jiraProjectScope.projectKeys, updatedAt: new Date().toISOString() },
    });
  }

  /** V2.5 — the ONLY place a Jira status classification is ever set. Always explicit and
   *  user-driven (no automatic status classification, no AI — see jira/work-relevance.ts).
   *  A configuration change, not a delivery event — deliberately does not emit a memory
   *  event (§23 "a status classification change is configuration, not a delivery event").
   *  V2.11 §1 — global: no projectKey parameter, since a classification now applies to
   *  every project at once. */
  setJiraStatusRelevance(status: string, relevance: WorkRelevance) {
    if (!status.trim()) return;
    this.set({ ...this.state, jiraWorkRelevancePolicy: withStatusRelevance(this.state.jiraWorkRelevancePolicy, status, relevance) });
  }

  /** V2.11 §1 — dismisses the one-time "policy was consolidated from N per-project
   *  settings" notice shown after migrating a pre-V2.11 per-project policy map. */
  dismissWorkRelevancePolicyMigrationNotice() {
    if (!this.state.workRelevancePolicyMigrationNotice) return;
    this.set({ ...this.state, workRelevancePolicyMigrationNotice: undefined });
  }

  /**
   * V1.3 §10-12 — manual Jira sync. Incremental by default (uses the last successful sync
   * timestamp as the JQL `updated >=` bound); pass `full: true` to re-pull everything.
   * On failure, the existing dataset is never touched — only jiraSync bookkeeping changes
   * (§12 "the user must never lose existing Command Center data because Jira became
   * temporarily unavailable").
   *
   * Mutually exclusive: at most one sync runs at a time, in this tab (auto-sync tick, header
   * button, Data & Settings button all funnel through here) and — via the Web Locks API —
   * across tabs of the same origin. A call made while another sync holds the lock is refused
   * with errorKind "sync-in-progress" and changes no state at all; it is never queued and
   * never allowed to run its own merge, which is what previously let the slower of two
   * overlapping syncs overwrite the faster one's commit. See sync-lock.ts.
   */
  async syncJira(options?: { full?: boolean; trigger?: JiraSyncTrigger }): Promise<JiraSyncResult> {
    // In-tab guard first, synchronously, before any await — two calls in the same tick can
    // never both get past this line.
    if (this.jiraSyncActivity.inProgress) return { ok: false, error: "Sync already in progress.", errorKind: "sync-in-progress" };
    this.setJiraSyncActivity({ inProgress: true, trigger: options?.trigger });
    try {
      // An undefined lock manager falls through to withJiraSyncLock's navigator.locks default.
      const outcome = await withJiraSyncLock(() => this.runJiraSync(options), this.deps.jiraSyncLockManager);
      if (outcome === LOCK_UNAVAILABLE) return { ok: false, error: "Sync already in progress (started in another tab).", errorKind: "sync-in-progress" };
      return outcome;
    } finally {
      this.setJiraSyncActivity(IDLE_JIRA_SYNC_ACTIVITY);
    }
  }

  private async runJiraSync(options?: { full?: boolean }): Promise<JiraSyncResult> {
    const startedAt = new Date().toISOString();
    this.set({ ...this.state, jiraSync: { ...this.state.jiraSync, lastSyncStartedAt: startedAt } });

    const scope = this.state.jiraProjectScope;

    // V2.3 §23 — a FOCUSED scope with nothing selected must never silently become ALL. This
    // is refused here, before any network call, so it can never even accidentally send an
    // unbounded query — and the sync route (§7) refuses it too as defense in depth.
    if (scope.mode === "FOCUSED" && scope.projectKeys.length === 0) {
      const error = "No Focus Projects selected. Select at least one project in Data & Settings before syncing.";
      this.set({
        ...this.state,
        jiraSync: {
          ...this.state.jiraSync,
          lastSyncStartedAt: startedAt,
          lastSyncStatus: "failed",
          lastSyncError: error,
          lastSyncErrorKind: "not-configured",
          previousDataPreserved: true,
          scopeMode: scope.mode,
          focusedProjectCount: 0,
          focusedProjects: [],
        },
      });
      return { ok: false, error, errorKind: "not-configured" };
    }

    // V1.7 §10 — the raw ISO datetime is sent as-is; the server route (which alone knows
    // any configured JIRA_TIMEZONE_OFFSET_MINUTES) is responsible for turning it into the
    // actual JQL cursor via buildIncrementalSinceParam. See jira/http.ts for the safety
    // reasoning (never lossy — `>=` plus a buffer, falls back to day-level precision when
    // no timezone is configured).
    const sinceIso =
      !options?.full && this.state.dataSource === "jira" && this.state.jiraSync.lastSyncCompletedAt ? this.state.jiraSync.lastSyncCompletedAt : undefined;

    // V2.10 §2 — mention tracking is opt-in: only sent when the user has configured an
    // accountId in Data & Settings (see setPersonalIdentity). Absent means the server route
    // simply skips the mention search entirely — no behavior change for installations that
    // never set one.
    let result: DataSourceSyncResult;
    try {
      result = await (this.deps.createJiraDataSource?.() ?? new JiraDataSource()).sync({
        sinceIso,
        scopeMode: scope.mode,
        projectKeys: scope.mode === "FOCUSED" ? scope.projectKeys : undefined,
        accountId: this.state.personalIdentity?.accountId,
        ...(this.state.jiraSprintFieldId ? { sprintFieldId: this.state.jiraSprintFieldId } : {}),
      });
    } catch (err) {
      // JiraDataSource already converts its own failures into { ok: false }, but a rejected
      // sync() must still land in the failure branch below (recorded, data preserved) rather
      // than escaping past the bookkeeping.
      result = { ok: false, error: err instanceof Error ? err.message : "Jira sync failed.", errorKind: "network-error" };
    }

    if (!result.ok || !result.data) {
      this.set({
        ...this.state,
        jiraSync: {
          ...this.state.jiraSync,
          lastSyncStartedAt: startedAt,
          lastSyncStatus: "failed",
          lastSyncError: result.error,
          lastSyncErrorKind: result.errorKind,
          previousDataPreserved: true,
          scopeMode: scope.mode,
          focusedProjectCount: scope.mode === "FOCUSED" ? scope.projectKeys.length : undefined,
          focusedProjects: scope.mode === "FOCUSED" ? scope.projectKeys : undefined,
        },
      });
      return { ok: false, error: result.error, errorKind: result.errorKind };
    }

    const incoming = result.data;
    // V2.18 §5 — a sync that hit the JIRA_MAX_ISSUES safety cap before reaching the real end
    // of matching issues is "partial", not "success": it must never destructively replace an
    // existing complete local dataset (see the isFullSync gating below), and its incremental
    // cursor must resume from where it stopped, not silently skip past whatever it didn't
    // fetch (see lastSyncCompletedAt below).
    const truncated = result.truncated === true;
    const prevWorkItemsById = new Map(this.state.data.workItems.map((w) => [w.id, w]));
    // Sync provenance: an item new to the local store gets firstSeenAt stamped exactly once,
    // here; an existing item carries its previous firstSeenAt forward (the incoming payload
    // never has one), so no later sync can overwrite it. Stamping happens BEFORE the
    // created/updated diff so a carried-forward field never makes an unchanged item look
    // "updated". Pre-existing items without firstSeenAt stay undefined — never back-filled
    // with a guess.
    const observedAt = new Date().toISOString();
    // A3 — a ticket absent from the local store but already KNOWN (it left the synced dataset
    // and came back, e.g. a project dropped from and re-added to Focus scope) keeps its
    // original firstSeenAt instead of being re-stamped as new. Seeded from the current work
    // items too, so installs from before knownTicketFirstSeen existed are covered from their
    // first sync on ("" = provenance predates firstSeenAt → stays undefined, never "new").
    const knownFirstSeen: Record<string, string> = { ...this.state.knownTicketFirstSeen };
    for (const w of this.state.data.workItems) if (!(w.key in knownFirstSeen)) knownFirstSeen[w.key] = w.firstSeenAt ?? "";
    // A3 — "assigned to you" since the last sync: assignment-detection.ts's ownerId diff,
    // applied only to tickets already in the store (a brand-new ticket is a "New ticket").
    const myAccountId = this.state.personalIdentity?.accountId;
    const reassignedToMe = new Set(
      detectNewAssignments(
        { ...emptyData(), workItems: incoming.workItems.filter((w) => prevWorkItemsById.has(w.id)) },
        { date: getTodayIso(), workItems: this.state.data.workItems, risks: [], requirements: [], dependencies: [], projects: [] },
        myAccountId
      ).map((e) => e.workItemId)
    );
    const incomingWorkItems: WorkItem[] = incoming.workItems.map((w) => {
      const prev = prevWorkItemsById.get(w.id);
      if (!prev) {
        const known = knownFirstSeen[w.key];
        if (known === undefined) return { ...w, firstSeenAt: observedAt };
        return known ? { ...w, firstSeenAt: known } : w;
      }
      const withFirstSeen = prev.firstSeenAt ? { ...w, firstSeenAt: prev.firstSeenAt } : w;
      if (reassignedToMe.has(w.id)) return { ...withFirstSeen, assignedToMeAt: observedAt };
      return prev.assignedToMeAt && myAccountId && w.ownerId === myAccountId ? { ...withFirstSeen, assignedToMeAt: prev.assignedToMeAt } : withFirstSeen;
    });
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const newTicketKeys: string[] = [];
    for (const w of incomingWorkItems) {
      const prev = prevWorkItemsById.get(w.id);
      if (!prev) {
        created++;
        if (!(w.key in knownFirstSeen)) newTicketKeys.push(w.key);
      } else if (JSON.stringify(prev) !== JSON.stringify(w)) updated++;
      else unchanged++;
    }
    for (const w of incomingWorkItems) if (!(w.key in knownFirstSeen)) knownFirstSeen[w.key] = w.firstSeenAt ?? "";
    // A3 — pin the Daily Review baseline once, at the first sync that HAS a previous one: the
    // legacy last visit if there was one, else that previous sync — exactly the cutoff the
    // pre-A3 page used, but frozen, so neither a refresh nor later syncs move it.
    const lastSyncEntry = this.state.syncLog[this.state.syncLog.length - 1];
    const dailyReviewBaselineAt = this.state.dailyReviewBaselineAt ?? (lastSyncEntry ? (this.state.dailyReviewLastVisitAt ?? lastSyncEntry.completedAt) : undefined);

    // V2.18 §7 — same deduped manual+auto risk set every other snapshot-producing call site
    // now persists (see importData/closeDay's own comments) — closes the confirmed gap where
    // auto-detected risks were never in snapshotHistory at all, so risk-escalation.ts's
    // day-over-day "worsening/days open" logic could never find history to match against.
    const prevSnapshot = this.state.loaded
      ? toSnapshot(this.state.data, getTodayIso(), dedupeRisks(this.state.data.risks, detectRisks(this.state.data, getTodayIso())))
      : null;
    const isFullSync = sinceIso === undefined;

    // V2.3 §10 — a full re-sync's pre-existing "drop all old Jira data, replace with the
    // fresh fetch" semantics is safe in ALL mode (the fresh fetch covers everything, so
    // nothing legitimate is lost) but would newly become destructive in FOCUSED mode, since
    // the fetch itself is now scope-restricted: replacing ALL old Jira data with only the
    // focused subset would silently erase every out-of-scope project's data. Scope must only
    // ever control what's operated on, never trigger deletion (§10) — so in FOCUSED mode,
    // only records belonging to a CURRENTLY-focused project are replaced; anything from a
    // project outside the current scope is left exactly as it was, never touched by this
    // sync (it simply stays out of the scoped view — see jira/project-scope.ts).
    const focusedProjectIds = scope.mode === "FOCUSED" ? new Set(scope.projectKeys.map((k) => `jira-project-${k}`)) : null;
    const staysUntouched = (projectId: string) => focusedProjectIds !== null && !focusedProjectIds.has(projectId);

    // V2.18 §5 — a truncated full sync must never destructively replace the existing complete
    // local dataset with only the (incomplete) subset it managed to fetch before hitting the
    // cap — it now behaves like an incremental merge instead, exactly the same non-destructive
    // treatment FOCUSED mode already gets for dependencies below. Nothing already-synced is
    // ever dropped by a partial sync; the next sync's resumed cursor (see lastSyncCompletedAt
    // below) fills in the rest.
    const replaceFullDataset = isFullSync && !truncated;
    const merged: CommandCenterData = {
      clients: mergeById(this.state.data.clients, incoming.clients),
      projects: replaceFullDataset
        ? [...this.state.data.projects.filter((p) => p.sourceType !== "jira" || staysUntouched(p.id)), ...incoming.projects]
        : mergeById(this.state.data.projects, incoming.projects),
      workItems: replaceFullDataset
        ? [...this.state.data.workItems.filter((w) => w.sourceType !== "jira" || staysUntouched(w.projectId)), ...incomingWorkItems]
        : mergeById(this.state.data.workItems, incomingWorkItems),
      requirements: this.state.data.requirements, // Jira does not feed requirements (§6 — only ingest fields required for intelligence)
      risks: this.state.data.risks, // manually-logged risks are preserved; auto-detected risks recompute live from the merged work items
      // Dependencies are keyed by workItemId, not projectId, so a per-project untouched-set
      // can't be applied as precisely as above without guessing at the Jira key embedded in
      // an issue key. In FOCUSED mode this simply never bulk-drops (merge-only, same as
      // incremental sync) — the one accepted, documented, non-destructive trade-off: a
      // dependency Jira has since resolved for an IN-scope project may not get cleaned up
      // until scope returns to ALL, but nothing is ever silently deleted.
      dependencies:
        replaceFullDataset && scope.mode !== "FOCUSED"
          ? [...this.state.data.dependencies.filter((d) => !d.id.startsWith("jira-dep-")), ...incoming.dependencies]
          : mergeById(this.state.data.dependencies, incoming.dependencies),
      decisions: this.state.data.decisions,
      actions: this.state.data.actions,
      communications: this.state.data.communications,
    };

    const newMemoryEvents = prevSnapshot ? this.computeMemoryEvents(merged, this.state.snapshotHistory, getTodayIso()) : [];

    // V2.25 Task 2 — Jira-side completions (a Dev/QA closing a ticket directly in Jira, not
    // any in-app action) are diffed the same way detectNewAssignments already diffs ownerId,
    // and turned into their own memoryEvent kind so Daily/Weekly Report stops silently missing
    // real completed work just because nobody clicked anything in this app. See
    // jira-completion-detection.ts for why isWorkItemDoneOrExcluded (not the broader
    // isWorkItemOperationallyOpen) is the right gate here.
    // B2 — only Done / COMPLETED counts; a move into EXCLUDED is its own "removed from scope"
    // event. Dated by Jira's resolutiondate when present (a Saturday close synced on Monday is
    // Saturday's), otherwise by this sync's day, marked as "detected".
    const syncIndex = buildWorkRelevanceIndex(this.state.jiraWorkRelevancePolicy);
    const detectedOn = getTodayIso();
    const jiraEvent = (c: JiraStatusCompletionEvent, kind: "JIRA_STATUS_COMPLETED" | "JIRA_REMOVED_FROM_SCOPE"): MemoryEvent => {
      const project = merged.projects.find((p) => p.id === c.projectId);
      const client = project ? merged.clients.find((cl) => cl.id === project.clientId) : undefined;
      const resolvedDay = c.resolvedAt && !Number.isNaN(new Date(c.resolvedAt).getTime()) ? toLocalIso(new Date(c.resolvedAt)) : undefined;
      return {
        id: `memory-event-${kind}-${c.workItemId}-${Date.now()}`,
        date: resolvedDay ?? detectedOn,
        kind,
        title: kind === "JIRA_STATUS_COMPLETED" ? `Completed in Jira: ${c.title}` : `Removed from scope: ${c.title}`,
        impact: kind === "JIRA_STATUS_COMPLETED" ? "Detected via Jira sync — no in-app action was taken." : "Moved to a status your Work Relevance Policy excludes — not counted as completed.",
        evidence: [],
        projectId: c.projectId,
        ticketKey: c.issueKey,
        ticketTitle: c.title,
        ...(c.url ? { ticketUrl: c.url } : {}),
        projectName: project?.name,
        clientName: client?.name,
        ...(c.assigneeId ? { assigneeId: c.assigneeId } : {}),
        ...(c.assigneeName ? { assigneeName: c.assigneeName } : {}),
        ...(merged.workItems.find((w) => w.id === c.workItemId)?.sprint ? { sprint: merged.workItems.find((w) => w.id === c.workItemId)!.sprint } : {}),
        datedBy: resolvedDay ? "resolution" : "detection",
        detectedOn,
      };
    };
    const jiraCompletionEvents: MemoryEvent[] = prevSnapshot
      ? [
          ...detectJiraStatusCompletions(merged, prevSnapshot, syncIndex).map((c) => jiraEvent(c, "JIRA_STATUS_COMPLETED")),
          ...detectJiraScopeRemovals(merged, prevSnapshot, syncIndex).map((c) => jiraEvent(c, "JIRA_REMOVED_FROM_SCOPE")),
        ]
      : [];

    // V2.10 §2, revised V2.17 §1a — mentionEvents are cumulative across syncs (like
    // workItems/dependencies above), now keyed by COMMENT id, not issue key: each incremental
    // sync's mention search only covers issues updated since the last sync, so a mention seen
    // on an earlier sync must persist here until its own attention item is acknowledged/
    // resolved by the user — it is never silently dropped just because a later sync's
    // narrower JQL window didn't re-fetch it. Keying by commentId (rather than the old
    // issue-level key) means a second, genuinely different comment on the same issue is
    // tracked as its own entry instead of overwriting the first — see MentionEvent.commentId's
    // own comment for the bug this fixes. Absent from `result` entirely (no accountId
    // configured, or the best-effort fetch failed) leaves the existing list untouched.
    const mergedMentionEvents =
      result.mentionEvents === undefined
        ? this.state.mentionEvents
        : (() => {
            const byCommentId = new Map(this.state.mentionEvents.map((m) => [m.commentId, m]));
            for (const m of result.mentionEvents!) byCommentId.set(m.commentId, m);
            return capMentionEvents(Array.from(byCommentId.values()), this.state.attentionState, MAX_MENTION_EVENTS);
          })();

    // V2.12 — first-observed timestamps for the Policy Review / Execution Gap signals
    // (jira/work-relevance-signals.ts). Additive-only, updated once per real Jira sync —
    // never touched by demo data, local-import, or any other mutation path.
    const workItemCalibrationHistory = updateWorkItemCalibrationHistory(this.state.workItemCalibrationHistory, merged, buildWorkRelevanceIndex(this.state.jiraWorkRelevancePolicy), getTodayIso());

    // A4 — a skipped/blocked ticket Jira has since closed (Done / COMPLETED) leaves the
    // Skipped/Blocked lists on its own and lands in Completed history, source "jira", keeping
    // the skip/block it replaced. Never the reverse: a Jira reopen does not un-complete it.
    const jiraClosed = closePausedTicketsFinishedInJira(this.state.ticketWorkStates, merged.workItems, buildWorkRelevanceIndex(this.state.jiraWorkRelevancePolicy), observedAt, getTodayIso());

    this.set({
      ...this.state,
      ...(jiraClosed.closedKeys.length > 0
        ? { ticketWorkStates: jiraClosed.states, ...deriveLegacyDailyCommandState(jiraClosed.states, observedAt, this.state.dailyCommandTombstones) }
        : {}),
      data: merged,
      dataSource: "jira",
      loaded: true,
      isDemo: false,
      snapshotHistory: prevSnapshot ? [...this.state.snapshotHistory, prevSnapshot].slice(-MAX_SNAPSHOT_HISTORY) : this.state.snapshotHistory,
      memoryEvents:
        newMemoryEvents.length > 0 || jiraCompletionEvents.length > 0
          ? [...this.state.memoryEvents, ...newMemoryEvents, ...jiraCompletionEvents].slice(-MAX_MEMORY_EVENTS)
          : this.state.memoryEvents,
      mentionEvents: mergedMentionEvents,
      workItemCalibrationHistory,
      syncLog: [...this.state.syncLog, { startedAt, completedAt: observedAt, recordsCreated: created, recordsUpdated: updated, newTicketKeys }].slice(-MAX_SYNC_LOG),
      knownTicketFirstSeen: capKnownTickets(knownFirstSeen),
      dailyReviewBaselineAt,
      myTicketActivity: mergeMyTicketActivity(this.state.myTicketActivity, result.myActivity),
      dailySyncSummary: this.state.features.syncHistory
        ? rollDailySyncSummary(this.state.dailySyncSummary, getTodayIso(), {
            at: observedAt,
            newTickets: newTicketKeys.length,
            assignedToMe: reassignedToMe.size,
            closed: jiraCompletionEvents.filter((e) => e.kind === "JIRA_STATUS_COMPLETED").length,
          })
        : this.state.dailySyncSummary,
      jiraSync: {
        lastSyncStartedAt: startedAt,
        // V2.18 §5 — on a partial sync, the incremental cursor advances only to the resume
        // boundary (the last-fetched issue's `updated`), never to "now" — so the NEXT sync's
        // `sinceIso` (read at the top of this method) naturally re-requests exactly the
        // window this sync didn't finish, through the existing incremental-sync path. If no
        // resume boundary was resolvable (e.g. every fetched issue was missing `updated`),
        // the cursor is left exactly where it was rather than guessing — never advanced past
        // data that was never actually fetched.
        lastSyncCompletedAt: truncated ? (result.resumeSinceIso ?? this.state.jiraSync.lastSyncCompletedAt) : (result.syncedAt ?? new Date().toISOString()),
        lastSyncStatus: truncated ? "partial" : "success",
        lastSyncError: undefined,
        lastSyncErrorKind: undefined,
        recordsFetched: result.recordsFetched,
        recordsCreated: created,
        recordsUpdated: updated,
        recordsUnchanged: unchanged,
        durationMs: result.durationMs,
        scopeChangesDetected: result.scopeChangesDetected,
        projectsDiscovered: result.projectsDiscovered,
        warnings: result.warnings,
        pages: result.pages,
        changelogRequests: result.changelogRequests,
        previousDataPreserved: false,
        scopeMode: scope.mode,
        focusedProjectCount: scope.mode === "FOCUSED" ? scope.projectKeys.length : undefined,
        focusedProjects: scope.mode === "FOCUSED" ? scope.projectKeys : undefined,
      },
    });

    // V2.25 Task 2 — a Daily Report must exist without requiring the user to ever open Close
    // Day (see auto-daily-report.ts's own top comment for the two-trigger design). This is the
    // "on sync" trigger, and deliberately unconditional (force:true on every successful sync,
    // not just when the day has rolled over): `this.state` already reflects the `this.set()`
    // just above (synchronous — see this file's own `set()`), so generateDailyReport reads
    // memoryEvents that already include this sync's own newMemoryEvents/jiraCompletionEvents.
    // Gating this by day-change too would defeat the actual point for the common case — a
    // user who syncs several times in one workday — since a Jira-detected completion from the
    // 2nd/3rd sync of the day would never make it into an already-generated today's report
    // until the user happened to open Close Day again. generateDailyReport's own cost is a
    // cheap filter over memoryEvents, so regenerating on every sync is not wasteful.
    this.generateDailyReport(getTodayIso(), true);
    // B2 — a Jira completion dated by its resolution day belongs in THAT day's report too.
    for (const day of Array.from(new Set(jiraCompletionEvents.map((e) => e.date)))) if (day !== getTodayIso()) this.generateDailyReport(day, true);
    return { ok: true };
  }

  /** V1.3 §31 "Disconnect / Clear Server Configuration". This only clears this session's
   *  local sync bookkeeping and stops treating the data source as actively Jira-synced —
   *  it cannot and does not touch server-side env configuration, and it does NOT delete
   *  the already-synced data (§12 sync-safety philosophy applies here too). */
  disconnectJira() {
    this.set({ ...this.state, dataSource: this.state.data.workItems.length > 0 ? "local-import" : "demo", jiraSync: initialJiraSync() });
  }

  private updateAction(id: string, patch: Partial<Action>) {
    const actions = this.state.data.actions.map((a) => (a.id === id ? { ...a, ...patch } : a));
    this.set({ ...this.state, data: { ...this.state.data, actions } });
  }

  /** V2.4 §14 — an Action's project association, ONLY when it can be traced through the
   *  explicit `relatedWorkItemId` foreign key it already carries; undefined (never guessed)
   *  when the action has no linked work item. Used to tag ACTION_* memory events below. */
  private projectIdForAction(action: Action | undefined): string | undefined {
    if (!action?.relatedWorkItemId) return undefined;
    return this.state.data.workItems.find((w) => w.id === action.relatedWorkItemId)?.projectId;
  }

  /** V2.17 Task 2 — a Decision's point-in-time report context: projectName/clientName from
   *  its own explicit projectId/clientId fields, and ticketKey ONLY when exactly one work
   *  item is related (a decision touching several tickets never picks one arbitrarily and
   *  presents it as THE ticket — same discipline as personal-focus.ts's singleWorkItem). */
  private reportContextForDecision(projectId: string | undefined, clientId: string | undefined, relatedWorkItemIds: string[] | undefined): { ticketKey?: string; projectName?: string; clientName?: string } {
    const singleWorkItemId = relatedWorkItemIds?.length === 1 ? relatedWorkItemIds[0] : undefined;
    return {
      ticketKey: singleWorkItemId ? this.state.data.workItems.find((w) => w.id === singleWorkItemId)?.key : undefined,
      projectName: projectId ? this.state.data.projects.find((p) => p.id === projectId)?.name : undefined,
      clientName: clientId ? this.state.data.clients.find((c) => c.id === clientId)?.name : undefined,
    };
  }

  /** V2.17 Task 2 — the same explicit `relatedWorkItemId` FK as projectIdForAction above, but
   *  resolving the full point-in-time context (ticket key, project/client NAME, not just the
   *  internal projectId) so it can be captured directly on the memory event at write time —
   *  see MemoryEvent.ticketKey's own comment for why this must never be resolved later from
   *  live state instead. */
  private reportContextForWorkItem(workItemId: string | undefined): { ticketKey?: string; projectName?: string; clientName?: string } {
    const workItem = workItemId ? this.state.data.workItems.find((w) => w.id === workItemId) : undefined;
    if (!workItem) return {};
    return {
      ticketKey: workItem.key,
      projectName: this.state.data.projects.find((p) => p.id === workItem.projectId)?.name,
      clientName: this.state.data.clients.find((c) => c.id === workItem.clientId)?.name,
    };
  }

  completeAction(id: string) {
    this.updateAction(id, { status: "completed", completedAt: getTodayIso() });
    const action = this.state.data.actions.find((a) => a.id === id);
    this.appendMemoryEvent({
      kind: "ACTION_COMPLETED",
      title: `Action completed: ${action?.title ?? id}`,
      impact: "Awaiting outcome confirmation.",
      evidence: [],
      projectId: this.projectIdForAction(action),
      ...this.reportContextForWorkItem(action?.relatedWorkItemId),
    });
    this.bumpUsage(USAGE_KEYS.ACTION_COMPLETED);
  }
  deferAction(id: string) {
    this.updateAction(id, { status: "deferred" });
  }
  snoozeAction(id: string, untilIso?: string) {
    this.updateAction(id, { status: "snoozed", snoozedUntil: untilIso });
  }
  markActionBlocked(id: string) {
    this.updateAction(id, { status: "blocked" });
  }
  reopenAction(id: string) {
    this.updateAction(id, { status: "open" });
  }
  addNoteToAction(id: string, note: string) {
    this.updateAction(id, { note });
  }
  /** V1.2 §9 — optionally record what happened when an action is completed. */
  recordActionOutcome(id: string, outcome: string) {
    const action = this.state.data.actions.find((a) => a.id === id);
    this.updateAction(id, { outcome, status: "completed", completedAt: action?.completedAt ?? getTodayIso() });
  }

  /** V1.5 §17 — explicit "started" transition, distinct from "open", so a delivery loop
   *  can observe when work on an action actually began. */
  startAction(id: string) {
    this.updateAction(id, { status: "in-progress" });
    const action = this.state.data.actions.find((a) => a.id === id);
    this.appendMemoryEvent({
      kind: "ACTION_STARTED",
      title: `Action started: ${action?.title ?? id}`,
      impact: "Work has begun on this action.",
      evidence: [],
      projectId: this.projectIdForAction(action),
      ...this.reportContextForWorkItem(action?.relatedWorkItemId),
    });
  }

  /** V1.5 §18-19 — "Did It Work?" outcome capture. This is the ground truth that
   *  action-effectiveness.ts prefers over its blocked/done heuristic. */
  recordActionOutcomeStatus(id: string, outcomeStatus: ActionOutcomeStatus, note?: string) {
    const action = this.state.data.actions.find((a) => a.id === id);
    this.updateAction(id, { outcomeStatus, outcomeDate: getTodayIso(), ...(note ? { outcome: note } : {}) });
    this.appendMemoryEvent({
      kind: "ACTION_OUTCOME",
      title: `Action outcome recorded: ${action?.title ?? id} — ${outcomeStatus}`,
      impact: note ?? `Classified ${outcomeStatus}.`,
      evidence: note ? [note] : [],
      projectId: this.projectIdForAction(action),
      outcomeNote: note,
      ...this.reportContextForWorkItem(action?.relatedWorkItemId),
    });
    this.bumpUsage(USAGE_KEYS.OUTCOME_CAPTURED);
  }

  addAction(action: Omit<Action, "id" | "createdAt" | "status">) {
    const newAction: Action = { ...action, id: `action-${Date.now()}`, createdAt: getTodayIso(), status: "open" };
    this.set({ ...this.state, data: { ...this.state.data, actions: [...this.state.data.actions, newAction] } });
    return newAction.id;
  }

  updateCommunication(id: string, patch: Partial<Communication>) {
    const communications = this.state.data.communications.map((c) => (c.id === id ? { ...c, ...patch } : c));
    this.set({ ...this.state, data: { ...this.state.data, communications } });
  }

  /** V1.2 §6-7 — Decision Memory: patch any decision (status, context, evidenceIds, etc). */
  updateDecision(id: string, patch: Partial<Decision>) {
    const decisions = this.state.data.decisions.map((d) => (d.id === id ? { ...d, ...patch } : d));
    this.set({ ...this.state, data: { ...this.state.data, decisions } });
  }

  addDecision(decision: Omit<Decision, "id">) {
    const newDecision: Decision = { ...decision, id: `decision-${Date.now()}` };
    this.set({ ...this.state, data: { ...this.state.data, decisions: [...this.state.data.decisions, newDecision] } });
    return newDecision.id;
  }

  /** V1.5 §11 — persists a decision only after explicit human confirmation from the
   *  "What Should I Do?" flow. Never called automatically. Updates an existing decision
   *  (e.g. one already flagged by Decision Radar) when `existingDecisionId` is given,
   *  otherwise creates a new one. */
  confirmDecisionFromOptions(input: {
    existingDecisionId?: string;
    projectId: string;
    clientId?: string;
    title: string;
    context?: string;
    options: DecisionOption[];
    selectedOptionId: string;
    expectedOutcome: string;
    relatedWorkItemIds?: string[];
    relatedRiskIds?: string[];
    relatedDependencyIds?: string[];
    evidenceIds?: string[];
  }): string {
    const selected = input.options.find((o) => o.id === input.selectedOptionId);
    const patch: Partial<Decision> & Pick<Decision, "title" | "status" | "description" | "projectId"> = {
      projectId: input.projectId,
      clientId: input.clientId,
      title: input.title,
      status: "DECIDED",
      description: selected?.rationale ?? input.title,
      date: getTodayIso(),
      context: input.context,
      decision: selected?.label,
      options: input.options,
      selectedOption: selected?.label,
      expectedOutcome: input.expectedOutcome,
      relatedWorkItemIds: input.relatedWorkItemIds,
      relatedRiskIds: input.relatedRiskIds,
      relatedDependencyIds: input.relatedDependencyIds,
      evidenceIds: input.evidenceIds,
    };

    let id: string;
    if (input.existingDecisionId && this.state.data.decisions.some((d) => d.id === input.existingDecisionId)) {
      id = input.existingDecisionId;
      this.updateDecision(id, patch);
    } else {
      id = this.addDecision(patch as Omit<Decision, "id">);
    }

    this.appendMemoryEvent({
      kind: "DECISION_MADE",
      title: `Decision made: ${input.title}`,
      impact: input.expectedOutcome,
      evidence: selected?.evidence ?? [],
      projectId: input.projectId,
      ...this.reportContextForDecision(input.projectId, input.clientId, input.relatedWorkItemIds),
    });
    this.bumpUsage(USAGE_KEYS.DECISION_CONFIRMED);
    return id;
  }

  /** V1.5 §14 — human-confirmed decision outcome. The deterministic classification is
   *  always computed and shown first (decision-effectiveness.ts); this only persists it
   *  once the user confirms, same pattern as Decision Radar's Review/Keep/Supersede. */
  confirmDecisionOutcome(id: string, outcomeStatus: DecisionEffectivenessClass, note?: string) {
    this.updateDecision(id, { outcomeStatus, ...(note ? { outcome: note } : {}) });
    const decision = this.state.data.decisions.find((d) => d.id === id);
    this.appendMemoryEvent({
      kind: "DECISION_OUTCOME",
      title: `Decision outcome confirmed: ${decision?.title ?? id} — ${outcomeStatus}`,
      impact: note ?? `Classified ${outcomeStatus}.`,
      evidence: note ? [note] : [],
      projectId: decision?.projectId,
      outcomeNote: note,
      ...this.reportContextForDecision(decision?.projectId, decision?.clientId, decision?.relatedWorkItemIds),
    });
  }

  /** Small helper shared by the V1.5 store methods above — appends one memory event
   *  immediately (decisions/actions are never snapshotted, so this is the only correct
   *  place to observe these transitions; see memory-events.ts for the closeDay/sync path). */
  private appendMemoryEvent(event: Omit<MemoryEvent, "id" | "date">) {
    const entry: MemoryEvent = { id: `memory-event-${event.kind}-${Date.now()}`, date: getTodayIso(), ...event };
    this.set({ ...this.state, memoryEvents: [...this.state.memoryEvents, entry].slice(-MAX_MEMORY_EVENTS) });
  }

  /** V2.25 — the exact ticket-key -> WorkItem-id resolution use-command-center.ts's own
   *  dailyCommandCompletedWorkItemIds/buildProjectOverrideView already apply, named once so
   *  the store's own internal engine calls (computeMemoryEvents/closeDay below) thread the
   *  same Daily Command Completion signal every other completion-aware engine now uses,
   *  instead of silently omitting it just because they run server-of-truth-side rather than
   *  through the React hook. */
  private resolveDailyCommandCompletedWorkItemIds(data: CommandCenterData): ReadonlySet<string> {
    return ticketExclusionSets(this.state.ticketWorkStates, data.workItems, getTodayIso()).doneIds;
  }

  /** V1.4 §41 — derives the small set of meaningful proactive-intelligence events for a
   *  data transition, comparing drift/escalation/dependency/release state just before vs.
   *  just after. `historyBeforeAppend` is snapshotHistory as it stood before this
   *  transition's own snapshot is pushed onto it. */
  private computeMemoryEvents(dataAfter: CommandCenterData, historyBeforeAppend: DailySnapshot[], today: string): MemoryEvent[] {
    // V2.25 — built once, threaded into every completion-aware engine below (see this file's
    // own resolveDailyCommandCompletedWorkItemIds and the audit note on dependency-radar.ts/
    // action-effectiveness.ts/memory.ts), closing the same gap use-command-center.ts's engines
    // already had fixed — a Work-Relevance-COMPLETED/EXCLUDED or Daily-Command-completed item
    // no longer generates a fresh memory event here as if it were still open/blocked.
    const workRelevanceIndex = buildWorkRelevanceIndex(this.state.jiraWorkRelevancePolicy);
    const dailyCommandCompletedWorkItemIds = this.resolveDailyCommandCompletedWorkItemIds(dataAfter);
    const currentMetrics = buildDailySnapshot(dataAfter, today, 0, undefined, workRelevanceIndex, dailyCommandCompletedWorkItemIds).metrics!;
    const currentDrift = computeDeliveryDrift(historyBeforeAppend, currentMetrics);

    const lastPrior = historyBeforeAppend[historyBeforeAppend.length - 1];
    const previousDrift = lastPrior?.metrics ? computeDeliveryDrift(historyBeforeAppend.slice(0, -1), lastPrior.metrics) : null;

    const openRisks = dedupeRisks(dataAfter.risks, detectRisks(dataAfter, today, workRelevanceIndex, dailyCommandCompletedWorkItemIds));
    const riskEscalations = computeRiskEscalations(openRisks, historyBeforeAppend, today);
    const dependencyRadar = computeDependencyRadar(dataAfter, openRisks, today, workRelevanceIndex, dailyCommandCompletedWorkItemIds);
    const releaseHealths = selectAllReleaseHealth(dataAfter, today, workRelevanceIndex);
    const releaseDrift = computeReleaseDrift(releaseHealths, lastPrior ?? null, today, workRelevanceIndex, dataAfter.workItems);

    const events = deriveMemoryEvents(previousDrift, currentDrift, riskEscalations, dependencyRadar, releaseDrift, today, dataAfter);

    // V1.5 §44 — LOOP_STALLED, computed at the same once-per-close/sync cadence as the
    // events above (never continuously — avoids daily-repeat noise beyond that cadence).
    const actionEffectiveness = computeActionEffectiveness(dataAfter, workRelevanceIndex, dailyCommandCompletedWorkItemIds);
    const ineffectiveWorkItemIds = new Set(
      actionEffectiveness.filter((r) => r.classification === "INEFFECTIVE").map((r) => dataAfter.actions.find((a) => a.id === r.actionId)?.relatedWorkItemId).filter((id): id is string => !!id)
    );
    const decisionRadar = computeDecisionRadar(dataAfter, this.state.isDemo ? "demo" : "manual", today, { riskEscalations, dependencyRadar, releaseDrift, ineffectiveActionWorkItemIds: ineffectiveWorkItemIds });
    const loops = computeDeliveryLoops(dataAfter, decisionRadar, actionEffectiveness, today);
    // V2.2.1 §14/§21 — the previous version logged a fresh LOOP_STALLED event on EVERY
    // close/sync while a loop remained stalled (no check against events already logged for
    // that loop), so one long-stuck loop could silently fill the bounded 200-slot memory
    // log with near-identical repeats and crowd out real signal. Only log it once per loop
    // — the event id embeds loop.id, so this is a simple prefix check against history
    // already gathered, same "meaningful transitions only" discipline as RE_ESCALATED above.
    for (const loop of loops) {
      if (loop.health !== "STALLED") continue;
      const alreadyLogged = this.state.memoryEvents.some((e) => e.kind === "LOOP_STALLED" && e.id.startsWith(`memory-event-loop-stalled-${loop.id}-`));
      if (alreadyLogged) continue;
      events.push({
        id: `memory-event-loop-stalled-${loop.id}-${Date.now()}`,
        date: today,
        kind: "LOOP_STALLED",
        title: `Stalled loop: ${loop.issue}`,
        impact: loop.why,
        evidence: [loop.nowWhat],
      });
    }

    return events;
  }

  // ===== V1.6 — Personal Delivery Copilot =====

  /** §5, §28 — the only place "who am I" is ever set. Never inferred. Kept for backward
   *  compatibility and as the simple path; delegates to setPersonalIdentity so `ownerName`
   *  and `personalIdentity` never diverge. */
  setOwnerName(name: string | undefined) {
    this.setPersonalIdentity(name ? { displayName: name } : undefined);
  }

  /** V1.7 §11-12 — "Who are you?" identity setup. `id` is generated once and kept stable
   *  across edits to displayName/email (re-entering your name doesn't create a new
   *  identity). No authentication, no accounts — purely local.
   *  V2.10 §1 — `accountId` (the real Jira accountId) is optional and, when set, is preferred
   *  over `displayName` everywhere identity is matched (see personal-focus.ts resolveOwner). */
  setPersonalIdentity(input: { displayName: string; email?: string; accountId?: string } | undefined) {
    const trimmedName = input?.displayName?.trim();
    if (!trimmedName) {
      this.set({ ...this.state, ownerName: undefined, personalIdentity: undefined });
      return;
    }
    const id = this.state.personalIdentity?.id ?? `identity-${Date.now()}`;
    const identity: PersonalIdentity = {
      id,
      displayName: trimmedName,
      email: input?.email?.trim() || undefined,
      accountId: input?.accountId?.trim() || undefined,
    };
    this.set({ ...this.state, ownerName: trimmedName, personalIdentity: identity });
  }

  private updatePersonalPlanItem(id: string, patch: Partial<PersonalPlanItem>) {
    const personalPlan = this.state.personalPlan.map((p) => (p.id === id ? { ...p, ...patch } : p));
    this.set({ ...this.state, personalPlan });
  }

  private nextPosition(plannedDate: string): number {
    const positions = this.state.personalPlan.filter((p) => p.plannedDate === plannedDate).map((p) => p.position);
    return positions.length > 0 ? Math.max(...positions) + 1 : 0;
  }

  /** §13 — adds one reference-only plan item. `priority` freezes the rank at planning time
   *  for "Why this order?" (§35); everything else re-derives live from the source.
   *  V1.7 §18, §22 — `origin` is planning metadata (defaults to "user-added", the common
   *  case: Start Focus / Add to Today); `snapshot` is the reconciliation baseline. */
  addPersonalPlanItem(input: {
    sourceType: PersonalPlanItem["sourceType"];
    sourceId: string;
    estimatedMinutes: number;
    plannedDate: string;
    priority: number;
    origin?: PlanItemOrigin;
    snapshot?: PersonalPlanItemSnapshot;
    /** The candidate's ticket, when it has one — links this plan item to TicketWorkState. */
    ticketKey?: string;
  }): string {
    const id = `plan-${input.sourceType}-${input.sourceId}-${Date.now()}`;
    const ticketKey = input.ticketKey ?? ticketKeyForPlanItem({ sourceId: input.sourceId }, this.state.data);
    const item: PersonalPlanItem = {
      id,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      priority: input.priority,
      position: this.nextPosition(input.plannedDate),
      plannedDate: input.plannedDate,
      status: "planned",
      estimatedMinutes: input.estimatedMinutes,
      addedAt: new Date().toISOString(),
      origin: input.origin ?? "user-added",
      snapshot: input.snapshot,
      ...(ticketKey ? { ticketKey } : {}),
    };
    const personalPlan = [...this.state.personalPlan, item].slice(-MAX_PERSONAL_PLAN_ITEMS);
    this.set({ ...this.state, personalPlan });
    return id;
  }

  /** §33 — bulk-accept a deterministically suggested daily plan. Only emits
   *  DAILY_PLAN_CREATED once per call, not once per item (§22 — meaningful events only). */
  acceptSuggestedPlan(candidates: PersonalFocusCandidate[], plannedDate: string) {
    if (candidates.length === 0) return;
    const items: PersonalPlanItem[] = candidates.map((c, i) => ({
      id: `plan-${c.sourceType}-${c.sourceId}-${Date.now()}-${i}`,
      sourceType: c.sourceType,
      sourceId: c.sourceId,
      priority: i,
      position: i,
      plannedDate,
      status: "planned",
      estimatedMinutes: c.estimatedMinutes,
      addedAt: new Date().toISOString(),
      origin: "system-suggested",
      snapshot: { category: c.category, projectId: c.projectId, ownershipExplicit: c.ownershipExplicit },
      ...(c.ticketKey ? { ticketKey: c.ticketKey } : {}),
    }));
    const personalPlan = [...this.state.personalPlan, ...items].slice(-MAX_PERSONAL_PLAN_ITEMS);
    this.set({ ...this.state, personalPlan });
    this.appendMemoryEvent({ kind: "DAILY_PLAN_CREATED", title: `Daily plan created — ${items.length} item(s)`, impact: `Planned for ${plannedDate}.`, evidence: [] });
  }

  /** §33 — clears today's not-yet-acted-on items so the suggested plan can be regenerated. */
  resetPersonalPlanForToday(today: string) {
    const personalPlan = this.state.personalPlan.filter((p) => !(p.plannedDate === today && p.status === "planned"));
    this.set({ ...this.state, personalPlan });
    this.appendMemoryEvent({ kind: "DAILY_PLAN_UPDATED", title: "Daily plan reset", impact: "Unstarted items for today were cleared.", evidence: [] });
  }

  /** §34 — human reordering always wins; only touches `position`. */
  reorderPersonalPlan(plannedDate: string, orderedIds: string[]) {
    const positionById = new Map(orderedIds.map((id, i) => [id, i]));
    const personalPlan = this.state.personalPlan.map((p) => (p.plannedDate === plannedDate && positionById.has(p.id) ? { ...p, position: positionById.get(p.id)! } : p));
    this.set({ ...this.state, personalPlan });
  }

  removePersonalPlanItem(id: string) {
    this.set({ ...this.state, personalPlan: this.state.personalPlan.filter((p) => p.id !== id) });
  }

  /** My Day "Defer". A plan item about a ticket defers the TICKET (TicketWorkState DEFERRED
   *  until `until`, default tomorrow — it comes back to Today on that date, everywhere); a
   *  ticketless item (decision loop, free action) keeps its own status. */
  deferPersonalPlanItem(id: string, until?: string) {
    const item = this.state.personalPlan.find((p) => p.id === id);
    const ticketKey = item ? ticketKeyForPlanItem(item, this.state.data) : undefined;
    if (ticketKey) {
      this.deferTicket(ticketKey, until, undefined, "my-day");
      return;
    }
    this.updatePersonalPlanItem(id, { status: "deferred", ...(until ? { deferredUntil: until } : {}) });
  }

  /** V1.7 §17 — a pinned item is never silently displaced or removed by reconciliation;
   *  see personal-plan.ts reconcilePersonalPlan for the enforcement side. */
  pinPersonalPlanItem(id: string) {
    this.updatePersonalPlanItem(id, { pinned: true });
  }
  unpinPersonalPlanItem(id: string) {
    this.updatePersonalPlanItem(id, { pinned: false });
  }

  /** §51-52 — carry an unfinished item forward as a fresh plan entry for today; the
   *  original historical entry is left untouched (§51 "completed items remain in history"). */
  carryForwardPersonalPlanItem(sourcePlanItem: PersonalPlanItem, today: string) {
    this.addPersonalPlanItem({
      sourceType: sourcePlanItem.sourceType,
      sourceId: sourcePlanItem.sourceId,
      estimatedMinutes: sourcePlanItem.estimatedMinutes,
      plannedDate: today,
      priority: sourcePlanItem.priority,
      origin: "carried-forward",
      snapshot: sourcePlanItem.snapshot,
      ticketKey: sourcePlanItem.ticketKey,
    });
  }

  /** Focus Session status change. A plan item about a ticket goes through setTicketStatus (so
   *  the ticket — and every list showing it — moves with it; the plan item follows as a linked
   *  record); a rejected ticket transition (e.g. the ticket is already DONE) changes nothing.
   *  A ticketless plan item keeps its own status. The FOCUS_* event carries the ticketKey so
   *  reports merge it with the TICKET_* event into one line. */
  private setFocusStatus(id: string, status: PersonalPlanItemStatus, kind: "FOCUS_STARTED" | "FOCUS_COMPLETED" | "FOCUS_BLOCKED" | "FOCUS_SKIPPED", today: string, ticketOpts: { reason?: string } = {}) {
    const item = this.state.personalPlan.find((p) => p.id === id);
    if (!item) return;
    const ticketKey = ticketKeyForPlanItem(item, this.state.data);
    if (ticketKey) {
      const to: TicketWorkStatus = status === "completed" ? "DONE" : status === "blocked" ? "BLOCKED" : status === "skipped" ? "SKIPPED" : "IN_PROGRESS";
      const current = ticketStatusOf(this.state.ticketWorkStates, ticketKey);
      if (!canTransition(current, to)) return;
      this.setTicketStatus(ticketKey, to, { surface: "focus-session", reason: ticketOpts.reason });
      // The plan item may be from an earlier day (not touched by the linked-records rule), so
      // make sure THIS one reflects the session.
      const after = this.state.personalPlan.find((p) => p.id === id);
      if (after && after.status !== status) this.updatePersonalPlanItem(id, { status, ticketKey, ...(status === "completed" ? { completedAt: today } : {}) });
    } else {
      this.updatePersonalPlanItem(id, { status, ...(status === "completed" ? { completedAt: today } : {}) });
    }
    // V2.17 Task 2 — a plan item's snapshot.projectId (captured when it was added to the
    // plan) is the only point-in-time project fact readily available here; its source can be
    // any of several entity types (attention/action/decision/loop), so — same "never guess
    // which ticket" discipline as reportContextForDecision above — no ticketKey is attempted.
    const projectName = item.snapshot?.projectId ? this.state.data.projects.find((p) => p.id === item.snapshot!.projectId)?.name : undefined;
    this.appendMemoryEvent({ kind, title: `Focus ${status}: ${item.sourceType}:${item.sourceId}`, impact: `Planned for ${item.plannedDate}.`, evidence: [], projectId: item.snapshot?.projectId, projectName, ...(ticketKey ? { ticketKey } : {}) });
  }

  /** §16, §18 — Focus Session lifecycle. These are personal execution states only — they
   *  never alter Jira status, Risk status, or auto-advance Decision status (§18). */
  startFocusItem(id: string, today: string) {
    this.setFocusStatus(id, "in-progress", "FOCUS_STARTED", today);
    this.bumpUsage(USAGE_KEYS.FOCUS_STARTED);
  }
  completeFocusItem(id: string, today: string, note?: string) {
    if (note) this.updatePersonalPlanItem(id, { note });
    this.setFocusStatus(id, "completed", "FOCUS_COMPLETED", today);
  }
  /** V2.0 §7 — blockedReason/blockedNote are optional capture from the Focus Session
   *  "Blocked" flow; never invented when the user skips the capture step. */
  blockFocusItem(id: string, today: string, blockedReason?: string, blockedNote?: string) {
    this.setFocusStatus(id, "blocked", "FOCUS_BLOCKED", today, { reason: [blockedReason, blockedNote].filter(Boolean).join(" — ") || undefined });
    if (blockedReason || blockedNote) this.updatePersonalPlanItem(id, { blockedReason, blockedNote });
  }
  skipFocusItem(id: string, today: string) {
    this.setFocusStatus(id, "skipped", "FOCUS_SKIPPED", today);
  }

  /** §22 — a single, low-frequency "the user actually reviewed today's focus" event,
   *  emitted at most once per day (call sites are responsible for the once-per-day check). */
  recordDailyFocusReviewed(today: string) {
    this.appendMemoryEvent({ kind: "DAILY_FOCUS_REVIEWED", title: "Daily focus reviewed", impact: `Reviewed on ${today}.`, evidence: [] });
  }

  /** V2.17 Task 2 — builds an immutable Daily Report for `dateIso` from that day's
   *  already-recorded memoryEvents (each entry a plain copy, never a live reference — see
   *  DailyReportSnapshot's own comment). Write-once by default: once a report exists for a
   *  given day, calling this again returns the existing snapshot completely untouched — a
   *  report about a day that has already passed must never silently change later just because
   *  Close Day (or this action) runs again. Pass `force: true` to deliberately regenerate —
   *  the one legitimate case is TODAY's own report, before the day is actually over and more
   *  memoryEvents might still land. */
  /** B3 — the standup state (in progress, blocked, skipped, new, mentions…) as of `now`, over
   *  the same project-scoped data every page shows. Pure read; see reports.ts. */
  buildLiveStandup(now: Date = new Date()): StandupState {
    const data = applyProjectScope(this.state.data, this.state.jiraProjectScope);
    return buildStandupState({
      data,
      identity: { displayName: this.state.personalIdentity?.displayName ?? this.state.ownerName, accountId: this.state.personalIdentity?.accountId },
      workRelevanceIndex: buildWorkRelevanceIndex(this.state.jiraWorkRelevancePolicy),
      ...selectDailyCommandMaps(this.state, toLocalIso(now)),
      ticketWorkStates: this.state.ticketWorkStates,
      personalPlan: this.state.personalPlan,
      mentionEvents: scopeMentionEvents(this.state.mentionEvents, data.workItems, this.state.jiraProjectScope),
      attentionState: this.state.attentionState,
      memoryEvents: this.state.memoryEvents,
      syncLog: this.state.syncLog,
      baselineAt: this.state.dailyReviewBaselineAt,
      lastVisitAt: this.state.dailyReviewLastVisitAt,
      reviewAcks: this.state.dailyReviewAcks,
      ...(this.state.features.mentionReplyTracking ? { mentionReplies: this.state.mentionReplies, myTicketActivity: this.state.myTicketActivity } : {}),
      now,
    });
  }

  generateDailyReport(dateIso: string, force = false): DailyReportSnapshot {
    const existing = this.state.dailyReports[dateIso];
    if (existing && !force) return existing;
    // B3 — today's report freezes the standup state as of now; a past day keeps whatever
    // standup it was last generated with (never recomputed from today's state).
    const standup = dateIso === getTodayIso() ? this.buildLiveStandup() : existing?.standup;
    const snapshot: DailyReportSnapshot = {
      date: dateIso,
      generatedAt: new Date().toISOString(),
      events: this.state.memoryEvents.filter((e) => e.date === dateIso).map((e) => ({ ...e })),
      ...(standup ? { standup } : {}),
    };
    const dailyReports: Record<string, DailyReportSnapshot> = { ...this.state.dailyReports, [dateIso]: snapshot };
    const overflow = Object.keys(dailyReports).length - MAX_DAILY_REPORTS;
    if (overflow > 0) {
      for (const oldestKey of Object.keys(dailyReports).sort().slice(0, overflow)) delete dailyReports[oldestKey];
    }
    this.set({ ...this.state, dailyReports });
    return snapshot;
  }

  // ===== V2.2 — Delivery Artifacts (§16) =====

  /** Saves a freshly-built or edited artifact draft to bounded local history. Never touches
   *  `data` — an artifact is a rendering, not a new source of truth. */
  saveArtifact(draft: ArtifactDraft, extra?: { aiDraftText?: string; aiDraftMode?: "mock" | "claude"; editedText?: string }): string {
    const id = `artifact-${Date.now()}`;
    const record: ArtifactRecord = { ...draft, id, createdAt: new Date().toISOString(), ...extra };
    const artifacts = [...this.state.artifacts, record].slice(-MAX_ARTIFACTS);
    this.set({ ...this.state, artifacts });
    return id;
  }

  updateArtifact(id: string, patch: Partial<Pick<ArtifactRecord, "aiDraftText" | "aiDraftMode" | "editedText" | "sections" | "evidence" | "evidenceVersion">>) {
    const artifacts = this.state.artifacts.map((a) => (a.id === id ? { ...a, ...patch } : a));
    this.set({ ...this.state, artifacts });
  }

  deleteArtifact(id: string) {
    this.set({ ...this.state, artifacts: this.state.artifacts.filter((a) => a.id !== id) });
  }

  // ===== V2.2 — Usage Observability (§22-23) =====

  /** Local-only, deterministic counters — never analytics infrastructure, never tracks
   *  credentials/payloads/prompts (§22). No-op once the defensive distinct-key cap is hit,
   *  rather than growing unboundedly on an unexpected key. */
  bumpUsage(key: string) {
    const current = this.state.usageCounters[key] ?? 0;
    if (current === 0 && Object.keys(this.state.usageCounters).length >= MAX_USAGE_COUNTER_KEYS) return;
    this.set({ ...this.state, usageCounters: { ...this.state.usageCounters, [key]: current + 1 } });
  }

  async closeDay(): Promise<EodEntry> {
    const today = getTodayIso();
    const { data, snapshotHistory } = this.state;
    const previous = previousSnapshotOf(this.state);
    // V2.3 §16 — the End-of-Day AI summary must never see an out-of-scope Jira project's
    // actions/risks; the archival snapshot below intentionally still records the full
    // dataset (snapshotHistory is the whole operational record over time, not a scoped view).
    const scopedForAi = applyProjectScope(data, this.state.jiraProjectScope);
    const completed = scopedForAi.actions.filter((a) => a.status === "completed" && a.completedAt === today);
    const deferred = scopedForAi.actions.filter((a) => a.status === "deferred");
    const blocked = scopedForAi.actions.filter((a) => a.status === "blocked");
    // V2.18 §7 — was scopedForAi.risks (manual-only — data.risks stays empty in normal Jira/
    // demo usage, so "new risks today" was effectively dead for auto-detected risks, the
    // overwhelming majority of what the product actually shows). Now the same deduped
    // manual+auto set every other surface already displays live, scoped the same way
    // completed/deferred/blocked already are above.
    const scopedOpenRisks = dedupeRisks(scopedForAi.risks, detectRisks(scopedForAi, today));
    const newRisks = scopedOpenRisks.filter((r) => r.status === "open" && r.detectedAt === today);
    const summary = await getAIProvider().generateEndOfDaySummary(completed, deferred, blocked, newRisks);
    const entry: EodEntry = { date: today, summary };

    // V2.18 §7 — unscoped (matches this snapshot's own "whole operational record, not a
    // scoped view" contract above) deduped manual+auto risk set, persisted into both the
    // diff (detectChanges) and the archival snapshot (buildDailySnapshot) so day-over-day
    // risk history actually contains what detectRisks live-computes — see change-detection.ts
    // and memory.ts's own comments for the persistence gap this closes.
    // V2.25 — same completion-aware threading as computeMemoryEvents below: built once here
    // so detectChanges/buildDailySnapshot agree with every other engine on what counts as
    // "done" (native Jira status, Work Relevance Policy, and Daily Command Completion).
    const workRelevanceIndex = buildWorkRelevanceIndex(this.state.jiraWorkRelevancePolicy);
    const dailyCommandCompletedWorkItemIds = this.resolveDailyCommandCompletedWorkItemIds(data);
    const unscopedOpenRisks = dedupeRisks(data.risks, detectRisks(data, today, workRelevanceIndex, dailyCommandCompletedWorkItemIds));
    const meaningfulChangeCount = detectChanges(previous, data, today, unscopedOpenRisks, workRelevanceIndex).length;
    const todaySnapshot = buildDailySnapshot(data, today, meaningfulChangeCount, unscopedOpenRisks, workRelevanceIndex, dailyCommandCompletedWorkItemIds);
    const newMemoryEvents = this.computeMemoryEvents(data, snapshotHistory, today);

    this.set({
      ...this.state,
      snapshotHistory: [...snapshotHistory, todaySnapshot].slice(-MAX_SNAPSHOT_HISTORY),
      eodHistory: [entry, ...this.state.eodHistory].slice(0, 30),
      memoryEvents: [...this.state.memoryEvents, ...newMemoryEvents].slice(-MAX_MEMORY_EVENTS),
    });
    return entry;
  }
}

export const commandCenterStore = new CommandCenterStore();
