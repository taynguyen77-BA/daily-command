// V2.38 J4/J5 — turns the date WORDS a model copied from a command or meeting notes ("monday",
// "tomorrow", "next week", "in 3 days", or an ISO date) into a local YYYY-MM-DD. Deterministic:
// the model never computes a date. Anything else is unresolved — the caller asks, never guesses.

import { addDays } from "../date-utils";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function resolveWhen(word: string | undefined, today: string): string | undefined {
  if (!word) return undefined;
  const w = word.trim().toLowerCase().replace(/^(on|by|until|till|to)\s+/, "").replace(/[.,!]$/, "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return w > today ? w : undefined;
  if (w === "today" || w === "eod" || w === "end of day") return today;
  if (w === "tomorrow" || w === "tmr") return addDays(today, 1);
  if (w === "next week") return nextWeekday(today, 1);
  const inDays = /^in (\d{1,2}) days?$/.exec(w);
  if (inDays) return addDays(today, Number(inDays[1]));
  const day = WEEKDAYS.findIndex((d) => w === d || w === d.slice(0, 3) || w === `next ${d}` || w === `this ${d}`);
  if (day >= 0) return nextWeekday(today, day);
  return undefined;
}

/** The next given weekday strictly after `today` (Monday on a Monday = a week later). */
export function nextWeekday(today: string, weekday: number): string {
  const d = new Date(today + "T00:00:00").getDay();
  const delta = ((weekday - d + 7) % 7) || 7;
  return addDays(today, delta);
}
