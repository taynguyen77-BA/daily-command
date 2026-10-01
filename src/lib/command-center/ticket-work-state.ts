// The canonical per-ticket work state — the single source of truth for "what am I doing about
// this ticket" (see TicketWorkState in types.ts and AUDIT_TASK_STATE.md). Pure: no store/window
// import, so it is tested directly and shared by store.ts (writes), app-state-sync.ts
// (cross-device merge) and every surface (reads).
//
// What lives here:
//   - the transition table (canTransition) and the one pure write (applyTicketStatus);
//   - the legacy projection: the three Daily Command maps (+ tombstones) are DERIVED from
//     ticketWorkStates (ticketStateMaps / deriveLegacyDailyCommandState), kept for one version
//     so code and older devices that still read them see the same truth;
//   - migration of legacy maps and ticket-linked plan items into ticketWorkStates (idempotent);
//   - the per-ticket LWW merge used by cross-tab rebase and cross-device sync;
//   - the read side: getTicketView / ticketBucket / ticketExclusionSets — what every list
//     derives its buckets and exclusion sets from.

import type {
  CommandCenterData,
  DailyCommandBlock,
  DailyCommandCompletion,
  DailyCommandSkip,
  DailyCommandTombstone,
  DailyCommandTombstones,
  FocusSignal,
  MemoryEvent,
  PersonalPlanItem,
  PersonalPlanItemStatus,
  SkipReason,
  TaskReactivation,
  TicketStatusSurface,
  TicketWorkState,
  TicketWorkStatus,
  WorkItem,
} from "./types";
import { TICKET_HISTORY_CAP } from "./types";
import { slug } from "./attention-queue";
import { resolveWorkRelevance, type EffectiveWorkRelevance, type WorkRelevanceIndex } from "./jira/work-relevance";
import { emptyTombstones, pruneTombstones, type DailyCommandState } from "./execution-state-merge";

export const TICKET_WORK_STATUSES: TicketWorkStatus[] = ["TODO", "IN_PROGRESS", "BLOCKED", "SKIPPED", "DEFERRED", "DONE"];
export const MAX_TICKET_REASON_LENGTH = 200;

export const TICKET_STATUS_LABEL: Record<TicketWorkStatus, string> = {
  TODO: "To do",
  IN_PROGRESS: "In progress",
  BLOCKED: "Blocked",
  SKIPPED: "Skipped",
  DEFERRED: "Deferred",
  DONE: "Done",
};

const isIsoDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// ===== Transition table ===================================================================

/** Every status can go to every status, except DONE, which only goes back to TODO (Reopen).
 *  Same-status writes are updates (new reason / date) — except TODO→TODO and DONE→DONE, which
 *  are no-ops (see isNoopTransition). */
export function canTransition(from: TicketWorkStatus, to: TicketWorkStatus): boolean {
  if (from === "DONE") return to === "TODO" || to === "DONE";
  return true;
}

export function isNoopTransition(from: TicketWorkStatus, to: TicketWorkStatus): boolean {
  return from === to && (to === "TODO" || to === "DONE");
}

export function ticketStatusOf(states: Record<string, TicketWorkState> | undefined, ticketKey: string): TicketWorkStatus {
  return states?.[ticketKey]?.status ?? "TODO";
}

/** The memory event a transition records (reports read only memoryEvents). */
export function ticketEventKind(from: TicketWorkStatus, to: TicketWorkStatus): MemoryEvent["kind"] {
  switch (to) {
    case "DONE":
      return "TICKET_COMPLETED";
    case "BLOCKED":
      return "TICKET_BLOCKED";
    case "SKIPPED":
      return "TICKET_SKIPPED";
    case "DEFERRED":
      return "TICKET_DEFERRED";
    case "IN_PROGRESS":
      return "TICKET_STARTED";
    case "TODO":
      if (from === "BLOCKED") return "TICKET_UNBLOCKED";
      if (from === "SKIPPED" || from === "DEFERRED") return "TICKET_REACTIVATED";
      return "TICKET_REOPENED";
  }
}

export interface SetTicketStatusOptions {
  reason?: string;
  /** Local YYYY-MM-DD revisit date (DEFERRED/SKIPPED/BLOCKED). */
  until?: string;
  surface: TicketStatusSurface;
  /** BLOCKED only — D5 follow-up ping date. */
  pingOn?: string;
  by?: string;
  source?: "user" | "jira";
  closedInJiraOn?: string;
}

