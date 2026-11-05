// W1 — Morning Briefing: ONE proactive message per workday that says what matters, delivered even when the app is closed.
// Deterministic content (sections 1-6), built from: the member's ReminderIndex (D4), a compact BriefingSnapshot the browser mirrors
// (Next Best Actions, new HIGH slip risks, mentions awaiting you — ticket keys + short reasons only, no ticket text), and one live Jira
// query (assigned tickets due within 2 days). Pure apart from injected I/O. Optional AI narration is an injection point (`narrate`):
// at most one call per user per day, only when configured and within the cap; otherwise the deterministic sentence.

import { isQuietNow, type NotifyPrefs } from "./notify-prefs";
import { REPLY_SLA_BUSINESS_DAYS } from "./awaiting-me";
import type { ReminderIndex } from "./reminder-index";
import { DEFAULT_REMINDER_PREFS, isWeekend, reminderDueNow, type ReminderNow } from "./reminder-schedule";

export const BRIEFING_MAX_LINES = 15;
export const BRIEFING_STALE_HOURS = 12;
export const BRIEFING_MAX_ATTEMPTS = 8;

export interface BriefingPrefs {
  /** Off by default: nothing new is sent until the user turns it on. */
  enabled: boolean;
  /** "HH:mm" in the member's zone. */
  time: string;
  skipWeekends: boolean;
  /** On: an empty day sends nothing. Off (default): a short "nothing needs you today" line. */
  skipIfEmpty: boolean;
  /** Local YYYY-MM-DD days with no briefing (holidays). */
  skipDates: string[];
}
export const DEFAULT_BRIEFING_PREFS: BriefingPrefs = { enabled: false, time: "08:30", skipWeekends: true, skipIfEmpty: false, skipDates: [] };

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export function asBriefingPrefs(raw: unknown): BriefingPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<BriefingPrefs>;
  return {
    enabled: r.enabled === true,
    time: typeof r.time === "string" && HM.test(r.time) ? r.time : DEFAULT_BRIEFING_PREFS.time,
    skipWeekends: r.skipWeekends !== false,
    skipIfEmpty: r.skipIfEmpty === true,
    skipDates: Array.isArray(r.skipDates) ? r.skipDates.filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 100) : [],
  };
}
export function validateBriefingTime(v: unknown): { ok: true } | { ok: false; message: string } {
  return typeof v === "string" && HM.test(v) ? { ok: true } : { ok: false, message: "Use a time as HH:mm (00:00 – 23:59)." };
}
const minutesOf = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

