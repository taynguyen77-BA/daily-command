// V2.25 Task 3 — Stale Assigned Ticket detector (miss-ticket safety net). Answers "is a ticket
// assigned to me sitting with zero observable activity for N business days?" — the most common
// way a BA/PO/PM covering several parallel projects genuinely misses a ticket: it's assigned,
// it's still open, but nobody has touched it in days, and no other signal (a mention, a fresh
// risk, drift) would otherwise surface it.
//
// Reuses getActiveAssignedWorkItems (assigned-work.ts) for the candidate population — no second
// "what's mine and still open" definition — and WorkItem.lastUpdated (already the Jira `updated`
// field, already the exact signal scoring.ts's own Aging factor uses) as "the last time anyone
// observably touched this ticket." Business-day math (date-utils.ts's businessDaysBetween) is
// deliberate: a ticket untouched over a weekend shouldn't count those two calendar days as
// "silence" the same way two weekday gaps would.
//
// Thresholds are user-configurable (store.ts's staleAssignedTicketThresholds field, exposed in
// Data & Settings) — never hardcoded, since a BA/PO covering fast-moving vs. slow-moving
// projects needs different tolerances for "how long is too long".

import { businessDaysBetween } from "./date-utils";
import type { WorkItem } from "./types";

export interface StaleAssignedTicketThresholds {
  warnBusinessDays: number;
  escalateBusinessDays: number;
}

export const DEFAULT_STALE_ASSIGNED_TICKET_THRESHOLDS: StaleAssignedTicketThresholds = {
  warnBusinessDays: 3,
  escalateBusinessDays: 5,
};

export interface StaleAssignedTicket {
  workItemId: string;
  issueKey: string;
  title: string;
  projectId: string;
  businessDaysSinceUpdate: number;
  severity: "WARN" | "ESCALATE";
}

/** Pure: given the caller's already-resolved "active, assigned to me" population
 *  (getActiveAssignedWorkItems), flags every item whose `lastUpdated` is at least
 *  `warnBusinessDays` business days behind `today`. An item with no `lastUpdated` at all is
 *  skipped rather than treated as infinitely stale — defensive; every real WorkItem always
 *  carries one (see jira/normalize.ts's own truncateToDate), but this function never guesses
 *  from a missing fact. Sorted most-stale first. */
export function computeStaleAssignedTickets(
  activeAssignedWorkItems: WorkItem[],
  today: string,
  thresholds: StaleAssignedTicketThresholds = DEFAULT_STALE_ASSIGNED_TICKET_THRESHOLDS
): StaleAssignedTicket[] {
  const out: StaleAssignedTicket[] = [];
  for (const item of activeAssignedWorkItems) {
    if (!item.lastUpdated) continue;
    const businessDaysSinceUpdate = businessDaysBetween(item.lastUpdated, today);
    if (businessDaysSinceUpdate < thresholds.warnBusinessDays) continue;
    const severity: "WARN" | "ESCALATE" = businessDaysSinceUpdate >= thresholds.escalateBusinessDays ? "ESCALATE" : "WARN";
    out.push({ workItemId: item.id, issueKey: item.key, title: item.title, projectId: item.projectId, businessDaysSinceUpdate, severity });
  }
  return out.sort((a, b) => b.businessDaysSinceUpdate - a.businessDaysSinceUpdate);
}
