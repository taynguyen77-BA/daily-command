// V2.53 fix 1 — two small, pure rules that cut KV bytes on the 15-minute cron tick without changing what it does.

import type { NotifyPrefs, NotifyPrefsStore } from "./notify-prefs";
import type { PersonalNotifyState } from "./notify-state";

/** The notify state is rewritten every tick only to move its `lastCheckedAtIso` cursor. Skip that write when nothing
 *  else changed and the stored cursor is under an hour old (a slightly older cursor only widens the next `updated >=`
 *  query; already-notified ids are de-duplicated, so no signal is lost or repeated). */
export const NOTIFY_CURSOR_MAX_STALE_MS = 60 * 60 * 1000;

export function shouldWriteNotifyState(previous: PersonalNotifyState | null, next: PersonalNotifyState, now: Date): boolean {
  if (!previous) return true;
  const prevAt = Date.parse(previous.lastCheckedAtIso);
  if (!Number.isFinite(prevAt)) return true;
  const age = now.getTime() - prevAt;
  if (age < 0 || age >= NOTIFY_CURSOR_MAX_STALE_MS) return true;
  const strip = (s: PersonalNotifyState) => JSON.stringify({ ...s, lastCheckedAtIso: "" });
  return strip(previous) !== strip(next);
}

/** One tick reads the member's notification preferences up to three times (notify, reminders, briefing). Within a tick
 *  they cannot change, so the first read is reused; a set drops the memo. */
export function memoizePrefsStore(inner: NotifyPrefsStore): NotifyPrefsStore {
  let memo: { value: NotifyPrefs | null } | null = null;
  return {
    async get() {
      if (!memo) memo = { value: await inner.get() };
      return memo.value;
    },
    async set(prefs) {
      memo = null;
      await inner.set(prefs);
    },
  };
}