export interface ApplyTicketStatusResult {
  states: Record<string, TicketWorkState>;
  from: TicketWorkStatus;
  changed: boolean;
  /** The transition table refused it (DONE → anything but TODO). */
  rejected: boolean;
}

/** The one pure write. Never mutates its input. */
export function applyTicketStatus(
  states: Record<string, TicketWorkState>,
  ticketKey: string,
  to: TicketWorkStatus,
  opts: SetTicketStatusOptions,
  nowIso: string
): ApplyTicketStatusResult {
  const prev = states[ticketKey];
  const from = prev?.status ?? "TODO";
  if (!canTransition(from, to)) return { states, from, changed: false, rejected: true };
  if (isNoopTransition(from, to)) return { states, from, changed: false, rejected: false };
  const reason = opts.reason?.trim().slice(0, MAX_TICKET_REASON_LENGTH) || undefined;
  const keepsDates = to === "BLOCKED" || to === "SKIPPED" || to === "DEFERRED";
  const until = keepsDates && isIsoDate(opts.until) ? opts.until : undefined;
  const pingOn = to === "BLOCKED" && isIsoDate(opts.pingOn) ? opts.pingOn : undefined;
  // LWW clock must move forward even when two writes land in the same millisecond.
  const updatedAt = prev && nowIso <= prev.updatedAt ? new Date(new Date(prev.updatedAt).getTime() + 1).toISOString() : nowIso;
  const next: TicketWorkState = {
    ticketKey,
    status: to,
    updatedAt,
    history: [...(prev?.history ?? []), { from, to, at: updatedAt, surface: opts.surface, ...(reason ? { reason } : {}) }].slice(-TICKET_HISTORY_CAP),
    ...(reason ? { reason } : {}),
    ...(until ? { until } : {}),
    ...(opts.by ? { updatedBy: opts.by } : {}),
    ...(pingOn ? { pingOn } : {}),
    ...(to === "DONE" && opts.source === "jira" ? { source: "jira" as const } : {}),
    ...(to === "DONE" && opts.closedInJiraOn ? { closedInJiraOn: opts.closedInJiraOn } : {}),
  };
  return { states: { ...states, [ticketKey]: next }, from, changed: true, rejected: false };
}

// ===== Legacy projection (deprecated maps) =================================================

const VALID_SKIP_REASONS = new Set<SkipReason>(["Team is handling it", "Not my action", "Waiting on another team", "Not relevant right now", "Other"]);
function asSkipReason(reason: string | undefined): SkipReason | undefined {
  if (!reason) return undefined;
  return VALID_SKIP_REASONS.has(reason as SkipReason) ? (reason as SkipReason) : "Other";
}

/** The skip/block a DONE record replaced (A4 "Closed in Jira — was Blocked: …"), from history. */
function previousPausedState(record: TicketWorkState): DailyCommandCompletion["previousState"] {
  const last = record.history[record.history.length - 1];
  if (!last || last.to !== "DONE" || (last.from !== "BLOCKED" && last.from !== "SKIPPED" && last.from !== "DEFERRED")) return undefined;
  const entered = [...record.history.slice(0, -1)].reverse().find((h) => h.to === last.from);
  const reason = entered?.reason;
  return { kind: last.from === "BLOCKED" ? "blocked" : "skipped", at: entered?.at ?? record.updatedAt, ...(reason ? { reason } : {}) };
}

export interface DailyCommandMapsView {
  dailyCommandCompletions: Record<string, DailyCommandCompletion>;
  dailyCommandSkips: Record<string, DailyCommandSkip>;
  dailyCommandBlocks: Record<string, DailyCommandBlock>;
}

/** Projects ticketWorkStates onto the three legacy maps. DONE → completion, BLOCKED → block,
 *  SKIPPED → skip, DEFERRED → skip with revisitOn = until; TODO / IN_PROGRESS → absent.
 *  With `today`, a DEFERRED ticket whose date has come projects as absent (back to active) —
 *  this is the projection engines read; without it (persisted / synced copy) it stays a skip. */
