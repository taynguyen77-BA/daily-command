// P3.5 — the digest queue: NORMAL signals held back (quiet hours, digest mode) and flushed as ONE Slack message.
// Pure helpers + the store contract. The queue is bounded (100, oldest dropped) and idempotent (a signal that is
// already queued is not queued twice).

import { localDateOf, isQuietNow, type NotifyPrefs } from "./notify-prefs";

export const MAX_DIGEST_ITEMS = 100;

export interface DigestItem {
  /** Stable identity: `${kind}|${issueKey}|${commentId ?? ""}`. */
  id: string;
  kind: "MENTION" | "ASSIGNMENT" | "ESCALATION";
  issueKey: string;
  summary: string;
  detail: string;
  url?: string;
  urgent: boolean;
  /** ISO time the underlying event happened (mention time) or was queued. */
  at: string;
}

export interface DigestState {
  items: DigestItem[];
  lastFlushAt?: string;
}

export interface DigestStore {
  get(): Promise<DigestState>;
  set(state: DigestState): Promise<void>;
}

export function createInMemoryDigestStore(initial: DigestState = { items: [] }): DigestStore {
  let s: DigestState = initial;
  return { get: async () => s, set: async (n) => { s = n; } };
}

export function digestItemId(kind: DigestItem["kind"], issueKey: string, commentId?: string): string {
  return `${kind}|${issueKey}|${commentId ?? ""}`;
}

/** Append without duplicates, keep the newest `cap`. */
export function enqueueDigest(queue: readonly DigestItem[], add: readonly DigestItem[], cap: number = MAX_DIGEST_ITEMS): DigestItem[] {
  const seen = new Set(queue.map((i) => i.id));
  const out = [...queue];
  for (const i of add) if (!seen.has(i.id)) { seen.add(i.id); out.push(i); }
  return out.length > cap ? out.slice(out.length - cap) : out;
}

/** When should a non-empty queue be sent? Never during quiet hours.
 *  immediate: as soon as quiet hours are over. hourly: at most once an hour. daily: once per local day. */
export function digestDue(prefs: Pick<NotifyPrefs, "mode" | "quietHours">, lastFlushAt: string | undefined, now: Date, offsetMinutes: number = 0): boolean {
  if (isQuietNow(prefs.quietHours, now, offsetMinutes)) return false;
  if (prefs.mode === "immediate") return true;
  if (!lastFlushAt) return true;
  const last = new Date(lastFlushAt);
  if (!Number.isFinite(last.getTime())) return true;
  if (prefs.mode === "digest-hourly") return now.getTime() - last.getTime() >= 60 * 60_000;
  return localDateOf(last, offsetMinutes) < localDateOf(now, offsetMinutes);
}
