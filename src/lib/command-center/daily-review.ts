// V2.26 — Daily Review: the "morning check" over everything the other surfaces record,
// matching the actual working loop (track in the morning → work → update → next day, check
// what was skipped / blocked / new). Pure composition of data that already exists — no new
// classifier, no new scoring:
//   - New since your last visit: WorkItem.firstSeenAt (sync provenance) vs. the user's
//     previous Daily Review visit, minus anything already finished or given a Daily Command
//     state. A returning (reactivated) ticket is never "new": it keeps its Completed/Skipped/
//     Blocked record, so it lands in that bucket with a reactivation label instead.
//   - Skipped / Blocked: straight from dailyCommandSkips / dailyCommandBlocks.
//   - Completed recently: dailyCommandCompletions + JIRA_STATUS_COMPLETED memory events from
//     the last N days, labeled by source.
//
// A3 — "New" is no longer "since you last opened this page" (a refresh emptied it) and no
// longer only "first seen": a ticket is New when, after the baseline, ANY of these happened —
//   - "new-ticket": first seen by a sync (WorkItem.firstSeenAt; personal = assigned to me),
//   - "assigned":   reassigned to me (WorkItem.assignedToMeAt, stamped per sync from
//                   assignment-detection.ts's diff),
//   - "mentioned":  a new mention of me (MentionEvent.mentionedAt),
// and it stays New until the user acknowledges it ("Seen" / "Mark all reviewed" →
// reviewAcks[key].reviewedAt), unless it is completed/skipped/blocked or finished in Jira.
// An acknowledgment only covers reasons up to its own time: a later mention or reassignment
// makes the ticket New again. The baseline is pinned by the store (dailyReviewBaselineAt) and
// never moves on a visit; with no baseline yet, the pre-A3 fallbacks apply unchanged.

import type { AttentionItemState, DailyCommandBlock, DailyCommandCompletion, DailyCommandSkip, DailyReviewAck, MemoryEvent, MentionEvent, SyncLogEntry, TaskReactivation, WorkItem } from "./types";
import { slug } from "./attention-queue";
import { getAssignedWorkItems } from "./assigned-work";
import { isWorkItemDoneOrExcluded, type WorkRelevanceIndex } from "./jira/work-relevance";
import type { PersonalRelationIdentity } from "./personal-relation";
import { computeMentionReactivations } from "./recent-mentions";
import { addDays, toLocalIso } from "./date-utils";

export const DAILY_REVIEW_COMPLETED_WINDOW_DAYS = 7;

export interface DailyReviewInput {
  /** Already project-scope/filter-restricted, same as every other surface. */
  workItems: WorkItem[];
  identity: PersonalRelationIdentity;
  workRelevanceIndex?: WorkRelevanceIndex;
  dailyCommandCompletions: Record<string, DailyCommandCompletion>;
  dailyCommandSkips: Record<string, DailyCommandSkip>;
  dailyCommandBlocks: Record<string, DailyCommandBlock>;
  memoryEvents: MemoryEvent[];
  mentionEvents: MentionEvent[];
  attentionState?: Record<string, AttentionItemState>;
  syncLog: SyncLogEntry[];
  /** The user's PREVIOUS Daily Review visit (captured before this visit is recorded). Pre-A3
   *  baseline, still honored when `baselineAt` is absent. */
  lastVisitAt?: string;
  /** A3 — the pinned baseline (StoreState.dailyReviewBaselineAt). Wins over lastVisitAt. */
  baselineAt?: string;
  /** A3 — explicit acknowledgments (StoreState.dailyReviewAcks). */
  reviewAcks?: Record<string, DailyReviewAck>;
  now: Date;
}

export type DailyReviewNewReasonKind = "new-ticket" | "assigned" | "mentioned";

export interface DailyReviewNewReason {
  kind: DailyReviewNewReasonKind;
  /** When it happened (sync time for new-ticket/assigned, comment time for mentioned). */
  at?: string;
  /** "mentioned" only: the comment author. */
  by?: string;
}

export interface DailyReviewNewRow {
  ticketKey: string;
  /** Undefined when a mention's ticket isn't in the current work-item set. */
  workItem?: WorkItem;
  reasons: DailyReviewNewReason[];
  /** Latest reason time — the row's sort key. */
  latestAt?: string;
}

export interface DailyReviewHistoryRow {
  ticketKey: string;
  /** Undefined when the ticket isn't in the current scope — the row still shows its key. */
  workItem?: WorkItem;
  at?: string;
  reactivation?: TaskReactivation;
  /** A4 — skipped/blocked rows: which, and the scheduled re-check day when one is set. */
  kind?: "skipped" | "blocked";
  revisitOn?: string;
}

