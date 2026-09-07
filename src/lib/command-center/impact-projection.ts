// Impact Projection (V2.0 §5) — "What happens if I do nothing?"
//
// This is NOT predictive AI. It only projects the continuation of an already-observed,
// already-classified condition (risk level, decision status, delivery-loop health, action
// staleness) that the deterministic engines already computed. No causal claims, no
// invented consequences: every unresolvedSignal string uses the fixed, non-causal phrasing
// "If no intervention occurs, X is expected to remain unresolved" — never
// "this will cause the release to fail." No AI call happens here.

import { makeEvidence } from "./evidence";
import type { Action, Decision, DeliveryLoop, Evidence, Risk } from "./types";

export interface ImpactProjection {
  currentCondition: string;
  unresolvedSignal: string;
  affectedEntities: string[];
  evidence: Evidence[];
  confidence: number;
  insufficientEvidence: boolean;
}

function projection(
  currentCondition: string,
  unresolvedSignal: string,
  affectedEntities: string[],
  evidenceContent: string[],
  sourceId: string,
  confidence: number
): ImpactProjection {
  return {
    currentCondition,
    unresolvedSignal,
    affectedEntities,
    evidence: evidenceContent.filter(Boolean).map((c) => makeEvidence(c, "manual", sourceId)),
    confidence,
    insufficientEvidence: evidenceContent.filter(Boolean).length === 0,
  };
}

const NO_SIGNAL = "This condition has already reached a resolved/terminal state — no ongoing signal to project.";

export function projectRiskImpact(risk: Risk): ImpactProjection {
  if (risk.status === "closed") {
    return projection(`Risk "${risk.title}" is closed.`, NO_SIGNAL, [risk.id], [], risk.id, 0.5);
  }
  return projection(
    `Risk "${risk.title}" is an open ${risk.level} risk.`,
    "If no intervention occurs, this risk is expected to remain unresolved.",
    [risk.id, ...risk.sourceWorkItemIds],
    [risk.potentialImpact, ...risk.evidence.slice(0, 2)],
    risk.id,
    0.7
  );
}

const DECISION_TERMINAL_STATUSES: Decision["status"][] = ["SUPERSEDED", "EFFECTIVE", "INEFFECTIVE"];

export function projectDecisionImpact(decision: Decision): ImpactProjection {
  if (DECISION_TERMINAL_STATUSES.includes(decision.status)) {
    return projection(`Decision "${decision.title}" has reached a terminal status (${decision.status}).`, NO_SIGNAL, [decision.id], [], decision.id, 0.5);
  }
  const reviewNote = decision.reviewDate ? `Review was due ${decision.reviewDate}.` : "No review date is set for this decision.";
  return projection(
    `Decision "${decision.title}" is currently ${decision.status} and has not been reviewed or confirmed.`,
    "If no intervention occurs, this decision is expected to remain unreviewed.",
    [decision.id, ...(decision.relatedWorkItemIds ?? [])],
    [reviewNote],
    decision.id,
    0.7
  );
}

const ACTION_UNRESOLVED_STATUSES: Action["status"][] = ["open", "recommended", "accepted", "in-progress", "blocked", "deferred", "snoozed"];

export function projectActionImpact(action: Action): ImpactProjection {
  if (!ACTION_UNRESOLVED_STATUSES.includes(action.status)) {
    return projection(`Action "${action.title}" is ${action.status}.`, NO_SIGNAL, [action.id], [], action.id, 0.5);
  }
  return projection(
    `Action "${action.title}" is ${action.status}${action.owner ? ` (owner: ${action.owner})` : ", with no owner set"}.`,
    "If no intervention occurs, this action is expected to remain unresolved.",
    [action.id, ...(action.relatedWorkItemId ? [action.relatedWorkItemId] : [])],
    [action.why],
    action.id,
    0.7
  );
}

export function projectLoopImpact(loop: DeliveryLoop): ImpactProjection {
  if (loop.health === "COMPLETED") {
    return projection(`Loop "${loop.issue}" has completed.`, NO_SIGNAL, [loop.id], [], loop.id, 0.5);
  }
  const unresolvedSignal =
    loop.health === "STALLED"
      ? "If no intervention occurs, this loop is expected to remain stalled."
      : "If no intervention occurs, this loop is expected to continue without a confirmed outcome.";
  return projection(
    `Loop "${loop.issue}" is currently ${loop.health}.`,
    unresolvedSignal,
    [loop.id, ...(loop.decision?.id ? [loop.decision.id] : []), ...(loop.action?.id ? [loop.action.id] : [])],
    [loop.why],
    loop.id,
    0.65
  );
}
