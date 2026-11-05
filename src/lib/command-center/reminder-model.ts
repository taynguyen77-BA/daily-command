// D4 — Reminder Center: the data model. ONE concept, "remind me on <date>" (`remindOn`), for BLOCKED / SKIPPED / DEFERRED tickets.
// Canonical storage stays `until` (re-check / wake-up date) and, for BLOCKED, `pingOn` (the V2.x follow-up ping date); remindOn is their
// alias: BLOCKED -> the earlier of pingOn and until; SKIPPED / DEFERRED -> until. Old blobs load unchanged (no migration step).
// Pure. Dates are local YYYY-MM-DD strings.

import type { TicketReminderMeta, TicketWorkState } from "./types";

export const REMINDER_STATES = ["BLOCKED", "SKIPPED", "DEFERRED"] as const;
export type ReminderState = (typeof REMINDER_STATES)[number];
export const isReminderState = (s: string): s is ReminderState => (REMINDER_STATES as readonly string[]).includes(s);

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDay = (v: unknown): v is string => typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

export function freshReminderMeta(nowIso: string, noReminder = false): TicketReminderMeta {
  return { level: 0, setAt: nowIso, ...(noReminder ? { noReminder: true } : {}) };
}

/** Parse-time shape check: anything malformed reads as "no meta" (never throws, never invents a value). */
export function asReminderMeta(raw: unknown): TicketReminderMeta | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Partial<TicketReminderMeta>;
  if (typeof r.setAt !== "string") return undefined;
  const level = typeof r.level === "number" && Number.isInteger(r.level) ? Math.min(3, Math.max(0, r.level)) : 0;
  return {
    level,
    setAt: r.setAt,
    ...(isIsoDay(r.snoozedUntil) ? { snoozedUntil: r.snoozedUntil } : {}),
    ...(isIsoDay(r.lastRemindedOn) ? { lastRemindedOn: r.lastRemindedOn } : {}),
    ...(r.noReminder === true ? { noReminder: true } : {}),
  };
}

/** The reminder date of a parked ticket: BLOCKED = earlier of pingOn / until; SKIPPED / DEFERRED = until. undefined = none was set. */
export function remindOnOf(r: Pick<TicketWorkState, "status" | "until" | "pingOn">): string | undefined {
  if (!isReminderState(r.status)) return undefined;
  if (r.status === "BLOCKED") {
    const c = [r.until, r.pingOn].filter((d): d is string => isIsoDay(d)).sort();
    return c[0];
  }
  return isIsoDay(r.until) ? r.until : undefined;
}

export type Validation = { ok: true } | { ok: false; message: string };

/** A reminder date must be a real calendar day, today or later. */
export function validateRemindOn(date: unknown, today: string): Validation {
  if (!isIsoDay(date)) return { ok: false, message: "Pick a valid date." };
  if (date < today) return { ok: false, message: "The reminder date cannot be in the past." };
  return { ok: true };
}
/** Optional time of day: HH:mm only. */
export function validateTime(v: unknown): Validation {
  return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? { ok: true } : { ok: false, message: "Use a time as HH:mm (00:00 – 23:59)." };
}
export function validateDeliveryHour(v: unknown): Validation {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 23 ? { ok: true } : { ok: false, message: "The delivery hour is a whole number from 0 to 23." };
}

/** The picker's decision: with requireReminderDate on, a date or an explicit "No reminder" is mandatory. */
export function canConfirmParking(args: { require: boolean; remindOn?: string; noReminder: boolean; today: string }): Validation {
  if (args.noReminder) return { ok: true };
  if (args.remindOn !== undefined && args.remindOn !== "") return validateRemindOn(args.remindOn, args.today);
  return args.require ? { ok: false, message: "Choose when to be reminded, or pick “No reminder”." } : { ok: true };
}

/** A parked ticket with no date (explicit noReminder, or a legacy skip/block without one) older than `days` — the "Parked without a date" list. */
export function isParkedWithoutDate(r: TicketWorkState, today: string, days: number): boolean {
  if (!isReminderState(r.status)) return false;
  if (remindOnOf(r) !== undefined) return false;
  const since = (r.reminder?.setAt ?? r.updatedAt).slice(0, 10);
  const age = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000);
  return age >= days;
}

export type ReminderPatch =
  | { kind: "snooze"; until: string }
  | { kind: "change-date"; remindOn: string }
  | { kind: "stop" }
  | { kind: "sent"; on: string; level: number };

/** The one pure reminder write (snooze / change date / stop reminding / progress). Bumps updatedAt so cross-device LWW picks it up.
 *  Returns the same object when nothing applies (unknown ticket, not a parked state). */
export function patchReminder(states: Record<string, TicketWorkState>, ticketKey: string, patch: ReminderPatch, nowIso: string): Record<string, TicketWorkState> {
  const prev = states[ticketKey];
  if (!prev || !isReminderState(prev.status)) return states;
  const bumped = nowIso <= prev.updatedAt ? new Date(new Date(prev.updatedAt).getTime() + 1).toISOString() : nowIso;
  const meta: TicketReminderMeta = { ...(prev.reminder ?? freshReminderMeta(nowIso)) };
  const next: TicketWorkState = { ...prev, updatedAt: bumped };
  switch (patch.kind) {
    case "snooze":
      if (!isIsoDay(patch.until)) return states;
      meta.snoozedUntil = patch.until;
      break;
    case "change-date":
      if (!isIsoDay(patch.remindOn)) return states;
      next.until = patch.remindOn;
      if (prev.status === "BLOCKED") delete next.pingOn; // the ONE date now (pingOn would otherwise win when earlier)
      // a new date restarts the ladder
      return { ...states, [ticketKey]: { ...next, reminder: freshReminderMeta(bumped) } };
    case "stop":
      delete next.until;
      delete next.pingOn;
      return { ...states, [ticketKey]: { ...next, reminder: freshReminderMeta(bumped, true) } };
    case "sent":
      meta.level = Math.min(3, Math.max(0, patch.level));
      meta.lastRemindedOn = patch.on;
      delete meta.snoozedUntil;
      break;
  }
  return { ...states, [ticketKey]: { ...next, reminder: meta } };
}
