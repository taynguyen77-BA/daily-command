// E4 — reports without opening the app: the cron writes a server-side daily standup snapshot
// (Jira-derived sections), the client merges it into dailyReports, and a day with nothing
// recorded says "No data recorded" instead of showing empty sections.
// Run through scripts/tests/run.mts (npm test).

import fs from "node:fs";
import path from "node:path";
import { CommandCenterStore } from "../../src/lib/command-center/store";
import { createMemoryStateStorage } from "../../src/lib/command-center/state-persistence";
import {
  createInMemoryServerReportStore,
  isServerDailyReportConfigured,
  isWorkday,
  localDateFor,
  runServerDailySnapshot,
  type ServerReportState,
} from "../../src/lib/command-center/server-daily-report";
import { mergeServerDailyReports, type ServerDailyStandup } from "../../src/lib/command-center/server-report-merge";
import { buildDailyReportView, renderDailyReport, NO_DATA_RECORDED } from "../../src/lib/command-center/reports";
import type { FetchLike } from "../../src/lib/command-center/jira/http";
import type { JiraConnectionConfig } from "../../src/lib/command-center/jira/types";
import { ok } from "./harness.mts";

const config: JiraConnectionConfig = { baseUrl: "https://example.atlassian.net", email: "a@b.com", apiToken: "tok" };
const ME = "acc-me";
const identity = { accountId: ME, displayName: "Me" };
const WED = "2026-10-07"; // a Wednesday
const CRON_AT = new Date(`${WED}T06:00:00.000Z`);

type RawIssue = { key: string; fields: Record<string, unknown> };
const issue = (key: string, summary: string, done = false): RawIssue => ({
  key,
  fields: { summary, assignee: { accountId: ME, displayName: "Me" }, status: { name: done ? "Done" : "In Progress", statusCategory: { key: done ? "done" : "indeterminate" } }, project: { key: key.split("-")[0], name: "Payments" } },
});
const mentionBody = { type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: ME, text: "@Me" } }, { type: "text", text: " can you confirm the API change?" }] }] };

