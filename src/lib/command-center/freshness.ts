// Data freshness (BUILD REQUEST V1.3 §14). Deterministic, configurable thresholds — never
// let stale data look live.

import type { Freshness } from "./types";

export const FRESHNESS_THRESHOLDS_MINUTES = { fresh: 30, aging: 240 } as const; // aging up to 4h

export function computeFreshness(lastSyncedAtIso: string | undefined, nowMs: number = Date.now()): Freshness {
  if (!lastSyncedAtIso) return "unknown";
  const ageMinutes = (nowMs - new Date(lastSyncedAtIso).getTime()) / 60_000;
  if (!Number.isFinite(ageMinutes) || ageMinutes < 0) return "unknown";
  if (ageMinutes < FRESHNESS_THRESHOLDS_MINUTES.fresh) return "fresh";
  if (ageMinutes < FRESHNESS_THRESHOLDS_MINUTES.aging) return "aging";
  return "stale";
}

export const FRESHNESS_LABEL: Record<Freshness, string> = {
  fresh: "🟢 Fresh",
  aging: "🟡 Aging",
  stale: "🔴 Stale",
  unknown: "⚪ Unknown",
};
