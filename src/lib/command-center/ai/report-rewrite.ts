// V2.37 I4 — "Rewrite for…" in Reports: Standup (team) / PM update / Client update / Vietnamese.
// The deterministic report (rendered as plain text) is the ONLY input; the model may rephrase
// and summarize, never change facts:
//   - post-check (also run server-side): every ticket key and number in the answer must exist
//     in the input, else the deterministic report is shown with a notice;
//   - Client update is built from a client-safe copy of the report: no Team section, no
//     skipped work, no mentions/removed-from-scope, no assignees/waits-on names, no notes
//     marked internal, no "needs decision from" names — and custom terms go through the
//     redaction aliases (restored for display).

import { SKIP_REASONS } from "../types";
import { renderDailyReport, renderWeeklyReport, type DailyReportView, type ReportTicket, type WeeklyReportView } from "../reports";
import { RedactionSession, type CustomTerm } from "./redaction";
import { lockedFactViolations } from "./task-registry";
import type { AIProvider } from "./provider";

export type ReportAudience = "standup" | "pm" | "client" | "vi";
export const REPORT_AUDIENCES: { id: ReportAudience; label: string }[] = [
  { id: "standup", label: "Standup (team)" },
  { id: "pm", label: "PM update" },
  { id: "client", label: "Client update" },
  { id: "vi", label: "Vietnamese" },
];

/** A note/reason the user marked internal ("[internal] …", "internal: …", "#internal"), or a
 *  personal skip reason. Never shown in a client update. */
export function isInternalNote(note: string): boolean {
  const n = note.trim();
  return /^(\[internal\]|\(internal\)|internal:)/i.test(n) || /#internal\b/i.test(n) || (SKIP_REASONS as string[]).includes(n);
}

function clientTicket(t: ReportTicket): ReportTicket {
  const notes = (t.notes ?? []).filter((n) => !isInternalNote(n));
  // assignee / waitsOn are teammates' names; mention refs are internal plumbing.
  return { key: t.key, title: t.title, url: t.url, project: t.project, client: t.client, sprint: t.sprint, since: t.since, ageBusinessDays: t.ageBusinessDays, revisitOn: t.revisitOn, ...(notes.length ? { notes } : {}) };
}
const clientList = (ts: ReportTicket[] | undefined) => (ts ?? []).map(clientTicket);

export function clientSafeDailyView(v: DailyReportView): DailyReportView {
  return {
    ...v,
    doneMine: clientList(v.doneMine),
    inProgress: clientList(v.inProgress),
    blocked: clientList(v.blocked),
    newToday: clientList(v.newToday),
    skipped: [],
    mentionsAwaitingReply: [],
    teamDone: [],
    removedFromScope: [],
    ...(v.openAssigned ? { openAssigned: clientList(v.openAssigned) } : {}),
    ...(v.overdueBlockers ? { overdueBlockers: clientList(v.overdueBlockers) } : {}),
    ...(v.blockedAging ? { blockedAging: clientList(v.blockedAging) } : {}),
    summary: undefined,
    needsDecisionFrom: undefined,
  };
}

export function clientSafeWeeklyView(v: WeeklyReportView): WeeklyReportView {
  return {
    ...v,
    totals: { ...v.totals, teamDone: 0, skipped: 0 },
    doneGroups: v.doneGroups.map((g) => ({ ...g, tickets: clientList(g.tickets) })),
    teamDone: [],
    carriedOver: clientList(v.carriedOver),
    blockers: clientList(v.blockers),
    skipped: [],
    newReceived: clientList(v.newReceived),
    nextWeek: clientList(v.nextWeek),
    ...(v.blockedAging ? { blockedAging: clientList(v.blockedAging) } : {}),
    summary: undefined,
    needsDecisionFrom: undefined,
  };
}

/** The deterministic text a rewrite starts from (and falls back to). */
export function rewriteSource(report: { kind: "daily"; view: DailyReportView } | { kind: "weekly"; view: WeeklyReportView }, audience: ReportAudience, includeTeam: boolean): string {
  const client = audience === "client";
  const raw = report.kind === "daily" ? renderDailyReport(client ? clientSafeDailyView(report.view) : report.view, "text", { includeTeam: client ? false : includeTeam }) : renderWeeklyReport(client ? clientSafeWeeklyView(report.view) : report.view, "text", { includeTeam: client ? false : includeTeam });
  return client ? dropClientSections(raw) : raw;
}

const CLIENT_DROPPED_SECTION = /^(Skipped|Mentions awaiting my reply|Removed from scope|Team: done|Needs decision from)\b.*\(\d+\)$/;

/** Removes the (already emptied) internal sections and the skipped / team totals lines, so a
 *  client update doesn't even show them as zero. */
export function dropClientSections(text: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    if (CLIENT_DROPPED_SECTION.test(line.trim())) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (line.trim() === "") skipping = false;
      continue;
    }
    if (/^\s*-\s*(Skipped|Team done):/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

export interface RewriteResult {
  text: string;
  usedAi: boolean;
  notice?: string;
}

export async function rewriteReportFlow(args: { source: string; audience: ReportAudience; customTerms: CustomTerm[]; provider: Pick<AIProvider, "rewriteReport" | "mode"> }): Promise<RewriteResult> {
  const session = new RedactionSession(args.customTerms);
  const redacted = session.redact(args.source);
  const out = await args.provider.rewriteReport(args.audience, redacted);
  if (args.provider.mode !== "claude" || out === redacted) {
    return { text: args.source, usedAi: false, notice: "AI rewrite unavailable — showing the deterministic report." };
  }
  const restored = session.restore(out);
  const violations = lockedFactViolations(restored, args.source);
  if (violations.length) {
    return { text: args.source, usedAi: false, notice: `The AI rewrite changed facts (${violations.slice(0, 3).join("; ")}) — showing the deterministic report instead.` };
  }
  return { text: restored, usedAi: true };
}
