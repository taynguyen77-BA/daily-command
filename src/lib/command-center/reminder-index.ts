// D4 — the compact ReminderIndex the browser mirrors to KV so the cron can remind with the app closed. Only what a reminder needs:
// ticket key, state, date, short reason/title, escalation progress. No description, no comment text. Pure.

import { asReminderPrefs, type ReminderPrefs } from "./reminder-schedule";
import { isReminderState, remindOnOf, type ReminderState } from "./reminder-model";
import type { TicketWorkState, WorkItem } from "./types";

export const REMINDER_INDEX_MAX_ITEMS = 500;

export interface ReminderIndexItem {
  ticketKey: string;
  status: ReminderState;
  remindOn?: string;
  reason?: string;
  title?: string;
  projectKey: string;
  url?: string;
  snoozedUntil?: string;
  level: number;
  lastRemindedOn?: string;
  noReminder?: boolean;
  /** When the ticket was parked (ISO) — "age" in the message, and the Parked-without-a-date clock. */
  parkedAt: string;
  /** Server-side only: failed Slack attempts (bounded, as in C1). */
  attempts?: number;
  /** Server-side only: the cron found it Done / not mine in Jira. */
  resolved?: "closed in Jira" | "not assigned to me";
  /** Server-side only: the Jira check could not run when this was last sent. */
  unverified?: boolean;
}

export interface ReminderIndex {
  version: 1;
  /** ISO of the client mirror that wrote it. */
  builtAt: string;
  items: ReminderIndexItem[];
  /** The member's reminder settings (delivery hour, ladder, weekends) — the cron has no browser to read them from. */
  prefs?: ReminderPrefs;
}

const short = (s: string | undefined, n: number) => (s ? s.replace(/\s+/g, " ").trim().slice(0, n) : undefined);
export const projectKeyOfTicket = (key: string): string => key.split("-")[0].toUpperCase();

export function buildReminderIndex(states: Record<string, TicketWorkState>, workItems: readonly Pick<WorkItem, "key" | "title" | "sourceUrl">[], nowIso: string, prefs?: ReminderPrefs): ReminderIndex {
  const byKey = new Map(workItems.map((w) => [w.key, w]));
  const items: ReminderIndexItem[] = [];
  for (const r of Object.values(states)) {
    if (!isReminderState(r.status)) continue;
    const w = byKey.get(r.ticketKey);
    const remindOn = remindOnOf(r);
    items.push({
      ticketKey: r.ticketKey,
      status: r.status,
      ...(remindOn ? { remindOn } : {}),
      ...(short(r.reason, 120) ? { reason: short(r.reason, 120)! } : {}),
      ...(w ? { title: short(w.title, 120)! } : {}),
      ...(w?.sourceUrl ? { url: w.sourceUrl } : {}),
      projectKey: projectKeyOfTicket(r.ticketKey),
      ...(r.reminder?.snoozedUntil ? { snoozedUntil: r.reminder.snoozedUntil } : {}),
      level: r.reminder?.level ?? 0,
      ...(r.reminder?.lastRemindedOn ? { lastRemindedOn: r.reminder.lastRemindedOn } : {}),
      ...(r.reminder?.noReminder ? { noReminder: true } : {}),
      parkedAt: r.reminder?.setAt ?? r.updatedAt,
    });
  }
  items.sort((a, b) => (a.remindOn ?? "9999").localeCompare(b.remindOn ?? "9999") || a.ticketKey.localeCompare(b.ticketKey));
  return { version: 1, builtAt: nowIso, items: items.slice(0, REMINDER_INDEX_MAX_ITEMS), ...(prefs ? { prefs } : {}) };
}

/** Stable signature of what the SERVER needs from the client (progress fields excluded) — the mirror only posts when it changes. */
export function indexSignature(index: ReminderIndex): string {
  return JSON.stringify([index.prefs ?? null, ...index.items.map((i) => [i.ticketKey, i.status, i.remindOn ?? "", i.snoozedUntil ?? "", i.noReminder ? 1 : 0, i.reason ?? "", i.title ?? "", i.parkedAt])]);
}

/** A client index replaces the server's, but escalation progress made by the cron survives for the SAME parking (same state + date):
 *  level / lastRemindedOn / attempts / resolved come from the existing item; a changed date or state starts over. */
export function mergeIndexProgress(incoming: ReminderIndex, existing: ReminderIndex | null): ReminderIndex {
  const old = new Map((existing?.items ?? []).map((i) => [i.ticketKey, i]));
  return {
    ...incoming,
    items: incoming.items.map((i) => {
      const o = old.get(i.ticketKey);
      const same = o && o.status === i.status && o.remindOn === i.remindOn && o.parkedAt === i.parkedAt;
      if (!same) return i;
      const keepsServerProgress = (o.level ?? 0) >= i.level ? o : i;
      return { ...i, level: keepsServerProgress.level, ...(keepsServerProgress.lastRemindedOn ? { lastRemindedOn: keepsServerProgress.lastRemindedOn } : {}), ...(o.attempts ? { attempts: o.attempts } : {}), ...(o.resolved ? { resolved: o.resolved } : {}) };
    }),
  };
}

export function asReminderIndex(raw: unknown): ReminderIndex | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<ReminderIndex>;
  if (r.version !== 1 || typeof r.builtAt !== "string" || !Array.isArray(r.items)) return null;
  const items = r.items.filter((i): i is ReminderIndexItem => !!i && typeof i === "object" && typeof (i as ReminderIndexItem).ticketKey === "string" && isReminderState(String((i as ReminderIndexItem).status)) && typeof (i as ReminderIndexItem).parkedAt === "string").slice(0, REMINDER_INDEX_MAX_ITEMS);
  return { version: 1, builtAt: r.builtAt, items, ...(r.prefs ? { prefs: asReminderPrefs(r.prefs) } : {}) };
}

export interface ReminderIndexStore {
  get(): Promise<ReminderIndex | null>;
  set(index: ReminderIndex): Promise<void>;
}
export function createInMemoryReminderIndexStore(initial: ReminderIndex | null = null): ReminderIndexStore {
  let v = initial;
  return { get: async () => v, set: async (n) => { v = n; } };
}
