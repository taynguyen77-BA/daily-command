// E4 — Reports without opening the app. A Daily Report used to exist only for days the app was
// opened (it is built from that browser's memoryEvents and standup state). When Vercel KV +
// APP_STATE_SECRET + PERSONAL_JIRA_ACCOUNT_ID are configured, the scheduled cron
// (jira/sync/route.ts GET) also writes a small server-side standup snapshot for each workday —
// Jira-derived sections only:
//   - New assigned:   open issues assigned to me that weren't assigned at the previous run.
//   - New mentions:   comments mentioning me not seen at the previous run.
//   - Closed in Jira: issues assigned to me that were open at the previous run and are Done now.
//   - Open assigned:  every open issue assigned to me right now.
// The client pulls these (GET /api/command-center/reports/server) and merges them into
// dailyReports as `server` — client data always wins for the in-app sections
// (server-report-merge.ts, kept separate so the browser bundle doesn't carry the Jira fetch code).
//
// Same shape as cron-notify.ts: every credential/env access is the caller's; this module takes a
// resolved config, an injected FetchLike and an injected store, so it is tested offline. A
// fetch failure never writes anything.

import { normalizeIssues } from "./jira/normalize";
import { fetchAssignedIssuesWith, fetchMentionedIssuesWith, type FetchLike } from "./jira/http";
import type { JiraConnectionConfig, JiraIssue } from "./jira/types";
import { collectCurrentMentions } from "./cron-notify";
import type { ReportTicket } from "./reports";
import type { ServerDailyStandup } from "./server-report-merge";

export type { ServerDailyStandup };

export interface ServerReportBaseline {
  assignedOpenKeys: string[];
  assignedAllKeys: string[];
  seenMentionCommentIds: string[];
  lastRunIso: string;
}

export interface ServerReportState {
  baseline: ServerReportBaseline | null;
  reports: Record<string, ServerDailyStandup>;
}

export interface ServerReportStore {
  get(): Promise<ServerReportState | null>;
  set(state: ServerReportState): Promise<void>;
}

export function createInMemoryServerReportStore(initial: ServerReportState | null = null): ServerReportStore {
  let state = initial;
  return {
    async get() {
      return state;
    },
    async set(next) {
      state = next;
    },
  };
}

export const MAX_SERVER_REPORT_DAYS = 60;
const MAX_SEEN_MENTIONS = 2000;

/** Whether the cron should write server-side reports: KV (to store them), APP_STATE_SECRET (so
 *  the client can fetch them) and a personal Jira account (whose work they describe). */
export function isServerDailyReportConfigured(env: Record<string, string | undefined>): boolean {
  return !!env.KV_REST_API_URL && !!env.KV_REST_API_TOKEN && !!env.APP_STATE_SECRET?.trim() && !!env.PERSONAL_JIRA_ACCOUNT_ID?.trim();
}

