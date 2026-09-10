// Deterministic AI Priority Model (BUILD REQUEST §7).
// Pure functions, no AI calls — every number here must be reproducible and explainable.

import { isWorkItemOperationallyOpen, type WorkRelevanceIndex } from "./jira/work-relevance";
import type { CommandCenterData, PriorityFactor, PriorityScoreResult, Severity, WorkItem } from "./types";

export function daysBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso + "T00:00:00");
  const to = new Date(toIso + "T00:00:00");
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

export function classify(score: number): Severity {
  if (score >= 80) return "CRITICAL";
  if (score >= 60) return "HIGH";
  if (score >= 40) return "MEDIUM";
  return "LOW";
}

/**
 * Weights sum to 100 at max contribution:
 *   Business impact (0-20) + Urgency/deadline (0-20) + Dependency risk (0-15)
 *   + Aging (0-10) + Blocker status (0-15) + Change frequency (0-10) + Ownership risk (0-10)
 */
export function scoreWorkItem(item: WorkItem, data: CommandCenterData, today: string): PriorityScoreResult {
  const factors: PriorityFactor[] = [];

  // V1.3 §17: a Jira-sourced item may not carry a business-impact-equivalent field —
  // never infer one from priority. Contributes 0 rather than a fabricated mid-value.
  const businessImpact = item.businessImpact !== undefined ? item.businessImpact * 4 : 0;
  factors.push({
    name: "Business impact",
    contribution: businessImpact,
    max: 20,
    detail: item.businessImpact !== undefined ? `Business impact rated ${item.businessImpact}/5` : "Business impact not provided",
  });

  let urgency = 0;
  let urgencyDetail = "No due date set";
  if (item.dueDate) {
    const days = daysBetween(today, item.dueDate);
    if (days < 0) { urgency = 20; urgencyDetail = `Overdue by ${Math.abs(days)} day(s)`; }
    else if (days <= 1) { urgency = 18; urgencyDetail = days === 0 ? "Due today" : "Due tomorrow"; }
    else if (days <= 3) { urgency = 14; urgencyDetail = `Due in ${days} days`; }
    else if (days <= 7) { urgency = 8; urgencyDetail = `Due in ${days} days`; }
    else if (days <= 14) { urgency = 4; urgencyDetail = `Due in ${days} days`; }
    else { urgency = 0; urgencyDetail = `Due in ${days} days`; }
  }
  factors.push({ name: "Deadline proximity", contribution: urgency, max: 20, detail: urgencyDetail });

  const unresolvedDeps = data.dependencies.filter(
    (d) => item.dependencyIds.includes(d.id) && d.status === "unresolved"
  ).length;
  const dependencyRisk = Math.min(unresolvedDeps, 3) * 5;
  factors.push({
    name: "Dependency risk",
    contribution: dependencyRisk,
    max: 15,
    detail: unresolvedDeps > 0 ? `${unresolvedDeps} unresolved dependenc${unresolvedDeps === 1 ? "y" : "ies"}` : "No unresolved dependencies",
  });

  const agingDays = Math.max(0, daysBetween(item.lastUpdated, today));
  const aging = Math.min(agingDays, 10);
  factors.push({
    name: "Aging",
    contribution: aging,
    max: 10,
    detail: `Last updated ${agingDays} day(s) ago`,
  });

  const blockerStatus = item.blocked ? 15 : 0;
  factors.push({
    name: "Blocker status",
    contribution: blockerStatus,
    max: 15,
    detail: item.blocked ? (item.blockerReason ?? "Currently blocked") : "Not blocked",
  });

  const changeFrequency = Math.min(item.scopeChangeCount, 5) * 2;
  factors.push({
    name: "Change frequency",
    contribution: changeFrequency,
    max: 10,
    detail: `${item.scopeChangeCount} scope change(s) recorded`,
  });

  const ownershipRisk = item.owner ? 0 : 10;
  factors.push({
    name: "Ownership risk",
    contribution: ownershipRisk,
    max: 10,
    detail: item.owner ? `Owned by ${item.owner}` : "No owner assigned",
  });

  const score = Math.round(factors.reduce((s, f) => s + f.contribution, 0));

  // Confidence reflects data completeness, not the AI's certainty about the future.
  let confidence = 0.95;
  if (!item.dueDate) confidence -= 0.15;
  if (!item.owner) confidence -= 0.1;
  if (item.businessImpact === undefined) confidence -= 0.1;
  if (item.type === "release" && item.uatCompletionPct === undefined) confidence -= 0.1;
  confidence = Math.max(0.5, Math.round(confidence * 100) / 100);

  const top = [...factors].sort((a, b) => b.contribution - a.contribution).slice(0, 2).filter((f) => f.contribution > 0);
  const reasoning =
    top.length > 0
      ? `Scored ${score}/100 mainly due to ${top.map((f) => f.detail.toLowerCase()).join(" and ")}.`
      : `Scored ${score}/100 — no significant risk factors detected.`;

  return { itemId: item.id, score, classification: classify(score), factors, confidence, reasoning };
}

