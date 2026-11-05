// D4 — the cron step that reminds with the app closed. Pure apart from injected I/O (index store, Jira check, Slack sender, clock):
//   due items (member's zone, delivery hour, not snoozed, nothing sent today) -> ONE batched Jira check that drops tickets already Done /
//   not mine -> ONE grouped Slack message -> record progress. Delivery guarantees as C1: a failed Slack post records nothing (the reminder
//   stays owed, delivered exactly once when Slack is back); attempts are bounded; a flood shows the first lines and "+N more", the rest
//   drains over later runs. Quiet hours (P3.5) defer. Jira unreachable: send anyway, mark `unverified`, check again next run.

import { isQuietNow, type NotifyPrefs } from "./notify-prefs";
import { buildReminderDigest, REMINDER_DIGEST_MAX_LINES, type DueReminder } from "./reminder-digest";
import { mergeIndexProgress, type ReminderIndex, type ReminderIndexItem, type ReminderIndexStore } from "./reminder-index";
import { DEFAULT_REMINDER_PREFS, reminderDueNow, type ReminderNow } from "./reminder-schedule";

export const REMINDER_MAX_ATTEMPTS = 8;

export type ParkedTicketCheck = Map<string, "open" | "closed" | "not-mine">;

export interface RemindersTickDeps {
  store: ReminderIndexStore;
  /** Batched Jira check (null = Jira not reachable / no connection: send anyway, unverified). */
  checkJira: ((keys: string[]) => Promise<ParkedTicketCheck | null>) | null;
  /** Posts one Slack message; false/throw = failed. null = Slack not configured (in-app only: nothing is sent or consumed). */
  send: ((text: string) => Promise<boolean>) | null;
  now: Date;
  /** Member's local date + minutes of day. */
  local: ReminderNow;
  quiet?: NotifyPrefs["quietHours"];
  offsetMinutes?: number;
  maxLines?: number;
}

export interface RemindersTickResult {
  due: number;
  sent: number;
  /** Resolved without a message (Done / not mine in Jira). */
  dropped: number;
  /** Still owed after this run (Slack down, quiet hours, or beyond the flood guard). */
  owed: number;
  unverified: boolean;
  skipped?: "no-index" | "no-slack" | "quiet-hours" | "nothing-due";
  error?: string;
}

const toItemFor = (index: ReminderIndex, key: string) => index.items.find((i) => i.ticketKey === key);

export async function runRemindersTick(deps: RemindersTickDeps): Promise<RemindersTickResult> {
  const base: RemindersTickResult = { due: 0, sent: 0, dropped: 0, owed: 0, unverified: false };
  let index: ReminderIndex | null;
  try { index = await deps.store.get(); } catch { return { ...base, skipped: "no-index", error: "reminder index unreadable" }; }
  if (!index || index.items.length === 0) return { ...base, skipped: "no-index" };
  const prefs = index.prefs ?? DEFAULT_REMINDER_PREFS;

  const dueAll: DueReminder[] = [];
  for (const item of index.items) {
    if (item.resolved) continue;
    const d = reminderDueNow({ status: item.status, until: item.remindOn, reminder: { level: item.level, setAt: item.parkedAt, ...(item.lastRemindedOn ? { lastRemindedOn: item.lastRemindedOn } : {}), ...(item.snoozedUntil ? { snoozedUntil: item.snoozedUntil } : {}), ...(item.noReminder ? { noReminder: true } : {}) } }, deps.local, prefs);
    if (d) dueAll.push({ item, level: d.level, dueOn: d.dueOn });
  }
  base.due = dueAll.length;
  if (dueAll.length === 0) return { ...base, skipped: "nothing-due" };
  if (!deps.send) return { ...base, owed: dueAll.length, skipped: "no-slack" };
  if (isQuietNow(deps.quiet, deps.now, deps.offsetMinutes ?? 0)) return { ...base, owed: dueAll.length, skipped: "quiet-hours" };

  // One batched Jira check for the tickets that would be shown (flood guard first, so a huge backlog costs one chunk, not hundreds).
  const max = deps.maxLines ?? REMINDER_DIGEST_MAX_LINES;
  const candidates = buildReminderDigest(dueAll, deps.local.date, max).shown;
  let unverified = false;
  let checked: ParkedTicketCheck | null = null;
  if (deps.checkJira) {
    try { checked = await deps.checkJira(candidates.map((c) => c.item.ticketKey)); } catch { checked = null; }
  }
  if (!checked) unverified = true;
  const working: ReminderIndex = JSON.parse(JSON.stringify(index));
  let dropped = 0;
  const keep: DueReminder[] = [];
  for (const c of candidates) {
    const verdict = checked?.get(c.item.ticketKey);
    if (verdict === "closed" || verdict === "not-mine") {
      const w = toItemFor(working, c.item.ticketKey)!;
      w.resolved = verdict === "closed" ? "closed in Jira" : "not assigned to me";
      dropped += 1;
    } else keep.push({ ...c, item: { ...c.item, ...(unverified ? { unverified: true } : {}) } });
  }
  if (keep.length === 0) {
    try { await deps.store.set(working); } catch { /* best effort */ }
    return { ...base, dropped, owed: dueAll.length - candidates.length, unverified, skipped: "nothing-due" };
  }

  const digest = buildReminderDigest(keep, deps.local.date, max, dueAll.length - candidates.length);
  let delivered = false;
  try { delivered = await deps.send(digest.text); } catch { delivered = false; }
  if (!delivered) {
    // Owed: nothing is consumed; attempts are bounded (C1) so a dead webhook cannot grow state forever.
    for (const k of keep) {
      const w = toItemFor(working, k.item.ticketKey)!;
      w.attempts = (w.attempts ?? 0) + 1;
      if (w.attempts >= REMINDER_MAX_ATTEMPTS) {
        // Bounded (C1): give up for today and move the ladder on instead of retrying a dead webhook forever.
        w.lastRemindedOn = deps.local.date;
        w.attempts = 0;
      }
      if (unverified) w.unverified = true;
    }
    try { await deps.store.set(working); } catch { /* best effort */ }
    return { ...base, dropped, owed: dueAll.length - dropped, unverified, error: "Slack delivery failed — reminders stay owed" };
  }
  for (const s of digest.shown) {
    const w = toItemFor(working, s.item.ticketKey)!;
    w.lastRemindedOn = deps.local.date;
    w.level = s.level;
    w.attempts = 0;
    if (unverified) w.unverified = true; else delete w.unverified;
  }
  try { await deps.store.set(working); } catch { return { ...base, sent: digest.shown.length, dropped, owed: 0, unverified, error: "could not record progress (a duplicate is possible on the next run)" }; }
  return { ...base, sent: digest.shown.length, dropped, owed: dueAll.length - dropped - digest.shown.length, unverified };
}

/** What the client mirror posts: replaces the index, keeping the cron's escalation progress for the SAME parking. */
export async function storeClientIndex(store: ReminderIndexStore, incoming: ReminderIndex): Promise<ReminderIndex> {
  const merged = mergeIndexProgress(incoming, await store.get().catch(() => null));
  await store.set(merged);
  return merged;
}

export type { ReminderIndexItem };
