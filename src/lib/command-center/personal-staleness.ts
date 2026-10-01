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

import { businessDaysBetween, toLocalIso } from "./date-utils";
import type { MyTicketActivity, WorkItem } from "./types";

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
  /** D6 — what the silence is measured from: the ticket's Jira `updated` (changed by ANYONE),
   *  or the configured user's own last comment/transition when that is known and opted in. */
  basis?: "ticket" | "me";
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
  thresholds: StaleAssignedTicketThresholds = DEFAULT_STALE_ASSIGNED_TICKET_THRESHOLDS,
  // D6 — optional: the user's own last activity per ticket key (comments/changelog the sync
  // could see). When a ticket has an entry, silence is measured from MY last activity
  // ("No activity by you…"); otherwise from the ticket's `updated`, as before.
  myActivity?: Record<string, MyTicketActivity>
): StaleAssignedTicket[] {
  const out: StaleAssignedTicket[] = [];
  for (const item of activeAssignedWorkItems) {
    const mine = myActivity?.[item.key]?.lastActivityAt;
    const mineDay = mine && !Number.isNaN(new Date(mine).getTime()) ? toLocalIso(new Date(mine)) : undefined;
    const from = mineDay ?? item.lastUpdated;
    if (!from) continue;
    const businessDaysSinceUpdate = businessDaysBetween(from, today);
    if (businessDaysSinceUpdate < thresholds.warnBusinessDays) continue;
    const severity: "WARN" | "ESCALATE" = businessDaysSinceUpdate >= thresholds.escalateBusinessDays ? "ESCALATE" : "WARN";
    out.push({ workItemId: item.id, issueKey: item.key, title: item.title, projectId: item.projectId, businessDaysSinceUpdate, severity, basis: mineDay ? "me" : "ticket" });
  }
  return out.sort((a, b) => b.businessDaysSinceUpdate - a.businessDaysSinceUpdate);
}
