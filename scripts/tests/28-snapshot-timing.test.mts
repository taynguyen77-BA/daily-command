// G3 — server snapshot timing: the cron runs at the end of the local workday (default 11:00 UTC =
// 18:00 UTC+7), a run before REPORT_SNAPSHOT_HOUR_LOCAL never writes the day's snapshot, and
// Setup Health warns when the scheduled run falls before 17:00 local.
// Run through scripts/tests/run.mts (npm test).

import fs from "node:fs";
import path from "node:path";
import { createInMemoryServerReportStore, localHourFor, reportSnapshotHourLocal, runServerDailySnapshot, DEFAULT_REPORT_SNAPSHOT_HOUR_LOCAL } from "../../src/lib/command-center/server-daily-report";
import { cronHoursUtc, latestSnapshotRunLocal, localHourOf } from "../../src/lib/command-center/report-schedule";
import { computeSetupHealthRows } from "../../src/components/command-center/SetupHealthBanner";
import { buildWorkRelevanceIndex } from "../../src/lib/command-center/jira/work-relevance";
import { emptyData } from "../../src/lib/command-center/types";
import type { FetchLike } from "../../src/lib/command-center/jira/http";
import { ok } from "./harness.mts";

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const ME = "acc-me";
const OFFSET = 420; // UTC+7
const config = { baseUrl: "https://acme.atlassian.net", email: "a@b.c", apiToken: "t" };
const issue = (key: string, done: boolean, resolved?: string) => ({
  key,
  fields: { summary: `Ticket ${key}`, assignee: { accountId: ME }, status: { name: done ? "Done" : "In Progress", statusCategory: { key: done ? "done" : "indeterminate" } }, project: { key: "PAY", name: "Payments" }, ...(resolved ? { resolutiondate: resolved } : {}) },
});
const jira = (assigned: unknown[]): FetchLike => async (url, init) => {
  const u = new URL(url);
  if (u.pathname.endsWith("/search/jql")) {
    const jql = String(JSON.parse(init?.body ?? "{}").jql ?? "");
    return { ok: true, status: 200, json: async () => ({ issues: jql.startsWith("assignee") ? assigned : [], isLast: true }) };
  }
  return { ok: true, status: 200, json: async () => ({ comments: [] }) };
};

// ----- Schedule -----
{
  const group = "G3 Cron schedule";
  const vercel = JSON.parse(read("vercel.json"));
  ok(group, JSON.stringify(cronHoursUtc(vercel)) === "[11]" && vercel.crons.length === 1, "one Vercel cron, at 11:00 UTC");
  ok(group, localHourOf(11, OFFSET) === 18 && localHourOf(0, OFFSET) === 7 && localHourOf(20, OFFSET) === 3 && localHourOf(2, -300) === 21, "UTC → local hour with the Jira offset (wraps around midnight both ways)");
  ok(group, latestSnapshotRunLocal([0, 11], OFFSET) === 18 && latestSnapshotRunLocal([], OFFSET) === undefined, "with a morning cron added, the latest run is the one that counts");
  ok(group, DEFAULT_REPORT_SNAPSHOT_HOUR_LOCAL === 17 && reportSnapshotHourLocal({}) === 17 && reportSnapshotHourLocal({ REPORT_SNAPSHOT_HOUR_LOCAL: "19" }) === 19 && reportSnapshotHourLocal({ REPORT_SNAPSHOT_HOUR_LOCAL: "25" }) === 17 && reportSnapshotHourLocal({ REPORT_SNAPSHOT_HOUR_LOCAL: "" }) === 17, "REPORT_SNAPSHOT_HOUR_LOCAL (0–23, default 17)");
  ok(group, localHourFor(new Date("2026-10-07T11:00:00Z"), OFFSET) === 18, "11:00 UTC is 18:00 in UTC+7");
  ok(group, /snapshotHourLocal: reportSnapshotHourLocal\(process\.env\)/.test(read("src/app/api/command-center/jira/sync/route.ts")), "the cron passes the snapshot hour to the snapshot run");
}