/** The user's local calendar date at `now`, given Jira's configured UTC offset (minutes). */
export function localDateFor(now: Date, timezoneOffsetMinutes: number = 0): string {
  return new Date(now.getTime() + timezoneOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** G3 — the local hour from which a run may write the day's snapshot (REPORT_SNAPSHOT_HOUR_LOCAL,
 *  0–23, default 17): an earlier run (e.g. a morning cron for the Morning Brief) syncs and
 *  notifies but never freezes a day that isn't over yet. */
export const DEFAULT_REPORT_SNAPSHOT_HOUR_LOCAL = 17;
export function reportSnapshotHourLocal(env: Record<string, string | undefined>): number {
  const n = Number(env.REPORT_SNAPSHOT_HOUR_LOCAL);
  return Number.isInteger(n) && n >= 0 && n <= 23 && env.REPORT_SNAPSHOT_HOUR_LOCAL?.trim() !== "" ? n : DEFAULT_REPORT_SNAPSHOT_HOUR_LOCAL;
}

/** The user's local hour (0–23) at `now`, given Jira's UTC offset in minutes. */
export function localHourFor(now: Date, timezoneOffsetMinutes: number = 0): number {
  return new Date(now.getTime() + timezoneOffsetMinutes * 60_000).getUTCHours();
}

export function isWorkday(isoDate: string): boolean {
  const day = new Date(isoDate + "T00:00:00Z").getUTCDay();
  return day !== 0 && day !== 6;
}

function ticketFromIssue(issue: JiraIssue, baseUrl: string, notes?: string[]): ReportTicket {
  const f = issue.fields ?? {};
  return {
    key: issue.key,
    ...(f.summary ? { title: f.summary } : {}),
    url: `${baseUrl.replace(/\/$/, "")}/browse/${issue.key}`,
    ...(f.project?.name ? { project: f.project.name } : {}),
    ...(notes && notes.length > 0 ? { notes } : {}),
  };
}

function unionByKey(a: ReportTicket[], b: ReportTicket[]): ReportTicket[] {
  const seen = new Set(a.map((t) => `${t.key}|${t.mention?.commentId ?? ""}`));
  return [...a, ...b.filter((t) => !seen.has(`${t.key}|${t.mention?.commentId ?? ""}`))];
}

export interface ServerDailySnapshotResult {
  date: string;
  written: boolean;
  skipped?: "weekend" | "too-early";
  error?: string;
}

export async function runServerDailySnapshot(
  fetchImpl: FetchLike,
  config: JiraConnectionConfig,
  accountId: string,
  store: ServerReportStore,
  options: { now: Date; timezoneOffsetMinutes?: number; snapshotHourLocal?: number }
): Promise<ServerDailySnapshotResult> {
  const date = localDateFor(options.now, options.timezoneOffsetMinutes);
  // Weekends are skipped entirely (baseline included), so Monday's diff covers the weekend.
  if (!isWorkday(date)) return { date, written: false, skipped: "weekend" };
  // G3 — only at/after the end of the local workday (nothing is written, baseline untouched).
  if (options.snapshotHourLocal !== undefined && localHourFor(options.now, options.timezoneOffsetMinutes) < options.snapshotHourLocal) return { date, written: false, skipped: "too-early" };

  const previous = await store.get();
  const baseline = previous?.baseline ?? null;

  const assignedResult = await fetchAssignedIssuesWith(fetchImpl, config, accountId);
  if (!assignedResult.ok) return { date, written: false, error: assignedResult.error };
  const { workItems } = normalizeIssues(assignedResult.data, { baseUrl: config.baseUrl, today: date });
  const issueByKey = new Map(assignedResult.data.map((i) => [i.key, i]));
  const openKeys = workItems.filter((w) => w.status !== "Done").map((w) => w.key);
  const doneKeys = new Set(workItems.filter((w) => w.status === "Done").map((w) => w.key));

  const mentionedResult = await fetchMentionedIssuesWith(fetchImpl, config, accountId, baseline?.lastRunIso);
  if (!mentionedResult.ok) return { date, written: false, error: mentionedResult.error };
  const mentions = await collectCurrentMentions(fetchImpl, config, accountId, mentionedResult.data.map((i) => i.key), date);

  const seen = new Set(baseline?.seenMentionCommentIds ?? []);
  const newMentionEntries = mentions.filter((m) => (baseline ? !seen.has(m.commentId) : m.event.mentionedAt.slice(0, 10) === date));
  const ticket = (key: string, notes?: string[]) => {
    const issue = issueByKey.get(key);
    return issue ? ticketFromIssue(issue, config.baseUrl, notes) : { key, url: `${config.baseUrl.replace(/\/$/, "")}/browse/${key}`, ...(notes ? { notes } : {}) };
  };

  const report: ServerDailyStandup = {
    date,
    generatedAt: options.now.toISOString(),
    newAssigned: baseline ? openKeys.filter((k) => !baseline.assignedAllKeys.includes(k)).map((k) => ticket(k, ["assigned to you"])) : [],
    newMentions: newMentionEntries.map((m) => ({
      key: m.event.issueKey,
      ...(m.event.commentUrl ? { url: m.event.commentUrl } : {}),
      notes: [m.event.commentAuthor ? `${m.event.commentAuthor}: ${m.event.excerpt}` : m.event.excerpt],
      mention: { commentId: m.commentId },
    })),
    closedInJira: baseline ? baseline.assignedOpenKeys.filter((k) => doneKeys.has(k)).map((k) => ticket(k, ["closed in Jira"])) : [],
    openAssigned: openKeys.map((k) => ticket(k)),
    ...(baseline ? {} : { coldStart: true }),
  };

  // A second run on the same day adds to that day's report rather than replacing it.
  const sameDay = previous?.reports[date];
  const merged: ServerDailyStandup = sameDay
    ? {
        ...report,
        newAssigned: unionByKey(sameDay.newAssigned, report.newAssigned),
        newMentions: unionByKey(sameDay.newMentions, report.newMentions),
        closedInJira: unionByKey(sameDay.closedInJira, report.closedInJira),
        ...(sameDay.coldStart && report.coldStart ? { coldStart: true } : { coldStart: undefined }),
      }
    : report;
  if (merged.coldStart === undefined) delete merged.coldStart;

  const reports = { ...(previous?.reports ?? {}), [date]: merged };
  for (const old of Object.keys(reports).sort().slice(0, Math.max(0, Object.keys(reports).length - MAX_SERVER_REPORT_DAYS))) delete reports[old];

  await store.set({
    baseline: {
      assignedOpenKeys: openKeys,
      assignedAllKeys: workItems.map((w) => w.key),
      seenMentionCommentIds: Array.from(new Set([...(baseline?.seenMentionCommentIds ?? []), ...mentions.map((m) => m.commentId)])).slice(-MAX_SEEN_MENTIONS),
      lastRunIso: options.now.toISOString(),
    },
    reports,
  });
  return { date, written: true };
}
