// P3.4 — FORECAST: lead-time distribution (created -> resolved) over the last 90 days of resolved items.
// Pure, deterministic, no AI. A number is only ever produced with its sample size; below the minimum
// the answer is UNKNOWN ("insufficient history"), never zero or a default.

import { daysBetween } from "../score-core";
import type { WorkItem } from "../types";

export const LEAD_TIME_WINDOW_DAYS = 90;
export const LEAD_TIME_MIN_SAMPLES = 8;

export interface LeadTimeSample {
  projectId: string;
  type: string;
  days: number;
}

export type LeadTimeScope = "project-type" | "project" | "global";

export type LeadTimeEstimate =
  | { status: "OK"; scope: LeadTimeScope; n: number; p50: number; p85: number; p95: number; basis: string; /** share (0-100) of the comparable tickets that took LESS time than `days` */ olderThanPct: (days: number) => number }
  | { status: "UNKNOWN"; n: number; reason: "insufficient history" };

/** Nearest-rank percentile of an ascending array: rank = ceil(q x n). [1..10] -> P50 5, P85 9, P95 10. */
export function percentile(sortedAsc: readonly number[], q: number): number {
  if (sortedAsc.length === 0) return NaN;
  const rank = Math.min(sortedAsc.length, Math.max(1, Math.ceil(q * sortedAsc.length)));
  return sortedAsc[rank - 1];
}

/** Created -> resolved, in days, for items resolved in the last `windowDays` (items without both dates are not used). */
export function leadTimeSamples(workItems: readonly Pick<WorkItem, "status" | "createdDate" | "resolvedAt" | "projectId" | "type">[], today: string, windowDays: number = LEAD_TIME_WINDOW_DAYS): LeadTimeSample[] {
  const out: LeadTimeSample[] = [];
  for (const w of workItems) {
    if (w.status !== "Done" || !w.resolvedAt || !w.createdDate) continue;
    const resolved = w.resolvedAt.slice(0, 10);
    const age = daysBetween(resolved, today);
    if (!Number.isFinite(age) || age < 0 || age > windowDays) continue;
    const days = daysBetween(w.createdDate.slice(0, 10), resolved);
    if (!Number.isFinite(days) || days < 0) continue;
    out.push({ projectId: w.projectId, type: String(w.type), days });
  }
  return out;
}

function estimateFrom(samples: readonly number[], scope: LeadTimeScope, basis: string): LeadTimeEstimate {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    status: "OK",
    scope,
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p85: percentile(sorted, 0.85),
    p95: percentile(sorted, 0.95),
    basis,
    olderThanPct: (days) => Math.round((100 * sorted.filter((d) => d < days).length) / sorted.length),
  };
}

export interface LeadTimeIndex {
  estimateFor(projectId: string, type: string): LeadTimeEstimate;
  /** All resolved samples in the window. */
  total: number;
}

/** Fallback chain: (project, type) with >= 8 samples, else the whole project, else everything, else UNKNOWN. */
export function buildLeadTimeIndex(samples: readonly LeadTimeSample[]): LeadTimeIndex {
  const byProject = new Map<string, LeadTimeSample[]>();
  const byPair = new Map<string, LeadTimeSample[]>();
  for (const s of samples) {
    byProject.set(s.projectId, [...(byProject.get(s.projectId) ?? []), s]);
    const k = `${s.projectId}|${s.type}`;
    byPair.set(k, [...(byPair.get(k) ?? []), s]);
  }
  const cache = new Map<string, LeadTimeEstimate>();
  return {
    total: samples.length,
    estimateFor(projectId, type) {
      const key = `${projectId}|${type}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const pair = byPair.get(key) ?? [];
      const proj = byProject.get(projectId) ?? [];
      const est: LeadTimeEstimate =
        pair.length >= LEAD_TIME_MIN_SAMPLES ? estimateFrom(pair.map((s) => s.days), "project-type", `${pair.length} resolved ${type} tickets in this project (last ${LEAD_TIME_WINDOW_DAYS} days)`)
        : proj.length >= LEAD_TIME_MIN_SAMPLES ? estimateFrom(proj.map((s) => s.days), "project", `${proj.length} resolved tickets in this project (last ${LEAD_TIME_WINDOW_DAYS} days)`)
        : samples.length >= LEAD_TIME_MIN_SAMPLES ? estimateFrom(samples.map((s) => s.days), "global", `${samples.length} resolved tickets across all projects (last ${LEAD_TIME_WINDOW_DAYS} days)`)
        : { status: "UNKNOWN", n: samples.length, reason: "insufficient history" };
      cache.set(key, est);
      return est;
    },
  };
}
