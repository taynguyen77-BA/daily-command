// D4 — grouping and Slack text for the reminders that are due. One grouped message ("3 reminders due today"); the flood guard shows the
// first MAX_LINES and says "+N more" — those stay due and drain over later runs. Pure.

import type { ReminderIndexItem } from "./reminder-index";

export const REMINDER_DIGEST_MAX_LINES = 15;
const STATE_LABEL = { BLOCKED: "Blocked", SKIPPED: "Skipped", DEFERRED: "Deferred" } as const;
const LEVEL_TAG = ["", " (2nd reminder)", " (3rd reminder)", " (still parked)"];

export interface DueReminder { item: ReminderIndexItem; level: number; dueOn: string }

const ageDays = (parkedAt: string, today: string) => Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${parkedAt.slice(0, 10)}T00:00:00Z`)) / 86_400_000));

export function buildReminderDigest(due: readonly DueReminder[], today: string, max: number = REMINDER_DIGEST_MAX_LINES, alsoDue: number = 0): { text: string; shown: DueReminder[]; more: number } {
  const ordered = [...due].sort((a, b) => b.level - a.level || a.dueOn.localeCompare(b.dueOn) || a.item.ticketKey.localeCompare(b.item.ticketKey));
  const shown = ordered.slice(0, max);
  const more = ordered.length - shown.length + alsoDue; // alsoDue: more reminders are due than were handed in (the flood guard cut them earlier)
  const lines = shown.map((d) => {
    const i = d.item;
    const link = i.url ? `<${i.url}|${i.ticketKey}>` : i.ticketKey;
    const age = ageDays(i.parkedAt, today);
    return `• ${link}${i.title ? ` — ${i.title}` : ""} · ${STATE_LABEL[i.status]}${i.reason ? `: ${i.reason}` : ""} · parked ${age} day${age === 1 ? "" : "s"}${LEVEL_TAG[Math.min(3, d.level)]}${i.unverified ? " · (not checked in Jira)" : ""}`;
  });
  const total = ordered.length + alsoDue;
  const head = `⏰ ${total} reminder${total === 1 ? "" : "s"} due today`;
  return { text: [head, ...lines, ...(more > 0 ? [`+${more} more — open Reminder Center`] : [])].join("\n"), shown, more };
}
