// V2.17 Task 2 — Daily/Weekly completed-work reports. Reuses memoryEvents (already an
// append-only, timestamped audit trail) rather than building a second tracking system: this
// file is purely a display/aggregation layer over already-frozen DailyReportSnapshot data
// (store.ts's generateDailyReport) — it never reads live WorkItem/Decision/Action state, so a
// report about a past day stays stable no matter what happens to the underlying tickets later.

import { addDays } from "./date-utils";
import type { DailyReportSnapshot, MemoryEvent } from "./types";

/** The 7 calendar dates ending on (and including) `todayIso`, oldest first — the window
 *  buildWeeklyReportSummary aggregates over. */
export function last7DaysEnding(todayIso: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(todayIso, i - 6));
}

type MemoryEventKind = MemoryEvent["kind"];
// V2.25 Task 2 — confirmed real gap: this used to be one COMPLETED_KINDS set covering only
// explicit in-app actions (ACTION_COMPLETED, FOCUS_COMPLETED), so a ticket a Dev/QA closed
// directly in Jira never appeared here even though it's genuinely finished work.
// JIRA_STATUS_COMPLETED (jira-completion-detection.ts, emitted from store.ts's syncJira) is
// now folded into "Completed" too — but kept in its own bucket, never blended into one
// undifferentiated list, so a reader never mistakes "the app observed this in Jira" for "you
// did this in the app".
const COMPLETED_IN_APP_KINDS: ReadonlySet<MemoryEventKind> = new Set<MemoryEventKind>(["ACTION_COMPLETED", "FOCUS_COMPLETED"]);
const COMPLETED_IN_JIRA_KINDS: ReadonlySet<MemoryEventKind> = new Set<MemoryEventKind>(["JIRA_STATUS_COMPLETED"]);
const DECISION_KINDS: ReadonlySet<MemoryEventKind> = new Set<MemoryEventKind>(["DECISION_MADE", "DECISION_OUTCOME"]);
const OUTCOME_KINDS: ReadonlySet<MemoryEventKind> = new Set<MemoryEventKind>(["ACTION_OUTCOME"]);

export interface DailyReportSummary {
  date: string;
  generatedAt: string;
  /** Every completed-work event, in-app and Jira-detected combined — for a caller that only
   *  needs a total (e.g. buildWeeklyReportSummary's byProject rollup). Prefer
   *  completedInApp/completedInJira below when the distinction matters for display. */
  completed: MemoryEvent[];
  /** Completed via an explicit action the user took inside this app (finished an Action,
   *  completed a Focus session). */
  completedInApp: MemoryEvent[];
  /** Completed in Jira — detected during a sync diff (jira-completion-detection.ts), with no
   *  corresponding in-app action. Never blended with completedInApp above. */
  completedInJira: MemoryEvent[];
  decisions: MemoryEvent[];
  outcomes: MemoryEvent[];
  /** Everything else recorded that day (drift/risk/loop/plan-housekeeping events) — still
   *  real history, just not "completed work" in the sense this report leads with. */
  other: MemoryEvent[];
}

/** Pure grouping over an already-frozen snapshot's events — never re-derives anything from
 *  live state. */
export function summarizeDailyReport(snapshot: DailyReportSnapshot): DailyReportSummary {
  const completedInApp: MemoryEvent[] = [];
  const completedInJira: MemoryEvent[] = [];
  const decisions: MemoryEvent[] = [];
  const outcomes: MemoryEvent[] = [];
  const other: MemoryEvent[] = [];
  for (const event of snapshot.events) {
    if (COMPLETED_IN_APP_KINDS.has(event.kind)) completedInApp.push(event);
    else if (COMPLETED_IN_JIRA_KINDS.has(event.kind)) completedInJira.push(event);
    else if (DECISION_KINDS.has(event.kind)) decisions.push(event);
    else if (OUTCOME_KINDS.has(event.kind)) outcomes.push(event);
    else other.push(event);
  }
  return {
    date: snapshot.date,
    generatedAt: snapshot.generatedAt,
    completed: [...completedInApp, ...completedInJira],
    completedInApp,
    completedInJira,
    decisions,
    outcomes,
    other,
  };
}

/** `title (ticketKey) — client/project — outcome note`, omitting any part the event doesn't
 *  actually carry (never fabricating a placeholder for a missing fact). */
function formatEventLine(event: MemoryEvent): string {
  const parts: string[] = [event.title];
  const context = [event.ticketKey, event.clientName, event.projectName].filter((v): v is string => !!v).join(" · ");
  if (context) parts.push(`(${context})`);
  if (event.outcomeNote) parts.push(`— ${event.outcomeNote}`);
  return parts.join(" ");
}

/** "Copy as Markdown" export for a single Daily Report — same lightweight
 *  clipboard.writeText pattern ArtifactEditor.tsx already uses, just a different generated
 *  string. */
