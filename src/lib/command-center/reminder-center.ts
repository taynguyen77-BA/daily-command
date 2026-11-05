// D4 — the Reminder Center's lists, from the ONE TicketWorkState: Due now · Upcoming · Parked without a date · Snoozed · History.
// A ticket is in exactly one list. Dates are the user's local day; "due" is date-based here (the delivery hour only gates the Slack message).

import { isParkedWithoutDate, isReminderState, remindOnOf, type ReminderState } from "./reminder-model";
import { addDays, nextMonday, nextReminderDay, type ReminderPrefs } from "./reminder-schedule";
import type { TicketWorkState, WorkItem } from "./types";

export interface ReminderRow {
  ticketKey: string;
  status: ReminderState;
  title?: string;
  url?: string;
  projectKey: string;
  reason?: string;
  remindOn?: string;
  /** The day the next message falls due (after weekend shift / snooze). */
  dueOn?: string;
  level: number;
  snoozedUntil?: string;
  parkedAt: string;
  ageDays: number;
  lastRemindedOn?: string;
}
export interface ReminderHistoryRow { ticketKey: string; title?: string; closedOn: string; via: "closed in Jira" | "marked done"; was: ReminderState }

export interface ReminderCenterView {
  dueNow: ReminderRow[];
  upcoming: ReminderRow[];
  parkedWithoutDate: ReminderRow[];
  snoozed: ReminderRow[];
  history: ReminderHistoryRow[];
  /** The Nav badge: what needs you today. */
  badge: number;
}

const ageOf = (iso: string, today: string) => Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${iso.slice(0, 10)}T00:00:00Z`)) / 86_400_000));

export function buildReminderCenter(states: Record<string, TicketWorkState>, workItems: readonly Pick<WorkItem, "key" | "title" | "sourceUrl">[], today: string, prefs: ReminderPrefs): ReminderCenterView {
  const byKey = new Map(workItems.map((w) => [w.key, w]));
  const view: ReminderCenterView = { dueNow: [], upcoming: [], parkedWithoutDate: [], snoozed: [], history: [], badge: 0 };
  for (const r of Object.values(states)) {
    if (isReminderState(r.status)) {
      const w = byKey.get(r.ticketKey);
      const next = nextReminderDay(r, prefs);
      const row: ReminderRow = {
        ticketKey: r.ticketKey,
        status: r.status,
        ...(w ? { title: w.title } : {}),
        ...(w?.sourceUrl ? { url: w.sourceUrl } : {}),
        projectKey: r.ticketKey.split("-")[0].toUpperCase(),
        ...(r.reason ? { reason: r.reason } : {}),
        ...(remindOnOf(r) ? { remindOn: remindOnOf(r)! } : {}),
        ...(next ? { dueOn: next.dueOn } : {}),
        level: next?.level ?? 0,
        ...(r.reminder?.snoozedUntil ? { snoozedUntil: r.reminder.snoozedUntil } : {}),
        parkedAt: r.reminder?.setAt ?? r.updatedAt,
        ageDays: ageOf(r.reminder?.setAt ?? r.updatedAt, today),
        ...(r.reminder?.lastRemindedOn ? { lastRemindedOn: r.reminder.lastRemindedOn } : {}),
      };
      if (r.reminder?.snoozedUntil && r.reminder.snoozedUntil > today) view.snoozed.push(row);
      else if (next && next.dueOn <= today) view.dueNow.push(row);
      else if (next) view.upcoming.push(row);
      else if (isParkedWithoutDate(r, today, prefs.parkedWithoutDateDays)) view.parkedWithoutDate.push(row);
      continue;
    }
    if (r.status === "DONE") {
      const last = r.history[r.history.length - 1];
      if (last && (last.from === "BLOCKED" || last.from === "SKIPPED" || last.from === "DEFERRED")) {
        const w = byKey.get(r.ticketKey);
        view.history.push({ ticketKey: r.ticketKey, ...(w ? { title: w.title } : {}), closedOn: r.updatedAt.slice(0, 10), via: r.source === "jira" ? "closed in Jira" : "marked done", was: last.from });
      }
    }
  }
  const byDue = (a: ReminderRow, b: ReminderRow) => (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999") || b.level - a.level || a.ticketKey.localeCompare(b.ticketKey);
  view.dueNow.sort(byDue);
  view.upcoming.sort(byDue);
  view.snoozed.sort((a, b) => (a.snoozedUntil ?? "").localeCompare(b.snoozedUntil ?? "") || a.ticketKey.localeCompare(b.ticketKey));
  view.parkedWithoutDate.sort((a, b) => b.ageDays - a.ageDays || a.ticketKey.localeCompare(b.ticketKey));
  view.history.sort((a, b) => b.closedOn.localeCompare(a.closedOn)).splice(30);
  view.badge = view.dueNow.length;
  return view;
}

export const SNOOZE_CHOICES = (today: string): { id: string; label: string; date: string }[] => [
  { id: "1d", label: "1 day", date: addDays(today, 1) },
  { id: "3d", label: "3 days", date: addDays(today, 3) },
  { id: "monday", label: "Next Monday", date: nextMonday(today) },
];
