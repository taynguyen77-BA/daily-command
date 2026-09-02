// Deterministic action-plan builder (BUILD REQUEST §10). Selection and ordering are
// pure functions of priority score, urgency, effort estimate, and dependency risk —
// the AI provider only narrates the result (see ai/provider.ts generateActionPlan).

import { scoreWorkItem } from "./scoring";
import { isPersonalWorkEligibleItem, type WorkRelevanceIndex } from "./jira/work-relevance";
import type { Action, CommandCenterData, PriorityScoreResult, WorkItem } from "./types";

export type TimeBudget = 15 | 30 | 60 | 120 | 480;

export const TIME_BUDGET_LABELS: Record<TimeBudget, string> = {
  15: "15 minutes",
  30: "30 minutes",
  60: "60 minutes",
  120: "2 hours",
  480: "Full day",
};

export interface PlanCandidate {
  id: string;
  title: string;
  estimateMinutes: number;
  priorityScore: number;
  reason: string;
  item?: WorkItem;
  action?: Action;
  result?: PriorityScoreResult;
}

function estimateForWorkItem(item: WorkItem): number {
  let minutes = 15;
  if (item.blocked) minutes += 10;
  if (item.priority === "P1") minutes += 5;
  return minutes;
}

export function buildCandidates(data: CommandCenterData, today: string, workRelevanceIndex?: WorkRelevanceIndex): PlanCandidate[] {
  const candidates: PlanCandidate[] = [];
  // BUGFIX — covered by ANY action regardless of status, not just "open" ones. The
  // underlying WorkItem doesn't become Done just because its Action was completed/
  // deferred/snoozed/blocked, so scoping this to "open" actions only meant that acting on
  // an auto-suggested candidate (e.g. clicking Complete) made it immediately re-eligible
  // for auto-suggestion again on the very next recompute — the same still-open, still
  // >=40-score WorkItem would come right back as a brand-new, action-less candidate,
  // silently erasing the fact the user already acted on it (most visible after a reload,
  // since the client-side liveAction workaround in action-plan/page.tsx's CandidateRow only
  // papers over this within one still-mounted component instance). Once a real Action
  // exists for a WorkItem, that Action — never a fresh synthesized one — is the only
  // representation of it; store.reopenAction() is the explicit way back to "active".
  const coveredItemIds = new Set(data.actions.filter((a) => a.relatedWorkItemId).map((a) => a.relatedWorkItemId!));

  for (const action of data.actions) {
    if (action.status !== "open") continue;
    const item = action.relatedWorkItemId ? data.workItems.find((w) => w.id === action.relatedWorkItemId) : undefined;
    const result = item ? scoreWorkItem(item, data, today) : undefined;
    candidates.push({
      id: action.id,
      title: action.title,
      estimateMinutes: action.estimateMinutes,
      priorityScore: result?.score ?? 55,
      reason: action.why,
      action,
      item,
      result,
    });
  }

  // V2.5 — a bare Jira work item only earns an auto-suggested candidate slot here when its
  // Work Relevance is ACTIONABLE (or the concept doesn't apply — demo/local-import data).
  // This is the ONE place in the codebase where a raw WorkItem (as opposed to an explicit,
  // human- or system-created Action above) becomes a personal task candidate — an OBSERVE/
  // WAITING/COMPLETED/EXCLUDED/UNKNOWN Jira status must never surface here regardless of
  // score/ownership/priority (§10-11). An Action a user has explicitly created and linked to
  // such an item is untouched — that's the user's own explicit decision, not an inference.
  for (const item of data.workItems) {
    if (item.status === "Done" || coveredItemIds.has(item.id)) continue;
    if (workRelevanceIndex && !isPersonalWorkEligibleItem(item, workRelevanceIndex)) continue;
    const result = scoreWorkItem(item, data, today);
    if (result.score < 40) continue; // LOW-priority items don't earn a slot in a time-boxed plan
    candidates.push({
      id: `plan-${item.id}`,
      title: `${item.key} — ${item.title}`,
      estimateMinutes: estimateForWorkItem(item),
      priorityScore: result.score,
      reason: result.reasoning,
      item,
      result,
    });
  }

  return candidates.sort((a, b) => b.priorityScore - a.priorityScore);
}

/** Greedy fill: highest priority first, skip anything that doesn't fit the remaining budget. */
export function buildPlan(data: CommandCenterData, today: string, budgetMinutes: TimeBudget, workRelevanceIndex?: WorkRelevanceIndex): PlanCandidate[] {
  const candidates = buildCandidates(data, today, workRelevanceIndex);
  const plan: PlanCandidate[] = [];
  let remaining = budgetMinutes;
  for (const c of candidates) {
    if (c.estimateMinutes <= remaining) {
      plan.push(c);
      remaining -= c.estimateMinutes;
    }
  }
  return plan;
}
