// V2.26 — one resolver for "what personal execution state is this ticket in, and what did the
// user record about it", shared by every surface that shows a ticket (TaskReferenceRow,
// My Assigned Work's history buckets, Daily Review). Reads the three Daily Command maps
// exactly as stored — no inference, no recomputation. The maps are mutually exclusive by
// construction (store.ts), so at most one of them can match; the order below only matters
// for corrupted data, where completion wins (the most conservative "don't nag me" reading).

import type { CommandCenterData, DailyCommandBlock, DailyCommandCompletion, DailyCommandSkip, DeliveryLoop, Dependency, WorkItem } from "./types";
import { formatRelativeDateTime } from "./relative-time";

export type TaskExecutionKind = "active" | "completed" | "skipped" | "blocked" | "done-in-jira";

export interface TaskExecutionState {
  kind: TaskExecutionKind;
  /** ISO datetime the user recorded the state, when there is a record. */
  at?: string;
  by?: string;
  reason?: string;
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
  if (completion) return { kind: "completed", at: completion.completedAt, by: completion.completedBy };
  if (finishedInJira) return { kind: "done-in-jira" };
  const skip = maps.dailyCommandSkips[ticketKey];
  if (skip) return { kind: "skipped", at: skip.skippedAt, by: skip.skippedBy, reason: skip.reason };
  const block = maps.dailyCommandBlocks[ticketKey];
  if (block) return { kind: "blocked", at: block.blockedAt, by: block.blockedBy, reason: block.reason };
  return { kind: "active" };
}

const KIND_LABEL: Record<TaskExecutionKind, string> = {
  active: "Active",
  completed: "Completed",
  skipped: "Skipped",
  blocked: "Blocked",
  "done-in-jira": "Completed in Jira",
};

/** "<reason>, <relative time>" for a history row — e.g. "Waiting for a reply, today 9:14 AM".
 *  Any missing piece is simply left out: no reason falls back to the state's own label
 *  ("Completed, yesterday 4:02 PM"); a missing/unparseable timestamp drops the time part.
 *  Never renders "undefined", "null", or "Invalid Date". Active returns undefined. */
export function formatExecutionRecord(state: TaskExecutionState, now: Date = new Date()): string | undefined {
  if (state.kind === "active") return undefined;
  const reason = state.reason?.trim() || KIND_LABEL[state.kind];
  const when = formatRelativeDateTime(state.at, now);
  return when ? `${reason}, ${when}` : reason;
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
