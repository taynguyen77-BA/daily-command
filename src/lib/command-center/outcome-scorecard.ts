// Outcome Scorecard (V1.5 §32-34). Pure deltas from already-computed metrics — no AI
// arithmetic (§32). "Did today help?" and "control effectiveness" are observations built
// from the same deltas, never a causal claim, and never a per-person score (§34).

import type { ActionEffectivenessResult, OutcomeScorecard, SnapshotMetrics } from "./types";

export function computeOutcomeScorecard(currentMetrics: SnapshotMetrics, previousMetrics: SnapshotMetrics | undefined, actionsToday: ActionEffectivenessResult[]): OutcomeScorecard {
  const risksDelta = previousMetrics ? previousMetrics.highRiskCount - currentMetrics.highRiskCount : 0;
  const blockersDelta = previousMetrics ? previousMetrics.blockedCount - currentMetrics.blockedCount : 0;
  const confidenceDelta = previousMetrics ? currentMetrics.deliveryConfidence - previousMetrics.deliveryConfidence : 0;
  const dependenciesDelta = previousMetrics ? previousMetrics.unresolvedDependenciesCount - currentMetrics.unresolvedDependenciesCount : 0;

  const actionsCompleted = actionsToday.length;
  const actionsEffective = actionsToday.filter((a) => a.classification === "EFFECTIVE").length;
  const actionsIneffective = actionsToday.filter((a) => a.classification === "INEFFECTIVE").length;

  let didTodayHelp: OutcomeScorecard["didTodayHelp"] = "UNKNOWN";
  if (previousMetrics) {
    const deltas = [risksDelta, blockersDelta, confidenceDelta, dependenciesDelta];
    const improved = deltas.filter((d) => d > 0).length;
    const worsened = deltas.filter((d) => d < 0).length;
    if (improved === 0 && worsened === 0) didTodayHelp = "UNKNOWN";
    else if (improved > 0 && worsened === 0) didTodayHelp = "YES";
    else if (worsened > 0 && improved === 0) didTodayHelp = "NO";
    else didTodayHelp = "MIXED";
  }

  const controlEffectiveness =
    didTodayHelp === "UNKNOWN"
      ? "No interventions recorded, or not enough history to compare."
      : didTodayHelp === "YES"
        ? "Today's interventions moved the tracked delivery signals in the right direction."
        : didTodayHelp === "NO"
          ? "Today's tracked delivery signals moved in the wrong direction despite any interventions."
          : "Today's interventions had a mixed effect on the tracked delivery signals.";

  return { risksDelta, blockersDelta, confidenceDelta, dependenciesDelta, actionsCompleted, actionsEffective, actionsIneffective, didTodayHelp, controlEffectiveness };
}