/**
 * V2.9 §F-01 fix — the raw 0-100 score conflates "missing data" with "zero risk" for
 * Business Impact and Deadline Proximity: an item without a mapped Business Impact field
 * or a Jira due date loses up to 40 of the 100 possible points before any real signal
 * (blocker, scope churn, aging, dependency risk, ownership) is even considered. On real
 * Jira data — where neither field is reliably populated — this silently capped every
 * item's score well under the candidate-eligibility bar, regardless of genuine signal.
 * eligibilityScore rescales the raw score against only the factors this item's data can
 * actually speak to, so a genuinely high-signal item (heavily churned, blocked, aged)
 * isn't punished for a field nobody populated — while a genuinely quiet item still scores
 * low and stays excluded. Used ONLY for the candidate-pool gate (action-plan.ts); the raw
 * score/classify() severity shown on Priorities and Risks is intentionally untouched.
 */
export function eligibilityScore(item: WorkItem, result: PriorityScoreResult): number {
  let maxAchievable = 100;
  if (item.businessImpact === undefined) maxAchievable -= 20;
  if (!item.dueDate) maxAchievable -= 20;
  if (maxAchievable >= 100 || maxAchievable <= 0) return result.score;
  return Math.round((result.score * 100) / maxAchievable);
}

/** V2.21 §3.2 — `workRelevanceIndex`/`dailyCommandCompletedWorkItemIds` are additive/optional
 *  trailing parameters: omitting them reproduces the pre-V2.21 behavior exactly (raw Jira
 *  Done only). Passing them makes "open" agree with the canonical gate
 *  (isWorkItemOperationallyOpen) every other personal-work surface already uses, so a
 *  Work-Relevance-COMPLETED/EXCLUDED or Daily-Command-completed item stops being scored/
 *  counted as open work here too. */
export function scoreAllWorkItems(
  data: CommandCenterData,
  today: string,
  workRelevanceIndex?: WorkRelevanceIndex,
  dailyCommandCompletedWorkItemIds?: ReadonlySet<string>
): PriorityScoreResult[] {
  return data.workItems
    .filter((i) => isWorkItemOperationallyOpen(i, workRelevanceIndex, dailyCommandCompletedWorkItemIds))
    .map((i) => scoreWorkItem(i, data, today))
    .sort((a, b) => b.score - a.score);
}

export function isOverdue(
  item: WorkItem,
  today: string,
  workRelevanceIndex?: WorkRelevanceIndex,
  dailyCommandCompletedWorkItemIds?: ReadonlySet<string>
): boolean {
  if (!item.dueDate || !isWorkItemOperationallyOpen(item, workRelevanceIndex, dailyCommandCompletedWorkItemIds)) return false;
  return daysBetween(today, item.dueDate) < 0;
}
