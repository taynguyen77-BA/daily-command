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