export interface BriefingSnapshot {
  /** ISO of the browser session that built it. */
  builtAt: string;
  nba: { key: string; headline: string }[];
  slipHigh: { key: string; reason: string }[];
  awaiting: { key: string; ageBusinessDays: number }[];
}
export interface BriefingRecord {
  snapshot?: BriefingSnapshot;
  prefs: BriefingPrefs;
  /** Slip-risk keys seen in the previous briefing (so "new since yesterday" is computable). */
  prevSlipKeys?: string[];
  lastSentOn?: string;
  attempts?: number;
  /** Titles / URLs for ticket links, from the client mirror (short). */
  links?: Record<string, { title?: string; url?: string }>;
}
/** Titles and https URLs only, bounded: the briefing renders them into a Slack message. */
function cleanLinks(raw: Record<string, unknown>): NonNullable<BriefingRecord["links"]> {
  const out: NonNullable<BriefingRecord["links"]> = {};
  for (const [k, v] of Object.entries(raw).slice(0, 200)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(k) || !v || typeof v !== "object") continue;
    const o = v as { title?: unknown; url?: unknown };
    const url = typeof o.url === "string" && /^https:\/\/[^\s<>|]+$/.test(o.url) && o.url.length <= 300 ? o.url : undefined;
    const title = typeof o.title === "string" ? o.title.replace(/[<>|\n\r]/g, " ").trim().slice(0, 100) : undefined;
    if (url || title) out[k] = { ...(title ? { title } : {}), ...(url ? { url } : {}) };
  }
  return out;
}
export interface BriefingStore { get(): Promise<BriefingRecord | null>; set(r: BriefingRecord): Promise<void> }
export function createInMemoryBriefingStore(initial: BriefingRecord | null = null): BriefingStore {
  let v = initial;
  return { get: async () => v, set: async (n) => { v = n; } };
}
export function asBriefingRecord(raw: unknown): BriefingRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<BriefingRecord>;
  const s = r.snapshot;
  const snapshot = s && typeof s === "object" && typeof s.builtAt === "string" && Array.isArray(s.nba) && Array.isArray(s.slipHigh) && Array.isArray(s.awaiting)
    ? { builtAt: s.builtAt, nba: s.nba.filter((n) => n && typeof n.key === "string" && typeof n.headline === "string").slice(0, 3).map((n) => ({ key: n.key, headline: n.headline.slice(0, 140) })), slipHigh: s.slipHigh.filter((n) => n && typeof n.key === "string").slice(0, 30).map((n) => ({ key: n.key, reason: String(n.reason ?? "").slice(0, 140) })), awaiting: s.awaiting.filter((n) => n && typeof n.key === "string" && typeof n.ageBusinessDays === "number").slice(0, 30) }
    : undefined;
  return {
    prefs: asBriefingPrefs(r.prefs),
    ...(snapshot ? { snapshot } : {}),
    ...(Array.isArray(r.prevSlipKeys) ? { prevSlipKeys: r.prevSlipKeys.filter((k): k is string => typeof k === "string").slice(0, 100) } : {}),
    ...(typeof r.lastSentOn === "string" ? { lastSentOn: r.lastSentOn } : {}),
    ...(typeof r.attempts === "number" ? { attempts: r.attempts } : {}),
    ...(r.links && typeof r.links === "object" ? { links: cleanLinks(r.links as Record<string, unknown>) } : {}),
  };
}

export interface DueSoonTicket { key: string; title?: string; dueDate: string }

export interface BriefingContent { lines: string[]; moreInApp: number; sectionCount: number; empty: boolean; text: string; notes: string[] }

const link = (key: string, links: BriefingRecord["links"]) => (links?.[key]?.url ? `<${links[key].url}|${key}>` : key);
const tail = (key: string, links: BriefingRecord["links"]) => (links?.[key]?.title ? ` — ${links[key].title}` : "");

/** Reminders due today or overdue, date-based (the delivery hour does not apply to the briefing: it IS the morning message). */
export function dueReminderKeys(index: ReminderIndex | null, today: string): { key: string; line: string }[] {
  if (!index) return [];
  const prefs = index.prefs ?? DEFAULT_REMINDER_PREFS;
  const out: { key: string; line: string }[] = [];
  for (const i of index.items) {
    if (i.resolved) continue;
    const d = reminderDueNow({ status: i.status, until: i.remindOn, reminder: { level: i.level, setAt: i.parkedAt, ...(i.lastRemindedOn ? { lastRemindedOn: i.lastRemindedOn } : {}), ...(i.snoozedUntil ? { snoozedUntil: i.snoozedUntil } : {}), ...(i.noReminder ? { noReminder: true } : {}) } }, { date: today, minutes: 24 * 60 }, prefs);
    if (d) out.push({ key: i.ticketKey, line: `${i.status === "BLOCKED" ? "Blocked" : i.status === "SKIPPED" ? "Skipped" : "Deferred"}${i.reason ? `: ${i.reason}` : ""}${d.level > 0 ? " (reminder again)" : ""}` });
  }
  return out;
}

