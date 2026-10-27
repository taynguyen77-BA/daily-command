// Shared by scoring.ts (v1) and scoring-v2.ts so neither imports the other: date arithmetic and the
// severity thresholds (80/60/40, unchanged by v2).

import type { Severity } from "./types";

// F6 — daysBetween runs for every item in several engines on every render; parsing the same few
// hundred distinct dates over and over was the single biggest cost on a 3,000-item Jira. The
// local-midnight timestamp of each date string is cached (bounded; same parse as before, so the
// result is identical — including NaN for an unparseable date).
const MIDNIGHT_CACHE_MAX = 5000;
const midnightCache = new Map<string, number>();
function localMidnightMs(iso: string): number {
  let t = midnightCache.get(iso);
  if (t === undefined) {
    if (midnightCache.size >= MIDNIGHT_CACHE_MAX) midnightCache.clear();
    t = new Date(iso + "T00:00:00").getTime();
    midnightCache.set(iso, t);
  }
  return t;
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((localMidnightMs(toIso) - localMidnightMs(fromIso)) / 86_400_000);
}

export function classify(score: number): Severity {
  if (score >= 80) return "CRITICAL";
  if (score >= 60) return "HIGH";
  if (score >= 40) return "MEDIUM";
  return "LOW";
}
