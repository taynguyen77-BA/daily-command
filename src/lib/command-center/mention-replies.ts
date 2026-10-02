// D4 — a mention leaves "awaiting my reply" once it is answered: marked "Replied" by hand, or
// (auto-detect) the user's own comment on the same issue is later than the mention.

import type { MentionEvent, MentionReply, MyTicketActivity } from "./types";

export function isMentionReplied(
  mention: Pick<MentionEvent, "commentId" | "issueKey" | "mentionedAt">,
  replies: Record<string, MentionReply>,
  myActivity: Record<string, MyTicketActivity>
): MentionReply | undefined {
  const manual = replies[mention.commentId];
  if (manual) return manual;
  const mine = myActivity[mention.issueKey]?.lastCommentAt;
  if (mine && mine > mention.mentionedAt) return { commentId: mention.commentId, issueKey: mention.issueKey, repliedAt: mine, source: "jira" };
  return undefined;
}

/** Keep the later of two activity records, field by field. */
export function mergeMyTicketActivity(a: Record<string, MyTicketActivity>, b: Record<string, MyTicketActivity> | undefined): Record<string, MyTicketActivity> {
  if (!b) return a;
  const out: Record<string, MyTicketActivity> = { ...a };
  const later = (x?: string, y?: string) => (!x ? y : !y ? x : x >= y ? x : y);
  for (const [key, v] of Object.entries(b)) {
    const cur = out[key] ?? {};
    const lastCommentAt = later(cur.lastCommentAt, v.lastCommentAt);
    const lastActivityAt = later(cur.lastActivityAt, v.lastActivityAt);
    out[key] = { ...(lastCommentAt ? { lastCommentAt } : {}), ...(lastActivityAt ? { lastActivityAt } : {}) };
  }
  return out;
}

/** Grow-only merge (an answered mention is never "un-answered" by another device). */
export function mergeMentionReplies(a: Record<string, MentionReply>, b: Record<string, MentionReply> | undefined): Record<string, MentionReply> {
  if (!b) return a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) if (!out[k] || v.repliedAt > out[k].repliedAt) out[k] = v;
  return out;
}

/** F3 — on sync: every mention I have since answered on Jira (my own comment on that issue is
 *  newer than the mention) becomes a recorded reply, source "jira" — so it leaves "awaiting my
 *  reply" on every device and stays answered even after the activity record rolls over. Only
 *  NEW records are returned; a mention already marked (by hand or earlier) is never touched,
 *  so a manual "Replied" is never overwritten. */
export function detectRepliedMentions(
  mentions: Pick<MentionEvent, "commentId" | "issueKey" | "mentionedAt">[],
  myActivity: Record<string, MyTicketActivity>,
  existing: Record<string, MentionReply>
): Record<string, MentionReply> {
  const found: Record<string, MentionReply> = {};
  for (const m of mentions) {
    if (existing[m.commentId]) continue;
    const mine = myActivity[m.issueKey]?.lastCommentAt;
    if (mine && mine > m.mentionedAt) found[m.commentId] = { commentId: m.commentId, issueKey: m.issueKey, repliedAt: mine, source: "jira" };
  }
  return found;
}
