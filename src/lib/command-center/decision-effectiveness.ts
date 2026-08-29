// Decision Effectiveness (V1.5 §14-16). Deterministic — pure arithmetic over snapshot
// metrics, never AI. Every observed-change sentence uses causality-safe wording ("X changed
// after the decision was implemented"), never a causal claim ("the decision caused X") —
// §16 is treated as a hard constraint, not a suggestion.
//
// WEIGHTING (documented): baseline = the earliest snapshot on/after decision.date. Deltas
// vs. current metrics: confidence (+1/point), blockers resolved (+3/item), high risks
// resolved (+3/item), dependencies resolved (+2/item). A related action classified
// EFFECTIVE adds +3; INEFFECTIVE subtracts 3.
//   EFFECTIVE:            score >= 8
//   PARTIALLY_EFFECTIVE:  0 < score < 8
//   INEFFECTIVE:          score < 0
//   UNKNOWN:              no baseline snapshot yet, or score === 0 with no related-action signal

import type { ActionEffectivenessResult, Decision, DecisionEffectivenessResult, DailySnapshot, SnapshotMetrics } from "./types";

export function computeDecisionEffectiveness(
  decision: Decision,
  snapshotHistory: DailySnapshot[],
  currentMetrics: SnapshotMetrics,
  relatedActionResults: ActionEffectivenessResult[]
): DecisionEffectivenessResult {
  if (!decision.date) {
    return { decisionId: decision.id, classification: "UNKNOWN", observedChanges: [], evidence: ["No decision date recorded — cannot establish a baseline to measure against."] };
  }

  const baseline = snapshotHistory
    .filter((s) => s.date >= decision.date! && !!s.metrics)
    .sort((a, b) => a.date.localeCompare(b.date))[0]?.metrics;

  if (!baseline) {
    return { decisionId: decision.id, classification: "UNKNOWN", observedChanges: [], evidence: ["Not enough snapshot history since the decision was made yet."] };
  }

  const confidenceDelta = currentMetrics.deliveryConfidence - baseline.deliveryConfidence;
  const blockerDelta = baseline.blockedCount - currentMetrics.blockedCount; // positive = improved
  const riskDelta = baseline.highRiskCount - currentMetrics.highRiskCount;
  const depDelta = baseline.unresolvedDependenciesCount - currentMetrics.unresolvedDependenciesCount;

  const observedChanges: string[] = [];
  const evidence: string[] = [];
  if (confidenceDelta !== 0) {
    observedChanges.push(`Delivery confidence ${confidenceDelta > 0 ? "increased" : "decreased"} ${Math.abs(confidenceDelta)} point(s) after the decision was implemented.`);
    evidence.push(`Delivery confidence: ${baseline.deliveryConfidence} → ${currentMetrics.deliveryConfidence}`);
  }
  if (blockerDelta !== 0) {
    observedChanges.push(`Blocked items ${blockerDelta > 0 ? "decreased" : "increased"} by ${Math.abs(blockerDelta)} after the decision was implemented.`);
    evidence.push(`Blocked items: ${baseline.blockedCount} → ${currentMetrics.blockedCount}`);
  }
  if (riskDelta !== 0) {
    observedChanges.push(`High-severity risks ${riskDelta > 0 ? "decreased" : "increased"} by ${Math.abs(riskDelta)} after the decision was implemented.`);
    evidence.push(`High risks: ${baseline.highRiskCount} → ${currentMetrics.highRiskCount}`);
  }
  if (depDelta !== 0) {
    observedChanges.push(`Unresolved dependencies ${depDelta > 0 ? "decreased" : "increased"} by ${Math.abs(depDelta)} after the decision was implemented.`);
    evidence.push(`Unresolved dependencies: ${baseline.unresolvedDependenciesCount} → ${currentMetrics.unresolvedDependenciesCount}`);
  }

  const relatedEffective = relatedActionResults.filter((r) => r.classification === "EFFECTIVE").length;
  const relatedIneffective = relatedActionResults.filter((r) => r.classification === "INEFFECTIVE").length;
  if (relatedEffective > 0) {
    observedChanges.push(`${relatedEffective} related action(s) were classified effective after this decision.`);
    evidence.push(`${relatedEffective} related action(s) effective`);
  }
  if (relatedIneffective > 0) {
    observedChanges.push(`${relatedIneffective} related action(s) did not resolve the underlying issue.`);
    evidence.push(`${relatedIneffective} related action(s) ineffective`);
  }

  const score = confidenceDelta + blockerDelta * 3 + riskDelta * 3 + depDelta * 2 + relatedEffective * 3 - relatedIneffective * 3;

  const classification = score >= 8 ? "EFFECTIVE" : score < 0 ? "INEFFECTIVE" : score > 0 ? "PARTIALLY_EFFECTIVE" : observedChanges.length > 0 ? "PARTIALLY_EFFECTIVE" : "UNKNOWN";

  if (evidence.length === 0) evidence.push("No measurable change in tracked delivery signals since the decision was made.");

  return { decisionId: decision.id, classification, observedChanges, evidence };
}
