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

// ---- D5: v2 classification ---------------------------------------------------------------------------------------
// The v1 thresholds (80/60/40) are unreachable by the v2 factor table: a realistic ticket tops out around 55-70
// (Priority 20 + Deadline 20 + Blocker 15 + Aging <=10 + small extras; Awaiting-you 15 and Dependency 5 are rare).
// THRESHOLD TABLE (v2.1): CRITICAL >= 65, HIGH >= 45, MEDIUM >= 28, else LOW.
//   P3 due today with some aging = 25-32 (LOW/MEDIUM) · P2 overdue = 34+ -> floor HIGH · P1 overdue + blocked -> floor CRITICAL.
// HARD-RULE FLOORS (a floor only raises the class; floors never exceed CRITICAL):
//   P1/P2 overdue >= HIGH · P1 overdue AND blocked >= CRITICAL · P1 due within 1 day >= MEDIUM
//   blocked P1/P2 >= MEDIUM · awaiting you past the reply SLA on P1/P2 >= HIGH
export const V2_THRESHOLDS = { critical: 65, high: 45, medium: 28 } as const;
const SEVERITY_RANK: Record<Severity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const SEVERITY_BY_RANK: Severity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

export interface SeverityFacts {
  /** Only when Jira (or the user) really set a priority. */
  priority?: "P1" | "P2" | "P3" | "P4";
  overdueDays: number; // > 0 when overdue
  daysToDue?: number; // undefined when no due date
  blocked: boolean;
  awaitingPastSla: boolean;
}

export interface SeverityResult { severity: Severity; floor?: { severity: Severity; reason: string } }

export function classifyByScoreV2(score: number): Severity {
  if (score >= V2_THRESHOLDS.critical) return "CRITICAL";
  if (score >= V2_THRESHOLDS.high) return "HIGH";
  if (score >= V2_THRESHOLDS.medium) return "MEDIUM";
  return "LOW";
}

export function classifyV2(score: number, facts: SeverityFacts): SeverityResult {
  const byScore = classifyByScoreV2(score);
  const high = facts.priority === "P1" || facts.priority === "P2";
  const p1 = facts.priority === "P1";
  const overdue = facts.overdueDays > 0;
  let floor: Severity = "LOW";
  let reason = "";
  const raise = (s: Severity, r: string) => { if (SEVERITY_RANK[s] > SEVERITY_RANK[floor]) { floor = s; reason = r; } };
  if (high && overdue) raise("HIGH", `${facts.priority}, overdue ${facts.overdueDays} day(s)`);
  if (p1 && overdue && facts.blocked) raise("CRITICAL", `P1, overdue ${facts.overdueDays} day(s), blocked`);
  if (p1 && facts.daysToDue !== undefined && facts.daysToDue >= 0 && facts.daysToDue <= 1) raise("MEDIUM", `P1 due ${facts.daysToDue === 0 ? "today" : "tomorrow"}`);
  if (high && facts.blocked) raise("MEDIUM", `${facts.priority}, blocked`);
  if (high && facts.awaitingPastSla) raise("HIGH", `${facts.priority}, awaiting your reply past the SLA`);
  if (SEVERITY_RANK[floor] > SEVERITY_RANK[byScore]) return { severity: SEVERITY_BY_RANK[SEVERITY_RANK[floor]], floor: { severity: floor, reason } };
  return { severity: byScore };
}

export function classify(score: number): Severity {
  if (score >= 80) return "CRITICAL";
  if (score >= 60) return "HIGH";
  if (score >= 40) return "MEDIUM";
  return "LOW";
}
