// E4 — the client half of the server-side daily standup snapshots (server-daily-report.ts):
// their shape, and how they fold into the client's dailyReports. Separate from the cron code so
// the browser bundle only carries this.

import type { DailyReportSnapshot } from "./types";
import type { ReportTicket } from "./reports";

export interface ServerDailyStandup {
  date: string;
  generatedAt: string;
  newAssigned: ReportTicket[];
  newMentions: ReportTicket[];
  closedInJira: ReportTicket[];
  openAssigned: ReportTicket[];
  /** First run for this install: there is no previous run to diff against, so "new" and
   *  "closed" are only what can be dated to this day (mentions) — never guessed. */
  coldStart?: boolean;
}

/** Folds server snapshots into the client's dailyReports. A day the client already has keeps
 *  everything it recorded (events, standup) and gains `server`; a day the app never opened gets
 *  a report with no events and only `server`. Returns the SAME object when nothing changed. */
export function mergeServerDailyReports(dailyReports: Record<string, DailyReportSnapshot>, server: Record<string, ServerDailyStandup>): Record<string, DailyReportSnapshot> {
  let out: Record<string, DailyReportSnapshot> | null = null;
  for (const [date, s] of Object.entries(server)) {
    if (!isServerDailyStandup(s) || s.date !== date) continue;
    const existing = dailyReports[date];
    if (existing?.server && existing.server.generatedAt >= s.generatedAt) continue;
    out ??= { ...dailyReports };
    out[date] = existing ? { ...existing, server: s } : { date, generatedAt: s.generatedAt, events: [], server: s };
  }
  return out ?? dailyReports;
}

export function isServerDailyStandup(v: unknown): v is ServerDailyStandup {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Partial<ServerDailyStandup>;
  return typeof s.date === "string" && typeof s.generatedAt === "string" && [s.newAssigned, s.newMentions, s.closedInJira, s.openAssigned].every(Array.isArray);
}
