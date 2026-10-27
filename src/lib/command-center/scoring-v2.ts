// Priority Score v2 (P3.1) — pure, deterministic, reproducible. Max 100; a factor with no data
// contributes 0 and lowers `confidence` — it never invents a value.
//
// WEIGHT TABLE (Jira data: businessImpact is never provided)          | with businessImpact (demo / import)
//   Priority         20  P1 20 · P2 14 · P3 7 · P4 0 · unknown 0      | scaled to 10: P1 10 · P2 7 · P3 4 · P4 0
//   Business impact   -  (n/a)                                        | 0-10 (rating x 2)
//   Deadline         20  as v1 (overdue 20 … >14 days 0)
//   Awaiting me      15  unanswered mention of me, by age vs the 2-business-day SLA (awaiting-me.ts)
//   Blocker          15  blocked
//   Dependency        5  1 unresolved = 3, 2 or more = 5
//   Aging            10  days since the status category changed (else last update), max 10
//   Change frequency 10  min(scope changes, 5) x 2 (as v1)
//   Ownership         5  no owner
// Classification thresholds are unchanged (80 / 60 / 40, score-core.ts).
//
// DEVIATION from the prompt's table (Dependency 10 / Change 5): with those weights an overdue, blocked
// P1 ticket with no dependency links and no mention tops out at 75 (HIGH), which contradicts the seed
// acceptance test (it must reach CRITICAL). 5 points moved from Dependency (sparse in real Jira: links
// are rarely modelled as dependencies) to Change frequency (v1's weight). The total stays 100.

import { awaitingMeAgeBusinessDays, awaitingMePoints, REPLY_SLA_BUSINESS_DAYS } from "./awaiting-me";
import { classify, daysBetween } from "./score-core";
import type { ScoringOptions } from "./scoring";
import { LEARN_MAX_DELTA, learnedDeltaFor } from "./learned-adjustments";
import type { CommandCenterData, PriorityFactor, PriorityScoreResult, WorkItem } from "./types";

export const LEARNED_FACTOR = "Learned (you)";
const PRIORITY_POINTS = { P1: 20, P2: 14, P3: 7, P4: 0 } as const;
export const SCORE_V2_MAX = { priority: 20, priorityWithBusinessImpact: 10, businessImpact: 10, deadline: 20, awaitingMe: 15, blocker: 15, dependency: 5, aging: 10, change: 10, ownership: 5 } as const;

/** Priority is only trusted when Jira actually gave a recognised one (WorkItem.priorityKnown, set by
 *  jira/normalize.ts). Items from other sources never carry the flag and are trusted as entered. */
