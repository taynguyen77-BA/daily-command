// Action Effectiveness / Action Loop Health (V1.4 §14-15). Classifies each completed
// action by whether the work item it targeted actually improved afterward — never
// inferred without outcome evidence (returns UNKNOWN rather than guessing).
//
// V1.5 §17-19 upgrade: when the user has explicitly recorded action.outcomeStatus (the
// "Did It Work?" capture), that ground truth is preferred over the blocked/done heuristic
// below, which remains only as a fallback for actions with no recorded outcome status.

import type { Action, ActionEffectivenessClass, ActionEffectivenessResult, ActionOutcomeStatus, CommandCenterData } from "./types";

const OUTCOME_STATUS_TO_CLASS: Record<ActionOutcomeStatus, ActionEffectivenessClass> = {
  RESOLVED: "EFFECTIVE",
  IMPROVED: "EFFECTIVE",
  PARTIALLY_IMPROVED: "PARTIALLY_EFFECTIVE",
  NO_CHANGE: "INEFFECTIVE",
  WORSENED: "INEFFECTIVE",
  UNKNOWN: "UNKNOWN",
};

export function computeActionEffectiveness(data: CommandCenterData): ActionEffectivenessResult[] {
  const completed = data.actions.filter((a) => a.status === "completed");

  // Repeated actions: same relatedWorkItemId targeted by 2+ completed actions is itself a
  // signal that earlier attempts didn't resolve the underlying issue.
  const repeatCounts = new Map<string, number>();
  for (const a of completed) {
    if (!a.relatedWorkItemId) continue;
    repeatCounts.set(a.relatedWorkItemId, (repeatCounts.get(a.relatedWorkItemId) ?? 0) + 1);
  }

  return completed.map((action) => {
    const evidence: string[] = [];
    let classification: ActionEffectivenessClass = "UNKNOWN";

    const relatedItem = action.relatedWorkItemId ? data.workItems.find((w) => w.id === action.relatedWorkItemId) : undefined;
    const repeatCount = action.relatedWorkItemId ? (repeatCounts.get(action.relatedWorkItemId) ?? 1) : 1;

    if (action.outcomeStatus) {
      // V1.5 — user-confirmed ground truth wins over any heuristic.
      classification = OUTCOME_STATUS_TO_CLASS[action.outcomeStatus];
      evidence.push(`Recorded outcome: ${action.outcomeStatus}${action.outcome ? ` — ${action.outcome}` : ""}`);
      if (repeatCount >= 2 && classification !== "EFFECTIVE") {
        evidence.push(`This is action #${repeatCount} targeting the same item.`);
      }
    } else if (!action.outcome && !relatedItem) {
      classification = "UNKNOWN";
      evidence.push("No outcome was recorded and the related work item could not be found.");
    } else {
      if (relatedItem) {
        const stillBlocked = relatedItem.blocked;
        const isDone = relatedItem.status === "Done";
        evidence.push(`${relatedItem.key} is currently ${relatedItem.status}${stillBlocked ? " (blocked)" : ""}.`);

        if (isDone && !stillBlocked) {
          classification = "EFFECTIVE";
        } else if (stillBlocked && repeatCount >= 2) {
          classification = "INEFFECTIVE";
          evidence.push(`This is action #${repeatCount} targeting the same item — earlier attempts did not resolve it.`);
        } else if (stillBlocked) {
          classification = action.outcome ? "PARTIALLY_EFFECTIVE" : "UNKNOWN";
        } else {
          classification = "PARTIALLY_EFFECTIVE";
        }
      } else {
        classification = "UNKNOWN";
      }

      if (action.outcome) evidence.push(`Recorded outcome: ${action.outcome}`);
    }

    if (repeatCount >= 3 && classification === "INEFFECTIVE") {
      evidence.push(`REPEATEDLY INEFFECTIVE (${repeatCount}x) — consider a different intervention strategy.`);
    }

    return {
      actionId: action.id,
      actionTitle: action.title,
      classification,
      evidence,
    } satisfies ActionEffectivenessResult;
  });
}

export function ineffectiveActions(results: ActionEffectivenessResult[], actions: Action[]): { result: ActionEffectivenessResult; action: Action }[] {
  const byId = new Map(actions.map((a) => [a.id, a]));
  return results
    .filter((r) => r.classification === "INEFFECTIVE")
    .map((result) => ({ result, action: byId.get(result.actionId)! }))
    .filter((r) => !!r.action);
}

/** V1.5 §20 — a same-titled/same-target action failing 3+ times. */
export function repeatedlyIneffective(results: ActionEffectivenessResult[], actions: Action[], threshold = 3): { result: ActionEffectivenessResult; action: Action }[] {
  return ineffectiveActions(results, actions).filter((r) => r.result.evidence.some((e) => e.includes("REPEATEDLY INEFFECTIVE")) || countRepeats(actions, r.action) >= threshold);
}

function countRepeats(actions: Action[], action: Action): number {
  if (!action.relatedWorkItemId) return 1;
  return actions.filter((a) => a.status === "completed" && a.relatedWorkItemId === action.relatedWorkItemId).length;
}

/** V1.5 §21 — deterministic facts fed to the existing assessProactive("action strategy", …)
 *  AI call (no new AI method — §50 "do not add unnecessary Claude calls"). Claude may
 *  suggest alternatives from these facts but must not invent organizational details. */
export function buildActionStrategyFacts(action: Action, repeatCount: number): { facts: string[]; evidence: string[] } {
  return {
    facts: [`Current approach: ${action.title}`, `Result: no resolution after ${repeatCount} attempt(s)`, action.owner ? `Owner: ${action.owner}` : "Owner: unassigned"],
    evidence: [action.why, ...(action.outcome ? [action.outcome] : [])],
  };
}
