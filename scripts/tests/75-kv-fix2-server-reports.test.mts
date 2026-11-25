// V2.53 fix 2 — server-reports split into per-day keys: legacy single blob stays readable, migrates lazily on the
// first write, the cron writes only today's day (+ the small baseline), GET can ask `?since=`.
import fs from "node:fs";
import { ok } from "./harness.mts";
import { strictJiraFake } from "./helpers.mts";
import { createInMemoryKv } from "../../src/lib/command-center/kv/kv.ts";
import { SERVER_REPORTS_KEY, createKvServerReportStore } from "../../src/lib/command-center/kv/kv-stores.ts";
import { withKvMetrics, aggregateKvMetrics } from "../../src/lib/command-center/kv/kv-metrics.ts";
import { runServerDailySnapshot, MAX_SERVER_REPORT_DAYS, type ServerReportState } from "../../src/lib/command-center/server-daily-report.ts";
import { scopedKey } from "../../src/lib/command-center/auth/auth-config.ts";

const G = "kv-fix2";
const ticket = (n: number) => ({ key: `P-${n}`, url: `https://x/browse/P-${n}`, title: "t".repeat(120) });
const day = (date: string, n = 30) => ({ date, generatedAt: `${date}T18:00:00.000Z`, newAssigned: [], newMentions: [], closedInJira: [], openAssigned: Array.from({ length: n }, (_, i) => ticket(i)) });
const dates = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10)); // 2026-09-01 ..
const baseline = { assignedOpenKeys: ["P-1"], assignedAllKeys: ["P-1"], seenMentionCommentIds: ["c1"], lastRunIso: "2026-10-06T18:00:00.000Z" };
const legacyState = (n: number): ServerReportState => ({ baseline, reports: Object.fromEntries(dates(n).map((d) => [d, day(d)])) as never });

// ---- legacy blob is read as before
{
  const kv = createInMemoryKv();
  await kv.set(SERVER_REPORTS_KEY, legacyState(5));
  const store = createKvServerReportStore(kv);
  const s = await store.get();
  ok(G, !!s && Object.keys(s.reports).length === 5 && s.baseline?.lastRunIso === baseline.lastRunIso, "a legacy single blob still reads (get)");
  const since = await store.getSince!("2026-09-04");
  ok(G, Object.keys(since).sort().join() === "2026-09-04,2026-09-05", "getSince on a legacy blob returns days >= since");
  ok(G, kv.keys().includes(SERVER_REPORTS_KEY), "reads never migrate (the legacy key is untouched)");
  ok(G, (await createKvServerReportStore(createInMemoryKv()).get()) === null, "nothing stored -> null, as before");
}

// ---- first write migrates lazily, losslessly, and deletes the legacy blob
{
  const kv = createInMemoryKv();
  await kv.set(SERVER_REPORTS_KEY, legacyState(5));
  const store = createKvServerReportStore(kv);
  await store.putDay!("2026-09-06", day("2026-09-06", 3) as never);
  ok(G, !kv.keys().includes(SERVER_REPORTS_KEY), "the legacy blob is deleted after fan-out");
  const s = (await store.get())!;
  ok(G, Object.keys(s.reports).length === 6 && s.baseline?.lastRunIso === baseline.lastRunIso, "all 5 legacy days + the new one survive the migration, baseline too");
  ok(G, JSON.stringify(s.reports["2026-09-03"]) === JSON.stringify(day("2026-09-03")), "a migrated day is byte-identical");
  const since = await store.getSince!("2026-09-05");
  ok(G, Object.keys(since).sort().join() === "2026-09-05,2026-09-06", "getSince on the v2 layout");
  const again = createKvServerReportStore(kv);
  await again.putDay!("2026-09-07", day("2026-09-07", 1) as never);
  ok(G, Object.keys((await again.get())!.reports).length === 7, "a second write does not re-migrate or lose anything");
}

