// V2.26 — one resolver for "what personal execution state is this ticket in, and what did the
// user record about it", shared by every surface that shows a ticket (TaskReferenceRow,
// My Assigned Work's history buckets, Daily Review). Reads the three Daily Command maps
// exactly as stored — no inference, no recomputation. The maps are mutually exclusive by
// construction (store.ts), so at most one of them can match; the order below only matters
// for corrupted data, where completion wins (the most conservative "don't nag me" reading).

import type { CommandCenterData, DailyCommandBlock, DailyCommandCompletion, DailyCommandSkip, DeliveryLoop, Dependency, WorkItem } from "./types";
import { formatRelativeDateTime } from "./relative-time";
import { businessDaysBetween, toLocalIso } from "./date-utils";
import { resolveWorkRelevance, type WorkRelevanceIndex } from "./jira/work-relevance";
import { applyDailyCommandChange, type DailyCommandState } from "./execution-state-merge";

export type TaskExecutionKind = "active" | "completed" | "skipped" | "blocked" | "done-in-jira";

export interface TaskExecutionState {
  kind: TaskExecutionKind;
  /** ISO datetime the user recorded the state, when there is a record. */
  at?: string;
  by?: string;
  reason?: string;
  /** A4 — skipped/blocked: the scheduled re-check day (local YYYY-MM-DD). */
  revisitOn?: string;
  /** A4 — completed: "jira" when created because Jira closed a skipped/blocked ticket. */
  source?: "daily-command" | "jira";
  closedInJiraOn?: string;
  previousState?: DailyCommandCompletion["previousState"];
}

export interface DailyCommandMaps {
  dailyCommandCompletions: Record<string, DailyCommandCompletion>;
  dailyCommandSkips: Record<string, DailyCommandSkip>;
  dailyCommandBlocks: Record<string, DailyCommandBlock>;
}

/** `finishedInJira` is the caller's own isWorkItemDoneOrExcluded verdict (Jira-native Done or
 *  Work Relevance COMPLETED/EXCLUDED) — it only applies when the user has no Daily Command
 *  record of their own, since that record is what the user can act on (Reopen/Reactivate/
 *  Unblock). A Jira-finished ticket that still carries a skip/block record shows as
 *  done-in-jira, matching assigned-work.ts where native truth wins the display bucket. */
export function resolveTaskExecutionState(ticketKey: string, maps: DailyCommandMaps, finishedInJira = false): TaskExecutionState {
  const completion = maps.dailyCommandCompletions[ticketKey];
  if (completion)
    return {
      kind: "completed",
      at: completion.completedAt,
      by: completion.completedBy,
      ...(completion.source === "jira" ? { source: "jira" as const, closedInJiraOn: completion.closedInJiraOn, previousState: completion.previousState } : {}),
    };
  if (finishedInJira) return { kind: "done-in-jira" };
  const skip = maps.dailyCommandSkips[ticketKey];
  if (skip) return { kind: "skipped", at: skip.skippedAt, by: skip.skippedBy, reason: skip.reason, ...(skip.revisitOn ? { revisitOn: skip.revisitOn } : {}) };
  const block = maps.dailyCommandBlocks[ticketKey];
  if (block) return { kind: "blocked", at: block.blockedAt, by: block.blockedBy, reason: block.reason, ...(block.revisitOn ? { revisitOn: block.revisitOn } : {}) };
  return { kind: "active" };
}

