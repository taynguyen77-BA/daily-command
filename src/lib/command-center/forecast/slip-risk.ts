// P3.4 / D5 — will this open ticket miss its due date?
//
// The remaining time is CONDITIONAL on survival: among comparable resolved tickets that took longer than the
// ticket's current age, remaining = days - age (P50 / P85 of those). The old max(0, P50 - age) gave "0 days to go"
// (LOW) to any ticket older than every comparable one — the opposite of the truth. "No precedent" is never LOW.
//
// KNOWN LIMITATION (right-censoring): lead time comes only from RESOLVED tickets, so very slow tickets that are
// still open are under-represented; the estimate leans optimistic. `openPeersOlder` shows how many open peers are
// already older than this one as context.

import { daysBetween } from "../score-core";
import type { WorkItem } from "../types";
import type { LeadTimeEstimate } from "./lead-time";

export type SlipLevel = "LOW" | "MEDIUM" | "HIGH";
export type SlipPrecedent = "conditional" | "thin" | "none";

/** Minimum number of comparable tickets that outlived the current age before the conditional estimate is trusted. */
export const SLIP_MIN_CONDITIONAL = 5;

export interface SlipRisk {
  level: SlipLevel;
  remainingDays: number;
  expectedRemainingP50: number;
  expectedRemainingP85: number;
  ageDays: number;
  n: number;
  precedent: SlipPrecedent;
  /** Open comparable tickets already older than this one (filled by computeForecast). */
  openPeersOlder?: number;
  explanation: string;
}

/** The one place that decides how much precedent exists for an age — aging.ts and slip-risk.ts both read it. */
export function precedentFor(estimate: Extract<LeadTimeEstimate, { status: "OK" }>, ageDays: number): { precedent: SlipPrecedent; cond: { n: number; p50: number; p85: number } | null } {
  if (ageDays > estimate.p95) return { precedent: "none", cond: null };
  const cond = estimate.conditional(ageDays);
  if (cond && cond.n >= SLIP_MIN_CONDITIONAL) return { precedent: "conditional", cond };
  return { precedent: "thin", cond };
}

export function slipRiskFor(item: Pick<WorkItem, "createdDate" | "dueDate">, today: string, estimate: LeadTimeEstimate): SlipRisk | null {
  if (!item.dueDate || !item.createdDate || estimate.status !== "OK") return null;
  const remainingDays = daysBetween(today, item.dueDate.slice(0, 10));
  const rawAge = daysBetween(item.createdDate.slice(0, 10), today);
  if (!Number.isFinite(remainingDays) || !Number.isFinite(rawAge) || rawAge < 0) return null;
  const ageDays = rawAge;
  const { precedent, cond } = precedentFor(estimate, ageDays);
  const when = remainingDays < 0 ? `overdue by ${-remainingDays} day(s)` : remainingDays === 0 ? "due today" : `${remainingDays} day(s) left`;
  let level: SlipLevel;
  let p50 = 0;
  let p85 = 0;
  let detail: string;
  if (precedent === "conditional" && cond) {
    p50 = cond.p50;
    p85 = cond.p85;
    level = remainingDays < 0 || p50 > remainingDays ? "HIGH" : p85 > remainingDays ? "MEDIUM" : "LOW";
    detail = `of ${cond.n} comparable tickets that lasted this long, typical remaining time is ${p50} more day(s) (P50), up to ${p85} (P85)`;
  } else if (precedent === "none") {
    level = remainingDays <= 7 ? "HIGH" : "MEDIUM";
    detail = `older than every comparable ticket (n = ${estimate.n}) — no precedent for how long this takes`;
  } else {
    level = remainingDays < 0 ? "HIGH" : "MEDIUM";
    p50 = cond?.p50 ?? 0;
    p85 = cond?.p85 ?? 0;
    detail = `thin precedent (${cond?.n ?? 0} comparable ticket(s) lasted this long)`;
  }
  // The aging chip says "older than P85": the slip level must never read LOW next to it.
  if (level === "LOW" && ageDays > estimate.p85) level = "MEDIUM";
  return {
    level,
    remainingDays,
    expectedRemainingP50: p50,
    expectedRemainingP85: p85,
    ageDays,
    n: estimate.n,
    precedent,
    explanation: `${when}; ${detail}. Forecast from ${estimate.basis}, n = ${estimate.n}.`,
  };
}
