// D1 — Morning Brief: "since yesterday 18:00" counts at the top of Daily Review, each a jump
// link. Pure; the boundary is the previous BUSINESS day at 18:00 local (so Monday morning
// reads "since Fri 18:00", not "since Sunday").

import { toLocalIso } from "./date-utils";
import type { DailyCommandBlock, DailyCommandSkip, MemoryEvent, MentionEvent, WorkItem } from "./types";
import { matchesIdentity, type PersonalRelationIdentity } from "./personal-relation";

export const MORNING_BRIEF_HOUR = 18;

/** 18:00 local on the business day before `now`'s day. */
export function morningBriefSince(now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), MORNING_BRIEF_HOUR, 0, 0, 0);
  do d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6);
  return d;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function morningBriefSinceLabel(since: Date, now: Date): string {
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const day = toLocalIso(since) === toLocalIso(yesterday) ? "yesterday" : DAYS[since.getDay()];
  return `Since ${day} ${String(MORNING_BRIEF_HOUR).padStart(2, "0")}:00`;
}

export interface MorningBriefCount {
  id: "new" | "assigned" | "mentions" | "recheck" | "team-closed";
  label: string;
  count: number;
  /** In-page anchor (Daily Review) or route the count jumps to. */
  href: string;
}

export interface MorningBrief {
  sinceLabel: string;
  sinceIso: string;
  counts: MorningBriefCount[];
}

export interface MorningBriefInput {
  /** The already-scoped work items Daily Review shows. */
  workItems: WorkItem[];
  identity: PersonalRelationIdentity;
  mentionEvents: MentionEvent[];
  memoryEvents: MemoryEvent[];
  dailyCommandSkips: Record<string, DailyCommandSkip>;
  dailyCommandBlocks: Record<string, DailyCommandBlock>;
  now: Date;
}

export function buildMorningBrief(input: MorningBriefInput): MorningBrief {
  const since = morningBriefSince(input.now);
  const sinceIso = since.toISOString();
  const after = (iso: string | undefined) => !!iso && !Number.isNaN(new Date(iso).getTime()) && new Date(iso).getTime() > since.getTime();
  const today = toLocalIso(input.now);
  const sinceDay = toLocalIso(since);
  const identityConfigured = !!input.identity.accountId || !!input.identity.displayName;
  const mine = (w: WorkItem) => !identityConfigured || matchesIdentity(w.ownerId, w.owner, input.identity);

  const newTickets = input.workItems.filter((w) => after(w.firstSeenAt) && mine(w)).length;
  const assigned = input.workItems.filter((w) => after(w.assignedToMeAt)).length;
  const mentions = new Set(input.mentionEvents.filter((m) => after(m.mentionedAt)).map((m) => m.commentId)).size;
  const recheck = [...Object.values(input.dailyCommandSkips), ...Object.values(input.dailyCommandBlocks)].filter((r) => !!r.revisitOn && r.revisitOn <= today).length;
  // Team closures are day-dated events: count those dated after the boundary's day (and the
  // boundary day itself only when Jira gave no resolution time — detected after 18:00 is unknowable).
  const teamClosed = new Set(
    input.memoryEvents
      .filter((e) => e.kind === "JIRA_STATUS_COMPLETED" && e.date > sinceDay && e.date <= today)
      .filter((e) => identityConfigured && !matchesIdentity(e.assigneeId, e.assigneeName, input.identity))
      .map((e) => e.ticketKey ?? e.id)
  ).size;

  return {
    sinceLabel: morningBriefSinceLabel(since, input.now),
    sinceIso,
    counts: [
      { id: "new", label: "new", count: newTickets, href: "#review-new" },
      { id: "assigned", label: "assigned", count: assigned, href: "#review-new" },
      { id: "mentions", label: `mention${mentions === 1 ? "" : "s"}`, count: mentions, href: "#review-new" },
      { id: "recheck", label: "due re-check", count: recheck, href: "#review-due" },
      { id: "team-closed", label: "closed by team", count: teamClosed, href: "/reports" },
    ],
  };
}

/** "4 new, 2 assigned, 3 mentions, 1 due re-check, 5 closed by team". */
export function morningBriefSentence(brief: MorningBrief): string {
  return `${brief.sinceLabel}: ${brief.counts.map((c) => `${c.count} ${c.label}`).join(", ")}`;
}

/** The one-click morning flow runs once per local day, only when the feature is on. */
export function shouldRunMorningBrief(enabled: boolean, lastRunDay: string | undefined, today: string): boolean {
  return enabled && lastRunDay !== today;
}
