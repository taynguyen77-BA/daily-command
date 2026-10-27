// P3.1 — "is this ticket waiting on ME?" from state the app already keeps: a mention of me
// (state.mentionEvents) with no recorded reply (state.mentionReplies — manual, or detected from my
// own Jira comment by mention-replies.ts). P3.2 extends this signal with conversation state; the
// score factor only depends on this shape.

import { businessDaysBetween } from "./date-utils";
import type { ConversationState } from "./conversation-state";
import type { MentionEvent, MentionReply } from "./types";

export interface AwaitingMeSignal {
  /** The oldest still-unanswered mention (ISO date or datetime). */
  sinceIso: string;
  count: number;
}

/** Reply SLA in business days — the same default the blocker follow-up uses. */
export const REPLY_SLA_BUSINESS_DAYS = 2;

export function buildAwaitingMe(
  mentions: readonly Pick<MentionEvent, "issueKey" | "commentId" | "mentionedAt">[] | undefined,
  replies: Readonly<Record<string, MentionReply>> | undefined,
  /** P3.2 — a ticket whose conversation says "awaiting me" counts too (the oldest wait wins; the mention count is kept). */
  conversation?: Readonly<Record<string, ConversationState>>
): Record<string, AwaitingMeSignal> {
  const out: Record<string, AwaitingMeSignal> = {};
  for (const m of mentions ?? []) {
    if (replies?.[m.commentId]) continue;
    const cur = out[m.issueKey];
    if (!cur) out[m.issueKey] = { sinceIso: m.mentionedAt, count: 1 };
    else {
      cur.count++;
      if (m.mentionedAt < cur.sinceIso) cur.sinceIso = m.mentionedAt;
    }
  }
  for (const [key, c] of Object.entries(conversation ?? {})) {
    if (c.awaiting !== "ME" || !c.sinceAt) continue;
    const cur = out[key];
    if (!cur) out[key] = { sinceIso: c.sinceAt, count: 1 };
    else if (c.sinceAt < cur.sinceIso) cur.sinceIso = c.sinceAt;
  }
  return out;
}

/** Business days the signal has been waiting at `today` (whole days, 0 when same day or in the future). */
export function awaitingMeAgeBusinessDays(signal: AwaitingMeSignal, today: string): number {
  return businessDaysBetween(signal.sinceIso.slice(0, 10), today);
}

/** 0-15: an unanswered mention is worth 7 at once, rising to 11 at the SLA, then +2 per business day to 15. */
export function awaitingMePoints(ageBusinessDays: number, slaBusinessDays: number = REPLY_SLA_BUSINESS_DAYS): number {
  if (ageBusinessDays <= slaBusinessDays) return 7 + Math.round((4 * ageBusinessDays) / slaBusinessDays);
  return Math.min(15, 11 + 2 * (ageBusinessDays - slaBusinessDays));
}
