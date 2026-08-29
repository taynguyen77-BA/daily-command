// Delivery Loops (V1.5 §26-29). One visible OBSERVE -> DECIDE -> ACT -> MEASURE loop per
// decision that's actually in flight (or urgently needs one). Deterministic classification
// only — never invents an owner (§29), never auto-advances a decision's status.
//
// HEALTH RULES (documented, checked in order):
//   STALLED    — decision confirmed but no related action exists, OR a related action has
//                no owner, OR the decision's reviewDate has passed with no re-review
//   AT_RISK    — a related action is completed but has no recorded outcome yet
//   COMPLETED  — the decision's own outcomeStatus, or every related action's classification,
//                reads EFFECTIVE
//   HEALTHY    — decision status is early-stage (PROPOSED/UNDER_REVIEW) and nothing above
//                triggered — nothing to intervene on yet
//   UNKNOWN    — none of the above could be determined (e.g. no related actions and no
//                outcome recorded, decision still DECIDED but not yet due for review)

import type { ActionEffectivenessResult, CommandCenterData, DecisionRadarItem, DeliveryLoop, LoopHealth } from "./types";

const IN_FLIGHT_STATUSES = new Set(["DECIDED", "IMPLEMENTING", "VALIDATING"]);
const EARLY_STATUSES = new Set(["PROPOSED", "UNDER_REVIEW"]);

export function computeDeliveryLoops(data: CommandCenterData, decisionRadar: DecisionRadarItem[], actionEffectiveness: ActionEffectivenessResult[], today: string): DeliveryLoop[] {
  const effectivenessByActionId = new Map(actionEffectiveness.map((r) => [r.actionId, r]));
  const loops: DeliveryLoop[] = [];

  for (const decision of data.decisions) {
    if (!IN_FLIGHT_STATUSES.has(decision.status) && !EARLY_STATUSES.has(decision.status)) continue;

    const relatedActions = data.actions.filter((a) => a.relatedDecisionId === decision.id || (decision.relatedActionIds ?? []).includes(a.id));
    const primaryAction = relatedActions[0];
    const actionResult = primaryAction ? effectivenessByActionId.get(primaryAction.id) : undefined;

    let health: LoopHealth;
    let why: string;
    let nowWhat: string;

    const reviewOverdue = decision.reviewDate && decision.reviewDate <= today;

    if (decision.outcomeStatus === "EFFECTIVE" || actionResult?.classification === "EFFECTIVE") {
      health = "COMPLETED";
      why = "The related outcome was classified effective.";
      nowWhat = "No further action needed on this loop.";
    } else if (IN_FLIGHT_STATUSES.has(decision.status) && !primaryAction) {
      health = "STALLED";
      why = `Decision confirmed${decision.date ? ` ${decision.date}` : ""} but no follow-up action exists.`;
      nowWhat = "Assign or confirm the next action.";
    } else if (primaryAction && !primaryAction.owner) {
      health = "STALLED";
      why = `Action "${primaryAction.title}" has no owner.`;
      nowWhat = "Assign an owner to this action.";
    } else if (reviewOverdue) {
      health = "STALLED";
      why = `Decision review was due ${decision.reviewDate} and has not happened.`;
      nowWhat = "Review this decision.";
    } else if (primaryAction && primaryAction.status === "completed" && !primaryAction.outcomeStatus) {
      health = "AT_RISK";
      why = `Action "${primaryAction.title}" is completed but no outcome has been recorded.`;
      nowWhat = "Record whether the action worked.";
    } else if (EARLY_STATUSES.has(decision.status)) {
      health = "HEALTHY";
      why = "Decision is still under review — nothing to intervene on yet.";
      nowWhat = "Continue evaluating options.";
    } else {
      health = "UNKNOWN";
      why = "Not enough signal yet to classify this loop's health.";
      nowWhat = "Check back after the next action or outcome update.";
    }

    loops.push({
      id: decision.id,
      issue: decision.title,
      decision: { id: decision.id, title: decision.title, status: decision.status },
      action: primaryAction ? { id: primaryAction.id, title: primaryAction.title, status: primaryAction.status } : undefined,
      outcomeStatus: decision.outcomeStatus ?? actionResult?.classification,
      health,
      why,
      nowWhat,
    });
  }

  // Urgent decisions that don't have a Decision record yet (radar-only, still under review).
  for (const item of decisionRadar) {
    if (item.reviewUrgency !== "URGENT_REVIEW") continue;
    if (loops.some((l) => l.id === item.decisionId)) continue;
    loops.push({
      id: `radar-${item.decisionId}`,
      issue: item.decision.title,
      decision: { title: item.decision.title, status: "Under review" },
      health: "STALLED",
      why: item.whyReview[0] ?? "This decision urgently needs review.",
      nowWhat: "Review this decision and decide on a next step.",
    });
  }

  const HEALTH_ORDER: Record<LoopHealth, number> = { STALLED: 0, AT_RISK: 1, UNKNOWN: 2, HEALTHY: 3, COMPLETED: 4 };
  return loops.sort((a, b) => HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health]);
}
