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

import type { AttentionItemState, DailyCommandBlock, DailyCommandCompletion, DailyCommandSkip, MemoryEvent, MentionEvent, SyncLogEntry, TaskReactivation, WorkItem } from "./types";
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
  /** The user's PREVIOUS Daily Review visit (captured before this visit is recorded). */
  lastVisitAt?: string;
  now: Date;
}

export interface DailyReviewHistoryRow {
  ticketKey: string;
  /** Undefined when the ticket isn't in the current scope — the row still shows its key. */
  workItem?: WorkItem;
  at?: string;
  reactivation?: TaskReactivation;
}

export interface DailyReviewCompletedRow extends DailyReviewHistoryRow {
  sources: ("jira" | "daily-command")[];
  /** Local YYYY-MM-DD the completion was recorded (for Jira, the sync day it was detected). */
  day: string;
}

export interface DailyReview {
  /** The cutoff "new" was computed against, and where it came from. */
  baseline: { at?: string; kind: "last-visit" | "previous-sync" | "first-sync" };
  newSinceLastVisit: WorkItem[];
  skipped: DailyReviewHistoryRow[];
  blocked: DailyReviewHistoryRow[];
  completedRecently: DailyReviewCompletedRow[];
  /** True when "new" is limited to tickets assigned to the configured identity. */
  personal: boolean;
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
  const baseline: DailyReview["baseline"] = input.lastVisitAt
    ? { at: input.lastVisitAt, kind: "last-visit" }
    : previousSync
      ? { at: previousSync.completedAt, kind: "previous-sync" }
      : { kind: "first-sync" };
  const firstSyncKeys = new Set(latestSync?.newTicketKeys ?? []);

  const personal = !!identity.accountId || !!identity.displayName;
  const population = personal ? getAssignedWorkItems(workItems, identity) : workItems;
  const newSinceLastVisit = population
    .filter((w) => {
      if (!w.firstSeenAt) return false; // provenance unknown (legacy data) is never "new"
      // Strictly after the baseline: a ticket first seen AT the baseline instant was already
      // visible then. This matters exactly for the "previous-sync" baseline, where a ticket
      // that sync created has firstSeenAt === that sync's completedAt (the same observedAt
      // value in store.ts) — ">=" would wrongly re-list the whole previous sync as new.
      if (baseline.at ? w.firstSeenAt <= baseline.at : !firstSyncKeys.has(w.key)) return false;
      if (isWorkItemDoneOrExcluded(w, workRelevanceIndex)) return false;
      return !(w.key in dailyCommandCompletions) && !(w.key in dailyCommandSkips) && !(w.key in dailyCommandBlocks);
    })
    .sort((a, b) => (b.firstSeenAt ?? "").localeCompare(a.firstSeenAt ?? ""));

  const historyRow = (ticketKey: string, at: string | undefined): DailyReviewHistoryRow => ({ ticketKey, workItem: byKey.get(ticketKey), at, reactivation: reactivations.get(ticketKey) });
  const skipped = Object.values(dailyCommandSkips).map((s) => historyRow(s.ticketKey, s.skippedAt)).sort(byAtDesc);
  const blocked = Object.values(dailyCommandBlocks).map((b) => historyRow(b.ticketKey, b.blockedAt)).sort(byAtDesc);

  const windowStart = addDays(toLocalIso(now), -(DAILY_REVIEW_COMPLETED_WINDOW_DAYS - 1));
  const completed = new Map<string, DailyReviewCompletedRow>();
  for (const c of Object.values(dailyCommandCompletions)) {
    const parsed = new Date(c.completedAt);
    const day = Number.isNaN(parsed.getTime()) ? undefined : toLocalIso(parsed);
    if (!day || day < windowStart) continue;
    completed.set(c.ticketKey, { ...historyRow(c.ticketKey, c.completedAt), sources: ["daily-command"], day });
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

  return { baseline, newSinceLastVisit, skipped, blocked, completedRecently, personal };
}