export function ticketStateMaps(states: Record<string, TicketWorkState> | undefined, today?: string): DailyCommandMapsView {
  const dailyCommandCompletions: Record<string, DailyCommandCompletion> = {};
  const dailyCommandSkips: Record<string, DailyCommandSkip> = {};
  const dailyCommandBlocks: Record<string, DailyCommandBlock> = {};
  for (const r of Object.values(states ?? {})) {
    if (r.status === "DONE") {
      const prev = r.source === "jira" ? previousPausedState(r) : undefined;
      dailyCommandCompletions[r.ticketKey] = {
        ticketKey: r.ticketKey,
        completedAt: r.updatedAt,
        updatedAt: r.updatedAt,
        ...(r.updatedBy ? { completedBy: r.updatedBy } : {}),
        ...(r.source === "jira" ? { source: "jira" as const, ...(r.closedInJiraOn ? { closedInJiraOn: r.closedInJiraOn } : {}), ...(prev ? { previousState: prev } : {}) } : {}),
      };
    } else if (r.status === "BLOCKED") {
      dailyCommandBlocks[r.ticketKey] = {
        ticketKey: r.ticketKey,
        blockedAt: r.updatedAt,
        updatedAt: r.updatedAt,
        ...(r.updatedBy ? { blockedBy: r.updatedBy } : {}),
        ...(r.reason ? { reason: r.reason } : {}),
        ...(r.until ? { revisitOn: r.until } : {}),
        ...(r.pingOn ? { pingOn: r.pingOn } : {}),
      };
    } else if (r.status === "SKIPPED" || r.status === "DEFERRED") {
      if (r.status === "DEFERRED" && today && r.until && r.until <= today) continue;
      const reason = asSkipReason(r.reason);
      dailyCommandSkips[r.ticketKey] = {
        ticketKey: r.ticketKey,
        skippedAt: r.updatedAt,
        updatedAt: r.updatedAt,
        ...(r.updatedBy ? { skippedBy: r.updatedBy } : {}),
        ...(reason ? { reason } : {}),
        ...(r.until ? { revisitOn: r.until } : {}),
      };
    }
  }
  return { dailyCommandCompletions, dailyCommandSkips, dailyCommandBlocks };
}

const MAP_OF: Partial<Record<TicketWorkStatus, keyof DailyCommandTombstones>> = { DONE: "completions", SKIPPED: "skips", DEFERRED: "skips", BLOCKED: "blocks" };

/** Tombstones for older devices: a ticket that was once in a map (per its history) and isn't
 *  now gets a tombstone dated when it entered its current status, so an older device's stale
 *  live copy loses the merge. Pruned like every other tombstone. */
function ticketStateTombstones(states: Record<string, TicketWorkState>): DailyCommandTombstones {
  const tomb = emptyTombstones();
  for (const r of Object.values(states)) {
    const current = MAP_OF[r.status];
    const was = new Set<keyof DailyCommandTombstones>();
    for (const h of r.history) {
      const m1 = MAP_OF[h.from];
      const m2 = MAP_OF[h.to];
      if (m1) was.add(m1);
      if (m2) was.add(m2);
    }
    for (const m of Array.from(was)) if (m !== current) tomb[m][r.ticketKey] = { ticketKey: r.ticketKey, deletedAt: r.updatedAt };
  }
  return tomb;
}

/** The full deprecated Daily Command state (maps + tombstones), derived from ticketWorkStates.
 *  `previousTombstones` (the legacy tombstones already on record) are kept where the map no
 *  longer holds a live record for that key — e.g. a pre-migration Reopen with no ticket state —
 *  so an older device still can't resurrect it. */
export function deriveLegacyDailyCommandState(states: Record<string, TicketWorkState>, nowIso: string | undefined, previousTombstones?: DailyCommandTombstones): DailyCommandState {
  const maps = ticketStateMaps(states);
  const derived = ticketStateTombstones(states);
  if (previousTombstones) {
    const live = { completions: maps.dailyCommandCompletions, skips: maps.dailyCommandSkips, blocks: maps.dailyCommandBlocks };
    for (const m of ["completions", "skips", "blocks"] as const) {
      for (const [key, t] of Object.entries(previousTombstones[m] ?? {})) {
        if (key in live[m]) continue;
        if (!derived[m][key] || t.deletedAt > derived[m][key].deletedAt) derived[m][key] = t;
      }
    }
  }
  // Pruned on local writes only (nowIso given) — same rule as execution-state-merge.ts.
  return { ...maps, dailyCommandTombstones: nowIso ? pruneTombstones(derived, nowIso) : derived };
}

