// Release Drift (V1.4 §34). Extends Release Health with a snapshot-over-snapshot delta —
// recomputes release health from the previous snapshot's raw workItems using the existing
// selectReleaseHealth() (the one release selector — never a second, divergent implementation).

import { isInRelease, selectReleaseHealth } from "./release-health";
import type { WorkRelevanceIndex } from "./jira/work-relevance";
import type { CommandCenterData, DailySnapshot, DriftLevel, ReleaseDrift, ReleaseHealth } from "./types";

function classifyLevel(score: number): DriftLevel {
  if (score >= 60) return "SEVERE";
  if (score >= 35) return "DRIFTING";
  if (score >= 15) return "WATCH";
  return "STABLE";
}

/** B5 — `workRelevanceIndex` (optional, additive) makes the previous-snapshot side use the same
 *  release truth as `current`; `currentWorkItems` (optional) adds the tickets that joined/left
 *  each release since the snapshot. */
export function computeReleaseDrift(
  current: ReleaseHealth[],
  previousSnapshot: DailySnapshot | null,
  today: string,
  workRelevanceIndex?: WorkRelevanceIndex,
  currentWorkItems?: CommandCenterData["workItems"]
): ReleaseDrift[] {
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
      const hadItemsBefore = previousSnapshot.workItems.some((w) => isInRelease(w, health.fixVersion));
      if (!hadItemsBefore) return null;
      const previousHealth = selectReleaseHealth(previousData, health.fixVersion, today, workRelevanceIndex);
      const before = new Set(previousSnapshot.workItems.filter((w) => isInRelease(w, health.fixVersion)).map((w) => w.key));
      const after = currentWorkItems ? new Set(currentWorkItems.filter((w) => isInRelease(w, health.fixVersion)).map((w) => w.key)) : undefined;

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
        ...(after
          ? {
              scopeAdded: Array.from(after).filter((k) => !before.has(k)).sort(),
              scopeRemoved: Array.from(before).filter((k) => !after.has(k)).sort(),
            }
          : {}),
      } satisfies ReleaseDrift;
    })
    .filter((r): r is ReleaseDrift => r !== null)
    .sort((a, b) => a.confidenceDelta - b.confidenceDelta);
}