export function isPriorityKnown(item: WorkItem): boolean {
  return item.priorityKnown !== false;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export function scoreWorkItemV2(item: WorkItem, data: CommandCenterData, today: string, options: ScoringOptions = {}): PriorityScoreResult {
  const factors: PriorityFactor[] = [];
  const hasImpact = item.businessImpact !== undefined;
  const known = isPriorityKnown(item);

  // Priority (20; 10 when a business-impact rating shares the weight).
  const prioMax = hasImpact ? SCORE_V2_MAX.priorityWithBusinessImpact : SCORE_V2_MAX.priority;
  const prioRaw = known ? PRIORITY_POINTS[item.priority] : 0;
  const prioPts = hasImpact ? Math.round(prioRaw / 2) : prioRaw;
  factors.push({
    name: "Priority",
    contribution: prioPts,
    max: prioMax,
    detail: !known ? "Priority not set in Jira" : item.jiraPriorityName ? `Priority ${item.priority} (${item.jiraPriorityName} in Jira)` : `Priority ${item.priority}`,
  });

  if (hasImpact) factors.push({ name: "Business impact", contribution: item.businessImpact! * 2, max: SCORE_V2_MAX.businessImpact, detail: `Business impact rated ${item.businessImpact}/5` });

  // Deadline — identical to v1.
  let urgency = 0;
  let urgencyDetail = "No due date set";
  if (item.dueDate) {
    const days = daysBetween(today, item.dueDate);
    if (days < 0) { urgency = 20; urgencyDetail = `Overdue by ${plural(Math.abs(days), "day", "days")}`; }
    else if (days <= 1) { urgency = 18; urgencyDetail = days === 0 ? "Due today" : "Due tomorrow"; }
    else if (days <= 3) { urgency = 14; urgencyDetail = `Due in ${days} days`; }
    else if (days <= 7) { urgency = 8; urgencyDetail = `Due in ${days} days`; }
    else if (days <= 14) { urgency = 4; urgencyDetail = `Due in ${days} days`; }
    else { urgency = 0; urgencyDetail = `Due in ${days} days`; }
  }
  factors.push({ name: "Deadline proximity", contribution: urgency, max: SCORE_V2_MAX.deadline, detail: urgencyDetail });

  // Awaiting me.
  const signal = options.awaitingMeByKey?.[item.key];
  let awaiting = 0;
  let awaitingDetail = "Nothing waiting on you";
  if (signal) {
    const age = awaitingMeAgeBusinessDays(signal, today);
    awaiting = awaitingMePoints(age, REPLY_SLA_BUSINESS_DAYS);
    awaitingDetail = `Awaiting your reply for ${plural(age, "business day", "business days")}${signal.count > 1 ? ` (${signal.count} mentions)` : ""}`;
  }
  factors.push({ name: "Awaiting you", contribution: awaiting, max: SCORE_V2_MAX.awaitingMe, detail: awaitingDetail });

  factors.push({ name: "Blocker status", contribution: item.blocked ? 15 : 0, max: SCORE_V2_MAX.blocker, detail: item.blocked ? (item.blockerReason ?? "Currently blocked") : "Not blocked" });

  const unresolvedDeps = data.dependencies.filter((d) => item.dependencyIds.includes(d.id) && d.status === "unresolved").length;
  factors.push({ name: "Dependency risk", contribution: unresolvedDeps >= 2 ? 5 : unresolvedDeps === 1 ? 3 : 0, max: SCORE_V2_MAX.dependency, detail: unresolvedDeps > 0 ? `${plural(unresolvedDeps, "unresolved dependency", "unresolved dependencies")}` : "No unresolved dependencies" });

  // Aging prefers the moment the status category last changed (real stagnation), else the last update.
  const agingFrom = item.statusCategoryChangedAt ? item.statusCategoryChangedAt.slice(0, 10) : item.lastUpdated;
  const agingDays = Math.max(0, daysBetween(agingFrom, today));
  factors.push({ name: "Aging", contribution: Math.min(agingDays, 10), max: SCORE_V2_MAX.aging, detail: item.statusCategoryChangedAt ? `In this status category for ${plural(agingDays, "day", "days")}` : `Last updated ${plural(agingDays, "day", "days")} ago` });

  factors.push({ name: "Change frequency", contribution: Math.min(item.scopeChangeCount, 5) * 2, max: SCORE_V2_MAX.change, detail: `${item.scopeChangeCount} scope change(s) recorded` });
  factors.push({ name: "Ownership risk", contribution: item.owner ? 0 : 5, max: SCORE_V2_MAX.ownership, detail: item.owner ? `Owned by ${item.owner}` : "No owner assigned" });

  // P3.3 — learned personal adjustment. Shadow: shown only. On: a LEARNED factor. Hard rules (overdue, blocked,
  // P1, awaiting-you past SLA) stop any negative delta.
  let learnedShadow: PriorityScoreResult["learnedShadow"];
  if (options.learned && options.learned.mode !== "off") {
    const look = learnedDeltaFor(item, options.learned.signalKindByKey?.[item.key] ?? "OTHER", options.learned.adjustments, { today, awaitingMe: signal });
    if (look.delta !== 0 && look.adjustment) {
      if (options.learned.mode === "on") factors.push({ name: LEARNED_FACTOR, contribution: look.delta, max: LEARN_MAX_DELTA, detail: look.adjustment.evidence, trust: "LEARNED" });
      else learnedShadow = { delta: look.delta, detail: look.adjustment.evidence };
    }
  }

  const score = Math.max(0, Math.min(100, Math.round(factors.reduce((s, f) => s + f.contribution, 0))));

  // Confidence = data completeness. Every missing input costs a little, none is guessed.
  let confidence = 0.95;
  if (!item.dueDate) confidence -= 0.15;
  if (!item.owner) confidence -= 0.1;
  if (!known) confidence -= 0.05;
  if (item.type === "release" && item.uatCompletionPct === undefined) confidence -= 0.1;
  confidence = Math.max(0.5, Math.round(confidence * 100) / 100);

  const top = factors.filter((f) => f.name !== LEARNED_FACTOR).sort((a, b) => b.contribution - a.contribution).slice(0, 2).filter((f) => f.contribution > 0);
  const reasoning = top.length > 0 ? `Scored ${score}/100: ${top.map((f, i) => (i === 0 ? f.detail : lowerFirst(f.detail))).join(" and ")}.` : `Scored ${score}/100 — no significant risk factors detected.`;

  return { itemId: item.id, score, classification: classify(score), factors, confidence, reasoning, ...(learnedShadow ? { learnedShadow } : {}) };
}

/** Same idea as v1's eligibilityScore: rescale against only the factors this item's data can speak to. */
export function eligibilityScoreV2(item: WorkItem, result: PriorityScoreResult): number {
  let maxAchievable = 100;
  if (!isPriorityKnown(item)) maxAchievable -= item.businessImpact !== undefined ? SCORE_V2_MAX.priorityWithBusinessImpact : SCORE_V2_MAX.priority;
  if (!item.dueDate) maxAchievable -= SCORE_V2_MAX.deadline;
  if (maxAchievable >= 100 || maxAchievable <= 0) return result.score;
  return Math.round((result.score * 100) / maxAchievable);
}