export interface DailyReviewCompletedRow extends DailyReviewHistoryRow {
  sources: ("jira" | "daily-command")[];
  /** Local YYYY-MM-DD the completion was recorded (for Jira, the sync day it was detected). */
  day: string;
}

export interface DailyReview {
  /** The cutoff "new" was computed against, and where it came from. */
  baseline: { at?: string; kind: "reviewed" | "last-visit" | "previous-sync" | "first-sync" };
  /** The New rows' work items (rows whose ticket is out of the current set are left out),
   *  kept for pre-A3 consumers. */
  newSinceLastVisit: WorkItem[];
  /** A3 — every New row, with WHY it is new. */
  newRows: DailyReviewNewRow[];
  /** A4 — skipped/blocked tickets whose re-check day is today or earlier. Still skipped/
   *  blocked (every other surface keeps excluding them) — listed here, and not again under
   *  Skipped/Blocked, until the user acts. */
  dueForRecheck: DailyReviewHistoryRow[];
  skipped: DailyReviewHistoryRow[];
  blocked: DailyReviewHistoryRow[];
  completedRecently: DailyReviewCompletedRow[];
  /** True when "new" is limited to tickets assigned to the configured identity. */
  personal: boolean;
}

/** A3 — "New ticket" / "Assigned to you" / "Mentioned by Anna", joined when several apply. */
export function newReasonLabel(reasons: DailyReviewNewReason[]): string {
  const labels = reasons.map((r) => (r.kind === "new-ticket" ? "New ticket" : r.kind === "assigned" ? "Assigned to you" : `Mentioned by ${r.by?.trim() || "someone"}`));
  return Array.from(new Set(labels)).join(" · ");
}

function byAtDesc<T extends { at?: string }>(a: T, b: T): number {
  return (b.at ?? "").localeCompare(a.at ?? "");
}

