// P3.4 — how old is this open ticket compared with similar tickets that were resolved? (EVIDENCE + FORECAST)

import { daysBetween } from "../score-core";
import type { WorkItem } from "../types";
import type { LeadTimeEstimate } from "./lead-time";

export interface AgingResult {
  ageDays: number;
  /** Days in the current status category (else since the last update) — context, not part of the comparison. */
  inStatusDays: number;
  /** True when the ticket is already older than the P85 lead time of comparable tickets. */
  olderThanP85: boolean;
  olderThanPct: number;
  n: number;
  p85: number;
  explanation: string;
}

export function agingFor(item: Pick<WorkItem, "createdDate" | "lastUpdated" | "statusCategoryChangedAt">, today: string, estimate: LeadTimeEstimate): AgingResult | null {
  if (estimate.status !== "OK" || !item.createdDate) return null;
  const ageDays = Math.max(0, daysBetween(item.createdDate.slice(0, 10), today));
  const inStatusDays = Math.max(0, daysBetween((item.statusCategoryChangedAt ?? item.lastUpdated).slice(0, 10), today));
  const olderThanPct = estimate.olderThanPct(ageDays);
  const olderThanP85 = ageDays > estimate.p85;
  return {
    ageDays,
    inStatusDays,
    olderThanP85,
    olderThanPct,
    n: estimate.n,
    p85: estimate.p85,
    explanation: `Open for ${ageDays} days (${inStatusDays} in its current status) — older than ${olderThanPct}% of similar tickets; 85% of them were resolved within ${estimate.p85} days. Forecast from ${estimate.basis}, n = ${estimate.n}.`,
  };
}
