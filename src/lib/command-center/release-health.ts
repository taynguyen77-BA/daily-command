// Release Health (BUILD REQUEST V1.3 §19-20). Groups by Jira Fix Version — the only
// "release" grouping V1.3 introduces (see WorkItem.fixVersion). Deliberately not a Jira
// release-management clone: no versions CRUD, no burndown, just a rollup of numbers the
// deterministic engines already compute, plus a documented readiness threshold.
//
// READINESS THRESHOLDS (deterministic, documented — Claude may explain but never override):
//   READY:     completion >= 90% AND 0 blocked AND 0 overdue AND 0 unresolved dependencies
//   NOT_READY: completion < 50% OR 3+ blocked OR 3+ overdue
//   AT_RISK:   everything in between

import { computeDeliveryConfidence } from "./executive";
import { detectRisks, RISK_LEVEL_ORDER } from "./risk-detection";
import { isOverdue, scoreAllWorkItems } from "./scoring";
import type { CommandCenterData, ReleaseHealth, ReleaseReadiness } from "./types";

function classifyReadiness(completionPct: number, blockedCount: number, overdueCount: number, unresolvedDependenciesCount: number): ReleaseReadiness {
  if (completionPct >= 90 && blockedCount === 0 && overdueCount === 0 && unresolvedDependenciesCount === 0) return "READY";
  if (completionPct < 50 || blockedCount >= 3 || overdueCount >= 3) return "NOT_READY";
  return "AT_RISK";
}

export function computeReleaseHealth(data: CommandCenterData, fixVersion: string, today: string): ReleaseHealth {
  const items = data.workItems.filter((w) => w.fixVersion === fixVersion);
  const itemIds = new Set(items.map((w) => w.id));
  const completedItems = items.filter((w) => w.status === "Done").length;
  const completionPct = items.length > 0 ? Math.round((completedItems / items.length) * 100) : 0;
  const blockedCount = items.filter((w) => w.blocked).length;
  const overdueCount = items.filter((w) => isOverdue(w, today)).length;
  const unresolvedDependenciesCount = data.dependencies.filter((d) => itemIds.has(d.workItemId) && d.status === "unresolved").length;
  const highPriorityIncompleteCount = items.filter((w) => (w.priority === "P1" || w.priority === "P2") && w.status !== "Done").length;
  const withUat = items.filter((w) => w.uatCompletionPct !== undefined);
  const avgUatCompletionPct = withUat.length > 0 ? Math.round(withUat.reduce((s, w) => s + (w.uatCompletionPct ?? 0), 0) / withUat.length) : undefined;

  const scores = scoreAllWorkItems({ ...data, workItems: items }, today);
  const releaseRisks = [...data.risks.filter((r) => r.sourceWorkItemIds.some((id) => itemIds.has(id))), ...detectRisks({ ...data, workItems: items }, today)]
    .filter((r) => r.status === "open")
    .sort((a, b) => RISK_LEVEL_ORDER[a.level] - RISK_LEVEL_ORDER[b.level]);
  const deliveryConfidence = computeDeliveryConfidence(scores, releaseRisks, overdueCount);

  return {
    fixVersion,
    totalItems: items.length,
    completedItems,
    completionPct,
    blockedCount,
    overdueCount,
    unresolvedDependenciesCount,
    highPriorityIncompleteCount,
    avgUatCompletionPct,
    deliveryConfidence,
    readiness: classifyReadiness(completionPct, blockedCount, overdueCount, unresolvedDependenciesCount),
    topRiskTitle: releaseRisks[0]?.title,
  };
}

export function computeAllReleaseHealth(data: CommandCenterData, today: string): ReleaseHealth[] {
  const versions = Array.from(new Set(data.workItems.map((w) => w.fixVersion).filter((v): v is string => !!v)));
  return versions.map((v) => computeReleaseHealth(data, v, today)).sort((a, b) => a.deliveryConfidence - b.deliveryConfidence);
}
