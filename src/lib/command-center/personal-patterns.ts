// Personal pattern detection + "My Delivery Review" facts (V1.6 §21, §23, §46-49). Fully
// deterministic — reads only PersonalPlanItem history plus the already-computed
// PersonalFocusCandidate list. Every finding is evidence-first and descriptive (§23) —
// this module must never emit a trait or performance judgment.

import { daysBetween } from "./scoring";
import { projectName as lookupProjectName } from "./selectors";
import type { ActionEffectivenessResult, CommandCenterData, PersonalFocusCandidate, PersonalDeliveryReviewFacts, PersonalPattern, PersonalPlanItem } from "./types";

const PATTERN_THRESHOLD = 3;

export function detectPersonalPatterns(planItems: PersonalPlanItem[], windowDays: number, today: string): PersonalPattern[] {
  const inWindow = planItems.filter((p) => daysBetween(p.plannedDate, today) <= windowDays && daysBetween(p.plannedDate, today) >= 0);
  const patterns: PersonalPattern[] = [];

  const skipped = inWindow.filter((p) => p.status === "skipped");
  if (skipped.length >= PATTERN_THRESHOLD) {
    patterns.push({
      id: "repeatedly-skipped",
      kind: "repeatedly-skipped",
      title: `${skipped.length} focus items were skipped this window.`,
      occurrences: skipped.length,
      evidence: skipped.slice(0, 5).map((p) => `${p.sourceType}:${p.sourceId} — planned ${p.plannedDate}`),
    });
  }

  const blocked = inWindow.filter((p) => p.status === "blocked");
  if (blocked.length >= PATTERN_THRESHOLD) {
    patterns.push({
      id: "repeatedly-blocked",
      kind: "repeatedly-blocked",
      title: `${blocked.length} focus items were marked blocked this window.`,
      occurrences: blocked.length,
      evidence: blocked.slice(0, 5).map((p) => `${p.sourceType}:${p.sourceId} — planned ${p.plannedDate}`),
    });
  }

  const deferredDecisions = inWindow.filter((p) => p.status === "deferred" && p.sourceType === "loop");
  if (deferredDecisions.length >= PATTERN_THRESHOLD) {
    patterns.push({
      id: "repeatedly-deferred-decisions",
      kind: "repeatedly-deferred-decisions",
      title: `${deferredDecisions.length} decision-related items were deferred this window.`,
      occurrences: deferredDecisions.length,
      evidence: deferredDecisions.slice(0, 5).map((p) => `${p.sourceType}:${p.sourceId} — planned ${p.plannedDate}`),
    });
  }

  return patterns;
}

export function detectProjectConcentration(candidates: PersonalFocusCandidate[]): PersonalPattern | null {
  const actionable = candidates.filter((c) => c.category === "DO_NOW" || c.category === "DO_TODAY");
  if (actionable.length < PATTERN_THRESHOLD) return null;
  const byProject = new Map<string, number>();
  for (const c of actionable) {
    if (!c.projectId) continue;
    byProject.set(c.projectId, (byProject.get(c.projectId) ?? 0) + 1);
  }
  const top = Array.from(byProject.entries()).sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] < Math.ceil(actionable.length * 0.6)) return null;
  const name = actionable.find((c) => c.projectId === top[0])?.projectName ?? top[0];
  return {
    id: "project-concentration",
    kind: "project-concentration",
    title: `${name} accounts for ${top[1]} of ${actionable.length} current focus item(s).`,
    occurrences: top[1],
    evidence: [`${name}: ${top[1]}/${actionable.length} DO_NOW/DO_TODAY items`],
  };
}

export function buildPersonalDeliveryReviewFacts(
  planItems: PersonalPlanItem[],
  candidates: PersonalFocusCandidate[],
  actionEffectiveness: ActionEffectivenessResult[],
  data: CommandCenterData,
  windowDays: number,
  today: string
): PersonalDeliveryReviewFacts {
  const inWindow = planItems.filter((p) => {
    const age = daysBetween(p.plannedDate, today);
    return age >= 0 && age <= windowDays;
  });

  const completed = inWindow.filter((p) => p.status === "completed");
  const blocked = inWindow.filter((p) => p.status === "blocked");
  const skipped = inWindow.filter((p) => p.status === "skipped");
  const deferred = inWindow.filter((p) => p.status === "deferred");

  const projectIds = new Set(
    completed
      .map((p) => candidates.find((c) => c.sourceType === p.sourceType && c.sourceId === p.sourceId)?.projectId)
      .filter((id): id is string => !!id)
  );
  const projectsWorkedIn = Array.from(projectIds).map((id) => lookupProjectName(data, id));

  const effectiveActionsCount = actionEffectiveness.filter((r) => r.classification === "EFFECTIVE").length;
  const ineffectiveActionsCount = actionEffectiveness.filter((r) => r.classification === "INEFFECTIVE").length;
  const decisionsReviewedCount = inWindow.filter((p) => p.sourceType === "loop" && p.status === "completed").length;

  const patterns = [...detectPersonalPatterns(planItems, windowDays, today)];
  const concentration = detectProjectConcentration(candidates);
  if (concentration) patterns.push(concentration);

  const stillRelevantSkipped: PersonalDeliveryReviewFacts["stillRelevantSkipped"] = [];
  const noLongerRelevantSkipped: string[] = [];
  for (const p of skipped) {
    const live = candidates.find((c) => c.sourceType === p.sourceType && c.sourceId === p.sourceId);
    if (live && live.category !== "DEFER") {
      stillRelevantSkipped.push({ title: live.title, sourceType: p.sourceType, sourceId: p.sourceId });
    } else {
      noLongerRelevantSkipped.push(`${p.sourceType}:${p.sourceId}`);
    }
  }

  return {
    windowDays,
    plannedCount: inWindow.length,
    completedCount: completed.length,
    blockedCount: blocked.length,
    skippedCount: skipped.length,
    deferredCount: deferred.length,
    projectsWorkedIn,
    effectiveActionsCount,
    ineffectiveActionsCount,
    decisionsReviewedCount,
    patterns,
    stillRelevantSkipped,
    noLongerRelevantSkipped,
  };
}
