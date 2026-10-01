// D3 — sync history per day: every successful Jira sync rolls into that local day's
// summary (syncs, new tickets, newly assigned to me, closed in Jira). Kept 90 days.

import { addDays } from "./date-utils";
import type { DailySyncSummary } from "./types";

export const SYNC_HISTORY_DAYS = 90;

export function rollDailySyncSummary(
  history: Record<string, DailySyncSummary>,
  day: string,
  sync: { at: string; newTickets: number; assignedToMe: number; closed: number }
): Record<string, DailySyncSummary> {
  const prev = history[day] ?? { date: day, syncs: 0, newTickets: 0, assignedToMe: 0, closed: 0 };
  const next: Record<string, DailySyncSummary> = {
    ...history,
    [day]: {
      date: day,
      syncs: prev.syncs + 1,
      newTickets: prev.newTickets + sync.newTickets,
      assignedToMe: prev.assignedToMe + sync.assignedToMe,
      closed: prev.closed + sync.closed,
      lastSyncAt: sync.at,
    },
  };
  const cutoff = addDays(day, -(SYNC_HISTORY_DAYS - 1));
  for (const key of Object.keys(next)) if (key < cutoff) delete next[key];
  return next;
}

/** Newest first, for display. */
export function listDailySyncSummaries(history: Record<string, DailySyncSummary>): DailySyncSummary[] {
  return Object.values(history).sort((a, b) => b.date.localeCompare(a.date));
}
