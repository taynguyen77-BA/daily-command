// V2.10 §2 — "who mentioned me in a comment?" Pure functions over already-fetched comment
// data (see ./http.ts fetchMentionedIssuesWith/fetchIssueCommentsWith) — no network calls
// here, matching normalize.ts's own "pure Jira -> domain-model" discipline.

import type { JiraComment, JiraIssue } from "./types";
import type { MentionEvent } from "../types";

const EXCERPT_MAX_LENGTH = 200;
const DEFAULT_RECENT_LOOKBACK_HOURS = 48;
const DEFAULT_RECENT_CANDIDATE_CAP = 20;

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

/** V2.13 §2 / V2.17 §1a — one mentioning comment's stable identity, used both to key
 *  MentionEvent.commentId (so store.ts/attention-queue.ts can track a mention per-comment) and
 *  by cron-notify.ts's own dedup. Jira always returns a real `id` for a genuine comment; the
 *  fallback (never expected to actually trigger against a real Jira instance) keeps this
 *  deterministic rather than crashing on an unexpected shape, same "never assume the ideal
 *  shape" discipline as this file's own ADF walker. */
export function mentionCommentId(issueKey: string, comment: { id?: string; created?: string }): string {
  return comment.id ?? `${issueKey}:no-id:${comment.created ?? ""}`;
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
      commentId: mentionCommentId(issueKey, comment),
      commentAuthor: comment.author?.displayName,
      excerpt: extractCommentExcerpt(comment.body),
      commentUrl: options.baseUrl ? `${options.baseUrl.replace(/\/$/, "")}/browse/${issueKey}?focusedCommentId=${comment.id ?? ""}` : undefined,
      mentionedAt: comment.created ?? options.today,
    });
  }
  return events;
}

/**
 * V2.17 — recency fallback for mention discovery. Jira's `comment ~ "accountid:X"` JQL search
 * (fetchMentionedIssuesWith) depends entirely on Jira's own full-text search index, which has
 * a real indexing lag for brand-new comments — confirmed directly against a real instance: a
 * mention posted ~1 day earlier was NOT yet findable via that JQL, while a ~2-month-old
 * mention on the same site was. So a mention from "last night" (the exact case mention
 * detection exists for) can be genuinely undiscoverable through the JQL alone for a while,
 * even though the comment itself already exists and commentMentionsAccount above would
 * correctly recognize it. This selects a small, bounded set of candidate issues to check
 * comments on directly instead — sidestepping the lagging index rather than depending on it —
 * from an already-fetched issue batch (never a second Jira fetch of its own): issues updated
 * within `lookbackHours`, excluding any already covered by the JQL search result
 * (`excludeKeys`), capped at `cap` so this can never become "check comments on every issue"
 * (see fetchMentionedIssuesWith's own comment on why bulk comment fetching is the one mistake
 * this app avoids). Callers are expected to pass an issue batch already ordered
 * most-recently-updated-first (buildIssuesJql's `order by updated desc`), so the cap keeps
 * the most relevant candidates — but this function sorts defensively rather than trusting
 * that ordering, since a wrongly-ordered cap would silently favor the wrong issues.
 */
export function selectRecentMentionCandidates(
  issues: JiraIssue[],
  excludeKeys: ReadonlySet<string>,
  nowMs: number,
  lookbackHours: number = DEFAULT_RECENT_LOOKBACK_HOURS,
  cap: number = DEFAULT_RECENT_CANDIDATE_CAP
): JiraIssue[] {
  const cutoffMs = nowMs - lookbackHours * 60 * 60 * 1000;
  return issues
    .filter((issue) => {
      if (excludeKeys.has(issue.key)) return false;
      const updated = issue.fields.updated;
      if (!updated) return false;
      const updatedMs = new Date(updated).getTime();
      return Number.isFinite(updatedMs) && updatedMs >= cutoffMs;
    })
    .sort((a, b) => (b.fields.updated ?? "").localeCompare(a.fields.updated ?? ""))
    .slice(0, cap);
}
