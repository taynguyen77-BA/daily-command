// P2.2 — unattended-run health: evaluateCronHealth, heartbeat, /health body, shared selector, workflow.
import fs from "node:fs";
import path from "node:path";
import { buildHeartbeat, createInMemoryHeartbeatStore, cronExpectedMinutes, describeServerCheck, evaluateCronHealth, type CronHeartbeat } from "../../src/lib/command-center/health";
import { buildHealthResponse } from "../../src/lib/command-center/health-response";
import { selectServerCheck } from "../../src/lib/command-center/health-client";
import { createKvHeartbeatStore } from "../../src/lib/command-center/kv/kv-stores";
import { createInMemoryKv } from "../../src/lib/command-center/kv/kv";
import { runCronForMembers, runCronTickWithHeartbeat, type CronMemberPlan } from "../../src/lib/command-center/jira/cron-tick";
import { createInMemoryNotifyStore } from "../../src/lib/command-center/notify-state";
import { computeSetupHealthRows } from "../../src/components/command-center/SetupHealthBanner";
import { emptyData } from "../../src/lib/command-center/types";
import { buildWorkRelevanceIndex } from "../../src/lib/command-center/jira/work-relevance";
import type { FetchLike } from "../../src/lib/command-center/jira/http";
import { ok } from "./harness.mts";
import { strictJiraFake } from "./helpers.mts";

const U1 = "u_000000000000000000000001";
const U2 = "u_000000000000000000000002";
const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const NOW = new Date("2026-10-27T12:00:00.000Z");
const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

{
  const group = "P2.2 evaluateCronHealth";
  const E = 20;
  const rows: [string, Parameters<typeof evaluateCronHealth>[0], string][] = [
    ["never run (null)", null, "NEVER"],
    ["never run (no lastRunAt)", {}, "NEVER"],
    ["fresh", { lastRunAt: minAgo(1), lastOkAt: minAgo(1) }, "OK"],
    ["exactly expected", { lastRunAt: minAgo(20), lastOkAt: minAgo(20) }, "OK"],
    ["exactly 2x (not LATE yet)", { lastRunAt: minAgo(40), lastOkAt: minAgo(40) }, "OK"],
    ["2x + 1 min", { lastRunAt: minAgo(41), lastOkAt: minAgo(41) }, "LATE"],
    ["exactly 6x (still LATE)", { lastRunAt: minAgo(120), lastOkAt: minAgo(120) }, "LATE"],
    ["6x + 1 min", { lastRunAt: minAgo(121), lastOkAt: minAgo(121) }, "STALE"],
    ["error, recent, with lastOkAt", { lastRunAt: minAgo(5), lastOkAt: minAgo(25), lastError: "Jira rejected the credentials" }, "ERROR"],
    ["error, recent, never ok", { lastRunAt: minAgo(5), lastError: "boom" }, "ERROR"],
    ["error but very old -> STALE wins", { lastRunAt: minAgo(500), lastError: "boom" }, "STALE"],
    ["garbage timestamp", { lastRunAt: "not a date" }, "NEVER"],
  ];
  for (const [name, hb, want] of rows) ok(group, evaluateCronHealth(hb, NOW, E).status === want, `${name} -> ${want} (got ${evaluateCronHealth(hb, NOW, E).status})`);
  ok(group, evaluateCronHealth({ lastRunAt: minAgo(5), lastError: "x" }, NOW).message.includes("No fully successful run") && evaluateCronHealth({ lastRunAt: minAgo(5), lastOkAt: minAgo(25), lastError: "x" }, NOW).message.includes("25 min ago"), "the ERROR message says whether there was ever a good run");
  ok(group, evaluateCronHealth({ lastRunAt: minAgo(1500) }, NOW, 1440).status === "OK" && evaluateCronHealth({ lastRunAt: minAgo(3000) }, NOW, 1440).status === "LATE", "expectedMinutes scales the thresholds (daily cron = 1440)");
  ok(group, cronExpectedMinutes({}) === 20 && cronExpectedMinutes({ CRON_EXPECTED_MINUTES: "1440" }) === 1440 && cronExpectedMinutes({ CRON_EXPECTED_MINUTES: "0" }) === 20 && cronExpectedMinutes({ CRON_EXPECTED_MINUTES: "x" }) === 20 && cronExpectedMinutes({ CRON_EXPECTED_MINUTES: "" }) === 20, "CRON_EXPECTED_MINUTES: positive number, default 20");
}