export function buildBriefing(args: {
  today: string;
  record: BriefingRecord;
  index: ReminderIndex | null;
  /** null = Jira unreachable (sections 3 is omitted with a note). */
  dueSoon: DueSoonTicket[] | null;
  now: Date;
  /** The one-sentence heads-up (AI narration or the deterministic one). */
  narration?: string;
  max?: number;
}): BriefingContent {
  const max = args.max ?? BRIEFING_MAX_LINES;
  const { record, today } = args;
  const links = record.links;
  const snap = record.snapshot;
  const notes: string[] = [];
  const sections: string[][] = [];

  const reminders = dueReminderKeys(args.index, today);
  if (reminders.length) sections.push([`*Reminders due* (${reminders.length})`, ...reminders.map((r) => `• ${link(r.key, links)}${tail(r.key, links)} · ${r.line}`)]);
  if (snap && snap.nba.length) sections.push([`*Do next*`, ...snap.nba.map((n) => `• ${link(n.key, links)} — ${n.headline}`)]);
  if (args.dueSoon === null) notes.push("Jira could not be reached, so tickets due soon and your mentions are not included.");
  else if (args.dueSoon.length) {
    sections.push([`*Due within 2 days or overdue* (${args.dueSoon.length})`, ...args.dueSoon.slice().sort((a, b) => a.dueDate.localeCompare(b.dueDate)).map((t) => `• ${link(t.key, links)}${t.title ? ` — ${t.title}` : tail(t.key, links)} · due ${t.dueDate}${t.dueDate < today ? " (overdue)" : ""}`)]);
  }
  const awaiting = args.dueSoon === null ? [] : (snap?.awaiting ?? []).filter((a) => a.ageBusinessDays > REPLY_SLA_BUSINESS_DAYS);
  if (awaiting.length) sections.push([`*Waiting for your reply* (past ${REPLY_SLA_BUSINESS_DAYS} business days)`, ...awaiting.map((a) => `• ${link(a.key, links)}${tail(a.key, links)} · ${a.ageBusinessDays} business days`)]);
  const prev = new Set(record.prevSlipKeys ?? []);
  const fresh = (snap?.slipHigh ?? []).filter((s) => !prev.has(s.key));
  if (fresh.length) sections.push([`*New high slip risk*`, ...fresh.map((s) => `• ${link(s.key, links)}${tail(s.key, links)} · ${s.reason}`)]);

  const staleHours = snap ? (args.now.getTime() - Date.parse(snap.builtAt)) / 3_600_000 : null;
  if (snap && staleHours !== null && staleHours > BRIEFING_STALE_HOURS) notes.push(`Next actions, mentions and slip risks are based on your last session (${snap.builtAt.slice(0, 16).replace("T", " ")} UTC).`);

  const empty = sections.length === 0;
  const totalItems = sections.reduce((n, s) => n + s.length - 1, 0);
  const headsUp = args.narration ?? (empty ? "" : `Heads-up: ${reminders.length} reminder${reminders.length === 1 ? "" : "s"} due, ${args.dueSoon?.length ?? 0} ticket${(args.dueSoon?.length ?? 0) === 1 ? "" : "s"} due within 2 days.`);
  const head = `☀️ Morning briefing — ${today}`;
  let lines: string[];
  let moreInApp = 0;
  if (empty) lines = [head, "Nothing needs you today."];
  else {
    const room = Math.max(1, max - 1 - (headsUp ? 1 : 0) - notes.length);
    // Section headers count as lines; truncate whole item lines when over budget.
    const kept: string[] = [];
    let itemsShown = 0;
    for (const s of sections) {
      if (kept.length >= room) break;
      kept.push(s[0]);
      for (const it of s.slice(1)) {
        if (kept.length >= room) break;
        kept.push(it);
        itemsShown += 1;
      }
    }
    moreInApp = Math.max(0, totalItems - itemsShown);
    lines = [head, ...kept, ...(moreInApp ? [`+${moreInApp} more in the app`] : []), ...(headsUp ? [headsUp] : [])];
  }
  for (const n of notes) lines.push(`_${n}_`);
  return { lines, moreInApp, sectionCount: sections.length, empty, text: lines.join("\n"), notes };
}

export function briefingDueNow(prefs: BriefingPrefs, local: ReminderNow, lastSentOn?: string): { due: boolean; why?: "disabled" | "weekend" | "skip-date" | "too-early" | "already-sent" } {
  if (!prefs.enabled) return { due: false, why: "disabled" };
  if (prefs.skipWeekends && isWeekend(local.date)) return { due: false, why: "weekend" };
  if (prefs.skipDates.includes(local.date)) return { due: false, why: "skip-date" };
  if (lastSentOn === local.date) return { due: false, why: "already-sent" };
  if (local.minutes < minutesOf(prefs.time)) return { due: false, why: "too-early" };
  return { due: true };
}

