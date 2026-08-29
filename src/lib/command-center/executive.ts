// Executive Mode (BUILD REQUEST V1.1 §14). Deterministic aggregation over data the
// dashboard already computed — reuses derived scores/risks/changes rather than
// recalculating anything, and adds one new, simple, explainable rollup number.

import type { ChangeEvent, CommandCenterData, Decision, PriorityScoreResult, Risk } from "./types";

export interface ExecutiveView {
  deliveryConfidence: number; // 0-100, higher is healthier — see formula below
  majorRisks: Risk[];
  majorChanges: ChangeEvent[];
  decisionsNeeded: Decision[];
  summary: string;
}

/**
 * Deterministic delivery-confidence rollup: start at 100 and subtract a fixed, documented
 * penalty per open CRITICAL/HIGH priority item, per HIGH/MEDIUM risk, and per overdue item.
 * This is a calculated number, not an AI opinion — labeled "Calculated" in the UI.
 */
export function computeDeliveryConfidence(scores: PriorityScoreResult[], risks: Risk[], overdueCount: number): number {
  let confidence = 100;
  confidence -= scores.filter((s) => s.classification === "CRITICAL").length * 8;
  confidence -= scores.filter((s) => s.classification === "HIGH").length * 4;
  confidence -= risks.filter((r) => r.level === "HIGH").length * 5;
  confidence -= risks.filter((r) => r.level === "MEDIUM").length * 2;
  confidence -= overdueCount * 6;
  return Math.max(0, Math.min(100, Math.round(confidence)));
}

export function buildExecutiveView(
  data: CommandCenterData,
  scores: PriorityScoreResult[],
  risks: Risk[],
  changes: ChangeEvent[],
  overdueCount: number
): ExecutiveView {
  const deliveryConfidence = computeDeliveryConfidence(scores, risks, overdueCount);
  const majorRisks = risks.filter((r) => r.level === "HIGH").slice(0, 5);
  const majorChanges = changes.filter((c) => /release|blocker|priority|status/i.test(c.field) || c.entityType === "Project").slice(0, 5);
  const decisionsNeeded = data.decisions.filter((d) => d.status === "pending");

  const band = deliveryConfidence >= 80 ? "healthy" : deliveryConfidence >= 60 ? "manageable" : deliveryConfidence >= 40 ? "at risk" : "critical";
  const summary = `Delivery is currently ${band} (${deliveryConfidence}/100), driven by ${majorRisks.length} high risk(s), ` +
    `${scores.filter((s) => s.classification === "CRITICAL" || s.classification === "HIGH").length} attention-needing item(s), ` +
    `and ${decisionsNeeded.length} pending decision(s).`;

  return { deliveryConfidence, majorRisks, majorChanges, decisionsNeeded, summary };
}
