// Project Memory (BUILD REQUEST V1.2 §2-4). Snapshots are built from data the app already
// computes elsewhere — scoring, risk detection, executive confidence — never recalculated
// with different logic. This module only captures and compares, it never invents a number.

import { toSnapshot } from "./change-detection";
import { computeDeliveryConfidence } from "./executive";
import { detectRisks, RISK_LEVEL_ORDER } from "./risk-detection";
import { isOverdue, scoreAllWorkItems } from "./scoring";
import type { CommandCenterData, DailySnapshot, HealthTrend, MetricDelta, SnapshotMetrics, TrendDirection } from "./types";

export function buildSnapshotMetrics(data: CommandCenterData, today: string, meaningfulChangeCount: number): SnapshotMetrics {
  const scores = scoreAllWorkItems(data, today);
  const risks = [...data.risks.filter((r) => r.status === "open"), ...detectRisks(data, today)];
  const seenTitles = new Set<string>();
  const dedupedRisks = risks.filter((r) => (seenTitles.has(r.title) ? false : (seenTitles.add(r.title), true)));
  const highRisks = dedupedRisks.filter((r) => r.level === "HIGH").sort((a, b) => RISK_LEVEL_ORDER[a.level] - RISK_LEVEL_ORDER[b.level]);
  const openItems = data.workItems.filter((w) => w.status !== "Done");
  const unresolvedDeps = data.dependencies.filter((d) => d.status === "unresolved");

  return {
    attentionCount: scores.filter((s) => s.classification === "CRITICAL" || s.classification === "HIGH").length,
    criticalCount: scores.filter((s) => s.classification === "CRITICAL").length,
    highRiskCount: highRisks.length,
    blockedCount: openItems.filter((w) => w.blocked).length,
    overdueCount: openItems.filter((w) => isOverdue(w, today)).length,
    deliveryConfidence: computeDeliveryConfidence(scores, dedupedRisks, openItems.filter((w) => isOverdue(w, today)).length),
    openDecisionsCount: data.decisions.filter((d) => d.status === "pending" || d.status === "ACTIVE" || d.status === "AT_RISK" || d.status === "REVISIT_REQUIRED").length,
    unresolvedDependenciesCount: unresolvedDeps.length,
    majorRiskTitles: highRisks.slice(0, 5).map((r) => r.title),
    unresolvedDependencyTeams: Array.from(new Set(unresolvedDeps.map((d) => d.dependsOnTeam))),
    meaningfulChangeCount,
  };
}

/** Builds the full, persistable DailySnapshot: raw data (reusing toSnapshot from
 *  change-detection.ts — never duplicated) plus computed metrics. */
export function buildDailySnapshot(data: CommandCenterData, today: string, meaningfulChangeCount: number): DailySnapshot {
  return { ...toSnapshot(data, today), metrics: buildSnapshotMetrics(data, today, meaningfulChangeCount) };
}

function direction(before: number, after: number, higherIsBetter: boolean): TrendDirection {
  if (before === after) return "stable";
  const improved = higherIsBetter ? after > before : after < before;
  return improved ? "improving" : "deteriorating";
}

const METRIC_DEFS: { key: keyof SnapshotMetrics; label: string; higherIsBetter: boolean }[] = [
  { key: "deliveryConfidence", label: "Delivery confidence", higherIsBetter: true },
  { key: "blockedCount", label: "Blocked items", higherIsBetter: false },
  { key: "highRiskCount", label: "High risks", higherIsBetter: false },
  { key: "overdueCount", label: "Overdue items", higherIsBetter: false },
  { key: "attentionCount", label: "Items needing attention", higherIsBetter: false },
  { key: "unresolvedDependenciesCount", label: "Unresolved dependencies", higherIsBetter: false },
];

/** BUILD REQUEST V1.2 §4 — deterministic Today vs Yesterday comparison. Never calls AI. */
export function compareSnapshots(current: SnapshotMetrics, previous: SnapshotMetrics | undefined): HealthTrend {
  if (!previous) {
    return { hasHistory: false, overall: "stable", deltas: [], gettingBetter: [], gettingWorse: [] };
  }

  const deltas: MetricDelta[] = METRIC_DEFS.map((def) => {
    const before = previous[def.key] as number;
    const after = current[def.key] as number;
    return { label: def.label, before, after, delta: after - before, direction: direction(before, after, def.higherIsBetter) };
  });

  const gettingBetter = deltas
    .filter((d) => d.direction === "improving")
    .map((d) => `${d.label}: ${d.before} → ${d.after} (${d.delta > 0 ? "+" : ""}${d.delta})`);
  const gettingWorse = deltas
    .filter((d) => d.direction === "deteriorating")
    .map((d) => `${d.label}: ${d.before} → ${d.after} (${d.delta > 0 ? "+" : ""}${d.delta})`);

  const improvingCount = deltas.filter((d) => d.direction === "improving").length;
  const deterioratingCount = deltas.filter((d) => d.direction === "deteriorating").length;
  const overall: TrendDirection = deterioratingCount > improvingCount ? "deteriorating" : improvingCount > deterioratingCount ? "improving" : "stable";

  return { hasHistory: true, overall, deltas, gettingBetter, gettingWorse };
}
