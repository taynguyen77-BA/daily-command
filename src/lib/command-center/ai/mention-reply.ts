// V2.37 I3 — Mention Reply Drafter. "Draft reply" on a mention row → the ticket's comment
// thread (allow-listed + redacted) → { reply, unansweredPoints }. Options: tone (client /
// internal), language (EN / VI), length (short / normal); each combination is its own cache
// entry, so switching an option produces a new draft.
//
// The draft is only ever COPIED, or posted via store.proposeJiraReply → the existing write-back
// confirmation dialog (editable preview, explicit confirm, server gate). A posted reply marks
// the mention replied. Nothing here writes anything.

import type { IssueContext } from "../jira/issue-context";
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

/** The full comment from the thread when we can find it (same author, same minute), else the
 *  mention's own excerpt. */
export function mentionBody(context: IssueContext, m: MentionRef): { author: string; created: string; body: string } {
  const minute = (iso: string) => iso.slice(0, 16);
  const hit = [...context.comments].reverse().find((c) => (!m.author || c.author === m.author) && minute(new Date(c.created).toISOString()) === minute(new Date(m.mentionedAt).toISOString()));
  return hit ? { author: hit.author, created: hit.created, body: hit.body } : { author: m.author ?? "Unknown", created: m.mentionedAt, body: m.excerpt };
}

export interface DraftCache {
  get(key: string): MentionReplyResponse | undefined;
  set(key: string, v: MentionReplyResponse): void;
}

/** Session-scoped default cache (drafts are cheap to re-ask, and hold thread content). */
export function memoryDraftCache(max = 50): DraftCache {
  const m = new Map<string, MentionReplyResponse>();
  return {
    get: (k) => m.get(k),
    set: (k, v) => {
      m.set(k, v);
      if (m.size > max) m.delete(m.keys().next().value as string);
    },
  };
}

export type ReplyDraftFlow = Exclude<TicketAiGate, { kind: "ready" }> | { kind: "done"; draft: MentionReplyResponse; fromCache: boolean; mode: "mock" | "claude" };

export async function draftMentionReplyFlow(args: {
  context: IssueContext;
  mention: MentionRef;
  options: ReplyOptions;
  settings: AiDataProtectionSettings;
  provider: Pick<AIProvider, "draftMentionReply" | "mode">;
  cache: DraftCache;
  previewConfirmed?: boolean;
}): Promise<ReplyDraftFlow> {
  const gate = gateTicketAi(args.context, args.settings, { previewConfirmed: args.previewConfirmed });
  if (gate.kind !== "ready") return gate;
  const key = mentionReplyCacheKey(args.mention, args.context.updated, args.options);
  const hit = args.cache.get(key);
  if (hit) return { kind: "done", draft: hit, fromCache: true, mode: "claude" };
  const body = mentionBody(args.context, args.mention);
  const raw = await args.provider.draftMentionReply({
    ticket: gate.input,
    mention: { author: gate.session.redact(body.author).slice(0, 200), created: body.created.slice(0, 40), body: gate.session.redact(body.body).slice(0, 4000) },
    ...args.options,
  });
  const draft = gate.session.restoreDeep(raw);
  // Only real AI drafts are cached — a template fallback is retried next time.
  if (args.provider.mode === "claude") args.cache.set(key, draft);
  return { kind: "done", draft, fromCache: false, mode: args.provider.mode };
}
