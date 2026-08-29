// Release Drift (V1.4 §34). Extends Release Health with a snapshot-over-snapshot delta —
// recomputes release health from the previous snapshot's raw workItems using the existing
// computeReleaseHealth() (never a second, divergent implementation).

import { computeReleaseHealth } from "./release-health";
import type { CommandCenterData, DailySnapshot, DriftLevel, ReleaseDrift, ReleaseHealth } from "./types";

function classifyLevel(score: number): DriftLevel {
  if (score >= 60) return "SEVERE";
  if (score >= 35) return "DRIFTING";
  if (score >= 15) return "WATCH";
  return "STABLE";
}

export function computeReleaseDrift(current: ReleaseHealth[], previousSnapshot: DailySnapshot | null, today: string): ReleaseDrift[] {
  if (!previousSnapshot) return [];

  const previousData: CommandCenterData = {
    clients: [],
    projects: previousSnapshot.projects,
    workItems: previousSnapshot.workItems,
    requirements: previousSnapshot.requirements,
    risks: previousSnapshot.risks,
    dependencies: previousSnapshot.dependencies,
    decisions: [],
    actions: [],
    communications: [],
  };

  return current
    .map((health) => {
      const hadItemsBefore = previousSnapshot.workItems.some((w) => w.fixVersion === health.fixVersion);
      if (!hadItemsBefore) return null;
      const previousHealth = computeReleaseHealth(previousData, health.fixVersion, today);

      const completionDelta = health.completionPct - previousHealth.completionPct;
      const blockedDelta = health.blockedCount - previousHealth.blockedCount;
      const confidenceDelta = health.deliveryConfidence - previousHealth.deliveryConfidence;
      const scopeDelta = health.totalItems - previousHealth.totalItems;

      const drivers: string[] = [];
      let score = 0;
      if (completionDelta < 0) { score += Math.min(Math.abs(completionDelta) * 2, 30); drivers.push(`completion slowed (${previousHealth.completionPct}% → ${health.completionPct}%)`); }
      if (blockedDelta > 0) { score += Math.min(blockedDelta * 10, 30); drivers.push(`blockers increased (${previousHealth.blockedCount} → ${health.blockedCount})`); }
      if (confidenceDelta < 0) { score += Math.min(Math.abs(confidenceDelta) * 1.5, 30); drivers.push(`confidence decreased (${previousHealth.deliveryConfidence} → ${health.deliveryConfidence})`); }
      if (scopeDelta > 0) { score += Math.min(scopeDelta * 4, 10); drivers.push(`scope increased by ${scopeDelta} item(s)`); }

      return {
        fixVersion: health.fixVersion,
        level: classifyLevel(Math.round(score)),
        completionDelta,
        blockedDelta,
        confidenceDelta,
        scopeDelta,
        drivers,
      } satisfies ReleaseDrift;
    })
    .filter((r): r is ReleaseDrift => r !== null)
    .sort((a, b) => a.confidenceDelta - b.confidenceDelta);
}
