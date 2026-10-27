// P3.5 — the smart branch of the server-side notify check: build the run's signals (new assignments, new mentions,
// escalations of mentions still unanswered after the reply SLA), route them through the user's preferences and
// say what the baseline must remember. The legacy path (default preferences) never comes here.

import { businessDaysBetween } from "./date-utils";
import { REPLY_SLA_BUSINESS_DAYS } from "./awaiting-me";
import { digestItemId, type DigestItem, type DigestState } from "./notify-digest";
import { immediateKindFor, isUrgent, type TicketUrgencyFacts } from "./notify-severity";
import { deliverSmart, type SmartDelivery, type SmartSignal } from "./notify-smart";
import type { NotifyPrefs } from "./notify-prefs";
import type { MentionEvent } from "./types";

export const MAX_PENDING_MENTIONS = 100;
export const MAX_ESCALATED_IDS = 500;
const MAX_ESCALATION_CHECKS_PER_RUN = 10;

export interface PendingMention {
  commentId: string;
  issueKey: string;
  mentionedAt: string;
  author?: string;
  excerpt: string;
  url?: string;
}

const cap = <T>(a: readonly T[], n: number): T[] => (a.length > n ? a.slice(a.length - n) : [...a]);
const projectOf = (key: string) => key.split("-")[0];

export interface SmartRunInput {
  prefs: NotifyPrefs;
  digest: DigestState;
  now: Date;
  offsetMinutes: number;
  today: string;
  assignments: readonly { issueKey: string; title: string }[];
  mentions: readonly { commentId: string; event: MentionEvent }[];
  facts: ReadonlyMap<string, TicketUrgencyFacts & { url?: string }>;
  previousPending: readonly PendingMention[];
  previousEscalated: readonly string[];
  /** My newest own comment per issue among the comments this run already fetched. */
  ownLastAt: Readonly<Record<string, string>>;
  /** Fetch my newest own comment for issues this run has not looked at (escalation candidates). */
  fetchOwnLast: (issueKeys: string[]) => Promise<Record<string, string>>;
  send: (text: string) => Promise<boolean>;
}

export interface SmartRunResult {
  delivery: SmartDelivery;
  pendingMentions: PendingMention[];
  escalatedCommentIds: string[];
}

export async function runSmartDelivery(input: SmartRunInput): Promise<SmartRunResult> {
  const { prefs, today, now } = input;
  const atIso = now.toISOString();
  const signals: SmartSignal[] = [];

  for (const a of input.assignments) {
    const f = input.facts.get(a.issueKey);
    const item: DigestItem = { id: digestItemId("ASSIGNMENT", a.issueKey), kind: "ASSIGNMENT", issueKey: a.issueKey, summary: a.title, detail: `${a.issueKey} was assigned to you.`, ...(f?.url ? { url: f.url } : {}), urgent: isUrgent(f, today), at: atIso };
    signals.push({ item, immediateKind: immediateKindFor("ASSIGNMENT", f, today), projectKey: projectOf(a.issueKey) });
  }
  for (const { commentId, event } of input.mentions) {
    const f = input.facts.get(event.issueKey);
    const kind = immediateKindFor("MENTION", f, today);
    const item: DigestItem = { id: digestItemId("MENTION", event.issueKey, commentId), kind: "MENTION", issueKey: event.issueKey, summary: event.commentAuthor ? `Mentioned by ${event.commentAuthor}` : "Mentioned in a comment", detail: event.excerpt, ...(event.commentUrl ? { url: event.commentUrl } : {}), urgent: isUrgent(f, today), at: event.mentionedAt };
    signals.push({ item, immediateKind: kind, projectKey: projectOf(event.issueKey) });
  }

  // Escalation: a mention announced earlier, still unanswered after the reply SLA, is re-announced ONCE.
  let pending: PendingMention[] = [...input.previousPending];
  let escalated = [...input.previousEscalated];
  if (prefs.escalateUnanswered) {
    pending = cap([...pending, ...input.mentions.filter((m) => !pending.some((p) => p.commentId === m.commentId)).map((m): PendingMention => ({ commentId: m.commentId, issueKey: m.event.issueKey, mentionedAt: m.event.mentionedAt, ...(m.event.commentAuthor ? { author: m.event.commentAuthor } : {}), excerpt: m.event.excerpt, ...(m.event.commentUrl ? { url: m.event.commentUrl } : {}) }))], MAX_PENDING_MENTIONS);
    const answered = (p: PendingMention, own: Readonly<Record<string, string>>) => !!own[p.issueKey] && own[p.issueKey] > p.mentionedAt;
    pending = pending.filter((p) => !answered(p, input.ownLastAt));
    const escalatedSet = new Set(escalated);
    const due = pending.filter((p) => !escalatedSet.has(p.commentId) && businessDaysBetween(p.mentionedAt.slice(0, 10), today) > REPLY_SLA_BUSINESS_DAYS).slice(0, MAX_ESCALATION_CHECKS_PER_RUN);
    const unseen = Array.from(new Set(due.filter((p) => !(p.issueKey in input.ownLastAt)).map((p) => p.issueKey)));
    const fetched = unseen.length > 0 ? await input.fetchOwnLast(unseen) : {};
    const own = { ...input.ownLastAt, ...fetched };
    pending = pending.filter((p) => !answered(p, own));
    for (const p of due) {
      if (answered(p, own)) continue;
      const item: DigestItem = { id: digestItemId("ESCALATION", p.issueKey, p.commentId), kind: "ESCALATION", issueKey: p.issueKey, summary: p.author ? `Still waiting on your reply to ${p.author}` : "Still waiting on your reply", detail: `You were mentioned ${p.mentionedAt.slice(0, 10)} and have not replied: ${p.excerpt}`, ...(p.url ? { url: p.url } : {}), urgent: true, at: p.mentionedAt };
      signals.push({ item, immediateKind: "ESCALATION", projectKey: projectOf(p.issueKey) });
      escalated.push(p.commentId);
    }
    // an escalated mention is done with: it will not be escalated (or tracked) again
    const nowEscalated = new Set(escalated);
    pending = pending.filter((p) => !nowEscalated.has(p.commentId));
    escalated = cap(Array.from(new Set(escalated)), MAX_ESCALATED_IDS);
  }

  const delivery = await deliverSmart({ signals, prefs, digest: input.digest, now, offsetMinutes: input.offsetMinutes, send: input.send });
  return { delivery, pendingMentions: pending, escalatedCommentIds: escalated };
}