// ----- AC: snapshot at 18:00 local includes an afternoon Jira close -----
{
  const group = "G3 Afternoon close";
  const WED = "2026-10-07";
  // Tuesday's 18:00-local run saw PAY-9 still open.
  const tuesdayRun = { baseline: { assignedOpenKeys: ["PAY-8", "PAY-9"], assignedAllKeys: ["PAY-8", "PAY-9"], seenMentionCommentIds: [], lastRunIso: "2026-10-06T11:00:00.000Z" }, reports: {} };
  // PAY-9 is closed in Jira on Wednesday at 15:00 local (08:00 UTC).
  const afterClose = jira([issue("PAY-8", false), issue("PAY-9", true, "2026-10-07T08:00:00.000Z")]);

  const evening = createInMemoryServerReportStore(structuredClone(tuesdayRun));
  const r = await runServerDailySnapshot(afterClose, config, ME, evening, { now: new Date("2026-10-07T11:00:00.000Z"), timezoneOffsetMinutes: OFFSET, snapshotHourLocal: 17 });
  const report = (await evening.get())!.reports[WED];
  ok(group, r.written && r.date === WED, "the 18:00-local run writes Wednesday's snapshot");
  ok(group, report.closedInJira.map((t) => t.key).join() === "PAY-9", "…and it lists the ticket closed at 15:00 that afternoon");

  // The old 06:00 UTC schedule = 13:00 local: the same close would have missed the day.
  const midday = createInMemoryServerReportStore(structuredClone(tuesdayRun));
  const beforeClose = jira([issue("PAY-8", false), issue("PAY-9", false)]);
  await runServerDailySnapshot(beforeClose, config, ME, midday, { now: new Date("2026-10-07T06:00:00.000Z"), timezoneOffsetMinutes: OFFSET });
  ok(group, (await midday.get())!.reports[WED].closedInJira.length === 0, "for contrast: a 13:00-local run (the old 06:00 UTC cron) can't contain the 15:00 close");

  const morning = createInMemoryServerReportStore(structuredClone(tuesdayRun));
  const m = await runServerDailySnapshot(afterClose, config, ME, morning, { now: new Date("2026-10-07T00:00:00.000Z"), timezoneOffsetMinutes: OFFSET, snapshotHourLocal: 17 });
  ok(group, !m.written && m.skipped === "too-early" && JSON.stringify(await morning.get()) === JSON.stringify(tuesdayRun), "a 07:00-local run (e.g. an extra Morning Brief cron) writes nothing and leaves the baseline alone");
}

// ----- Setup Health -----
{
  const group = "G3 Setup Health";
  const idx = buildWorkRelevanceIndex({});
  const rows = (snapshotSchedule: { cronHoursUtc: number[]; offsetMinutes?: number; snapshotHourLocal: number }) =>
    computeSetupHealthRows({ displayName: "A", accountId: "x" } as never, "jira", emptyData(), idx, { configured: true, serverSideNotifyActive: true } as never, { snapshotSchedule }).filter((r) => r.id === "snapshot-hour");
  const early = rows({ cronHoursUtc: [6], offsetMinutes: OFFSET, snapshotHourLocal: 17 });
  ok(group, early.length === 1 && /13:00 local time \(06:00 UTC\)/.test(early[0].text) && /before 17:00/.test(early[0].text), `a 06:00 UTC cron in UTC+7 (13:00 local) → warning ("${early[0]?.text.slice(0, 90)}…")`);
  ok(group, rows({ cronHoursUtc: [11], offsetMinutes: OFFSET, snapshotHourLocal: 17 }).length === 0, "11:00 UTC in UTC+7 (18:00 local) → no warning");
  const noOffset = rows({ cronHoursUtc: [11], snapshotHourLocal: 17 });
  ok(group, noOffset.length === 1 && /JIRA_TIMEZONE_OFFSET_MINUTES not set/.test(noOffset[0].text), "no Jira offset configured → treated as UTC (11:00 local) and says so");
  ok(group, rows({ cronHoursUtc: [0, 11], offsetMinutes: OFFSET, snapshotHourLocal: 17 }).length === 0, "an extra morning cron doesn't trigger the warning when an evening run exists");
  const route = read("src/app/api/command-center/reports/schedule/route.ts");
  ok(group, /cronHoursUtc\(vercelConfig/.test(route) && /snapshotHourLocal: reportSnapshotHourLocal\(process\.env\)/.test(route), "the schedule the banner checks comes from vercel.json and the server's env");
  const readme = read("README.md");
  ok(group, /`0 11 \* \* \*`/.test(readme) && /REPORT_SNAPSHOT_HOUR_LOCAL/.test(readme), "README documents the 11:00 UTC default, how to change it, and REPORT_SNAPSHOT_HOUR_LOCAL");
}
