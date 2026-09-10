// V2.19 — My Assigned Work. Answers "what is currently assigned to me?" with the FULL Jira
// assignee population, deliberately separate from Your Delivery Focus (personal-focus.ts's
// curated, scored, ranked subset — never every assigned ticket, see that file's own top
// comment). No new scoring, no new classifier: ownership reuses matchesIdentity
// (personal-relation.ts, the same accountId-first/displayName-fallback comparison every other
// ownership check in this codebase uses) and completion reuses isWorkItemDoneOrExcluded
// (jira/work-relevance.ts) plus the caller-supplied Daily Command Completion set — the exact
// same two signals personal-focus.ts's gate and proactive.ts's MENTION auto-resolve already
// consult, so "assigned" and "active" never disagree with what Your Delivery Focus itself
// would say about the same ticket.

import type { WorkItem } from "./types";
import { matchesIdentity, type PersonalRelationIdentity } from "./personal-relation";
import { isWorkItemDoneOrExcluded, type WorkRelevanceIndex } from "./jira/work-relevance";

/** Every Jira-sourced work item assigned to the configured identity — unfiltered by score,
 *  status, or any curation rule. Returns an empty array (never a guess) when no identity is
 *  configured at all, same "never infer ownership" discipline as classifyPersonalRelation. */
export function getAssignedWorkItems(workItems: WorkItem[], identity: PersonalRelationIdentity): WorkItem[] {
  if (!identity.accountId && !identity.displayName) return [];
  return workItems.filter((w) => w.sourceType === "jira" && matchesIdentity(w.ownerId, w.owner, identity));
}

/** Assigned work whose ticket is NOT finished — neither by Jira's own status (native "Done",
 *  or the Work Relevance Policy's explicit COMPLETED/EXCLUDED) nor by an explicit Daily
 *  Command Completion. This is the population "My Assigned Work" renders as active. */
export function getActiveAssignedWorkItems(
  workItems: WorkItem[],
  identity: PersonalRelationIdentity,
  workRelevanceIndex: WorkRelevanceIndex | undefined,
  dailyCommandCompletedTicketKeys: ReadonlySet<string> = new Set()
): WorkItem[] {
  return getAssignedWorkItems(workItems, identity).filter((w) => !isWorkItemDoneOrExcluded(w, workRelevanceIndex) && !dailyCommandCompletedTicketKeys.has(w.key));
}

/** The complement of getActiveAssignedWorkItems — assigned work that IS finished, shown
 *  collapsed/separately per the product's own "Optionally: Completed collapsed separately"
 *  guidance, never mixed into the active list. */
export function getCompletedAssignedWorkItems(
  workItems: WorkItem[],
  identity: PersonalRelationIdentity,
  workRelevanceIndex: WorkRelevanceIndex | undefined,
  dailyCommandCompletedTicketKeys: ReadonlySet<string> = new Set()
): WorkItem[] {
  return getAssignedWorkItems(workItems, identity).filter((w) => isWorkItemDoneOrExcluded(w, workRelevanceIndex) || dailyCommandCompletedTicketKeys.has(w.key));
}
