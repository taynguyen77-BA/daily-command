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
import { todayLocalIso } from "./date-utils";
import { buildDailySnapshot } from "./memory";
import { JiraDataSource } from "./datasource/jira-source";
import { idbGet, idbSet } from "./local-db";
import { applyProjectScope, DEFAULT_JIRA_PROJECT_SCOPE, parseJiraProjectScope } from "./jira/project-scope";
import { buildWorkRelevanceIndex, DEFAULT_WORK_RELEVANCE_POLICY_MAP, parseWorkRelevancePolicyMap, withStatusRelevance } from "./jira/work-relevance";
import { updateWorkItemCalibrationHistory, type WorkItemCalibrationHistory } from "./jira/work-relevance-history";
import { computeActionEffectiveness } from "./action-effectiveness";
import { computeDecisionRadar } from "./decision-radar";
import { computeDeliveryDrift } from "./delivery-drift";
import { computeDeliveryLoops } from "./delivery-loops";
import { computeDependencyRadar } from "./dependency-radar";
import { computeRiskEscalations } from "./risk-escalation";
import { computeAllReleaseHealth } from "./release-health";
import { computeReleaseDrift } from "./release-drift";
import { deriveMemoryEvents } from "./memory-events";
import { detectRisks } from "./risk-detection";
import { dedupeRisks } from "./selectors";
import { USAGE_KEYS } from "./usage";
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
  DailyReportSnapshot,
  DailySnapshot,
  DataSourceType,
  Decision,
  DecisionEffectivenessClass,
  DecisionOption,
  GlobalFilters,
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
  PlanItemOrigin,
  WorkRelevance,
  WorkRelevancePolicyMigrationNotice,
} from "./types";
import { DATA_SCHEMA_VERSION, emptyData } from "./types";
import type { ImportResult } from "./import";
import type { SyncedAppState } from "./app-state";
export type { MyActionItemsOnlyByPage };

const STORAGE_KEY = "command-center:v1";
const MAX_SNAPSHOT_HISTORY = 60; // ~2 months of daily closes — plenty for trend/pattern/weekly-review, bounded
const MAX_MEMORY_EVENTS = 200;
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
  // V2.19 — Daily Command Completion. Keyed by Jira issue KEY (see DailyCommandCompletion's
  // own comment for why), local-only (deliberately not added to app-state.ts's SyncedAppState
  // in this pass — see completeTicketInDailyCommand/reopenTicketInDailyCommand below). A
  // ticket present here is suppressed from active personal-work surfaces regardless of its
  // Jira status; removed only by an explicit reopen.
  dailyCommandCompletions: Record<string, DailyCommandCompletion>;
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
    dailyCommandCompletions: {},
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
  return typeof c.ticketKey === "string" && typeof c.completedAt === "string" && (c.completedBy === undefined || typeof c.completedBy === "string");
}

function asDailyCommandCompletions(v: unknown): Record<string, DailyCommandCompletion> {
  const obj = asPlainObject<Record<string, unknown>>(v, {});
  const out: Record<string, DailyCommandCompletion> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isDailyCommandCompletionShape(value)) out[key] = value;
  }
  return out;
}

// V2.14 §4 — same discipline as every other parsed field here: a malformed/missing entry
// falls back to its safe default (false — "Everything") rather than being trusted as-is.
function asMyActionItemsOnly(v: unknown): MyActionItemsOnlyByPage {
  const obj = asPlainObject<Partial<MyActionItemsOnlyByPage>>(v, {});
  return { attention: obj.attention === true, myDay: obj.myDay === true, priorities: obj.priorities === true };
}