// ===== Migration ===========================================================================

function completionClock(c: DailyCommandCompletion): string {
  return c.updatedAt ?? c.completedAt;
}
function skipClock(s: DailyCommandSkip): string {
  return s.updatedAt ?? s.skippedAt;
}
function blockClock(b: DailyCommandBlock): string {
  return b.updatedAt ?? b.blockedAt;
}

function migratedRecord(prev: TicketWorkState | undefined, ticketKey: string, to: TicketWorkStatus, at: string, extra: Partial<TicketWorkState>): TicketWorkState {
  const from = prev?.status ?? "TODO";
  const reason = extra.reason;
  return {
    ticketKey,
    status: to,
    updatedAt: at,
    history: [...(prev?.history ?? []), { from, to, at, surface: "migration" as const, ...(reason ? { reason } : {}) }].slice(-TICKET_HISTORY_CAP),
    ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)),
  };
}

const PLAN_STATUS_TO_TICKET: Partial<Record<PersonalPlanItemStatus, TicketWorkStatus>> = {
  completed: "DONE",
  blocked: "BLOCKED",
  skipped: "SKIPPED",
  "in-progress": "IN_PROGRESS",
  deferred: "DEFERRED",
};

/** Folds legacy Daily Command records (and ticket-linked plan items) into ticketWorkStates.
 *  Idempotent and lossless: a legacy record only wins when its own clock is STRICTLY newer than
 *  the ticket state (so the projection of a ticket state never re-applies itself), a legacy
 *  tombstone newer than the ticket state sends it back to TODO (an older device's Reopen /
 *  Reactivate / Unblock), and nothing is ever deleted. Returns the same object when nothing
 *  changed. */
export function migrateLegacyIntoTicketStates(
  states: Record<string, TicketWorkState>,
  legacy: Partial<DailyCommandState>,
  plan: PersonalPlanItem[] = []
): Record<string, TicketWorkState> {
  let out = states;
  const put = (key: string, rec: TicketWorkState) => {
    if (out === states) out = { ...states };
    out[key] = rec;
  };
  const newer = (key: string, clock: string) => !out[key] || clock > out[key].updatedAt;

  for (const c of Object.values(legacy.dailyCommandCompletions ?? {})) {
    const clock = completionClock(c);
    if (!newer(c.ticketKey, clock) || out[c.ticketKey]?.status === "DONE") continue;
    put(c.ticketKey, migratedRecord(out[c.ticketKey], c.ticketKey, "DONE", clock, { updatedBy: c.completedBy, source: c.source === "jira" ? "jira" : undefined, closedInJiraOn: c.closedInJiraOn }));
  }
  for (const s of Object.values(legacy.dailyCommandSkips ?? {})) {
    const clock = skipClock(s);
    if (!newer(s.ticketKey, clock)) continue;
    put(s.ticketKey, migratedRecord(out[s.ticketKey], s.ticketKey, "SKIPPED", clock, { updatedBy: s.skippedBy, reason: s.reason, until: s.revisitOn }));
  }
  for (const b of Object.values(legacy.dailyCommandBlocks ?? {})) {
    const clock = blockClock(b);
    if (!newer(b.ticketKey, clock)) continue;
    put(b.ticketKey, migratedRecord(out[b.ticketKey], b.ticketKey, "BLOCKED", clock, { updatedBy: b.blockedBy, reason: b.reason, until: b.revisitOn, pingOn: b.pingOn }));
  }
  const tomb = legacy.dailyCommandTombstones;
  if (tomb) {
    for (const [map, statuses] of [
      ["completions", ["DONE"]],
      ["skips", ["SKIPPED", "DEFERRED"]],
      ["blocks", ["BLOCKED"]],
    ] as const) {
      for (const t of Object.values((tomb[map] ?? {}) as Record<string, DailyCommandTombstone>)) {
        const cur = out[t.ticketKey];
        if (!cur || !(statuses as readonly string[]).includes(cur.status) || !(t.deletedAt > cur.updatedAt)) continue;
        put(t.ticketKey, migratedRecord(cur, t.ticketKey, "TODO", t.deletedAt, {}));
      }
    }
  }
  // Ticket-linked plan items: the newest one per ticket, only when newer than the ticket state.
  // A plan item has no status timestamp, so its clock is completedAt (a date — older than any
  // timestamp that same day) or addedAt: conservative, a real ticket record always wins.
  const newestPlan = new Map<string, { status: TicketWorkStatus; clock: string; item: PersonalPlanItem }>();
  for (const p of plan) {
    const to = p.ticketKey ? PLAN_STATUS_TO_TICKET[p.status] : undefined;
    if (!p.ticketKey || !to) continue;
    const clock = (p.status === "completed" && p.completedAt) || p.addedAt;
    if (typeof clock !== "string") continue;
    const cur = newestPlan.get(p.ticketKey);
    if (!cur || clock > cur.clock) newestPlan.set(p.ticketKey, { status: to, clock, item: p });
  }
  for (const [key, { status, clock, item }] of Array.from(newestPlan.entries())) {
    if (!newer(key, clock)) continue;
    if (!canTransition(ticketStatusOf(out, key), status) || ticketStatusOf(out, key) === status) continue;
    put(key, migratedRecord(out[key], key, status, clock, { reason: status === "BLOCKED" ? item.blockedReason : undefined, until: status === "DEFERRED" ? item.deferredUntil : undefined }));
  }
  return out;
}