export interface BriefingTickDeps {
  store: BriefingStore;
  remindersStore: { get(): Promise<ReminderIndex | null> } | null;
  /** Assigned open tickets due within 2 days / overdue; null = Jira unreachable. */
  fetchDueSoon: ((today: string) => Promise<DueSoonTicket[] | null>) | null;
  send: ((text: string) => Promise<boolean>) | null;
  now: Date;
  local: ReminderNow;
  quiet?: NotifyPrefs["quietHours"];
  offsetMinutes?: number;
  /** Optional one-sentence AI narration (≤ 1 call/user/day, capped); throws/null -> the deterministic sentence. */
  narrate?: (facts: string[]) => Promise<string | null>;
}
export interface BriefingTickResult { sent: boolean; skipped?: "disabled" | "weekend" | "skip-date" | "too-early" | "already-sent" | "no-record" | "no-slack" | "quiet-hours" | "empty"; error?: string; lines?: number }

export async function runBriefingTick(deps: BriefingTickDeps): Promise<BriefingTickResult> {
  let record: BriefingRecord | null;
  try { record = await deps.store.get(); } catch { return { sent: false, skipped: "no-record", error: "briefing record unreadable" }; }
  if (!record) return { sent: false, skipped: "no-record" };
  const due = briefingDueNow(record.prefs, deps.local, record.lastSentOn);
  if (!due.due) return { sent: false, skipped: due.why };
  if (!deps.send) return { sent: false, skipped: "no-slack" };
  if (isQuietNow(deps.quiet, deps.now, deps.offsetMinutes ?? 0)) return { sent: false, skipped: "quiet-hours" };
  const index = await (deps.remindersStore?.get() ?? Promise.resolve(null)).catch(() => null);
  let dueSoon: DueSoonTicket[] | null = [];
  if (deps.fetchDueSoon) { try { dueSoon = await deps.fetchDueSoon(deps.local.date); } catch { dueSoon = null; } }
  let narration: string | undefined;
  if (deps.narrate) {
    try { narration = (await deps.narrate([...(record.snapshot?.nba.map((n) => `${n.key}: ${n.headline}`) ?? []), ...(dueSoon ?? []).map((t) => `${t.key} due ${t.dueDate}`)])) ?? undefined; } catch { narration = undefined; }
  }
  const content = buildBriefing({ today: deps.local.date, record, index, dueSoon, now: deps.now, ...(narration ? { narration } : {}) });
  if (content.empty && record.prefs.skipIfEmpty) {
    await deps.store.set({ ...record, lastSentOn: deps.local.date, attempts: 0 }).catch(() => undefined);
    return { sent: false, skipped: "empty" };
  }
  let delivered = false;
  try { delivered = await deps.send(content.text); } catch { delivered = false; }
  if (!delivered) {
    const attempts = (record.attempts ?? 0) + 1;
    // Owed and retried on the next runs of the same day; bounded (C1) — after the bound it is skipped for today.
    await deps.store.set({ ...record, attempts: attempts >= BRIEFING_MAX_ATTEMPTS ? 0 : attempts, ...(attempts >= BRIEFING_MAX_ATTEMPTS ? { lastSentOn: deps.local.date } : {}) }).catch(() => undefined);
    return { sent: false, error: "Slack delivery failed — the briefing stays owed today" };
  }
  try { await deps.store.set({ ...record, lastSentOn: deps.local.date, attempts: 0, prevSlipKeys: (record.snapshot?.slipHigh ?? []).map((s) => s.key) }); } catch { return { sent: true, lines: content.lines.length, error: "could not record the send (a duplicate is possible)" }; }
  return { sent: true, lines: content.lines.length };
}

/** The client's snapshot update keeps the server-owned progress (lastSentOn, attempts, prevSlipKeys). */
export function mergeClientBriefing(existing: BriefingRecord | null, incoming: { snapshot?: BriefingSnapshot; prefs: BriefingPrefs; links?: BriefingRecord["links"] }): BriefingRecord {
  return { ...(existing ?? {}), prefs: incoming.prefs, ...(incoming.snapshot ? { snapshot: incoming.snapshot } : {}), ...(incoming.links ? { links: incoming.links } : {}) };
}
