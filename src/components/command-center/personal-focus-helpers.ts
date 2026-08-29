// Shared helpers for the V1.6 Personal Focus UI. Not a new data layer — just glue between
// live PersonalFocusCandidate[] (personal-focus.ts) and the persisted PersonalPlanItem[]
// (store.ts), so components don't duplicate this join logic.

import type { CommandCenterStore } from "@/lib/command-center/store";
import type { PersonalFocusCandidate, PersonalPlanItem } from "@/lib/command-center/types";

/** Finds today's active plan item for a candidate, or creates one on demand — lets
 *  [START FOCUS] work directly from Top 3 / the 30-minute plan without first requiring the
 *  user to build and accept a full daily plan (§16 is the primary interaction). */
export function ensurePlanItemId(store: CommandCenterStore, personalPlan: PersonalPlanItem[], candidate: PersonalFocusCandidate, today: string, rankHint: number): string {
  const existing = personalPlan.find((p) => p.sourceType === candidate.sourceType && p.sourceId === candidate.sourceId && p.plannedDate === today && p.status !== "completed" && p.status !== "skipped");
  if (existing) return existing.id;
  return store.addPersonalPlanItem({
    sourceType: candidate.sourceType,
    sourceId: candidate.sourceId,
    estimatedMinutes: candidate.estimatedMinutes,
    plannedDate: today,
    priority: rankHint,
    snapshot: { category: candidate.category, projectId: candidate.projectId, ownershipExplicit: candidate.ownershipExplicit },
  });
}

export function openSourceHref(candidate: PersonalFocusCandidate): string {
  if (candidate.decisionId) return "/decisions";
  if (candidate.sourceType === "loop") return "/loops";
  return "/attention";
}
