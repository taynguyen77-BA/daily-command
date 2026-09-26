// Human-readable relative datetimes for provenance/history labels ("today 9:14 AM",
// "yesterday 4:02 PM", "3 days ago", "Sep 3"). Local-calendar based, same discipline as
// date-utils.ts: "today" means the viewer's local day, never UTC's. Deterministic (explicit
// formatting, `now` injectable) so labels are directly testable.

import { toLocalIso } from "./date-utils";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function clockTime(d: Date): string {
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? "AM" : "PM"}`;
}

/** Whole local calendar days from `iso`'s day to `now`'s day (0 = same day). */
function localDayDiff(d: Date, now: Date): number {
  const a = new Date(toLocalIso(d) + "T00:00:00").getTime();
  const b = new Date(toLocalIso(now) + "T00:00:00").getTime();
  return Math.round((b - a) / 86_400_000);
}

/** Undefined/empty/unparseable input returns undefined — callers render nothing rather than
 *  "undefined" or "Invalid Date". A timestamp later than `now` (clock skew) reads as today. */
export function formatRelativeDateTime(iso: string | undefined, now: Date = new Date()): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const days = localDayDiff(d, now);
  if (days <= 0) return `today ${clockTime(d)}`;
  if (days === 1) return `yesterday ${clockTime(d)}`;
  if (days < 7) return `${days} days ago`;
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

/** True when `iso` falls on `now`'s local calendar day. False for undefined/unparseable. */
export function isSameLocalDay(iso: string | undefined, now: Date = new Date()): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && localDayDiff(d, now) === 0;
}

/** Day-precision variant for plain local YYYY-MM-DD dates (e.g. a memory event's `date`):
 *  "today", "yesterday", "3 days ago", "Sep 3". Parsed as a LOCAL date, never UTC. */
export function formatRelativeDay(isoDate: string | undefined, now: Date = new Date()): string | undefined {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return undefined;
  const d = new Date(isoDate + "T00:00:00");
  if (Number.isNaN(d.getTime())) return undefined;
  const days = localDayDiff(d, now);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}
