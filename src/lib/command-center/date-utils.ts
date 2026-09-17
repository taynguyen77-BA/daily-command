// Local-calendar date helpers. Deliberately never round-trip through Date#toISOString()
// (which serializes in UTC) — for a user east of UTC, that silently shifts "today" and
// due-date offsets back by a day for part of the evening/early morning. Every date in
// this app is a plain YYYY-MM-DD string interpreted in the browser's local calendar.

export function toLocalIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function todayLocalIso(): string {
  return toLocalIso(new Date());
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return toLocalIso(d);
}

/** V2.25 Task 3 — business-day count strictly between `fromIso` (exclusive) and `toIso`
 *  (inclusive), i.e. how many Mon-Fri calendar days have elapsed. Used by the Stale Assigned
 *  Ticket detector so a ticket untouched over a weekend isn't treated the same as one
 *  untouched for two weekdays. Never counts a weekend day; `toIso` on or before `fromIso`
 *  returns 0 rather than a negative count. */
export function businessDaysBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso + "T00:00:00");
  const to = new Date(toIso + "T00:00:00");
  if (to.getTime() <= from.getTime()) return 0;
  let count = 0;
  const cursor = new Date(from);
  while (cursor.getTime() < to.getTime()) {
    cursor.setDate(cursor.getDate() + 1);
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}