/** Fake Jira: assignee search, comment-mention search, per-issue comments. Counts calls. */
function fakeJira(opts: { assigned: RawIssue[]; mentioned: RawIssue[]; comments: Record<string, unknown[]>; failAssigned?: boolean }) {
  let calls = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls++;
    const u = new URL(url);
    if (u.pathname.endsWith("/search/jql")) {
      const jql = String((init?.body ? JSON.parse(init.body) : {}).jql ?? "");
      if (jql.startsWith("assignee")) return opts.failAssigned ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ issues: opts.assigned, isLast: true }) };
      if (jql.startsWith("comment")) return { ok: true, status: 200, json: async () => ({ issues: opts.mentioned, isLast: true }) };
      return { ok: false, status: 400, json: async () => ({}) };
    }
    const m = u.pathname.match(/issue\/([^/]+)\/comment/);
    if (m) return { ok: true, status: 200, json: async () => ({ comments: opts.comments[decodeURIComponent(m[1])] ?? [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, calls: () => calls };
}

const tuesdayBaseline: ServerReportState = {
  baseline: { assignedOpenKeys: ["SR-1", "SR-2"], assignedAllKeys: ["SR-1", "SR-2"], seenMentionCommentIds: [], lastRunIso: "2026-10-06T06:00:00.000Z" },
  reports: {},
};
const wednesdayJira = () =>
  fakeJira({
    assigned: [issue("SR-1", "Settlement batch"), issue("SR-2", "Refund flow", true), issue("SR-3", "Fraud rule v2")],
    mentioned: [issue("SR-4", "API contract")],
    comments: { "SR-4": [{ id: "c-41", author: { displayName: "Anna", accountId: "acc-anna" }, body: mentionBody, created: `${WED}T03:00:00.000Z` }] },
  });

// ----- AC: simulated day with the app closed + cron run → that day's report lists Jira sections -----
{
  const group = "E4 Server daily report";
  ok(group, isWorkday(WED) && !isWorkday("2026-10-10"), "sanity: 2026-10-07 is a workday, 2026-10-10 (Saturday) is not");
  const serverStore = createInMemoryServerReportStore(structuredClone(tuesdayBaseline));
  const jira = wednesdayJira();
  const result = await runServerDailySnapshot(jira.fetchImpl, config, ME, serverStore, { now: CRON_AT });
  const written = (await serverStore.get())!;
  const s = written.reports[WED];
  ok(group, result.written && result.date === WED && !!s, "the cron run writes a snapshot for that workday");
  ok(group, s.newAssigned.map((t) => t.key).join() === "SR-3", "New assigned: only the issue assigned since the previous run");
  ok(group, s.newMentions.length === 1 && s.newMentions[0].key === "SR-4" && s.newMentions[0].mention?.commentId !== undefined && /Anna/.test(s.newMentions[0].notes?.[0] ?? ""), "New mentions: the new comment mentioning me, with author and excerpt");
  ok(group, s.closedInJira.map((t) => t.key).join() === "SR-2", "Closed in Jira: open at the previous run, Done now");
  ok(group, s.openAssigned.map((t) => t.key).join() === "SR-1,SR-3", "Open assigned: every open issue assigned to me");
  ok(group, s.openAssigned.every((t) => t.url === `https://example.atlassian.net/browse/${t.key}` && t.project === "Payments" && !!t.title), "each line carries its Jira link, title and project");
  ok(group, written.baseline!.assignedOpenKeys.join() === "SR-1,SR-3" && written.baseline!.seenMentionCommentIds.length === 1, "the baseline advances for the next run");

  // The app was closed all day: the client has no report for WED until it pulls.
  const client = new CommandCenterStore({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [], jiraSyncLockManager: null });
  client.getSnapshot();
  ok(group, client.getSnapshot().dailyReports[WED] === undefined, "sanity: the app recorded nothing that day");
  client.mergeServerDailyReports(written.reports);
  const report = client.getSnapshot().dailyReports[WED];
  ok(group, !!report && report.events.length === 0 && report.server?.date === WED, "after the pull, that day has a report holding the server snapshot");
  const view = buildDailyReportView(report, WED, identity);
  ok(group, !view.noData && view.serverSnapshot !== undefined, "the day is not 'no data' — it is a server-recorded day");
  ok(group, view.newToday.map((t) => t.key).join() === "SR-3" && view.mentionsAwaitingReply.map((t) => t.key).join() === "SR-4" && view.doneMine.map((t) => t.key).join() === "SR-2" && (view.openAssigned ?? []).map((t) => t.key).join() === "SR-1,SR-3", "the Daily Report view lists the Jira-derived sections");
  const md = renderDailyReport(view, "markdown");
  ok(group, /## Done \(1\)\n- \[SR-2\]/.test(md) && /## New today \(1\)\n- \[SR-3\]/.test(md) && /## Mentions awaiting my reply \(1\)\n- \[SR-4\]/.test(md) && /## Open assigned \(from Jira\) \(2\)/.test(md), "the exported report lists them under Done / New today / Mentions / Open assigned");
  ok(group, /Recorded by the server while the app was closed/.test(md), "and says the day was recorded by the server");
  ok(group, mergeServerDailyReports(client.getSnapshot().dailyReports, written.reports) === client.getSnapshot().dailyReports, "pulling the same snapshots again changes nothing (same object, no write)");
}

// ----- Client data wins for in-app sections -----
{
  const group = "E4 Client data wins";
  const server: ServerDailyStandup = {
    date: WED,
    generatedAt: CRON_AT.toISOString(),
    newAssigned: [{ key: "SV-NEW" }],
    newMentions: [{ key: "SV-MENTION" }],
    closedInJira: [{ key: "SV-CLOSED", notes: ["closed in Jira"] }, { key: "CL-DONE", notes: ["closed in Jira"] }],
    openAssigned: [{ key: "SV-OPEN" }],
  };
  const standup = { asOf: `${WED}T17:00:00.000Z`, inProgress: [{ key: "CL-WIP" }], blocked: [], skipped: [], newToday: [{ key: "CL-NEW" }], mentionsAwaitingReply: [], openAssigned: [{ key: "CL-WIP" }] };
  const clientReport = {
    date: WED,
    generatedAt: `${WED}T17:00:00.000Z`,
    events: [{ id: "e1", date: WED, kind: "TICKET_COMPLETED" as const, title: "done", impact: "", evidence: [], ticketKey: "CL-DONE" }],
    standup,
  };
  const merged = mergeServerDailyReports({ [WED]: clientReport }, { [WED]: server });
  ok(group, merged[WED].events === clientReport.events && merged[WED].standup === standup && merged[WED].server === server, "the client's events and standup are kept; the server snapshot is added beside them");
  const view = buildDailyReportView(merged[WED], WED, identity);
  ok(group, view.newToday.map((t) => t.key).join() === "CL-NEW" && view.mentionsAwaitingReply.length === 0 && view.inProgress.map((t) => t.key).join() === "CL-WIP", "in-app sections come from the client's standup, not the server");
  ok(group, view.doneMine.map((t) => t.key).join() === "CL-DONE,SV-CLOSED", "Done = the client's completions + Jira closures the client didn't already list (no duplicate CL-DONE)");
  ok(group, (view.openAssigned ?? []).length === 0, "Open assigned from the server isn't shown when the client recorded its own standup");

  const store = new CommandCenterStore({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [], jiraSyncLockManager: null });
  store.getSnapshot();
  store.mergeServerDailyReports({ [WED]: server });
  store.generateDailyReport(WED, true);
  ok(group, store.getSnapshot().dailyReports[WED].server?.generatedAt === server.generatedAt, "regenerating that day's report keeps the server snapshot");
  const older = { ...server, generatedAt: `${WED}T05:00:00.000Z`, newAssigned: [] };
  store.mergeServerDailyReports({ [WED]: older });
  ok(group, store.getSnapshot().dailyReports[WED].server?.newAssigned.length === 1, "an older server snapshot never replaces a newer one");
}

// ----- Days with neither client nor server snapshot: "No data recorded" -----
{
  const group = "E4 No data recorded";
  const view = buildDailyReportView(undefined, "2026-10-05", identity);
  ok(group, view.noData === true, "no client report and no server snapshot → noData");
  for (const format of ["markdown", "slack", "text"] as const) {
    const out = renderDailyReport(view, format);
    ok(group, out.includes(NO_DATA_RECORDED) && !/Done \(0\)|None\./.test(out), `${format}: says "No data recorded" instead of empty sections`);
  }
  ok(group, buildDailyReportView({ date: "2026-10-05", generatedAt: "2026-10-05T18:00:00.000Z", events: [] }, "2026-10-05", identity).noData === false, "a day the app did record (even with no events) is not 'no data'");
  const page = fs.readFileSync(path.join(process.cwd(), "src/app/reports/page.tsx"), "utf8");
  ok(group, /v\.noData \?/.test(page) && /No data recorded for \{date\}/.test(page), "the Reports page shows 'No data recorded' for such a day");
}

// ----- Robustness: weekends, failures, cold start, repeated runs -----
{
  const group = "E4 Server snapshot rules";
  const sat = await runServerDailySnapshot(wednesdayJira().fetchImpl, config, ME, createInMemoryServerReportStore(structuredClone(tuesdayBaseline)), { now: new Date("2026-10-10T06:00:00.000Z") });
  ok(group, sat.skipped === "weekend" && !sat.written, "weekends are skipped (Monday's diff covers them)");
  ok(group, localDateFor(new Date("2026-10-06T20:00:00.000Z"), 420) === WED && localDateFor(new Date("2026-10-06T20:00:00.000Z")) === "2026-10-06", "the day is the user's local date (JIRA_TIMEZONE_OFFSET_MINUTES), not UTC's");

  const failing = createInMemoryServerReportStore(structuredClone(tuesdayBaseline));
  const fail = await runServerDailySnapshot(fakeJira({ assigned: [], mentioned: [], comments: {}, failAssigned: true }).fetchImpl, config, ME, failing, { now: CRON_AT });
  ok(group, !fail.written && !!fail.error && JSON.stringify(await failing.get()) === JSON.stringify(tuesdayBaseline), "a Jira failure writes nothing (baseline and reports untouched)");

  const cold = createInMemoryServerReportStore(null);
  await runServerDailySnapshot(wednesdayJira().fetchImpl, config, ME, cold, { now: CRON_AT });
  const c = (await cold.get())!.reports[WED];
  ok(group, c.coldStart === true && c.newAssigned.length === 0 && c.closedInJira.length === 0 && c.openAssigned.length === 2, "first-ever run: no guessed 'new'/'closed', open work listed, flagged coldStart");
  ok(group, c.newMentions.map((t) => t.key).join() === "SR-4", "…mentions dated that day still count");

  const twice = createInMemoryServerReportStore(structuredClone(tuesdayBaseline));
  await runServerDailySnapshot(wednesdayJira().fetchImpl, config, ME, twice, { now: CRON_AT });
  await runServerDailySnapshot(wednesdayJira().fetchImpl, config, ME, twice, { now: new Date(`${WED}T09:00:00.000Z`) });
  const t = (await twice.get())!.reports[WED];
  ok(group, t.newAssigned.map((x) => x.key).join() === "SR-3" && t.closedInJira.map((x) => x.key).join() === "SR-2" && t.newMentions.length === 1, "a second run the same day keeps what the first found (no loss, no duplicates)");

  ok(group, isServerDailyReportConfigured({ KV_REST_API_URL: "u", KV_REST_API_TOKEN: "t", APP_STATE_SECRET: "s", PERSONAL_JIRA_ACCOUNT_ID: "a" }), "configured with KV + APP_STATE_SECRET + PERSONAL_JIRA_ACCOUNT_ID");
  ok(group, ["KV_REST_API_URL", "KV_REST_API_TOKEN", "APP_STATE_SECRET", "PERSONAL_JIRA_ACCOUNT_ID"].every((k) => !isServerDailyReportConfigured({ KV_REST_API_URL: "u", KV_REST_API_TOKEN: "t", APP_STATE_SECRET: "s", PERSONAL_JIRA_ACCOUNT_ID: "a", [k]: undefined })), "any one missing → off (the cron does exactly what it did before)");
}

// ----- Wiring (route sources import server-only code, so they're checked as text) -----
{
  const group = "E4 Wiring";
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
  const sync = read("src/app/api/command-center/jira/sync/route.ts");
  ok(group, /snapshot: isServerDailyReportConfigured\(process\.env\)\s*\? \{ store: createServerReportStore\(\)/.test(sync) && /runServerDailySnapshot\(fetchImpl, config, accountId, store, options\)/.test(read("src/lib/command-center/jira/cron-tick.ts")), "the cron GET runs the real snapshot with the KV store, gated on configuration");
  const route = read("src/app/api/command-center/reports/server/route.ts");
  ok(group, /checkAppStateAuth\(req\.headers\.get\("authorization"\), process\.env\.APP_STATE_SECRET\)/.test(route) && /force-dynamic/.test(route), "GET /api/command-center/reports/server uses the paired-device auth and is never statically cached");
  const sync2 = read("src/lib/command-center/app-state-sync.ts");
  ok(group, /if \(!isDevicePaired\(\)\) return;\s*\/\/[^\n]*\n[^\n]*\n\s*void pullServerDailyReports\(store\);/.test(sync2), "a paired client pulls server snapshots on load");
  ok(group, !/server-daily-report"/.test(read("src/lib/command-center/store.ts")), "the browser store imports only the small merge module, not the cron/Jira fetch code");
}