export function buildDailyReview(input: DailyReviewInput): DailyReview {
  const { workItems, identity, workRelevanceIndex, dailyCommandCompletions, dailyCommandSkips, dailyCommandBlocks, now } = input;
  const byKey = new Map(workItems.map((w) => [w.key, w]));
  const reactivations = computeMentionReactivations(input.mentionEvents, { dailyCommandCompletions, dailyCommandSkips, dailyCommandBlocks }, input.attentionState);

  // Baseline: the previous visit when there is one; otherwise "since the sync before the
  // latest one"; on an install with a single sync ever, everything that sync created is new.
  const previousSync = input.syncLog.length >= 2 ? input.syncLog[input.syncLog.length - 2] : undefined;
  const latestSync = input.syncLog[input.syncLog.length - 1];
  const baseline: DailyReview["baseline"] = input.baselineAt
    ? { at: input.baselineAt, kind: "reviewed" }
    : input.lastVisitAt
    ? { at: input.lastVisitAt, kind: "last-visit" }
    : previousSync
      ? { at: previousSync.completedAt, kind: "previous-sync" }
      : { kind: "first-sync" };
  const firstSyncKeys = new Set(latestSync?.newTicketKeys ?? []);

  const personal = !!identity.accountId || !!identity.displayName;
  const population = personal ? getAssignedWorkItems(workItems, identity) : workItems;
  const acks = input.reviewAcks ?? {};
  // Strictly after the baseline: something stamped AT the baseline instant was already visible
  // then. This matters exactly for the "previous-sync" baseline, where a ticket that sync
  // created has firstSeenAt === that sync's completedAt (the same observedAt value in
  // store.ts) — ">=" would wrongly re-list the whole previous sync as new.
  const afterBaseline = (at: string | undefined) => !!at && !!baseline.at && at > baseline.at;
  const rows = new Map<string, DailyReviewNewRow>();
  const addReason = (ticketKey: string, workItem: WorkItem | undefined, reason: DailyReviewNewReason) => {
    const ack = acks[ticketKey]?.reviewedAt;
    if (ack && reason.at && reason.at <= ack) return; // acknowledged after it happened
    const row = rows.get(ticketKey) ?? { ticketKey, workItem, reasons: [] };
    row.workItem ??= workItem;
    row.reasons.push(reason);
    if (reason.at && (!row.latestAt || reason.at > row.latestAt)) row.latestAt = reason.at;
    rows.set(ticketKey, row);
  };

  for (const w of population) {
    if (!w.firstSeenAt) continue; // provenance unknown (legacy data) is never "new"
    if (baseline.at ? !afterBaseline(w.firstSeenAt) : !firstSyncKeys.has(w.key)) continue;
    addReason(w.key, w, { kind: "new-ticket", at: w.firstSeenAt });
  }
  // Reassignment and mentions need a real baseline: on the very first sync there is no
  // "before" to compare against, so nothing can honestly be called new for these reasons.
  if (baseline.at) {
    for (const w of workItems) {
      if (afterBaseline(w.assignedToMeAt) && (!personal || getAssignedWorkItems([w], identity).length > 0)) addReason(w.key, w, { kind: "assigned", at: w.assignedToMeAt });
    }
    for (const m of input.mentionEvents) {
      if (!afterBaseline(m.mentionedAt)) continue;
      // Already dealt with from the Attention Queue → not news any more.
      const lifecycle = input.attentionState?.[`MENTION:${slug(m.issueKey)}:${slug(m.commentId)}`]?.lifecycle;
      if (lifecycle === "RESOLVED" || lifecycle === "ACKNOWLEDGED") continue;
      addReason(m.issueKey, byKey.get(m.issueKey), { kind: "mentioned", at: m.mentionedAt, by: m.commentAuthor });
    }
  }

  const newRows = Array.from(rows.values())
    .filter((r) => {
      if (r.workItem && isWorkItemDoneOrExcluded(r.workItem, workRelevanceIndex)) return false;
      return !(r.ticketKey in dailyCommandCompletions) && !(r.ticketKey in dailyCommandSkips) && !(r.ticketKey in dailyCommandBlocks);
    })
    .sort((a, b) => (b.latestAt ?? "").localeCompare(a.latestAt ?? "") || a.ticketKey.localeCompare(b.ticketKey));
  const newSinceLastVisit = newRows.flatMap((r) => (r.workItem ? [r.workItem] : []));

  const historyRow = (ticketKey: string, at: string | undefined): DailyReviewHistoryRow => ({ ticketKey, workItem: byKey.get(ticketKey), at, reactivation: reactivations.get(ticketKey) });
  const today = toLocalIso(now);
  const isDue = (revisitOn: string | undefined) => !!revisitOn && revisitOn <= today;
  const pausedRow = (ticketKey: string, at: string, kind: "skipped" | "blocked", revisitOn: string | undefined): DailyReviewHistoryRow => ({ ...historyRow(ticketKey, at), kind, ...(revisitOn ? { revisitOn } : {}) });
  const skippedAll = Object.values(dailyCommandSkips).map((s) => pausedRow(s.ticketKey, s.skippedAt, "skipped", s.revisitOn));
  const blockedAll = Object.values(dailyCommandBlocks).map((b) => pausedRow(b.ticketKey, b.blockedAt, "blocked", b.revisitOn));
  const skipped = skippedAll.filter((r) => !isDue(r.revisitOn)).sort(byAtDesc);
  const blocked = blockedAll.filter((r) => !isDue(r.revisitOn)).sort(byAtDesc);
  const dueForRecheck = [...skippedAll, ...blockedAll].filter((r) => isDue(r.revisitOn)).sort((a, b) => (a.revisitOn ?? "").localeCompare(b.revisitOn ?? "") || byAtDesc(a, b));

  const windowStart = addDays(toLocalIso(now), -(DAILY_REVIEW_COMPLETED_WINDOW_DAYS - 1));
  const completed = new Map<string, DailyReviewCompletedRow>();
  for (const c of Object.values(dailyCommandCompletions)) {
    const parsed = new Date(c.completedAt);
    const day = Number.isNaN(parsed.getTime()) ? undefined : toLocalIso(parsed);
    if (!day || day < windowStart) continue;
    // A4 — a completion recorded because Jira closed a skipped/blocked ticket is a Jira fact.
    completed.set(c.ticketKey, { ...historyRow(c.ticketKey, c.completedAt), sources: [c.source === "jira" ? "jira" : "daily-command"], day });
  }
  for (const ev of input.memoryEvents) {
    if (ev.kind !== "JIRA_STATUS_COMPLETED" || !ev.ticketKey || ev.date < windowStart) continue;
    const existing = completed.get(ev.ticketKey);
    if (existing) {
      if (!existing.sources.includes("jira")) existing.sources.push("jira");
      continue;
    }
    completed.set(ev.ticketKey, { ...historyRow(ev.ticketKey, undefined), sources: ["jira"], day: ev.date });
  }
  const completedRecently = Array.from(completed.values()).sort((a, b) => b.day.localeCompare(a.day) || byAtDesc(a, b));

  return { baseline, newSinceLastVisit, newRows, dueForRecheck, skipped, blocked, completedRecently, personal };
}