export function parseStoredState(raw: string): StoreState {
  try {
    const parsed = JSON.parse(raw) as Partial<StoreState> & { previousSnapshot?: DailySnapshot | null };
    const snapshotHistory = parsed.snapshotHistory ?? (parsed.previousSnapshot ? [parsed.previousSnapshot] : []);
    const { policy: jiraWorkRelevancePolicy, migration } = parseWorkRelevancePolicyMap(parsed.jiraWorkRelevancePolicy);
    const dataSourceValue: StoreState["dataSource"] = ["demo", "local-import", "jira"].includes(parsed.dataSource as string)
      ? (parsed.dataSource as StoreState["dataSource"])
      : parsed.isDemo
      ? "demo"
      : parsed.loaded
      ? "local-import"
      : "demo";
    return {
      schemaVersion: DATA_SCHEMA_VERSION,
      data: asPlainObject(parsed.data, emptyData()),
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
      personalPlan: Array.isArray(parsed.personalPlan) ? parsed.personalPlan : [],
      artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts.filter(isArtifactRecordShape) : [],
      usageCounters: asUsageCounters(parsed.usageCounters),
      mentionEvents: normalizeMentionEvents(parsed.mentionEvents),
      showAdvancedSettings: parsed.showAdvancedSettings === true,
      workItemCalibrationHistory: asWorkItemCalibrationHistory(parsed.workItemCalibrationHistory),
      myActionItemsOnly: asMyActionItemsOnly(parsed.myActionItemsOnly),
      lastAppStateSyncIso: typeof parsed.lastAppStateSyncIso === "string" ? parsed.lastAppStateSyncIso : undefined,
      dailyReports: asDailyReports(parsed.dailyReports),
      dailyCommandCompletions: asDailyCommandCompletions(parsed.dailyCommandCompletions),
    };
  } catch {
    return initialState();
  }
}

export class CommandCenterStore {
  private state: StoreState = initialState();
  private listeners = new Set<Listener>();
  private hydrated = false;

