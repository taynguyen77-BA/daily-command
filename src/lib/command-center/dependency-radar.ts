// Dependency Radar + Dependency Heat (V1.4 §10-11). Enhances the existing Dependency
// model — no new persisted entity, purely a deterministic rollup over Dependency +
// WorkItem + Risk. Never invents a target resolution date.
//
// HEAT WEIGHTING (documented, capped 0-100):
//   Age:                    min(ageDays, 10) * 3   (max 30)
//   Blocked items:          min(blockedItemCount, 5) * 6  (max 30)
//   High-priority blocked:  min(blockedHighPriorityCount, 3) * 10  (max 30)
//   Release proximity:      +20 if <=3 days to a linked release, +10 if <=14 days
//   Linked risk severity:   +15 HIGH, +7 MEDIUM
// LEVELS: CRITICAL >= 70, HIGH >= 45, MEDIUM >= 20, else LOW.

import { daysBetween } from "./scoring";
import type { CommandCenterData, DependencyHeat, DependencyRadarItem, Risk, RiskLevel } from "./types";

const RISK_ORDER: Record<RiskLevel, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

function classifyHeat(score: number): DependencyHeat {
  if (score >= 70) return "CRITICAL";
  if (score >= 45) return "HIGH";
  if (score >= 20) return "MEDIUM";
  return "LOW";
}

export function computeDependencyRadar(data: CommandCenterData, risks: Risk[], today: string): DependencyRadarItem[] {
  const openRisksByWorkItem = new Map<string, Risk[]>();
  for (const r of risks) {
    if (r.status !== "open") continue;
    for (const id of r.sourceWorkItemIds) openRisksByWorkItem.set(id, [...(openRisksByWorkItem.get(id) ?? []), r]);
  }

  return data.dependencies
    .filter((dep) => dep.status === "unresolved")
    .map((dep) => {
      const blockedItems = data.workItems.filter((w) => w.dependencyIds.includes(dep.id) && w.status !== "Done");
      const blockedItemCount = blockedItems.length;
      const blockedHighPriorityCount = blockedItems.filter((w) => w.priority === "P1" || w.priority === "P2").length;
      const ageDays = daysBetween(dep.raisedDate, today);

      const withDueDate = blockedItems.filter((w) => w.fixVersion && w.dueDate);
      const nearest = withDueDate.sort((a, b) => daysBetween(today, a.dueDate!) - daysBetween(today, b.dueDate!))[0];
      const releaseProximity = nearest ? { fixVersion: nearest.fixVersion!, daysToRelease: daysBetween(today, nearest.dueDate!) } : undefined;

      const linkedRisks = blockedItems.flatMap((w) => openRisksByWorkItem.get(w.id) ?? []);
      const linkedRiskLevel = linkedRisks.sort((a, b) => RISK_ORDER[a.level] - RISK_ORDER[b.level])[0]?.level;

      const ageScore = Math.min(ageDays, 10) * 3;
      const blockedScore = Math.min(blockedItemCount, 5) * 6;
      const highPriorityScore = Math.min(blockedHighPriorityCount, 3) * 10;
      const releaseScore = releaseProximity ? (releaseProximity.daysToRelease <= 3 ? 20 : releaseProximity.daysToRelease <= 14 ? 10 : 0) : 0;
      const riskScore = linkedRiskLevel === "HIGH" ? 15 : linkedRiskLevel === "MEDIUM" ? 7 : 0;
      const score = Math.min(100, ageScore + blockedScore + highPriorityScore + releaseScore + riskScore);
      const heat = classifyHeat(score);

      const recommended = !dep.ownerId
        ? "Escalate ownership and confirm target resolution date."
        : releaseProximity && releaseProximity.daysToRelease <= 7
          ? `Escalate resolution urgently — release ${releaseProximity.fixVersion} is ${releaseProximity.daysToRelease} day(s) away.`
          : `Confirm target resolution date with ${dep.dependsOnTeam}.`;

      const evidence = [
        `Raised ${dep.raisedDate} (${ageDays} day(s) ago)`,
        `Blocking ${blockedItemCount} work item(s)`,
        ...(blockedHighPriorityCount > 0 ? [`${blockedHighPriorityCount} high-priority item(s) blocked`] : []),
        ...(releaseProximity ? [`Nearest linked release ${releaseProximity.fixVersion} in ${releaseProximity.daysToRelease} day(s)`] : []),
        ...(linkedRiskLevel ? [`Linked to a ${linkedRiskLevel}-severity risk`] : []),
      ];

      return {
        dependencyId: dep.id,
        description: dep.description,
        dependsOnTeam: dep.dependsOnTeam,
        ownerId: dep.ownerId,
        ageDays,
        blockedItemCount,
        blockedHighPriorityCount,
        releaseProximity,
        linkedRiskLevel,
        heat,
        recommended,
        evidence,
      } satisfies DependencyRadarItem;
    })
    .sort((a, b) => {
      const heatOrder: Record<DependencyHeat, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
      return heatOrder[a.heat] - heatOrder[b.heat] || b.ageDays - a.ageDays;
    });
}
