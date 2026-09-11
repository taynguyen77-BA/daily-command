// Client-facing Daily/Weekly report — grounded in the same frozen DailyReportSnapshot events
// as daily-report.ts (never re-derived from live state), but organized and worded for external
// delivery: grouped by Client -> Project (never by internal "kind"/"trust label" plumbing),
// and listing only real completed work and real decisions — nothing invented, nothing scored.

import type { DailyReportSnapshot, MemoryEvent } from "./types";
import { summarizeDailyReport } from "./daily-report";

const UNASSIGNED_CLIENT = "Internal / Unassigned";

export interface ClientReportProjectSection {
  projectName: string;
  completed: MemoryEvent[];
  decisions: MemoryEvent[];
}

export interface ClientReportClientSection {
  clientName: string;
  projects: ClientReportProjectSection[];
  totalCompleted: number;
  totalDecisions: number;
}

export interface ClientReportSummary {
  rangeLabel: string;
  generatedAt: string;
  clients: ClientReportClientSection[];
  totalCompleted: number;
  totalDecisions: number;
  /** Outcomes were measured (see daily-report.ts's OUTCOME_KINDS) but aren't broken out per
   *  client/project below — surfaced only as a total so the report doesn't silently drop them. */
  totalOutcomes: number;
}

/** Client -> Project, in the same shape daily-report.ts already tracks Client/Project via
 *  each event's own clientName/projectName captured at record time. An event with no
 *  resolvable client (e.g. internal housekeeping) lands under UNASSIGNED_CLIENT rather than
 *  being silently dropped from a client-facing document. */
function groupByClientThenProject(completed: MemoryEvent[], decisions: MemoryEvent[]): ClientReportClientSection[] {
  const clientMap = new Map<string, Map<string, ClientReportProjectSection>>();

  function bucket(event: MemoryEvent, into: "completed" | "decisions") {
    const clientName = event.clientName || UNASSIGNED_CLIENT;
    const projectName = event.projectName || "Other work";
    if (!clientMap.has(clientName)) clientMap.set(clientName, new Map());
    const projects = clientMap.get(clientName)!;
    if (!projects.has(projectName)) projects.set(projectName, { projectName, completed: [], decisions: [] });
    projects.get(projectName)![into].push(event);
  }
  for (const e of completed) bucket(e, "completed");
  for (const e of decisions) bucket(e, "decisions");

  const clients = Array.from(clientMap.entries()).map(([clientName, projects]) => {
    const projectSections = Array.from(projects.values()).sort((a, b) => b.completed.length - a.completed.length);
    return {
      clientName,
      projects: projectSections,
      totalCompleted: projectSections.reduce((sum, p) => sum + p.completed.length, 0),
      totalDecisions: projectSections.reduce((sum, p) => sum + p.decisions.length, 0),
    };
  });

  // Real clients first (busiest first), Internal/Unassigned always last regardless of volume —
  // a client report should lead with client work, not internal noise.
  clients.sort((a, b) => {
    if (a.clientName === UNASSIGNED_CLIENT) return 1;
    if (b.clientName === UNASSIGNED_CLIENT) return -1;
    return b.totalCompleted - a.totalCompleted;
  });
  return clients;
}

export function buildDailyClientReport(snapshot: DailyReportSnapshot): ClientReportSummary {
  const summary = summarizeDailyReport(snapshot);
  const clients = groupByClientThenProject(summary.completed, summary.decisions);
  return {
    rangeLabel: snapshot.date,
    generatedAt: snapshot.generatedAt,
    clients,
    totalCompleted: summary.completed.length,
    totalDecisions: summary.decisions.length,
    totalOutcomes: summary.outcomes.length,
  };
}

/** `dateRange` is the label range (oldest first); `snapshots` are whichever of those days
 *  actually have a persisted Daily Report (a date with none is simply absent from the totals,
 *  same "never fabricate a gap" discipline as buildWeeklyReportSummary in daily-report.ts). */
export function buildWeeklyClientReport(dateRange: string[], snapshots: DailyReportSnapshot[]): ClientReportSummary {
  const summaries = snapshots.map(summarizeDailyReport);
  const completed = summaries.flatMap((s) => s.completed);
  const decisions = summaries.flatMap((s) => s.decisions);
  const outcomes = summaries.flatMap((s) => s.outcomes);
  const clients = groupByClientThenProject(completed, decisions);
  return {
    rangeLabel: `${dateRange[0]} to ${dateRange[dateRange.length - 1]}`,
    generatedAt: new Date().toISOString(),
    clients,
    totalCompleted: completed.length,
    totalDecisions: decisions.length,
    totalOutcomes: outcomes.length,
  };
}

/** `title (TICKET-123) — outcome note`, omitting any part the event doesn't actually carry. */
function formatWorkLine(event: MemoryEvent): string {
  const parts: string[] = [`- ${event.title}`];
  if (event.ticketKey) parts.push(`(${event.ticketKey})`);
  const line = parts.join(" ");
  return event.outcomeNote ? `${line} — ${event.outcomeNote}` : line;
}

export function clientReportToMarkdown(report: ClientReportSummary): string {
  const lines: string[] = [`# Status Update — ${report.rangeLabel}`, ""];

  if (report.clients.length === 0) {
    lines.push("No completed work or decisions recorded for this period.", "");
  }

  for (const client of report.clients) {
    lines.push(`## ${client.clientName}`, "");
    for (const project of client.projects) {
      lines.push(`### ${project.projectName}`);
      if (project.completed.length > 0) {
        lines.push("**Completed:**", ...project.completed.map(formatWorkLine), "");
      }
      if (project.decisions.length > 0) {
        lines.push("**Decisions:**", ...project.decisions.map(formatWorkLine), "");
      }
      if (project.completed.length === 0 && project.decisions.length === 0) lines.push("");
    }
  }

  if (report.totalOutcomes > 0) {
    lines.push(`_${report.totalOutcomes} outcome(s) also measured this period — see the internal Weekly Report for detail._`, "");
  }

  lines.push("---", `_Prepared ${report.generatedAt}_`);
  return lines.join("\n");
}

/** Client-side-only "Save As" for a generated report — the app is local-only (no backend), so
 *  this is a plain Blob + anchor download, same trust boundary as clipboard export elsewhere. */
export function downloadMarkdown(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
