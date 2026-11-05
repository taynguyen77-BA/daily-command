// D4 — when is a reminder due? Business-day math, weekend shift, the delivery window, the escalation ladder and snooze. Pure.
// All dates are local YYYY-MM-DD in the member's zone; the caller supplies "now" as { date, minutes } in that zone
// (localDateOf / localMinutesOfDay from notify-prefs.ts, or the IANA resolver's local parts).

import { isIsoDay, isReminderState, remindOnOf } from "./reminder-model";
import type { TicketWorkState } from "./types";

export interface ReminderPrefs {
  /** Skip/Block/Defer cannot be confirmed without a date or "No reminder". Default off for existing installs. */
  requireReminderDate: boolean;
  /** Local hour reminders go out (0-23). */
  deliveryHourLocal: number;
  /** A reminder due on Saturday/Sunday goes out on Monday. */
  skipWeekends: boolean;
  /** Days after remindOn of escalation 1, 2, 3 (then weekly). */
  ladder: [number, number, number];
  /** noReminder / date-less tickets surface under "Parked without a date" after this many days. */
  parkedWithoutDateDays: number;
}
export const DEFAULT_REMINDER_PREFS: ReminderPrefs = { requireReminderDate: false, deliveryHourLocal: 9, skipWeekends: true, ladder: [1, 3, 7], parkedWithoutDateDays: 14 };

export function asReminderPrefs(raw: unknown): ReminderPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<ReminderPrefs>;
  const d = DEFAULT_REMINDER_PREFS;
  const hour = typeof r.deliveryHourLocal === "number" && Number.isInteger(r.deliveryHourLocal) && r.deliveryHourLocal >= 0 && r.deliveryHourLocal <= 23 ? r.deliveryHourLocal : d.deliveryHourLocal;
  const ladder = Array.isArray(r.ladder) && r.ladder.length === 3 && r.ladder.every((n) => Number.isInteger(n) && n >= 1 && n <= 60) && r.ladder[0] < r.ladder[1] && r.ladder[1] < r.ladder[2] ? (r.ladder as [number, number, number]) : d.ladder;
  const parked = typeof r.parkedWithoutDateDays === "number" && Number.isInteger(r.parkedWithoutDateDays) && r.parkedWithoutDateDays >= 1 && r.parkedWithoutDateDays <= 365 ? r.parkedWithoutDateDays : d.parkedWithoutDateDays;
  return { requireReminderDate: r.requireReminderDate === true, deliveryHourLocal: hour, skipWeekends: r.skipWeekends !== false, ladder, parkedWithoutDateDays: parked };
}

// ----- calendar math (UTC arithmetic on the date string: no DST drift) -----
export const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const dayOfWeek = (iso: string): number => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 Sun … 6 Sat
export const isWeekend = (iso: string): boolean => dayOfWeek(iso) === 0 || dayOfWeek(iso) === 6;
export const shiftToWeekday = (iso: string): string => (dayOfWeek(iso) === 6 ? addDays(iso, 2) : dayOfWeek(iso) === 0 ? addDays(iso, 1) : iso);
export function addBusinessDays(iso: string, n: number): string {
  let d = iso;
  let left = Math.abs(n);
  const step = n < 0 ? -1 : 1;
  while (left > 0) {
    d = addDays(d, step);
    if (!isWeekend(d)) left -= 1;
  }
  return d;
}
export const nextMonday = (iso: string): string => addDays(iso, ((8 - dayOfWeek(iso)) % 7) || 7);
export const businessDaysBetween = (from: string, to: string): number => {
  let n = 0;
  for (let d = from; d < to; d = addDays(d, 1)) if (!isWeekend(addDays(d, 1))) n += 1;
  return n;
};

export interface ReminderChip { id: "tomorrow" | "in-3-days" | "next-monday" | "in-2-weeks"; label: string; date: string }
export function reminderChips(today: string): ReminderChip[] {
  return [
    { id: "tomorrow", label: "Tomorrow", date: addDays(today, 1) },
    { id: "in-3-days", label: "In 3 days", date: addDays(today, 3) },
    { id: "next-monday", label: "Next Monday", date: nextMonday(today) },
    { id: "in-2-weeks", label: "In 2 weeks", date: addDays(today, 14) },
  ];
}

/** The picker's pre-selected date. BLOCKED: the blocker SLA in business days, or 2 business days before the Jira due date when sooner;
 *  SKIPPED: +3 business days; DEFERRED: the date the user already chose. Never earlier than tomorrow. */
export function smartDefaultRemindOn(args: { status: "BLOCKED" | "SKIPPED" | "DEFERRED"; today: string; slaBusinessDays?: number; jiraDueDate?: string; chosenDate?: string }): string {
  const tomorrow = addDays(args.today, 1);
  if (args.status === "DEFERRED" && args.chosenDate && isIsoDay(args.chosenDate) && args.chosenDate >= args.today) return args.chosenDate;
  if (args.status === "SKIPPED") return addBusinessDays(args.today, 3);
  let d = addBusinessDays(args.today, Math.max(1, args.slaBusinessDays ?? 2));
  if (args.status === "BLOCKED" && args.jiraDueDate && isIsoDay(args.jiraDueDate)) {
    const before = addBusinessDays(args.jiraDueDate, -2);
    if (before < d) d = before;
  }
  return d < tomorrow ? tomorrow : d;
}

// ----- due logic -----
export interface ReminderNow { date: string; minutes: number }

export interface ReminderDue {
  /** Level of the message that would go out (0 first, 1-3 escalations). */
  level: number;
  /** The local day it became due (after weekend shift / snooze). */
  dueOn: string;
}

const lastLevelLabel = (level: number) => ["", "reminder 2", "reminder 3", "stale — still parked"][Math.min(3, Math.max(0, level))];
export { lastLevelLabel };

/** The next date a reminder for this ticket falls due, ignoring "now" (null: nothing scheduled — no date, or noReminder). */
export function nextReminderDay(r: Pick<TicketWorkState, "status" | "until" | "pingOn" | "reminder">, prefs: ReminderPrefs): { dueOn: string; level: number } | null {
  if (!isReminderState(r.status) || r.reminder?.noReminder) return null;
  const base = remindOnOf(r);
  if (!base) return null;
  const sent = r.reminder?.lastRemindedOn;
  const k = sent ? (r.reminder?.level ?? 0) + 1 : 0;
  let due: string;
  if (k === 0) due = base;
  else if (k <= 3) due = addDays(base, prefs.ladder[k - 1]);
  else due = addDays(sent!, 7); // then a weekly "stale parking lot" line
  if (sent && due <= sent) due = addDays(sent, 1); // never more than one message per ticket per day
  const snooze = r.reminder?.snoozedUntil;
  if (snooze && snooze > due) due = snooze; // "nothing before this date"
  if (prefs.skipWeekends) due = shiftToWeekday(due);
  return { dueOn: due, level: Math.min(3, k) };
}

/** Due now? On/after the day, and — on the day itself — at/after the delivery hour. */
export function reminderDueNow(r: Pick<TicketWorkState, "status" | "until" | "pingOn" | "reminder">, now: ReminderNow, prefs: ReminderPrefs): ReminderDue | null {
  const n = nextReminderDay(r, prefs);
  if (!n) return null;
  if (now.date < n.dueOn) return null;
  if (now.date === n.dueOn && now.minutes < prefs.deliveryHourLocal * 60) return null;
  return n;
}