// ===== Cross-tab / cross-device merge ======================================================

/** Per-ticket last-writer-wins on updatedAt. Ties: the longer history, then the greater JSON —
 *  deterministic and symmetric. A record with status TODO is how a "cleared" ticket wins over
 *  the other side's stale record, so no tombstones are needed here. */
export function mergeTicketWorkStates(a: Record<string, TicketWorkState> | undefined, b: Record<string, TicketWorkState> | undefined): Record<string, TicketWorkState> {
  const out: Record<string, TicketWorkState> = { ...(a ?? {}) };
  for (const [key, rb] of Object.entries(b ?? {})) {
    const ra = out[key];
    if (!ra) {
      out[key] = rb;
      continue;
    }
    if (ra.updatedAt !== rb.updatedAt) {
      if (rb.updatedAt > ra.updatedAt) out[key] = rb;
      continue;
    }
    if (rb.history.length !== ra.history.length) {
      if (rb.history.length > ra.history.length) out[key] = rb;
      continue;
    }
    if (JSON.stringify(rb) > JSON.stringify(ra)) out[key] = rb;
  }
  return out;
}

/** Parse-time shape check: drops malformed records instead of trusting them. */
export function asTicketWorkStates(v: unknown): Record<string, TicketWorkState> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, TicketWorkState> = {};
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    const r = raw as Partial<TicketWorkState> | null;
    if (!r || typeof r !== "object" || typeof r.ticketKey !== "string" || typeof r.updatedAt !== "string") continue;
    if (!TICKET_WORK_STATUSES.includes(r.status as TicketWorkStatus)) continue;
    const history = Array.isArray(r.history)
      ? r.history.filter((h) => !!h && typeof h === "object" && TICKET_WORK_STATUSES.includes(h.from) && TICKET_WORK_STATUSES.includes(h.to) && typeof h.at === "string").slice(-TICKET_HISTORY_CAP)
      : [];
    out[key] = {
      ticketKey: r.ticketKey,
      status: r.status as TicketWorkStatus,
      updatedAt: r.updatedAt,
      history: history.map((h) => ({ ...h, surface: typeof h.surface === "string" ? h.surface : "other" })),
      ...(typeof r.reason === "string" && r.reason ? { reason: r.reason } : {}),
      ...(isIsoDate(r.until) ? { until: r.until } : {}),
      ...(typeof r.updatedBy === "string" ? { updatedBy: r.updatedBy } : {}),
      ...(isIsoDate(r.pingOn) ? { pingOn: r.pingOn } : {}),
      ...(r.source === "jira" || r.source === "user" ? { source: r.source } : {}),
      ...(isIsoDate(r.closedInJiraOn) ? { closedInJiraOn: r.closedInJiraOn } : {}),
    };
  }
  return out;
}

// ===== Linking plan items / actions / attention items to tickets ===========================

/** A plan item's ticket, from its sourceId (attention item id) — never guessed: only the
 *  attention kinds whose id names one work item resolve. Loops and portfolio signals (RISK,
 *  DRIFT, DECISION…) stay ticketless. */
