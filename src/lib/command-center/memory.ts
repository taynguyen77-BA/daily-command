// Project Memory (BUILD REQUEST V1.2 §2-4). Snapshots are built from data the app already
// computes elsewhere — scoring, risk detection, executive confidence — never recalculated
// with different logic. This module only captures and compares, it never invents a number.

import { toSnapshot } from "./change-detection";
import { computeDeliveryConfidence } from "./executive";
import { detectRisks, RISK_LEVEL_ORDER } from "./risk-detection";
import { dedupeRisks } from "./selectors";
import { isOverdue, scoreAllWorkItems } from "./scoring";
import type { CommandCenterData, DailySnapshot, HealthTrend, MetricDelta, Risk, SnapshotMetrics, TrendDirection } from "./types";

/** V2.18 §7 — risksOverride, when passed, is used as-is instead of recomputing
 *  dedupeRisks(data.risks, detectRisks(data, today)) here — this used to have its own
 *  separate, title-only dedupe (a second, drifted implementation of the same concern
 *  selectors.ts's dedupeRisks already owns); now reuses that single source of truth. */
export function buildSnapshotMetrics(data: CommandCenterData, today: string, meaningfulChangeCount: number, risksOverride?: Risk[]): SnapshotMetrics {
  const scores = scoreAllWorkItems(data, today);
  const dedupedRisks = risksOverride ?? dedupeRisks(data.risks, detectRisks(data, today));
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
 *  change-detection.ts — never duplicated) plus computed metrics. risksOverride, when
 *  passed, flows into both — the persisted snapshot's `.risks` and its `.metrics` stay
 *  consistent with each other, never computed from two different risk sets. */
export function buildDailySnapshot(data: CommandCenterData, today: string, meaningfulChangeCount: number, risksOverride?: Risk[]): DailySnapshot {
  return { ...toSnapshot(data, today, risksOverride), metrics: buildSnapshotMetrics(data, today, meaningfulChangeCount, risksOverride) };
}

/** V2.18 §10 — confirmed real gap: snapshotHistory is appended to on EVERY sync/import/
 *  closeDay with no same-calendar-day guard (store.ts's three snapshot-producing call sites
 *  all just append), so a user who clicks "Sync Now" repeatedly in one sitting (or a
 *  deployment syncing more than once a day) accumulates multiple same-day entries. Trend/
 *  drift/weekly-review math (delivery-drift.ts, weekly-review.ts) read straight from that raw
 *  list, so a same-day noise delta could be reported as if it were a real day-over-day trend.
 *
 *  This does NOT change how snapshotHistory itself is stored — that stays the full
 *  operational record (useful for change detection at whatever granularity syncs actually
 *  happen), matching closeDay()'s own "snapshotHistory is the whole operational record over
 *  time, not a scoped view" comment. It's a pure, read-time derivation: collapse to the LAST
 *  entry per calendar date, preserving chronological order. Callers that need genuine
 *  day-over-day comparison (computeDeliveryDrift, computeTrajectory, computeRiskEscalations,
 *  buildWeeklyReviewFacts) call this once at their own top instead of taking the raw list —
 *  see proactive.ts and weekly-review.ts. */
export function dailyCanonicalSnapshots(history: DailySnapshot[]): DailySnapshot[] {
  const lastByDate = new Map<string, DailySnapshot>();
  for (const snapshot of history) lastByDate.set(snapshot.date, snapshot);
  const orderOfFirstAppearance: string[] = [];
  const seen = new Set<string>();
  for (const snapshot of history) {
    if (!seen.has(snapshot.date)) {
      seen.add(snapshot.date);
      orderOfFirstAppearance.push(snapshot.date);
    }
  }
  return orderOfFirstAppearance.map((date) => lastByDate.get(date)!);
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
