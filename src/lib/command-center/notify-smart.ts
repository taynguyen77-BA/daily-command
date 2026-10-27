// P3.5 — routing of one cron run's signals under the user's preferences: send now, hold for a digest, drop (muted),
// cap a flood. Pure apart from the injected `send`. A failed post never loses a signal: it is kept for the next flush.

import { digestDue, enqueueDigest, type DigestItem, type DigestState } from "./notify-digest";
import { isQuietNow, type ImmediateKind, type NotifyPrefs } from "./notify-prefs";
import { renderDigest, renderMoreSummary, renderSmartLine } from "./notify-render";

export interface SmartSignal {
  item: DigestItem;
  /** The preference kind this signal may bypass quiet hours / digest mode under (null: it never bypasses). */
  immediateKind: ImmediateKind | null;
  projectKey: string;
}

export interface SmartDelivery {
  /** Signals that reached Slack (individually, in a "+M more" summary, or in a digest). */
  delivered: number;
  /** Signals now waiting in the digest queue. */
  queued: number;
  muted: number;
  /** Slack messages posted this run. */
  messages: number;
  digest: DigestState;
}

export async function deliverSmart(input: {
  signals: readonly SmartSignal[];
  prefs: NotifyPrefs;
  digest: DigestState;
  now: Date;
  offsetMinutes?: number;
  send: (text: string) => Promise<boolean>;
}): Promise<SmartDelivery> {
  const { prefs, now } = input;
  const offset = input.offsetMinutes ?? 0;
  const muted = new Set(prefs.mutedProjects.map((k) => k.toUpperCase()));
  const live = input.signals.filter((s) => !muted.has(s.projectKey.toUpperCase()));
  const quiet = isQuietNow(prefs.quietHours, now, offset);

  const immediate: SmartSignal[] = [];
  let queue = [...input.digest.items];
  for (const s of live) {
    const bypass = !!s.immediateKind && prefs.immediateKinds.includes(s.immediateKind);
    if ((prefs.mode === "immediate" && !quiet) || bypass) immediate.push(s);
    else queue = enqueueDigest(queue, [s.item]);
  }

  let delivered = 0;
  let messages = 0;
  const send = async (text: string) => {
    messages++;
    return input.send(text);
  };

  // Flood guard: at most maxPerRun separate messages, then ONE "+M more" summary.
  const limit = prefs.maxPerRun > 0 ? prefs.maxPerRun : Number.POSITIVE_INFINITY;
  const individually = immediate.slice(0, limit);
  const overflow = immediate.slice(limit);
  for (const s of individually) {
    if (await send(renderSmartLine(s.item, now))) delivered++;
    else queue = enqueueDigest(queue, [s.item]); // not lost: it goes out with the next digest
  }
  if (overflow.length > 0) {
    if (await send(renderMoreSummary(overflow.map((o) => o.item)))) delivered += overflow.length;
    else queue = enqueueDigest(queue, overflow.map((o) => o.item));
  }

  // Flush the digest when it is due — ONE message; a failed post keeps the whole queue.
  let lastFlushAt = input.digest.lastFlushAt;
  if (queue.length > 0 && digestDue(prefs, lastFlushAt, now, offset)) {
    if (await send(renderDigest(queue, now))) {
      delivered += queue.length;
      queue = [];
      lastFlushAt = now.toISOString();
    }
  }
  return { delivered, queued: queue.length, muted: input.signals.length - live.length, messages, digest: { items: queue, ...(lastFlushAt ? { lastFlushAt } : {}) } };
}