{
  const group = "P2.2 Heartbeat";
  const hb = (over: Partial<CronHeartbeat> = {}): CronHeartbeat => ({ lastRunAt: minAgo(30), lastOkAt: minAgo(30), durationMs: 10, notified: 0, warnings: [], ...over });
  const good = buildHeartbeat({ startedAt: 1000, finishedAt: 3500, notified: 2, warnings: [], previous: null });
  ok(group, good.lastOkAt === good.lastRunAt && good.lastError === undefined && good.durationMs === 2500 && good.notified === 2, "a clean run sets lastOkAt = lastRunAt");
  const bad = buildHeartbeat({ startedAt: 0, finishedAt: 10, notified: 0, warnings: Array.from({ length: 9 }, (_, i) => `w${i}`), previous: hb({ lastOkAt: "2026-10-01T00:00:00.000Z" }) });
  ok(group, bad.lastOkAt === "2026-10-01T00:00:00.000Z" && bad.lastError === "w0" && bad.warnings.length === 5, "a failed run keeps the previous lastOkAt, records lastError and at most 5 warnings");

  // success and failure through the real cron wrapper, no throw either way
  const okFetch = strictJiraFake(async (url) => new URL(url).pathname.endsWith("/search/jql") ? { ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) } : { ok: true, status: 200, json: async () => ({ comments: [] }) });
  const store = createInMemoryHeartbeatStore();
  const cfg = { baseUrl: "https://example.atlassian.net", email: "a@b.com", apiToken: "tok" };
  const notifyStore = createInMemoryNotifyStore({ assignedIssueKeys: [], notifiedCommentIds: [], lastCheckedAtIso: "2026-10-27T08:00:00.000Z" });
  let t = Date.parse("2026-10-27T12:00:00.000Z");
  const clock = () => (t += 100);
  const r1 = await runCronTickWithHeartbeat(okFetch, cfg, "acc", { notifyStore }, store, clock);
  const h1 = await store.get();
  ok(group, r1.warnings.length === 0 && h1 !== null && h1.lastError === undefined && h1.lastOkAt === h1.lastRunAt && h1.durationMs > 0, "a successful run writes a heartbeat with lastOkAt");
  const failFetch: FetchLike = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const r2 = await runCronTickWithHeartbeat(failFetch, cfg, "acc", { notifyStore }, store, clock);
  const h2 = await store.get();
  ok(group, r2.warnings.length > 0 && h2!.lastError !== undefined && h2!.lastOkAt === h1!.lastOkAt, "a failing run writes a heartbeat with lastError and keeps the previous lastOkAt");
  const throwing = { get: async () => { throw new Error("kv down"); }, set: async () => { throw new Error("kv down"); } };
  const r3 = await runCronTickWithHeartbeat(okFetch, cfg, "acc", { notifyStore }, throwing, clock);
  ok(group, r3.ok === true, "a heartbeat store failure never throws out of the run");
  const explode: FetchLike = async () => { throw new Error("socket"); };
  const r4 = await runCronTickWithHeartbeat(explode, cfg, "acc", { notifyStore }, store, clock);
  ok(group, r4.ok === true && (await store.get())!.lastError !== undefined, "even a thrown fetch yields a normal result and an error heartbeat");
  const none = await runCronTickWithHeartbeat(okFetch, cfg, "acc", { notifyStore }, undefined, clock);
  ok(group, none.ok === true, "no store (KV not configured) is a no-op");

  // KV validator + scoping
  const kv = createInMemoryKv();
  const a = createKvHeartbeatStore(kv), m = createKvHeartbeatStore(kv, U1);
  await a.set(hb());
  ok(group, (await a.get())?.durationMs === 10 && (await m.get()) === null, "KV heartbeat is per member when a uid is given and global otherwise");
  await kv.set("daily-command:cron-heartbeat:v1", { lastRunAt: 5 });
  ok(group, (await a.get()) === null, "a malformed heartbeat blob reads as nothing");

  // team mode: one heartbeat per member
  const plans: CronMemberPlan[] = [U1, U2].map((uid) => ({ uid, email: `${uid}@x.com`, config: cfg, accountId: `acc-${uid}`, webhookUrl: null, notify: true, snapshot: false }));
  const stores = new Map([[U1, createInMemoryHeartbeatStore()], [U2, createInMemoryHeartbeatStore()]]);
  await runCronForMembers(okFetch, plans, { storesFor: () => ({ notifyStore: createInMemoryNotifyStore({ assignedIssueKeys: [], notifiedCommentIds: [], lastCheckedAtIso: "2026-10-27T08:00:00.000Z" }) }), now: () => NOW, budgetMs: 10_000, heartbeatFor: (uid) => stores.get(uid) });
  ok(group, (await stores.get(U1)!.get()) !== null && (await stores.get(U2)!.get()) !== null, "team cron writes each member's own heartbeat");

  const route = read("src/app/api/command-center/jira/sync/route.ts");
  ok(group, /runCronTickWithHeartbeat\(fetch, config, accountId/.test(route) && /heartbeatFor: \(uid\) => createHeartbeatStore\(uid\)/.test(route), "the cron GET (single-user and per member) goes through the heartbeat wrapper");
}

