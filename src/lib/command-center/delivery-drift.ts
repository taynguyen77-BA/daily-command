// Delivery Drift Engine (V1.4 §3-7). Deterministic — Claude never computes this score, it
// only narrates it (see ai/prompts/proactive-assessment.ts). Drift means the project is
// moving away from its previously observed trajectory, not an arbitrary single signal —
// every level is backed by multiple weighted deltas against the most recent prior snapshot.
//
// WEIGHTING (documented, all deltas are "worse direction" only — improvement never adds
// drift score):
//   Delivery confidence drop:      2 pts per 1-point drop, capped at 40
//   Blocked items increase:        8 pts per item, capped at 24
//   Overdue items increase:        8 pts per item, capped at 24
//   High risk count increase:      6 pts per risk, capped at 18
//   Unresolved dependencies +:     4 pts per dependency, capped at 12
//   (sum capped at 100)
// LEVELS: SEVERE >= 60, DRIFTING >= 35, WATCH >= 15, else STABLE.
//
// TREND QUALITY (§7) is a function of how many prior snapshots were actually available —
// never presented as a strong trend off a single data point.

import type { DailySnapshot, DeliveryDrift, DeliveryTrajectory, DriftFactor, SnapshotMetrics, TrajectoryLevel, TrendDirection, TrendQuality } from "./types";

export function trendQuality(snapshotsUsed: number): TrendQuality {
  if (snapshotsUsed >= 5) return "strong";
  if (snapshotsUsed >= 3) return "moderate";
  if (snapshotsUsed >= 2) return "early-signal";
  return "insufficient";
}

function worsening(before: number, after: number): number {
  return Math.max(0, after - before);
}

export function computeDeliveryDrift(history: DailySnapshot[], currentMetrics: SnapshotMetrics): DeliveryDrift {
  const withMetrics = history.filter((s): s is DailySnapshot & { metrics: SnapshotMetrics } => !!s.metrics);
  const previous = withMetrics[withMetrics.length - 1]?.metrics;

  if (!previous) {
    return {
      level: "STABLE",
      score: 0,
      factors: [],
      evidence: ["No previous snapshot with metrics is available yet — drift cannot be assessed from a single point in time."],
      trend: "stable",
      confidence: 0.3,
      trendQuality: "insufficient",
      snapshotsUsed: withMetrics.length,
    };
  }

  const factors: DriftFactor[] = [];
  const evidence: string[] = [];

  const confidenceDrop = Math.max(0, previous.deliveryConfidence - currentMetrics.deliveryConfidence);
  const confidenceContribution = Math.min(confidenceDrop * 2, 40);
  if (confidenceDrop > 0) {
    factors.push({ name: "Delivery confidence", contribution: confidenceContribution, detail: `Confidence dropped ${confidenceDrop} point(s) (${previous.deliveryConfidence} → ${currentMetrics.deliveryConfidence})` });
    evidence.push(`Delivery confidence: ${previous.deliveryConfidence} → ${currentMetrics.deliveryConfidence}`);
  }

  const blockedIncrease = worsening(previous.blockedCount, currentMetrics.blockedCount);
  const blockedContribution = Math.min(blockedIncrease * 8, 24);
  if (blockedIncrease > 0) {
    factors.push({ name: "Blockers", contribution: blockedContribution, detail: `Blocked items increased by ${blockedIncrease} (${previous.blockedCount} → ${currentMetrics.blockedCount})` });
    evidence.push(`Blocked items: ${previous.blockedCount} → ${currentMetrics.blockedCount}`);
  }

  const overdueIncrease = worsening(previous.overdueCount, currentMetrics.overdueCount);
  const overdueContribution = Math.min(overdueIncrease * 8, 24);
  if (overdueIncrease > 0) {
    factors.push({ name: "Overdue work", contribution: overdueContribution, detail: `Overdue items increased by ${overdueIncrease} (${previous.overdueCount} → ${currentMetrics.overdueCount})` });
    evidence.push(`Overdue items: ${previous.overdueCount} → ${currentMetrics.overdueCount}`);
  }

  const riskIncrease = worsening(previous.highRiskCount, currentMetrics.highRiskCount);
  const riskContribution = Math.min(riskIncrease * 6, 18);
  if (riskIncrease > 0) {
    factors.push({ name: "High-severity risk", contribution: riskContribution, detail: `High risks increased by ${riskIncrease} (${previous.highRiskCount} → ${currentMetrics.highRiskCount})` });
    evidence.push(`High risks: ${previous.highRiskCount} → ${currentMetrics.highRiskCount}`);
  }

  const depIncrease = worsening(previous.unresolvedDependenciesCount, currentMetrics.unresolvedDependenciesCount);
  const depContribution = Math.min(depIncrease * 4, 12);
  if (depIncrease > 0) {
    factors.push({ name: "Unresolved dependencies", contribution: depContribution, detail: `Unresolved dependencies increased by ${depIncrease} (${previous.unresolvedDependenciesCount} → ${currentMetrics.unresolvedDependenciesCount})` });
    evidence.push(`Unresolved dependencies: ${previous.unresolvedDependenciesCount} → ${currentMetrics.unresolvedDependenciesCount}`);
  }

  const score = Math.min(100, Math.round(confidenceContribution + blockedContribution + overdueContribution + riskContribution + depContribution));
  const level = score >= 60 ? "SEVERE" : score >= 35 ? "DRIFTING" : score >= 15 ? "WATCH" : "STABLE";
  const trend: TrendDirection = score >= 15 ? "deteriorating" : currentMetrics.deliveryConfidence > previous.deliveryConfidence ? "improving" : "stable";

  if (evidence.length === 0) evidence.push("No worsening signals detected since the previous snapshot.");

  return {
    level,
    score,
    factors: factors.sort((a, b) => b.contribution - a.contribution),
    evidence,
    trend,
    confidence: Math.min(0.9, 0.5 + withMetrics.length * 0.08),
    trendQuality: trendQuality(withMetrics.length),
    snapshotsUsed: withMetrics.length,
  };
}

/**
 * Multi-point trajectory over the available snapshot history (never just yesterday).
 * Uses up to the last 5 snapshots' deliveryConfidence plus today's, and requires at least
 * one usable prior point — otherwise explicitly reports INSUFFICIENT_HISTORY rather than
 * inventing a trend (§6).
 */
export function computeTrajectory(history: DailySnapshot[], currentMetrics: SnapshotMetrics): DeliveryTrajectory {
  const withMetrics = history.filter((s): s is DailySnapshot & { metrics: SnapshotMetrics } => !!s.metrics).slice(-5);
  if (withMetrics.length === 0) {
    return { level: "INSUFFICIENT_HISTORY", trendQuality: "insufficient", snapshotsUsed: 0 };
  }

  const points = [...withMetrics.map((s) => s.metrics.deliveryConfidence), currentMetrics.deliveryConfidence];
  const netChange = points[points.length - 1] - points[0];
  const worseningSteps = points.slice(1).filter((v, i) => v < points[i]).length;
  const improvingSteps = points.slice(1).filter((v, i) => v > points[i]).length;

  let level: TrajectoryLevel;
  if (netChange <= -20) level = "CRITICAL";
  else if (netChange <= -8) level = "DRIFTING";
  else if (netChange < 0 || worseningSteps > improvingSteps) level = "WATCH";
  else level = "ON_TRACK";

  return { level, trendQuality: trendQuality(withMetrics.length), snapshotsUsed: withMetrics.length };
}
