// Decision Radar + Decision Staleness (V1.4 §12-13). Wraps the existing
// detectDecisionConflictCandidates() (decision-conflicts.ts) rather than duplicating its
// precondition logic — this module only adds the time dimension (how long has the decision
// sat unchanged) and evidence-growth count. Never automatically changes decision status;
// the UI must always require an explicit REVIEW / KEEP / MARK SUPERSEDED choice (§12).
//
// V1.5 §6-7 upgrade: reviewUrgency is now a documented weighted score over age, evidence
// changes, related risk/dependency/release signals, and related action outcomes — not just
// the V1.4 staleness+evidence trigger. Still never touches decision.status.

import { detectDecisionConflictCandidates } from "./decision-conflicts";
import { daysBetween } from "./scoring";
import type { CommandCenterData, DecisionRadarItem, DependencyRadarItem, EvidenceSourceType, ReleaseDrift, RiskEscalation } from "./types";

const OPEN_STATUSES = new Set(["pending", "ACTIVE", "AT_RISK", "REVISIT_REQUIRED", "PROPOSED", "UNDER_REVIEW", "DECIDED", "IMPLEMENTING", "VALIDATING"]);

/** V2.0 §9 — deterministic review-date status for any open decision, independent of the
 *  weighted radar score above (a decision with a review date 2 days out has REVIEW_SOON
 *  even if nothing else about it currently needs attention). Never invents a review date:
 *  a decision with none set is always NO_REVIEW_DATE, never guessed at. Never changes
 *  decision.status — this is read-only classification for UI surfacing.
 *
 *  The spec's reminder vocabulary is exactly 4 states (REVIEW DUE / REVIEW SOON /
 *  REVIEW OVERDUE / NO REVIEW DATE); NOT_DUE_YET is a 5th internal value for a decision
 *  that DOES have a review date but it isn't within the reminder window yet — callers that
 *  render the 4-state reminder surface should treat NOT_DUE_YET as "nothing to show", not
 *  collapse it into NO_REVIEW_DATE (which would misleadingly imply no date is set at all). */
export type DecisionReviewStatus = "REVIEW_DUE" | "REVIEW_SOON" | "REVIEW_OVERDUE" | "NO_REVIEW_DATE" | "NOT_DUE_YET";

const REVIEW_SOON_WINDOW_DAYS = 3;

export function reviewStatusFor(decision: Pick<import("./types").Decision, "reviewDate">, today: string): DecisionReviewStatus {
  if (!decision.reviewDate) return "NO_REVIEW_DATE";
  if (decision.reviewDate < today) return "REVIEW_OVERDUE";
  if (decision.reviewDate === today) return "REVIEW_DUE";
  const daysUntil = daysBetween(today, decision.reviewDate);
  return daysUntil <= REVIEW_SOON_WINDOW_DAYS ? "REVIEW_SOON" : "NOT_DUE_YET";
}

export interface DecisionRadarContext {
  riskEscalations: RiskEscalation[];
  dependencyRadar: DependencyRadarItem[];
  releaseDrift: ReleaseDrift[];
  ineffectiveActionWorkItemIds: Set<string>;
}

export function computeDecisionRadar(data: CommandCenterData, sourceType: EvidenceSourceType, today: string, context?: DecisionRadarContext): DecisionRadarItem[] {
  const candidates = detectDecisionConflictCandidates(data, sourceType);
  const candidatesByDecisionId = new Map(candidates.map((c) => [c.decision.id, c]));

  const worseningRiskTitles = new Set((context?.riskEscalations ?? []).filter((r) => r.trend === "worsening" || r.reopened).map((r) => r.riskTitle));
  const dangerousDependencyIds = new Set((context?.dependencyRadar ?? []).filter((d) => d.heat === "HIGH" || d.heat === "CRITICAL").map((d) => d.dependencyId));
  const driftingFixVersions = new Set((context?.releaseDrift ?? []).filter((r) => r.level === "DRIFTING" || r.level === "SEVERE").map((r) => r.fixVersion));

  return data.decisions
    .filter((d) => OPEN_STATUSES.has(d.status))
    .map((decision) => {
      const candidate = candidatesByDecisionId.get(decision.id);
      const reasons = candidate?.reasons ?? [];

      const anchorDate = decision.date ?? decision.dueDate;
      const stalenessDays = anchorDate ? Math.max(0, daysBetween(anchorDate, today)) : 0;

      const relatedIds = decision.relatedWorkItemIds?.length
        ? new Set(decision.relatedWorkItemIds)
        : new Set(data.workItems.filter((w) => w.projectId === decision.projectId).map((w) => w.id));
      const relatedItems = data.workItems.filter((w) => relatedIds.has(w.id));
      const newEvidenceCount = relatedItems.reduce((s, w) => s + w.scopeChangeCount, 0);

      const whyReview = [...reasons];
      let score = reasons.length;

      const stalenessTrigger = stalenessDays >= 14 && newEvidenceCount >= 3;
      if (stalenessTrigger) {
        whyReview.push(`unchanged for ${stalenessDays} day(s) while ${newEvidenceCount} scope change(s) accumulated on related items`);
        score += 2;
      }

      const relatedRiskTitles = relatedItems.flatMap((w) => w.riskIds).map((rid) => data.risks.find((r) => r.id === rid)?.title).filter((t): t is string => !!t);
      const worseningRelatedRisk = relatedRiskTitles.find((t) => worseningRiskTitles.has(t));
      if (worseningRelatedRisk) {
        whyReview.push(`a related risk is escalating: ${worseningRelatedRisk}`);
        score += 2;
      }

      const relatedDependencyIds = relatedItems.flatMap((w) => w.dependencyIds);
      const dangerousRelatedDependency = relatedDependencyIds.find((id) => dangerousDependencyIds.has(id));
      if (dangerousRelatedDependency) {
        whyReview.push("a related dependency has become HIGH/CRITICAL heat");
        score += 2;
      }

      const relatedFixVersions = new Set(relatedItems.map((w) => w.fixVersion).filter((v): v is string => !!v));
      const drifting = Array.from(relatedFixVersions).find((v) => driftingFixVersions.has(v));
      if (drifting) {
        whyReview.push(`release ${drifting} is drifting`);
        score += 2;
      }

      const relatedActionIneffective = context?.ineffectiveActionWorkItemIds && relatedItems.some((w) => context.ineffectiveActionWorkItemIds.has(w.id));
      if (relatedActionIneffective) {
        whyReview.push("a related action did not resolve the underlying issue");
        score += 1;
      }

      const reviewDatePassed = decision.reviewDate && decision.reviewDate <= today;
      if (reviewDatePassed) {
        whyReview.push(`review was due ${decision.reviewDate}`);
        score += 2;
      }

      const needsAttention = score > 0;
      const reviewUrgency: "REVIEW" | "URGENT_REVIEW" = score >= 4 ? "URGENT_REVIEW" : "REVIEW";
      const confidence = Math.min(0.5 + whyReview.length * 0.1, 0.9);

      return {
        decisionId: decision.id,
        decision,
        reasons,
        stalenessDays,
        newEvidenceCount,
        needsAttention,
        evidence: candidate?.evidence ?? [],
        reviewUrgency,
        whyReview,
        confidence,
      } satisfies DecisionRadarItem;
    })
    .filter((item) => item.needsAttention)
    .sort((a, b) => (b.reviewUrgency === "URGENT_REVIEW" ? 1 : 0) - (a.reviewUrgency === "URGENT_REVIEW" ? 1 : 0) || b.whyReview.length - a.whyReview.length || b.stalenessDays - a.stalenessDays);
}