  private hydrate() {
    if (this.hydrated || typeof window === "undefined") return;
    this.hydrated = true;
    if (typeof indexedDB === "undefined") {
      // No IndexedDB available (old browser, some locked-down private-browsing modes, or
      // this app's own Node-based offline test environment) — the original, fully
      // synchronous localStorage path, unchanged.
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) this.state = parseStoredState(raw);
      } catch {
        // localStorage inaccessible (e.g. private browsing) — fall back to pristine state.
        this.state = initialState();
      }
      return;
    }
    // V2.16 — IndexedDB reads are inherently async, but getSnapshot() must return
    // synchronously for useSyncExternalStore — this kicks off the read in the background;
    // once it resolves, set() notifies every subscribed component, same as any other state
    // change. Until then, callers see the pristine initialState(), an unavoidable, brief
    // first-paint gap — the same one this app already accepts for getServerSnapshot()
    // (also always pristine).
    void this.hydrateFromIndexedDb();
  }

  /** V2.16 — one-time migration: a device that already has real data in the OLD localStorage
   *  key (every install from before this pass) must not appear to have "lost" it just
   *  because IndexedDB is empty on its first-ever read here. The legacy key is only cleared
   *  once its content has actually been confirmed written to IndexedDB — a failed migration
   *  write leaves the old copy in place so the next reload simply retries. */
  private async hydrateFromIndexedDb() {
    try {
      const fromIdb = await idbGet(STORAGE_KEY);
      if (fromIdb) {
        this.set(parseStoredState(fromIdb));
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
    this.set(migrated);
    try {
      await idbSet(STORAGE_KEY, JSON.stringify(migrated));
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Migration write failed — legacy copy stays in place; persist() below will keep
      // retrying the IndexedDB write on every subsequent mutation regardless.
    }
  }

  private persist() {
    if (typeof window === "undefined") return;
    if (typeof indexedDB === "undefined") {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      } catch {
        // Storage full/unavailable — keep working in-memory for this session.
      }
      return;
    }
    // V2.16 — fire-and-forget, same as the localStorage write it replaces: persistence must
    // never block a UI update. IndexedDB's much larger quota makes hitting it a genuinely
    // rare condition (unlike localStorage's ~5-10MB ceiling this replaces) — still never
    // thrown past this module (the same "keep working in-memory" contract as every other
    // storage failure here), but logged rather than fully swallowed, since a failure here is
    // unusual enough to be worth a trace if someone's debugging "my changes don't survive a
    // reload".
    void idbSet(STORAGE_KEY, JSON.stringify(this.state)).catch((err) => {
      console.error("CommandCenterStore: failed to persist to IndexedDB", err);
    });
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

  // Must return a referentially-stable value — useSyncExternalStore calls this on every
  // render, and a freshly-built object here trips React's "getServerSnapshot should be
  // cached" infinite-loop guard.
  private static readonly SERVER_SNAPSHOT: StoreState = initialState();
  getServerSnapshot = (): StoreState => CommandCenterStore.SERVER_SNAPSHOT;

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

  /** V2.19 — Daily Command Completion: "I'm done with this ticket here", independent of the
   *  Jira issue's own status and of any specific Action/Mention. Never touches Jira, never
   *  mutates data.workItems or any existing Action — see types.ts's DailyCommandCompletion for
   *  the full reasoning and personal-focus.ts/assigned-work.ts/recent-mentions.ts for where
   *  this suppresses the ticket. `completedBy` defaults to the configured identity's display
   *  name, when set, matching every other "who did this" field in this codebase. */
  completeTicketInDailyCommand(ticketKey: string) {
    const completion: DailyCommandCompletion = {
      ticketKey,
      completedAt: new Date().toISOString(),
      completedBy: this.state.personalIdentity?.displayName ?? this.state.ownerName,
    };
    this.set({ ...this.state, dailyCommandCompletions: { ...this.state.dailyCommandCompletions, [ticketKey]: completion } });
  }

  /** The only way back once a ticket is Daily-Command-completed — never automatic (§14
   *  Reactivation Rule: even a genuinely new mention only reactivates Recently Mentioned, it
   *  never clears this record on its own). */
  reopenTicketInDailyCommand(ticketKey: string) {
    if (!(ticketKey in this.state.dailyCommandCompletions)) return;
    const next = { ...this.state.dailyCommandCompletions };
    delete next[ticketKey];
    this.set({ ...this.state, dailyCommandCompletions: next });
  }

  setFilters(patch: Partial<GlobalFilters>) {
    this.set({ ...this.state, filters: { ...this.state.filters, ...patch } });
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
   */
  async syncJira(options?: { full?: boolean }): Promise<{ ok: boolean; error?: string }> {
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
      return { ok: false, error };
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
    const result = await new JiraDataSource().sync({
      sinceIso,
      scopeMode: scope.mode,
      projectKeys: scope.mode === "FOCUSED" ? scope.projectKeys : undefined,
      accountId: this.state.personalIdentity?.accountId,
    });

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
      return { ok: false, error: result.error };
    }

    const incoming = result.data;
    // V2.18 §5 — a sync that hit the JIRA_MAX_ISSUES safety cap before reaching the real end
    // of matching issues is "partial", not "success": it must never destructively replace an
    // existing complete local dataset (see the isFullSync gating below), and its incremental
    // cursor must resume from where it stopped, not silently skip past whatever it didn't
    // fetch (see lastSyncCompletedAt below).
    const truncated = result.truncated === true;
    const prevWorkItemsById = new Map(this.state.data.workItems.map((w) => [w.id, w]));
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    for (const w of incoming.workItems) {
      const prev = prevWorkItemsById.get(w.id);
      if (!prev) created++;
      else if (JSON.stringify(prev) !== JSON.stringify(w)) updated++;
      else unchanged++;
    }

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
        ? [...this.state.data.workItems.filter((w) => w.sourceType !== "jira" || staysUntouched(w.projectId)), ...incoming.workItems]
        : mergeById(this.state.data.workItems, incoming.workItems),
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

    this.set({
      ...this.state,
      data: merged,
      dataSource: "jira",
      loaded: true,
      isDemo: false,
      snapshotHistory: prevSnapshot ? [...this.state.snapshotHistory, prevSnapshot].slice(-MAX_SNAPSHOT_HISTORY) : this.state.snapshotHistory,
      memoryEvents: newMemoryEvents.length > 0 ? [...this.state.memoryEvents, ...newMemoryEvents].slice(-MAX_MEMORY_EVENTS) : this.state.memoryEvents,
      mentionEvents: mergedMentionEvents,
      workItemCalibrationHistory,
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

  /** V1.4 §41 — derives the small set of meaningful proactive-intelligence events for a
   *  data transition, comparing drift/escalation/dependency/release state just before vs.
   *  just after. `historyBeforeAppend` is snapshotHistory as it stood before this
   *  transition's own snapshot is pushed onto it. */
  private computeMemoryEvents(dataAfter: CommandCenterData, historyBeforeAppend: DailySnapshot[], today: string): MemoryEvent[] {
    const currentMetrics = buildDailySnapshot(dataAfter, today, 0).metrics!;
    const currentDrift = computeDeliveryDrift(historyBeforeAppend, currentMetrics);

    const lastPrior = historyBeforeAppend[historyBeforeAppend.length - 1];
    const previousDrift = lastPrior?.metrics ? computeDeliveryDrift(historyBeforeAppend.slice(0, -1), lastPrior.metrics) : null;

    const openRisks = dedupeRisks(dataAfter.risks, detectRisks(dataAfter, today));
    const riskEscalations = computeRiskEscalations(openRisks, historyBeforeAppend, today);
    const dependencyRadar = computeDependencyRadar(dataAfter, openRisks, today);
    const releaseHealths = computeAllReleaseHealth(dataAfter, today);
    const releaseDrift = computeReleaseDrift(releaseHealths, lastPrior ?? null, today);

    const events = deriveMemoryEvents(previousDrift, currentDrift, riskEscalations, dependencyRadar, releaseDrift, today, dataAfter);

    // V1.5 §44 — LOOP_STALLED, computed at the same once-per-close/sync cadence as the
    // events above (never continuously — avoids daily-repeat noise beyond that cadence).
    const actionEffectiveness = computeActionEffectiveness(dataAfter);
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
  }): string {
    const id = `plan-${input.sourceType}-${input.sourceId}-${Date.now()}`;
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

  deferPersonalPlanItem(id: string) {
    this.updatePersonalPlanItem(id, { status: "deferred" });
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
    });
  }

  private setFocusStatus(id: string, status: PersonalPlanItemStatus, kind: "FOCUS_STARTED" | "FOCUS_COMPLETED" | "FOCUS_BLOCKED" | "FOCUS_SKIPPED", today: string) {
    const item = this.state.personalPlan.find((p) => p.id === id);
    if (!item) return;
    this.updatePersonalPlanItem(id, { status, ...(status === "completed" ? { completedAt: today } : {}) });
    // V2.17 Task 2 — a plan item's snapshot.projectId (captured when it was added to the
    // plan) is the only point-in-time project fact readily available here; its source can be
    // any of several entity types (attention/action/decision/loop), so — same "never guess
    // which ticket" discipline as reportContextForDecision above — no ticketKey is attempted.
    const projectName = item.snapshot?.projectId ? this.state.data.projects.find((p) => p.id === item.snapshot!.projectId)?.name : undefined;
    this.appendMemoryEvent({ kind, title: `Focus ${status}: ${item.sourceType}:${item.sourceId}`, impact: `Planned for ${item.plannedDate}.`, evidence: [], projectId: item.snapshot?.projectId, projectName });
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
    if (blockedReason || blockedNote) this.updatePersonalPlanItem(id, { blockedReason, blockedNote });
    this.setFocusStatus(id, "blocked", "FOCUS_BLOCKED", today);
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
  generateDailyReport(dateIso: string, force = false): DailyReportSnapshot {
    const existing = this.state.dailyReports[dateIso];
    if (existing && !force) return existing;
    const snapshot: DailyReportSnapshot = {
      date: dateIso,
      generatedAt: new Date().toISOString(),
      events: this.state.memoryEvents.filter((e) => e.date === dateIso).map((e) => ({ ...e })),
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
    const unscopedOpenRisks = dedupeRisks(data.risks, detectRisks(data, today));
    const meaningfulChangeCount = detectChanges(previous, data, today, unscopedOpenRisks).length;
    const todaySnapshot = buildDailySnapshot(data, today, meaningfulChangeCount, unscopedOpenRisks);
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