{
  const group = "P2.2 /health body";
  const secrets = { KV_REST_API_TOKEN: "kv-token-SECRET-123", CRON_SECRET: "cron-SECRET-456", ANTHROPIC_API_KEY: "sk-ant-SECRET-789", SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T0/B0/SECRET-abc", JIRA_API_TOKEN: "jira-SECRET-def" };
  const body = buildHealthResponse({ version: "2.42.0", kvConfigured: true, kvReachable: true, jiraConfigured: true, slackConfigured: true, aiAvailable: true, heartbeat: { lastRunAt: minAgo(3), lastOkAt: minAgo(3), durationMs: 5, notified: 1, warnings: [] }, expectedMinutes: 20, now: NOW, schedule: { cronHoursUtc: [11], snapshotHourLocal: 17 } });
  const json = JSON.stringify(body);
  ok(group, Object.values(secrets).every((v) => !json.includes(v)) && !/https?:\/\//.test(json), "the serialized body contains none of the secret env values and no URL");
  ok(group, JSON.stringify(Object.keys(body).sort()) === JSON.stringify(["ai", "cron", "jira", "kv", "schedule", "slack", "version"]) && body.cron.status === "OK" && body.kv.reachable === true && body.schedule.snapshotHourLocal === 17, "shape: version, kv, jira, slack, ai, cron, schedule");
  const route = read("src/app/api/command-center/health/route.ts");
  ok(group, /requestPrincipal\(req, \{ legacyCheck: "open" \}\)/.test(route) && /principalError\(p\)/.test(route) && /force-dynamic/.test(route), "same auth gate as the other status routes (503/401 via principalError), always dynamic");
}

{
  const group = "P2.2 Chip and Setup Health agree";
  for (const status of ["OK", "LATE", "STALE", "NEVER", "ERROR"] as const) {
    const hbMap: Record<string, Parameters<typeof evaluateCronHealth>[0]> = { OK: { lastRunAt: minAgo(2) }, LATE: { lastRunAt: minAgo(60) }, STALE: { lastRunAt: minAgo(300) }, NEVER: null, ERROR: { lastRunAt: minAgo(2), lastError: "boom" } };
    const health = buildHealthResponse({ version: "x", kvConfigured: true, kvReachable: true, jiraConfigured: true, slackConfigured: false, aiAvailable: false, heartbeat: hbMap[status] ? { durationMs: 0, notified: 0, warnings: [], lastRunAt: "", ...hbMap[status] } as CronHeartbeat : null, expectedMinutes: 20, now: NOW, schedule: { cronHoursUtc: [], snapshotHourLocal: 17 } });
    const chip = selectServerCheck(health)!;
    const rows = computeSetupHealthRows(undefined, "jira", emptyData(), buildWorkRelevanceIndex({}), { configured: false }, { serverCheck: chip });
    const row = rows.find((r) => r.id === "server-check");
    const expectTone = status === "OK" ? "green" : status === "LATE" ? "amber" : "red";
    ok(group, chip.tone === expectTone && (status === "OK" ? row === undefined : row?.text === chip.tooltip), `${status}: chip tone ${chip.tone}; Setup Health ${status === "OK" ? "shows no row" : "shows the same text as the chip tooltip"}`);
  }
  ok(group, selectServerCheck(buildHealthResponse({ version: "x", kvConfigured: false, kvReachable: null, jiraConfigured: false, slackConfigured: false, aiAvailable: false, heartbeat: null, expectedMinutes: 20, now: NOW, schedule: { cronHoursUtc: [], snapshotHourLocal: 17 } })) === null && selectServerCheck(null) === null, "without KV (or while loading) there is no chip and no row");
  ok(group, describeServerCheck({ status: "STALE", message: "m" }).label === "Server check stale", "labels");
  ok(group, /<ServerCheckChip \/>/.test(read("src/components/command-center/Header.tsx")) && /selectServerCheck/.test(read("src/components/command-center/SetupHealthBanner.tsx")) && /selectServerCheck/.test(read("src/components/command-center/ServerCheckChip.tsx")), "Header and Setup Health both render through selectServerCheck");
}

{
  const group = "P2.2 Workflow and README";
  const wf = read(".github/workflows/sync.yml");
  ok(group, /-X GET "\$SYNC_URL\/api\/command-center\/jira\/sync"/.test(wf) && !/-X POST/.test(wf), "the scheduled workflow calls GET (the method that runs notify + snapshot), not POST");
  ok(group, /::warning/.test(wf) && /GITHUB_STEP_SUMMARY/.test(wf) && /exit 0/.test(wf), "missing secrets: a warning annotation and a step summary, still exit 0");
  ok(group, /actions: write/.test(wf) && /workflows\/sync\.yml\/enable/.test(wf) && /continue-on-error: true/.test(wf) && /60 days/.test(wf), "a best-effort keep-alive step re-enables the workflow; the 60-day rule is documented");
  const readme = read("README.md");
  ok(group, /### Choosing a scheduler/.test(readme) && /cron-job\.org/.test(readme) && /QStash/.test(readme) && /Vercel Pro cron/.test(readme) && /GitHub Actions/.test(readme) && /Recommendation/.test(readme), "README has the scheduler table with a recommendation");
  ok(group, JSON.stringify(JSON.parse(read("vercel.json")).crons) === JSON.stringify([{ path: "/api/command-center/jira/sync", schedule: "0 11 * * *" }]), "vercel.json is unchanged");
}
