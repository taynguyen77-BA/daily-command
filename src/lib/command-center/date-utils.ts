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
