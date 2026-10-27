// P3.5 — smart notifications: the user's preferences. Pure. DEFAULT_NOTIFY_PREFS reproduces today's
// behaviour exactly: every signal is sent at once, nothing is muted, quiet hours are off.
// Stored where the cron can read it without a browser (KV, scoped like the notify baseline) and read/written
// through /api/command-center/notify (zod-validated, same auth).

import { z } from "zod";

export type NotifyMode = "immediate" | "digest-hourly" | "digest-daily";
export type ImmediateKind = "ASSIGNMENT_P1P2" | "MENTION_URGENT" | "ESCALATION";
export const IMMEDIATE_KINDS: readonly ImmediateKind[] = ["ASSIGNMENT_P1P2", "MENTION_URGENT", "ESCALATION"];

export interface NotifyPrefs {
  mode: NotifyMode;
  /** "HH:mm" in the member's timezone. start == end means no quiet hours; start > end crosses midnight. */
  quietHours?: { start: string; end: string };
  /** URGENT signals of these kinds are sent at once even in quiet hours / digest mode. */
  immediateKinds: ImmediateKind[];
  /** Project keys (the prefix of a ticket key) that never notify. */
  mutedProjects: string[];
  /** A run that would send more than this many separate messages sends the first N and one "+M more" summary. 0 = no limit (default). */
  maxPerRun: number;
  /** Re-announce, once, a mention you have not answered after the reply SLA. Off by default (today's behaviour). */
  escalateUnanswered: boolean;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = { mode: "immediate", immediateKinds: [...IMMEDIATE_KINDS], mutedProjects: [], maxPerRun: 0, escalateUnanswered: false };

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const notifyPrefsSchema = z.object({
  mode: z.enum(["immediate", "digest-hourly", "digest-daily"]),
  quietHours: z.object({ start: z.string().regex(HM), end: z.string().regex(HM) }).optional(),
  immediateKinds: z.array(z.enum(["ASSIGNMENT_P1P2", "MENTION_URGENT", "ESCALATION"])).max(3),
  mutedProjects: z.array(z.string().trim().min(1).max(20)).max(100),
  maxPerRun: z.number().int().min(0).max(200),
  escalateUnanswered: z.boolean(),
});

/** Anything stored or sent that does not validate reads as the defaults — a bad record can never silence the user. */
export function asNotifyPrefs(raw: unknown): NotifyPrefs {
  const parsed = notifyPrefsSchema.safeParse(raw);
  if (!parsed.success) return { ...DEFAULT_NOTIFY_PREFS, immediateKinds: [...DEFAULT_NOTIFY_PREFS.immediateKinds] };
  const p = parsed.data;
  return { mode: p.mode, ...(p.quietHours ? { quietHours: p.quietHours } : {}), immediateKinds: Array.from(new Set(p.immediateKinds)), mutedProjects: Array.from(new Set(p.mutedProjects.map((k) => k.toUpperCase()))), maxPerRun: p.maxPerRun, escalateUnanswered: p.escalateUnanswered };
}

export function isDefaultNotifyPrefs(p: NotifyPrefs): boolean {
  const q = p.quietHours;
  return p.mode === "immediate" && (!q || q.start === q.end) && p.mutedProjects.length === 0 && p.maxPerRun === 0 && !p.escalateUnanswered;
}

export function minutesOf(hm: string): number {
  const m = HM.exec(hm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** Minutes since local midnight at `now`, for a fixed UTC offset in minutes (no DST rules: the offset is the member's/Jira's configured one). */
export function localMinutesOfDay(now: Date, offsetMinutes: number = 0): number {
  const t = new Date(now.getTime() + offsetMinutes * 60_000);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}

export function localDateOf(now: Date, offsetMinutes: number = 0): string {
  return new Date(now.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** Quiet hours are [start, end): the start minute is quiet, the end minute is not. start > end crosses midnight. */
export function isQuietNow(quiet: NotifyPrefs["quietHours"], now: Date, offsetMinutes: number = 0): boolean {
  if (!quiet) return false;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === end) return false;
  const m = localMinutesOfDay(now, offsetMinutes);
  return start < end ? m >= start && m < end : m >= start || m < end;
}

export interface NotifyPrefsStore {
  /** null = never saved (the defaults apply). */
  get(): Promise<NotifyPrefs | null>;
  set(prefs: NotifyPrefs): Promise<void>;
}

export function createInMemoryNotifyPrefsStore(initial: NotifyPrefs | null = null): NotifyPrefsStore {
  let p = initial;
  return { get: async () => p, set: async (n) => { p = n; } };
}
