// V2.25 Task 2 — Jira-side completion detection. Confirmed real gap: Daily/Weekly Report
// (daily-report.ts, store.ts's generateDailyReport) only ever read memoryEvents, which were
// only ever appended by an explicit IN-APP action (completing an Action, finishing a Focus
// session, etc.) — a ticket a Dev/QA closed directly in Jira never produced a memoryEvent at
// all, so it silently disappeared from both reports even though real work genuinely finished.
//
// Same deterministic diff-against-the-previous-DailySnapshot pattern assignment-detection.ts
// already uses for "did ownerId become mine since the last snapshot" — narrowed here to "did
// this work item's Jira-side completion state flip from open to done since the last snapshot".
// Uses native Jira status + Work Relevance Policy only (narrowed further by B2 below),
// NOT the broader isWorkItemOperationallyOpen — Daily Command Completion is an explicit in-app
// action, already a distinct fact from "closed in Jira" (see daily-report.ts's own COMPLETED_KINDS
// split: "Completed via Daily Command" vs "Completed in Jira"), so folding it in here would
// mislabel an in-app action as something sync "detected". No previous snapshot (first-ever sync)
// means nothing can be honestly compared against — never guesses "just completed" from a single
// observation, same discipline detectNewAssignments already applies.

//
// B2 — accuracy fixes. (1) Only a real finish counts: Jira native Done or Work-Relevance
// COMPLETED (task-execution.ts's isWorkItemFinishedInJira). A move into an EXCLUDED status is
// "removed from scope" — reported on its own line by detectJiraScopeRemovals, never as done.
// (2) Each event carries the assignee as of that sync, so reports split My work / Team work.
// (3) Each event carries Jira's resolutiondate when sent, so it is dated by when it happened.

import { isWorkItemDoneOrExcluded, type WorkRelevanceIndex } from "./jira/work-relevance";
import { isWorkItemFinishedInJira } from "./task-execution";
import type { CommandCenterData, DailySnapshot, WorkItem } from "./types";

export interface JiraStatusCompletionEvent {
  workItemId: string;
  issueKey: string;
  title: string;
  projectId: string;
  // B2 — additive.
  url?: string;
  assigneeId?: string;
  assigneeName?: string;
  /** Jira resolutiondate (ISO datetime), when Jira sent one. */
  resolvedAt?: string;
}

function toEvent(item: WorkItem, withResolution: boolean): JiraStatusCompletionEvent {
  return {
    workItemId: item.id,
    issueKey: item.key,
    title: item.title,
    projectId: item.projectId,
    ...(item.sourceUrl ? { url: item.sourceUrl } : {}),
    ...(item.ownerId ? { assigneeId: item.ownerId } : {}),
    ...(item.owner ? { assigneeName: item.owner } : {}),
    ...(withResolution && item.resolvedAt ? { resolvedAt: item.resolvedAt } : {}),
  };
}

/** Open (as of the previous snapshot) → Done / COMPLETED now. EXCLUDED never counts. */
export function detectJiraStatusCompletions(
  data: CommandCenterData,
  previousSnapshot: DailySnapshot | null,
  workRelevanceIndex: WorkRelevanceIndex | undefined
): JiraStatusCompletionEvent[] {
  if (!previousSnapshot) return [];
  const prevById = new Map(previousSnapshot.workItems.map((w) => [w.id, w]));
  const out: JiraStatusCompletionEvent[] = [];
  for (const item of data.workItems) {
    if (item.sourceType !== "jira") continue; // Jira-side completion only — demo/local-import never syncs
    const prev = prevById.get(item.id);
    if (!prev) continue; // a brand-new item was never "open, then completed" — no transition to report
    if (isWorkItemDoneOrExcluded(prev, workRelevanceIndex)) continue; // already finished/excluded as of the last snapshot
    if (!isWorkItemFinishedInJira(item, workRelevanceIndex)) continue; // still open, or EXCLUDED (see detectJiraScopeRemovals)
    out.push(toEvent(item, true));
  }
  return out;
}

/** B2 — open (as of the previous snapshot) → a Work-Relevance EXCLUDED status now: the ticket
 *  left this user's operational scope. Reported as "Removed from scope", never as completed. */
export function detectJiraScopeRemovals(
  data: CommandCenterData,
  previousSnapshot: DailySnapshot | null,
  workRelevanceIndex: WorkRelevanceIndex | undefined
): JiraStatusCompletionEvent[] {
  if (!previousSnapshot || !workRelevanceIndex) return [];
  const prevById = new Map(previousSnapshot.workItems.map((w) => [w.id, w]));
  const out: JiraStatusCompletionEvent[] = [];
  for (const item of data.workItems) {
    if (item.sourceType !== "jira") continue;
    const prev = prevById.get(item.id);
    if (!prev || isWorkItemDoneOrExcluded(prev, workRelevanceIndex)) continue;
    if (isWorkItemDoneOrExcluded(item, workRelevanceIndex) && !isWorkItemFinishedInJira(item, workRelevanceIndex)) out.push(toEvent(item, false));
  }
  return out;
}
