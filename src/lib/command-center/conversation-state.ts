// P3.2 — "whose turn is it?" for a ticket, from its few newest comments. Pure and deterministic
// (no AI, no clock reads: `today` is passed in). It only ever looks at the comments it is given
// (the sync fetches the 5 newest per ticket), so "my last comment" means "my last comment among
// those" — if I have not commented in the newest 5, that is treated as "I have not replied".

import { businessDaysBetween } from "./date-utils";
import { commentMentionsAccount } from "./jira/mentions";
import { daysBetween } from "./score-core";
import type { JiraComment } from "./jira/types";
import type { NeedsFromOthersRow } from "./communicate";

export type Awaiting = "ME" | "THEM" | "NONE";

export interface ConversationState {
  lastCommentAt?: string;
  lastByAccountId?: string;
  lastByName?: string;
  lastIsMe: boolean;
  /** Newest comment by someone other than me. */
  lastExternalAt?: string;
  myLastAt?: string;
  awaiting: Awaiting;
  /** When the wait began: the oldest unanswered comment that is waiting on me, or my comment that is waiting on them. */
  sinceAt?: string;
  /** The issue's `updated` when this was computed — with the key, the cache key (an unchanged ticket is not re-fetched). */
  issueUpdatedAt?: string;
}

export interface ConversationInput {
  comments: readonly Pick<JiraComment, "created" | "body" | "author">[];
  accountId?: string;
  assigneeAccountId?: string;
  /** Not Done / not closed. */
  open: boolean;
  today: string;
  issueUpdatedAt?: string;
}

const iso = (c: Pick<JiraComment, "created">) => c.created ?? "";

export function computeConversationState(input: ConversationInput): ConversationState {
  const { comments, accountId, assigneeAccountId, open, today, issueUpdatedAt } = input;
  const sorted = [...comments].filter((c) => !!c.created).sort((a, b) => iso(b).localeCompare(iso(a))); // newest first
  const newest = sorted[0];
  const isMine = (c: Pick<JiraComment, "author">) => !!accountId && c.author?.accountId === accountId;
  const myLast = sorted.find(isMine);
  const external = sorted.filter((c) => !isMine(c));
  const base: ConversationState = {
    ...(newest ? { lastCommentAt: newest.created, ...(newest.author?.accountId ? { lastByAccountId: newest.author.accountId } : {}), ...(newest.author?.displayName ? { lastByName: newest.author.displayName } : {}) } : {}),
    lastIsMe: !!newest && isMine(newest),
    ...(external[0]?.created ? { lastExternalAt: external[0].created } : {}),
    ...(myLast?.created ? { myLastAt: myLast.created } : {}),
    awaiting: "NONE",
    ...(issueUpdatedAt ? { issueUpdatedAt } : {}),
  };
  if (!open || !accountId || !newest) return base;

  // AWAITING_ME: someone else spoke after my last comment, and it concerns me — it mentions me, or I am the assignee.
  const unanswered = external.filter((c) => !myLast || iso(c) > iso(myLast));
  const concerning = unanswered.filter((c) => commentMentionsAccount(c.body, accountId) || assigneeAccountId === accountId);
  if (concerning.length > 0) return { ...base, awaiting: "ME", sinceAt: iso(concerning[concerning.length - 1]) };

  // AWAITING_THEM: my comment is the newest, and it has waited at least one business day.
  if (base.lastIsMe && myLast?.created && businessDaysBetween(myLast.created.slice(0, 10), today) >= 1) return { ...base, awaiting: "THEM", sinceAt: myLast.created };
  return base;
}

/** Whole calendar days the wait has lasted (0 = today); undefined when there is no wait. */
export function waitingDays(c: ConversationState, today: string): number | undefined {
  return c.awaiting !== "NONE" && c.sinceAt ? Math.max(0, daysBetween(c.sinceAt.slice(0, 10), today)) : undefined;
}

/** Awaiting THEM for more business days than the SLA (the same strictly-greater rule as an overdue blocker). */
export function needsNudge(c: ConversationState | undefined, today: string, slaBusinessDays: number): boolean {
  return !!c && c.awaiting === "THEM" && !!c.sinceAt && businessDaysBetween(c.sinceAt.slice(0, 10), today) > slaBusinessDays;
}

export interface ConversationChip {
  text: string;
  awaiting: Exclude<Awaiting, "NONE">;
  nudge: boolean;
}

/** The ONE rendering of a conversation, used by the row chip and by the "Needs a nudge" list. */
export function conversationChip(c: ConversationState | undefined, today: string, slaBusinessDays: number): ConversationChip | null {
  if (!c || c.awaiting === "NONE") return null;
  const d = waitingDays(c, today);
  const age = d === undefined ? "" : d === 0 ? " · today" : ` · ${d}d`;
  return { text: `${c.awaiting === "ME" ? "Awaiting you" : "Awaiting them"}${age}`, awaiting: c.awaiting, nudge: needsNudge(c, today, slaBusinessDays) };
}

export interface NudgeRow {
  ticketKey: string;
  title?: string;
  chip: ConversationChip;
  businessDays: number;
  /** The draft, via the same renderer the blocker follow-ups use. */
  draftRow: NeedsFromOthersRow;
}

/** "Needs a nudge": open tickets awaiting THEM past the SLA, longest wait first (ties by key). Same predicate as the chip. */
export function nudgeList(
  conversation: Readonly<Record<string, ConversationState>> | undefined,
  tickets: readonly { key: string; title?: string; dueDate?: string }[],
  today: string,
  slaBusinessDays: number
): NudgeRow[] {
  const rows: NudgeRow[] = [];
  for (const t of tickets) {
    const c = conversation?.[t.key];
    const chip = conversationChip(c, today, slaBusinessDays);
    if (!c || !chip || !chip.nudge) continue;
    const days = businessDaysBetween(c.sinceAt!.slice(0, 10), today);
    rows.push({
      ticketKey: t.key,
      ...(t.title ? { title: t.title } : {}),
      chip,
      businessDays: days,
      draftRow: {
        person: "UNKNOWN",
        what: `a reply on ${t.key}${t.title ? ` — ${t.title}` : ""}`,
        why: `I commented ${days} business day(s) ago and have not had a response`,
        by: t.dueDate || "UNKNOWN",
        evidence: [],
        isUnknownPerson: true,
        isUnknownBy: !t.dueDate,
      },
    });
  }
  return rows.sort((a, b) => b.businessDays - a.businessDays || a.ticketKey.localeCompare(b.ticketKey));
}
