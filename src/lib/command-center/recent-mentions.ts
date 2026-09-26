// V2.19 — Recently Mentioned. Answers "what recently involved me?" over a real, deterministic
// last-24-hours rolling window (NOW - 24h -> NOW, never a calendar day) — a distinct concern
// from the Attention Queue's MENTION category, which is lifecycle-based with no time decay at
// all (see attention-queue.ts's own top comment: NEW/ACTIVE/ACKNOWLEDGED persist until
// resolved, regardless of age). Both read the exact same underlying MentionEvent records
// (jira/mentions.ts) — this is a second VIEW over that data, not a second mention-detection
// engine. Dedup reuses mention-grouping.ts's existing per-ticket folding rather than a second
// implementation.

import type { AttentionItemState, DailyCommandBlock, DailyCommandCompletion, DailyCommandSkip, MentionEvent, TaskReactivation, WorkItem } from "./types";
import { slug } from "./attention-queue";
import { groupMentionItems } from "./mention-grouping";

export const RECENT_MENTION_WINDOW_HOURS = 24;

export interface RecentMention {
  issueKey: string;
  commentId: string;
  commentAuthor?: string;
  excerpt: string;
  commentUrl?: string;
  mentionedAt: string;
  workItem?: WorkItem;
  /** >1 means this card was folded from several still-recent comments on the same ticket
   *  (mention-grouping.ts) — the represented commentId/excerpt/mentionedAt are the MOST
   *  RECENT of the group, never an arbitrary one. */
  groupCount: number;
  /** V2.26 — set when this ticket carries a Daily Command Completed/Skipped/Blocked record and
   *  the (most recent) mention came strictly AFTER it: the ticket is back because of a new
   *  comment, not new work. UI renders "↺ Reactivated" instead of a plain new-mention card. */
  reactivation?: TaskReactivation;
}

function mentionAttentionId(issueKey: string, commentId: string): string {
  return `MENTION:${slug(issueKey)}:${slug(commentId)}`;
}

/** A Daily-Command-completed ticket's mention is suppressed here too — UNLESS this specific
 *  mention happened strictly after the completion (the §14 Reactivation Rule: a genuinely new
 *  mention reactivates the ticket into Recently Mentioned, and ONLY here — it never
 *  auto-creates an Action and never un-suppresses Your Delivery Focus/My Assigned Work on its
 *  own, both of which require an explicit reopen). */
function suppressedByDailyCommandCompletion(issueKey: string, mentionedAt: string, completions: Record<string, DailyCommandCompletion>): boolean {
  const completion = completions[issueKey];
  if (!completion) return false;
  return mentionedAt <= completion.completedAt;
}

/** V2.23 §8 — same reactivation-by-mention semantics as suppressedByDailyCommandCompletion
 *  above, for a Daily-Command-SKIPPED ticket: a mention from before the skip stays suppressed
 *  (nothing new happened), but a genuinely NEW mention strictly after skippedAt is a real
 *  personal signal — the ticket is relevant again — and surfaces here, the ONE deliberate
 *  reactivation exception (§9's explicit Reactivate button is the OTHER, broader way back;
 *  this one only ever un-suppresses Recently Mentioned, exactly like completion's own). */
function suppressedByDailyCommandSkip(issueKey: string, mentionedAt: string, skips: Record<string, DailyCommandSkip>): boolean {
  const skip = skips[issueKey];
  if (!skip) return false;
  return mentionedAt <= skip.skippedAt;
}

/** V2.26 — same reactivation-by-mention semantics for a Daily-Command-BLOCKED ticket: a
 *  mention from before the block stays suppressed; a genuinely new one after blockedAt (very
 *  often the very reply the block was waiting on) surfaces here, labeled as a reactivation. */
function suppressedByDailyCommandBlock(issueKey: string, mentionedAt: string, blocks: Record<string, DailyCommandBlock>): boolean {
  const block = blocks[issueKey];
  if (!block) return false;
  return mentionedAt <= block.blockedAt;
}

export interface DailyCommandRecordMaps {
  dailyCommandCompletions?: Record<string, DailyCommandCompletion>;
  dailyCommandSkips?: Record<string, DailyCommandSkip>;
  dailyCommandBlocks?: Record<string, DailyCommandBlock>;
}

/** V2.26 — the reactivation label for one mention, or undefined when the ticket has no Daily
 *  Command record or the mention isn't strictly newer than it (then it's either suppressed
 *  or genuinely ordinary). The three maps are mutually exclusive, so at most one applies. */
