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
const COMPLETED_KINDS: ReadonlySet<MemoryEventKind> = new Set<MemoryEventKind>(["ACTION_COMPLETED", "FOCUS_COMPLETED"]);
const DECISION_KINDS: ReadonlySet<MemoryEventKind> = new Set<MemoryEventKind>(["DECISION_MADE", "DECISION_OUTCOME"]);
const OUTCOME_KINDS: ReadonlySet<MemoryEventKind> = new Set<MemoryEventKind>(["ACTION_OUTCOME"]);

export interface DailyReportSummary {
  date: string;
  generatedAt: string;
  completed: MemoryEvent[];
  decisions: MemoryEvent[];
  outcomes: MemoryEvent[];
  /** Everything else recorded that day (drift/risk/loop/plan-housekeeping events) — still
   *  real history, just not "completed work" in the sense this report leads with. */
  other: MemoryEvent[];
}

/** Pure grouping over an already-frozen snapshot's events — never re-derives anything from
 *  live state. */
export function summarizeDailyReport(snapshot: DailyReportSnapshot): DailyReportSummary {
  const completed: MemoryEvent[] = [];
  const decisions: MemoryEvent[] = [];
  const outcomes: MemoryEvent[] = [];
  const other: MemoryEvent[] = [];
  for (const event of snapshot.events) {
    if (COMPLETED_KINDS.has(event.kind)) completed.push(event);
    else if (DECISION_KINDS.has(event.kind)) decisions.push(event);
    else if (OUTCOME_KINDS.has(event.kind)) outcomes.push(event);
    else other.push(event);
  }
  return { date: snapshot.date, generatedAt: snapshot.generatedAt, completed, decisions, outcomes, other };
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

  lines.push(`## Completed (${summary.completed.length})`);
  lines.push(...(summary.completed.length === 0 ? ["- None."] : summary.completed.map((e) => `- ${formatEventLine(e)}`)), "");

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
  const completed = allEvents.filter((e) => COMPLETED_KINDS.has(e.kind));
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
    `- Completed: ${summary.totalCompleted}`,
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
