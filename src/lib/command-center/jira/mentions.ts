// V2.10 §2 — "who mentioned me in a comment?" Pure functions over already-fetched comment
// data (see ./http.ts fetchMentionedIssuesWith/fetchIssueCommentsWith) — no network calls
// here, matching normalize.ts's own "pure Jira -> domain-model" discipline.

import type { JiraComment } from "./types";
import type { MentionEvent } from "../types";

const EXCERPT_MAX_LENGTH = 200;

/** Jira's v3 API returns a comment body as Atlassian Document Format (a nested node tree);
 *  some instances/API paths return a plain string instead. Never assumed to be one or the
 *  other — both are walked without throwing on an unexpected shape (§29). */
function walkAdf(node: unknown, onText: (text: string) => void, onMentionId: (id: string) => void): void {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (obj.type === "text" && typeof obj.text === "string") onText(obj.text);
  if (obj.type === "mention") {
    const attrs = obj.attrs as Record<string, unknown> | undefined;
    if (typeof attrs?.id === "string") onMentionId(attrs.id);
  }
  const content = obj.content;
  if (Array.isArray(content)) {
    for (const child of content) walkAdf(child, onText, onMentionId);
  }
}

/** Plain-text excerpt for display — evidence, never a full reproduction (capped). */
export function extractCommentExcerpt(body: unknown, maxLength = EXCERPT_MAX_LENGTH): string {
  let text: string;
  if (typeof body === "string") {
    text = body;
  } else {
    const parts: string[] = [];
    walkAdf(body, (t) => parts.push(t), () => {});
    text = parts.join(" ").replace(/\s+/g, " ").trim();
  }
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * V2.10 §2 — the real client-side check: a comment only "mentions" the configured account
 * when its body contains a structured ADF `mention` node whose id matches (Jira's actual
 * representation of an @mention), or — for the plain-string body shape some instances/API
 * versions return — the classic `[~accountid:ID]` wiki-markup mention syntax. Never trusts
 * the JQL match (`comment ~ "accountid:X"`) alone as the final filter: Jira's text search can
 * match more loosely than an exact mention (e.g. the id appearing as part of unrelated text).
 */
export function commentMentionsAccount(body: unknown, accountId: string): boolean {
  if (typeof body === "string") return body.includes(`accountid:${accountId}`);
  const mentionedIds = new Set<string>();
  walkAdf(body, () => {}, (id) => mentionedIds.add(id));
  return mentionedIds.has(accountId);
}

/** One issue's raw comment list -> the MentionEvents that actually mention `accountId`.
 *  `today` is only ever used as a safe fallback when Jira omits a comment's `created`
 *  timestamp — never fabricated otherwise, same convention as jira/normalize.ts. */
export function buildMentionEvents(
  issueKey: string,
  comments: JiraComment[],
  accountId: string,
  options: { baseUrl?: string; today: string }
): MentionEvent[] {
  const events: MentionEvent[] = [];
  for (const comment of comments) {
    if (!commentMentionsAccount(comment.body, accountId)) continue;
    events.push({
      issueKey,
      commentAuthor: comment.author?.displayName,
      excerpt: extractCommentExcerpt(comment.body),
      commentUrl: options.baseUrl ? `${options.baseUrl.replace(/\/$/, "")}/browse/${issueKey}?focusedCommentId=${comment.id ?? ""}` : undefined,
      mentionedAt: comment.created ?? options.today,
    });
  }
  return events;
}
