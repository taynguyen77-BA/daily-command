// P3.4 — will this open ticket miss its due date? Remaining days vs the expected remaining time
// max(0, P50 - age) (typical) and max(0, P85 - age) (slow). Not computed without a due date or enough history.

import { daysBetween } from "../score-core";
import type { WorkItem } from "../types";
import type { LeadTimeEstimate } from "./lead-time";

export type SlipLevel = "LOW" | "MEDIUM" | "HIGH";

export interface SlipRisk {
  level: SlipLevel;
  remainingDays: number;
  expectedRemainingP50: number;
  expectedRemainingP85: number;
  ageDays: number;
  n: number;
  explanation: string;
}

/** HIGH: overdue, or even the typical remaining time (P50) exceeds the days left. MEDIUM: only the slow case (P85) exceeds them. LOW otherwise. */
export function slipRiskFor(item: Pick<WorkItem, "createdDate" | "dueDate">, today: string, estimate: LeadTimeEstimate): SlipRisk | null {
  if (!item.dueDate || !item.createdDate || estimate.status !== "OK") return null;
  const remainingDays = daysBetween(today, item.dueDate.slice(0, 10));
  const ageDays = Math.max(0, daysBetween(item.createdDate.slice(0, 10), today));
  const expectedRemainingP50 = Math.max(0, estimate.p50 - ageDays);
  const expectedRemainingP85 = Math.max(0, estimate.p85 - ageDays);
  const level: SlipLevel = remainingDays < 0 || expectedRemainingP50 > remainingDays ? "HIGH" : expectedRemainingP85 > remainingDays ? "MEDIUM" : "LOW";
  const when = remainingDays < 0 ? `overdue by ${-remainingDays} day(s)` : remainingDays === 0 ? "due today" : `${remainingDays} day(s) left`;
  return {
    level,
    remainingDays,
    expectedRemainingP50,
    expectedRemainingP85,
    ageDays,
    n: estimate.n,
    explanation: `${when}; similar tickets typically need ${expectedRemainingP50} more day(s) (P50) and up to ${expectedRemainingP85} (P85) at this age. Forecast from ${estimate.basis}, n = ${estimate.n}.`,
  };
}