const KIND_LABEL: Record<TaskExecutionKind, string> = {
  active: "Active",
  completed: "Completed",
  skipped: "Skipped",
  blocked: "Blocked",
  "done-in-jira": "Completed in Jira",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDate(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00");
  return Number.isNaN(d.getTime()) ? isoDate : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** A4 — how long a ticket has been skipped/blocked: "today", "1 business day", "6 business
 *  days" (Mon-Fri only, same counting as the Stale Assigned Ticket detector). Undefined for a
 *  missing/unparseable timestamp. */
export function formatPausedAge(at: string | undefined, now: Date = new Date()): string | undefined {
  if (!at) return undefined;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return undefined;
  const from = toLocalIso(d);
  const to = toLocalIso(now);
  if (from >= to) return "today";
  const n = businessDaysBetween(from, to);
  // Paused over a weekend only: no full business day has passed yet.
  if (n === 0) return "under 1 business day";
  return n === 1 ? "1 business day" : `${n} business days`;
}

/** The history label for a row. Completed: "<reason>, <relative time>" — e.g. "Completed,
 *  yesterday 4:02 PM"; a Jira-closed one (A4): "Closed in Jira on Sep 18 — was Blocked:
 *  <reason>". Skipped/Blocked (A4): "Blocked 6 business days — Waiting for a reply · since
 *  Sep 18", plus "· re-check Sep 30" / "· re-check due" when a re-check day is set. Any
 *  missing piece is simply left out; never renders "undefined", "null", or "Invalid Date".
 *  Active returns undefined. */
export function formatExecutionRecord(state: TaskExecutionState, now: Date = new Date()): string | undefined {
  if (state.kind === "active") return undefined;
  const when = formatRelativeDateTime(state.at, now);
  if (state.kind === "completed" && state.source === "jira") {
    const closed = state.closedInJiraOn ? `Closed in Jira on ${shortDate(state.closedInJiraOn)}` : "Closed in Jira";
    const prev = state.previousState;
    if (!prev) return closed;
    const prevReason = prev.reason?.trim();
    return `${closed} — was ${KIND_LABEL[prev.kind]}${prevReason ? `: ${prevReason}` : ""}`;
  }
  if (state.kind === "skipped" || state.kind === "blocked") {
    const reason = state.reason?.trim();
    const age = formatPausedAge(state.at, now);
    const parts = [age ? `${KIND_LABEL[state.kind]} ${age}${reason ? ` — ${reason}` : ""}` : reason || KIND_LABEL[state.kind]];
    if (when) parts.push(`since ${when}`);
    if (state.revisitOn) parts.push(`re-check ${state.revisitOn <= toLocalIso(now) ? "due" : shortDate(state.revisitOn)}`);
    return parts.join(" · ");
  }
  const reason = state.reason?.trim() || KIND_LABEL[state.kind];
  return when ? `${reason}, ${when}` : reason;
}

/** A4 — "Done/COMPLETED in Jira": native Done, or Work Relevance COMPLETED. Deliberately NOT
 *  EXCLUDED (that is "outside my relevance", not "finished"). */
export function isWorkItemFinishedInJira(item: Pick<WorkItem, "status" | "sourceType" | "projectId" | "jiraStatusName">, index: WorkRelevanceIndex | undefined): boolean {
  if (item.status === "Done") return true;
  return !!index && resolveWorkRelevance(item, index) === "COMPLETED";
}

/** A4 — a skipped/blocked ticket that Jira has since closed moves to Completed history on its
 *  own: the skip/block is removed (tombstoned) and a completion is recorded with source
 *  "jira", the day it was detected, and the skip/block it replaced (so nothing the user
 *  recorded is lost). Pure; run by store.ts after every successful Jira sync. */
export function closePausedTicketsFinishedInJira(
  state: DailyCommandState,
  workItems: Pick<WorkItem, "key" | "status" | "sourceType" | "projectId" | "jiraStatusName">[],
  index: WorkRelevanceIndex | undefined,
  nowIso: string,
  todayIso: string
): { state: DailyCommandState; closedKeys: string[] } {
  const byKey = new Map(workItems.map((w) => [w.key, w]));
  let next = state;
  const closedKeys: string[] = [];
  const paused: { key: string; kind: "skipped" | "blocked"; at: string; reason?: string }[] = [
    ...Object.values(state.dailyCommandSkips).map((s) => ({ key: s.ticketKey, kind: "skipped" as const, at: s.skippedAt, reason: s.reason })),
    ...Object.values(state.dailyCommandBlocks).map((b) => ({ key: b.ticketKey, kind: "blocked" as const, at: b.blockedAt, reason: b.reason })),
  ];
  for (const p of paused) {
    const item = byKey.get(p.key);
    if (!item || !isWorkItemFinishedInJira(item, index)) continue;
    const completion: DailyCommandCompletion = {
      ticketKey: p.key,
      completedAt: nowIso,
      source: "jira",
      closedInJiraOn: todayIso,
      previousState: { kind: p.kind, at: p.at, ...(p.reason ? { reason: p.reason } : {}) },
    };
    next = applyDailyCommandChange(next, p.key, { kind: "completion", record: completion }, nowIso);
    closedKeys.push(p.key);
  }
  return { state: next, closedKeys };
}

/** V2.26 — resolve explicit work-item foreign keys (Risk.sourceWorkItemIds,
 *  Decision.relatedWorkItemIds, Dependency.workItemId, …) to the WorkItems themselves, in
 *  the given order, deduped. An id with no matching item in `workItems` (out of the current
 *  scope/filter, or deleted) is simply dropped — never guessed at. */
export function workItemsForIds(workItems: WorkItem[], ids: readonly (string | undefined)[] | undefined): WorkItem[] {
  if (!ids || ids.length === 0) return [];
  const byId = new Map(workItems.map((w) => [w.id, w]));
  const seen = new Set<string>();
  const out: WorkItem[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const w = byId.get(id);
    if (w) out.push(w);
  }
  return out;
}

/** V2.26 — a Delivery Loop's tickets, through its explicit links only: the loop's Decision's
 *  relatedWorkItemIds plus its Action's relatedWorkItemId. A loop with neither has no ticket. */
export function relatedWorkItemIdsForLoop(loop: DeliveryLoop, data: Pick<CommandCenterData, "decisions" | "actions">): string[] {
  const decision = loop.decision?.id ? data.decisions.find((d) => d.id === loop.decision!.id) : undefined;
  const action = loop.action ? data.actions.find((a) => a.id === loop.action!.id) : undefined;
  return [...(decision?.relatedWorkItemIds ?? []), ...(action?.relatedWorkItemId ? [action.relatedWorkItemId] : [])];
}

/** V2.26 — a Dependency Radar item's blocked ticket, via the underlying Dependency record. */
export function workItemIdForDependency(dependencyId: string, dependencies: Pick<Dependency, "id" | "workItemId">[]): string | undefined {
  return dependencies.find((d) => d.id === dependencyId)?.workItemId;
}
