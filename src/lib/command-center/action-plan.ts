// Deterministic action-plan builder (BUILD REQUEST §10). Selection and ordering are
// pure functions of priority score, urgency, effort estimate, and dependency risk —
// the AI provider only narrates the result (see ai/provider.ts generateActionPlan).

import { scoreWorkItem } from "./scoring";
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

export function buildCandidates(data: CommandCenterData, today: string): PlanCandidate[] {
  const candidates: PlanCandidate[] = [];
  const coveredItemIds = new Set(
    data.actions.filter((a) => a.status === "open" && a.relatedWorkItemId).map((a) => a.relatedWorkItemId!)
  );

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

  for (const item of data.workItems) {
    if (item.status === "Done" || coveredItemIds.has(item.id)) continue;
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
export function buildPlan(data: CommandCenterData, today: string, budgetMinutes: TimeBudget): PlanCandidate[] {
  const candidates = buildCandidates(data, today);
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