// ---- per-user scope is preserved
{
  const kv = createInMemoryKv();
  const A = "u_" + "a".repeat(24), B = "u_" + "b".repeat(24);
  await createKvServerReportStore(kv, A).putDay!("2026-10-07", day("2026-10-07") as never);
  ok(G, (await createKvServerReportStore(kv, B).get()) === null && Object.keys((await createKvServerReportStore(kv, A).get())!.reports).length === 1, "v2 keys are scoped per member");
  ok(G, kv.keys().some((k) => k.includes(`:u:${A}`)), "keys use scopedKey");
  void scopedKey;
}

// ---- retention
{
  const kv = createInMemoryKv();
  const store = createKvServerReportStore(kv);
  for (const d of dates(MAX_SERVER_REPORT_DAYS + 3)) await store.putDay!(d, day(d, 1) as never);
  const keys = Object.keys((await store.get())!.reports).sort();
  ok(G, keys.length === MAX_SERVER_REPORT_DAYS && keys[0] === dates(MAX_SERVER_REPORT_DAYS + 3)[3], `keeps the newest ${MAX_SERVER_REPORT_DAYS} days`);
  ok(G, kv.keys().filter((k) => k.includes("server-reports:v2:2026")).length === MAX_SERVER_REPORT_DAYS, "old day keys are really deleted");
}

// ---- a full set() (old callers) still round-trips
{
  const kv = createInMemoryKv();
  const store = createKvServerReportStore(kv);
  await store.set(legacyState(4));
  const s = (await store.get())!;
  ok(G, Object.keys(s.reports).length === 4 && s.baseline?.seenMentionCommentIds[0] === "c1", "set(full state) then get round-trips");
}

// ---- the cron snapshot writes only today (+ baseline): bytes
{
  const WED = "2026-10-07";
  const NOW = new Date(`${WED}T18:00:00.000Z`);
  const fetchImpl = strictJiraFake(async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/search/jql")) return { ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) };
    return { ok: false, status: 404, json: async () => ({}) };
  });
  const config = { baseUrl: "https://example.atlassian.net", email: "a@b.com", apiToken: "t" } as never;
  const raw = createInMemoryKv();
  await raw.set(SERVER_REPORTS_KEY, legacyState(MAX_SERVER_REPORT_DAYS));
  const legacyBytes = JSON.stringify(legacyState(MAX_SERVER_REPORT_DAYS)).length;
  const lines: string[] = [];
  const kv = withKvMetrics(raw, { log: (l) => lines.push(l) });
  const store = createKvServerReportStore(kv);
  await runServerDailySnapshot(fetchImpl, config, "acc-me", store, { now: NOW, timezoneOffsetMinutes: 0, snapshotHourLocal: 0 }); // migrates + writes today
  lines.length = 0;
  const NOW2 = new Date(`${WED}T18:15:00.000Z`);
  await runServerDailySnapshot(fetchImpl, config, "acc-me", store, { now: NOW2, timezoneOffsetMinutes: 0, snapshotHourLocal: 0 }); // a later tick, same day
  const rows = aggregateKvMetrics(lines);
  const total = rows.reduce((s, r) => s + r.bytesRead + r.bytesWritten, 0);
  ok(G, total < legacyBytes / 10, `a steady-state tick moves ${total} B vs ${legacyBytes} B for the old blob read+write (>10x less)`);
  const s = (await store.get())!;
  ok(G, !!s.reports[WED] && Object.keys(s.reports).length === MAX_SERVER_REPORT_DAYS, "today's report exists and the history is intact");
  ok(G, lines.every((l) => !/"op":"get","key":"daily-command:server-reports:v1/.test(l)), "no read of the legacy blob once migrated");
}

// ---- wiring (static)
const route = fs.readFileSync("src/app/api/command-center/reports/server/route.ts", "utf8");
ok(G, /since/.test(route) && /getSince/.test(route), "GET reports/server supports ?since=");
const sync = fs.readFileSync("src/lib/command-center/app-state-sync.ts", "utf8");
ok(G, /since=/.test(sync), "the client passes since when pulling server reports");