export function dailyReportToMarkdown(snapshot: DailyReportSnapshot): string {
  const summary = summarizeDailyReport(snapshot);
  const lines: string[] = [`# Daily Report — ${summary.date}`, ""];

  // V2.25 Task 2 — the two completion sources are labeled separately (never blended into one
  // undifferentiated list) so a reader never mistakes "the app observed this in Jira" for "you
  // did this in the app" — see this file's own top comment.
  lines.push(`## Completed (${summary.completed.length})`);
  if (summary.completed.length === 0) {
    lines.push("- None.", "");
  } else {
    if (summary.completedInApp.length > 0) {
      lines.push(`**Completed via Daily Command (${summary.completedInApp.length})**`);
      lines.push(...summary.completedInApp.map((e) => `- ${formatEventLine(e)}`), "");
    }
    if (summary.completedInJira.length > 0) {
      lines.push(`**Completed in Jira (${summary.completedInJira.length})**`);
      lines.push(...summary.completedInJira.map((e) => `- ${formatEventLine(e)}`), "");
    }
  }

  lines.push(`## Decisions (${summary.decisions.length})`);
  lines.push(...(summary.decisions.length === 0 ? ["- None."] : summary.decisions.map((e) => `- ${formatEventLine(e)}`)), "");

  if (summary.outcomes.length > 0) {
    lines.push(`## Outcomes recorded (${summary.outcomes.length})`);
    lines.push(...summary.outcomes.map((e) => `- ${formatEventLine(e)}`), "");
  }

  if (summary.other.length > 0) {
    lines.push(`## Other activity (${summary.other.length})`);
    lines.push(...summary.other.map((e) => `- ${e.title}`), "");
  }

  lines.push(`_Generated ${summary.generatedAt}_`);
  return lines.join("\n");
}

export interface WeeklyReportSummary {
  /** The 7 calendar dates this weekly report covers, oldest first — NOT filtered to only the
   *  days that actually have a report, so a genuinely empty day is visible as a real gap
   *  rather than silently missing. */
  dateRange: string[];
  /** The persisted snapshots actually found for `dateRange`, in the same order — a date with
   *  no snapshot yet is simply absent here (never a fabricated empty placeholder). */
  snapshots: DailyReportSnapshot[];
  totalCompleted: number;
  /** V2.25 Task 2 — the same in-app/Jira-detected split summarizeDailyReport applies per day,
   *  rolled up over the week. totalCompleted === totalCompletedInApp + totalCompletedInJira. */
  totalCompletedInApp: number;
  totalCompletedInJira: number;
  totalDecisions: number;
  totalOutcomes: number;
  /** Per-project completed-work counts, computed only from events that actually carry a
   *  projectName — an event with no resolvable project context contributes to the totals
   *  above but never to a fabricated "Unknown project" bucket here. */
  byProject: { projectName: string; count: number }[];
}

/** Aggregates on demand over the 7 relevant already-persisted DailyReportSnapshots — never
 *  persists a separate weekly blob (per the dev prompt's own "don't persist redundantly").
 *  `dateRange` should be the 7 ISO dates the caller wants covered (oldest first); any date
 *  with no persisted snapshot is simply skipped, never inventing one. */
export function buildWeeklyReportSummary(dateRange: string[], dailyReports: Record<string, DailyReportSnapshot>): WeeklyReportSummary {
  const snapshots = dateRange.map((d) => dailyReports[d]).filter((s): s is DailyReportSnapshot => !!s);
  const allEvents = snapshots.flatMap((s) => s.events);
  const completedInApp = allEvents.filter((e) => COMPLETED_IN_APP_KINDS.has(e.kind));
  const completedInJira = allEvents.filter((e) => COMPLETED_IN_JIRA_KINDS.has(e.kind));
  const completed = [...completedInApp, ...completedInJira];
  const decisions = allEvents.filter((e) => DECISION_KINDS.has(e.kind));
  const outcomes = allEvents.filter((e) => OUTCOME_KINDS.has(e.kind));

  const projectCounts = new Map<string, number>();
  for (const event of completed) {
    if (!event.projectName) continue;
    projectCounts.set(event.projectName, (projectCounts.get(event.projectName) ?? 0) + 1);
  }
  const byProject = Array.from(projectCounts.entries())
    .map(([projectName, count]) => ({ projectName, count }))
    .sort((a, b) => b.count - a.count);

  return {
    dateRange,
    snapshots,
    totalCompleted: completed.length,
    totalCompletedInApp: completedInApp.length,
    totalCompletedInJira: completedInJira.length,
    totalDecisions: decisions.length,
    totalOutcomes: outcomes.length,
    byProject,
  };
}

export function weeklyReportToMarkdown(summary: WeeklyReportSummary): string {
  const lines: string[] = [
    `# Weekly Report — ${summary.dateRange[0]} to ${summary.dateRange[summary.dateRange.length - 1]}`,
    "",
    `${summary.snapshots.length} of ${summary.dateRange.length} day(s) in this range have a Daily Report.`,
    "",
    `## Totals`,
    `- Completed: ${summary.totalCompleted} (${summary.totalCompletedInApp} via Daily Command, ${summary.totalCompletedInJira} in Jira)`,
    `- Decisions: ${summary.totalDecisions}`,
    `- Outcomes recorded: ${summary.totalOutcomes}`,
    "",
  ];

  if (summary.byProject.length > 0) {
    lines.push("## By project");
    lines.push(...summary.byProject.map((p) => `- ${p.projectName}: ${p.count}`), "");
  }

  lines.push("## Day by day");
  for (const date of summary.dateRange) {
    const snapshot = summary.snapshots.find((s) => s.date === date);
    if (!snapshot) {
      lines.push(`- ${date}: no report generated.`);
      continue;
    }
    const daySummary = summarizeDailyReport(snapshot);
    lines.push(`- ${date}: ${daySummary.completed.length} completed, ${daySummary.decisions.length} decision(s).`);
  }

  return lines.join("\n");
}
