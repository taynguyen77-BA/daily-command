// P3.1 — which scoring model a stored snapshot's score-based metrics came from. Pure.
import type { SnapshotMetrics } from "./types";

export type SnapshotScoreModel = "v1" | "v2" | "v2.1";

/** A snapshot without the field was scored by v1 (every snapshot written before V2.43 is v1). */
export function scoringModelOf(metrics: Pick<SnapshotMetrics, "scoringModel" | "severityRules"> | undefined): SnapshotScoreModel {
  const model = metrics?.scoringModel ?? "v1";
  // D5 — v2 scores classified with the recalibrated thresholds + hard-rule floors ("v2.1"). Counts of critical items are
  // not comparable with snapshots classified by the old 80/60/40 table, so the two never compare.
  return model === "v2" && metrics?.severityRules === "v2.1" ? "v2.1" : model;
}

/** Metrics whose value depends on the scoring model; never compared across models. */
export const SCORE_BASED_METRICS = ["attentionCount", "criticalCount", "deliveryConfidence"] as const;
