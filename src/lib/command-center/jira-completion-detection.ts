// V2.25 Task 2 — Jira-side completion detection. Confirmed real gap: Daily/Weekly Report
// (daily-report.ts, store.ts's generateDailyReport) only ever read memoryEvents, which were
// only ever appended by an explicit IN-APP action (completing an Action, finishing a Focus
// session, etc.) — a ticket a Dev/QA closed directly in Jira never produced a memoryEvent at
// all, so it silently disappeared from both reports even though real work genuinely finished.
//
// Same deterministic diff-against-the-previous-DailySnapshot pattern assignment-detection.ts
// already uses for "did ownerId become mine since the last snapshot" — narrowed here to "did
// this work item's Jira-side completion state flip from open to done since the last snapshot".
// Deliberately uses isWorkItemDoneOrExcluded (native Jira status + Work Relevance Policy only),
// NOT the broader isWorkItemOperationallyOpen — Daily Command Completion is an explicit in-app
// action, already a distinct fact from "closed in Jira" (see daily-report.ts's own COMPLETED_KINDS
// split: "Completed via Daily Command" vs "Completed in Jira"), so folding it in here would
// mislabel an in-app action as something sync "detected". No previous snapshot (first-ever sync)
// means nothing can be honestly compared against — never guesses "just completed" from a single
// observation, same discipline detectNewAssignments already applies.

import { isWorkItemDoneOrExcluded, type WorkRelevanceIndex } from "./jira/work-relevance";
import type { CommandCenterData, DailySnapshot } from "./types";

export interface JiraStatusCompletionEvent {
  workItemId: string;
  issueKey: string;
  title: string;
  projectId: string;
}

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
    if (isWorkItemDoneOrExcluded(prev, workRelevanceIndex)) continue; // already finished as of the last snapshot — not a new completion
    if (!isWorkItemDoneOrExcluded(item, workRelevanceIndex)) continue; // still open — nothing to report
    out.push({ workItemId: item.id, issueKey: item.key, title: item.title, projectId: item.projectId });
  }
  return out;
}