export function ticketKeyForPlanItem(item: Pick<PersonalPlanItem, "sourceId" | "ticketKey">, data: Pick<CommandCenterData, "workItems" | "actions" | "dependencies">): string | undefined {
  if (item.ticketKey) return item.ticketKey;
  const [kind, ...rest] = item.sourceId.split(":");
  const ref = rest.join(":");
  const bySlugId = (s: string) => data.workItems.find((w) => slug(w.id) === s);
  switch (kind) {
    case "MENTION":
      return data.workItems.find((w) => slug(w.key) === rest[0])?.key;
    case "ASSIGNMENT":
    case "STALE":
      return bySlugId(ref)?.key;
    case "ACTION": {
      const action = data.actions.find((a) => slug(a.id) === ref);
      return action?.relatedWorkItemId ? data.workItems.find((w) => w.id === action.relatedWorkItemId)?.key : undefined;
    }
    case "DEPENDENCY": {
      const dep = data.dependencies.find((d) => slug(d.id) === ref);
      return dep ? data.workItems.find((w) => w.id === dep.workItemId)?.key : undefined;
    }
    default:
      return undefined;
  }
}

/** Hydrate-time backfill: sets ticketKey on plan items that resolve to one. Returns the same
 *  array when nothing changed. */
export function backfillPlanTicketKeys(plan: PersonalPlanItem[], data: Pick<CommandCenterData, "workItems" | "actions" | "dependencies">): PersonalPlanItem[] {
  let changed = false;
  const next = plan.map((p) => {
    if (p.ticketKey || p.sourceType !== "attention") return p;
    const key = ticketKeyForPlanItem(p, data);
    if (!key) return p;
    changed = true;
    return { ...p, ticketKey: key };
  });
  return changed ? next : plan;
}

/** An Action's ticket, through relatedWorkItemId. */
export function ticketKeyForAction(action: { relatedWorkItemId?: string }, workItems: Pick<WorkItem, "id" | "key">[]): string | undefined {
  return action.relatedWorkItemId ? workItems.find((w) => w.id === action.relatedWorkItemId)?.key : undefined;
}

// ===== Read side: one selector, one bucket =================================================

export type TicketBucket = "TODAY" | "IN_PROGRESS" | "BLOCKED" | "SKIPPED_DEFERRED" | "DONE";

export const TICKET_BUCKET_LABEL: Record<TicketBucket, string> = {
  TODAY: "Today",
  IN_PROGRESS: "In progress",
  BLOCKED: "Blocked",
  SKIPPED_DEFERRED: "Skipped / Deferred",
  DONE: "Done",
};

/** Exactly one bucket per ticket. A DEFERRED ticket comes back to Today on its date. */
export function ticketBucket(status: TicketWorkStatus, until: string | undefined, today: string): TicketBucket {
  switch (status) {
    case "TODO":
      return "TODAY";
    case "IN_PROGRESS":
      return "IN_PROGRESS";
    case "BLOCKED":
      return "BLOCKED";
    case "SKIPPED":
      return "SKIPPED_DEFERRED";
    case "DEFERRED":
      return until && until <= today ? "TODAY" : "SKIPPED_DEFERRED";
    case "DONE":
      return "DONE";
  }
}

export interface TicketView {
  ticketKey: string;
  status: TicketWorkStatus;
  bucket: TicketBucket;
  reason?: string;
  until?: string;
  /** When the ticket entered its current status (undefined for an implicit TODO). */
  since?: string;
  updatedBy?: string;
  /** Read-only Jira overlay — never merged into `status`. */
  jiraStatus?: string;
  relevance?: EffectiveWorkRelevance;
  isNew: boolean;
  newReason?: string;
  reactivation?: TaskReactivation;
  signals: FocusSignal[];
  /** DONE because Jira closed a skipped/blocked ticket. */
  closedInJira?: boolean;
  closedInJiraOn?: string;
  pingOn?: string;
}

export interface TicketViewContext {
  ticketWorkStates: Record<string, TicketWorkState>;
  today: string;
  workItemsByKey?: Map<string, Pick<WorkItem, "key" | "status" | "jiraStatusName" | "sourceType" | "projectId">>;
  workRelevanceIndex?: WorkRelevanceIndex;
  newReasons?: Map<string, string>;
  reactivations?: Map<string, TaskReactivation>;
  signals?: Map<string, FocusSignal[]>;
}

