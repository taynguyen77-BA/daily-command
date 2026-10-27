// P3.1 — which scoring model a stored snapshot's score-based metrics came from. Pure.
import type { SnapshotMetrics } from "./types";

export type SnapshotScoreModel = "v1" | "v2";

/** A snapshot without the field was scored by v1 (every snapshot written before V2.43 is v1). */
export function scoringModelOf(metrics: Pick<SnapshotMetrics, "scoringModel"> | undefined): SnapshotScoreModel {
  return metrics?.scoringModel ?? "v1";
}

/** Metrics whose value depends on the scoring model; never compared across models. */
export const SCORE_BASED_METRICS = ["attentionCount", "criticalCount", "deliveryConfidence"] as const;
