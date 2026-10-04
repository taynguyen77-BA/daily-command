// V2.37 I3 — Mention Reply Drafter. "Draft reply" on a mention row → the ticket's comment
// thread (allow-listed + redacted) → { reply, unansweredPoints }. Options: tone (client /
// internal), language (EN / VI), length (short / normal); each combination is its own cache
// entry, so switching an option produces a new draft.
//
// The draft is only ever COPIED, or posted via store.proposeJiraReply → the existing write-back
// confirmation dialog (editable preview, explicit confirm, server gate). A posted reply marks
// the mention replied. Nothing here writes anything.
//
// K1 — the thread must contain the mention: a cached context older than the mention, or one
// whose comments don't include it, is refetched once. If the comment still isn't there, the
// draft is made from the mention's excerpt and says so (MENTION_NOT_FOUND_NOTICE). A cached
// draft keeps the mode that produced it.

import type { IssueContext } from "../jira/issue-context";
import { compareJiraUpdated } from "../jira/updated-time";
import { gateTicketAi, type AiDataProtectionSettings, type TicketAiGate } from "./data-protection";
import type { AIProvider } from "./provider";
import type { MentionReplyResponse } from "./schemas";

export interface ReplyOptions {
  tone: "client" | "internal";
  language: "en" | "vi";
  length: "short" | "normal";
}
export const DEFAULT_REPLY_OPTIONS: ReplyOptions = { tone: "internal", language: "en", length: "normal" };

export interface MentionRef {
  issueKey: string;
  commentId: string;
  author?: string;
  excerpt: string;
  mentionedAt: string;
}

export function mentionReplyCacheKey(m: Pick<MentionRef, "commentId">, issueUpdated: string, o: ReplyOptions): string {
  return `${m.commentId}|${issueUpdated}|${o.tone}|${o.language}|${o.length}`;
}

export const MENTION_NOT_FOUND_NOTICE = "Mention comment not found in thread — draft based on excerpt only";

const minuteOf = (iso: string) => {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? "" : t.toISOString().slice(0, 16);
};

/** The full comment from the thread when we can find it (same author, same minute), else the
 *  mention's own excerpt — `found` says which. */
export function mentionBody(context: IssueContext, m: MentionRef): { author: string; created: string; body: string; found: boolean } {
  const minute = minuteOf(m.mentionedAt);
  const hit = minute ? [...context.comments].reverse().find((c) => (!m.author || c.author === m.author) && minuteOf(c.created) === minute) : undefined;
  return hit ? { author: hit.author, created: hit.created, body: hit.body, found: true } : { author: m.author ?? "Unknown", created: m.mentionedAt, body: m.excerpt, found: false };
}

/** The context predates the mention, or its thread doesn't contain the mention comment. */
export function contextMissesMention(context: IssueContext, m: MentionRef): boolean {
  return (!!context.updated && compareJiraUpdated(m.mentionedAt, context.updated) > 0) || !mentionBody(context, m).found;
}

export interface CachedReplyDraft {
  draft: MentionReplyResponse;
  mode: "mock" | "claude";
}

export interface DraftCache {
  get(key: string): CachedReplyDraft | undefined;
  set(key: string, v: CachedReplyDraft): void;
}

/** Session-scoped default cache (drafts are cheap to re-ask, and hold thread content). */
export function memoryDraftCache(max = 50): DraftCache {
  const m = new Map<string, CachedReplyDraft>();
  return {
    get: (k) => m.get(k),
    set: (k, v) => {
      m.set(k, v);
      if (m.size > max) m.delete(m.keys().next().value as string);
    },
  };
}

export type ReplyDraftFlow =
  | Exclude<TicketAiGate, { kind: "ready" }>
  | { kind: "error"; message: string }
  | { kind: "done"; draft: MentionReplyResponse; fromCache: boolean; mode: "mock" | "claude"; excerptOnly: boolean };

export type ReplyContextLoad = { ok: true; context: IssueContext; fromCache: boolean } | { ok: false; error: string };

export async function draftMentionReplyFlow(args: {
  /** Loads the ticket's content; `force` bypasses the cached copy (ticket-ai-client.ts). */
  loadContext: (force: boolean) => Promise<ReplyContextLoad>;
  mention: MentionRef;
  options: ReplyOptions;
  settings: AiDataProtectionSettings;
  provider: Pick<AIProvider, "draftMentionReply" | "mode">;
  cache: DraftCache;
  previewConfirmed?: boolean;
}): Promise<ReplyDraftFlow> {
  let loaded = await args.loadContext(false);
  // A cached thread that can't contain the mention is refetched — once. A fresh fetch is
  // already the newest Jira has, so it is never repeated.
  if (loaded.ok && loaded.fromCache && contextMissesMention(loaded.context, args.mention)) loaded = await args.loadContext(true);
  if (!loaded.ok) return { kind: "error", message: loaded.error };
  const context = loaded.context;
  const gate = gateTicketAi(context, args.settings, { previewConfirmed: args.previewConfirmed });
  if (gate.kind !== "ready") return gate;
  const body = mentionBody(context, args.mention);
  const key = mentionReplyCacheKey(args.mention, context.updated, args.options);
  const hit = args.cache.get(key);
  if (hit) return { kind: "done", draft: hit.draft, fromCache: true, mode: hit.mode, excerptOnly: !body.found };
  const raw = await args.provider.draftMentionReply({
    ticket: gate.input,
    mention: { author: gate.session.redact(body.author).slice(0, 200), created: body.created.slice(0, 40), body: gate.session.redact(body.body).slice(0, 4000) },
    ...args.options,
  });
  const draft = gate.session.restoreDeep(raw);
  // Only real AI drafts are cached — a template fallback is retried next time.
  if (args.provider.mode === "claude") args.cache.set(key, { draft, mode: args.provider.mode });
  return { kind: "done", draft, fromCache: false, mode: args.provider.mode, excerptOnly: !body.found };
}