/** THE selector every list reads a ticket's status through. */
export function getTicketView(ticketKey: string, ctx: TicketViewContext): TicketView {
  const r = ctx.ticketWorkStates[ticketKey];
  const status = r?.status ?? "TODO";
  const w = ctx.workItemsByKey?.get(ticketKey);
  const newReason = ctx.newReasons?.get(ticketKey);
  return {
    ticketKey,
    status,
    bucket: ticketBucket(status, r?.until, ctx.today),
    ...(r?.reason ? { reason: r.reason } : {}),
    ...(r?.until ? { until: r.until } : {}),
    ...(r && status !== "TODO" ? { since: r.updatedAt } : {}),
    ...(r?.updatedBy ? { updatedBy: r.updatedBy } : {}),
    ...(w ? { jiraStatus: w.jiraStatusName ?? w.status } : {}),
    ...(w && ctx.workRelevanceIndex ? { relevance: resolveWorkRelevance(w, ctx.workRelevanceIndex) } : {}),
    isNew: !!newReason,
    ...(newReason ? { newReason } : {}),
    ...(ctx.reactivations?.get(ticketKey) ? { reactivation: ctx.reactivations.get(ticketKey) } : {}),
    signals: ctx.signals?.get(ticketKey) ?? [],
    ...(status === "DONE" && r?.source === "jira" ? { closedInJira: true, ...(r.closedInJiraOn ? { closedInJiraOn: r.closedInJiraOn } : {}) } : {}),
    ...(r?.pingOn && status === "BLOCKED" ? { pingOn: r.pingOn } : {}),
  };
}

export interface TicketExclusionSets {
  /** Work item ids whose ticket is DONE. */
  doneIds: Set<string>;
  /** BLOCKED ∪ SKIPPED ∪ DEFERRED-until-future — out of every active personal list. */
  pausedIds: Set<string>;
  blockedIds: Set<string>;
  /** SKIPPED ∪ DEFERRED-until-future. */
  skippedIds: Set<string>;
  inProgressIds: Set<string>;
}

/** The exclusion sets every engine (personal focus, action plan, attention, staleness,
 *  priorities) receives — derived from ticketWorkStates only, resolved key → work item id over
 *  the caller's own (scoped) population. */
export function ticketExclusionSets(states: Record<string, TicketWorkState> | undefined, workItems: Pick<WorkItem, "id" | "key">[], today: string): TicketExclusionSets {
  const sets: TicketExclusionSets = { doneIds: new Set(), pausedIds: new Set(), blockedIds: new Set(), skippedIds: new Set(), inProgressIds: new Set() };
  if (!states || Object.keys(states).length === 0) return sets;
  for (const w of workItems) {
    const r = states[w.key];
    if (!r) continue;
    const bucket = ticketBucket(r.status, r.until, today);
    if (bucket === "DONE") sets.doneIds.add(w.id);
    else if (bucket === "BLOCKED") {
      sets.blockedIds.add(w.id);
      sets.pausedIds.add(w.id);
    } else if (bucket === "SKIPPED_DEFERRED") {
      sets.skippedIds.add(w.id);
      sets.pausedIds.add(w.id);
    } else if (bucket === "IN_PROGRESS") sets.inProgressIds.add(w.id);
  }
  return sets;
}

/** Plan-item statuses that mirror a ticket status (STEP 1's "linked records" table). */
export function planStatusForTicket(status: TicketWorkStatus): PersonalPlanItemStatus {
  switch (status) {
    case "DONE":
      return "completed";
    case "BLOCKED":
      return "blocked";
    case "SKIPPED":
      return "skipped";
    case "DEFERRED":
      return "deferred";
    case "IN_PROGRESS":
      return "in-progress";
    case "TODO":
      return "planned";
  }
}

/** The same vocabulary for ticketless rows (decision loops, free actions): a plan item's own
 *  status shown with the ticket labels, so every list reads the same words. */
export function ticketStatusForPlanStatus(status: PersonalPlanItemStatus): TicketWorkStatus {
  switch (status) {
    case "completed":
      return "DONE";
    case "blocked":
      return "BLOCKED";
    case "skipped":
      return "SKIPPED";
    case "deferred":
      return "DEFERRED";
    case "in-progress":
      return "IN_PROGRESS";
    case "planned":
      return "TODO";
  }
}