export function mentionReactivation(issueKey: string, mentionedAt: string, maps: DailyCommandRecordMaps): TaskReactivation | undefined {
  const completion = maps.dailyCommandCompletions?.[issueKey];
  if (completion) return mentionedAt > completion.completedAt ? { reason: "new-mention-after-completion", reactivatedAt: mentionedAt } : undefined;
  const skip = maps.dailyCommandSkips?.[issueKey];
  if (skip) return mentionedAt > skip.skippedAt ? { reason: "new-mention-after-skip", reactivatedAt: mentionedAt } : undefined;
  const block = maps.dailyCommandBlocks?.[issueKey];
  if (block) return mentionedAt > block.blockedAt ? { reason: "new-mention-after-block", reactivatedAt: mentionedAt } : undefined;
  return undefined;
}

/** V2.26 — per-ticket reactivation (latest qualifying mention wins) over ALL mention events,
 *  not just the 24h window — for history surfaces (My Assigned Work's buckets, Daily Review)
 *  that show a Completed/Skipped/Blocked ticket and need to say "a new comment arrived since".
 *  A mention the user already Resolved/Snoozed in the Attention Queue doesn't count. */
export function computeMentionReactivations(mentionEvents: MentionEvent[], maps: DailyCommandRecordMaps, attentionState: Record<string, AttentionItemState> = {}): Map<string, TaskReactivation> {
  const out = new Map<string, TaskReactivation>();
  for (const m of mentionEvents) {
    const lifecycle = attentionState[mentionAttentionId(m.issueKey, m.commentId)]?.lifecycle;
    if (lifecycle === "RESOLVED" || lifecycle === "SNOOZED") continue;
    const r = mentionReactivation(m.issueKey, m.mentionedAt, maps);
    if (!r) continue;
    const existing = out.get(m.issueKey);
    if (!existing || (existing.reactivatedAt ?? "") < (r.reactivatedAt ?? "")) out.set(m.issueKey, r);
  }
  return out;
}

/**
 * Pure function — no hidden `Date.now()` (matches jira/mentions.ts's own
 * selectRecentMentionCandidates convention of taking `nowMs` explicitly, for determinism).
 * `mentionEvents` should already be project-scope-filtered by the caller (scopeMentionEvents),
 * same "enforce scope at the data boundary" discipline every other engine in this app follows
 * — this function has no scope concept of its own.
 */
export function selectRecentMentions(
  mentionEvents: MentionEvent[],
  workItems: WorkItem[],
  attentionState: Record<string, AttentionItemState>,
  nowMs: number,
  options: { windowHours?: number } & DailyCommandRecordMaps = {}
): RecentMention[] {
  const windowHours = options.windowHours ?? RECENT_MENTION_WINDOW_HOURS;
  const completions = options.dailyCommandCompletions ?? {};
  const skips = options.dailyCommandSkips ?? {};
  const blocks = options.dailyCommandBlocks ?? {};
  const cutoffMs = nowMs - windowHours * 60 * 60 * 1000;
  const workItemByKey = new Map(workItems.map((w) => [w.key, w]));

  const withinWindow = mentionEvents.filter((m) => {
    const t = new Date(m.mentionedAt).getTime();
    if (!Number.isFinite(t) || t < cutoffMs || t > nowMs) return false;
    const state = attentionState[mentionAttentionId(m.issueKey, m.commentId)];
    // A mention the user has already acted on (Resolve/Snooze) is no longer "needs my
    // attention right now" — same RESOLVED/SNOOZED suppression the Attention Queue panel
    // itself already applies to the same underlying attention item.
    if (state?.lifecycle === "RESOLVED" || state?.lifecycle === "SNOOZED") return false;
    if (suppressedByDailyCommandCompletion(m.issueKey, m.mentionedAt, completions)) return false;
    if (suppressedByDailyCommandSkip(m.issueKey, m.mentionedAt, skips)) return false;
    if (suppressedByDailyCommandBlock(m.issueKey, m.mentionedAt, blocks)) return false;
    return true;
  });

  const asRecentMentions: RecentMention[] = withinWindow.map((m) => ({
    issueKey: m.issueKey,
    commentId: m.commentId,
    commentAuthor: m.commentAuthor,
    excerpt: m.excerpt,
    commentUrl: m.commentUrl,
    mentionedAt: m.mentionedAt,
    workItem: workItemByKey.get(m.issueKey),
    groupCount: 1,
  }));

  const grouped = groupMentionItems(asRecentMentions, {
    isMention: () => true,
    groupKey: (item) => item.issueKey,
    recency: (item) => item.mentionedAt,
    relabel: (mostRecent, count) => ({ ...mostRecent, groupCount: count }),
  });

  // Labeled after grouping, from the card's representative (most recent) mention — every
  // mention that survived the filter above is already strictly newer than any record.
  return grouped
    .map((m) => {
      const reactivation = mentionReactivation(m.issueKey, m.mentionedAt, { dailyCommandCompletions: completions, dailyCommandSkips: skips, dailyCommandBlocks: blocks });
      return reactivation ? { ...m, reactivation } : m;
    })
    .sort((a, b) => (a.mentionedAt < b.mentionedAt ? 1 : -1));
}
