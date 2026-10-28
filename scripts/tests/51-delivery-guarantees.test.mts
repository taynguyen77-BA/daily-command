// C1 — delivery guarantees (bounded retries, flood guard, smart path) and timezone-correct JQL cursors.
// Complements the seed 50-delivery-and-cursor (R1/R2): that proves the basics, this proves the edges.

import { runServerSideNotifyCheck } from "../../src/lib/command-center/cron-notify";
import { createInMemoryNotifyStore } from "../../src/lib/command-center/notify-state";
import { createInMemoryNotifyPrefsStore, DEFAULT_NOTIFY_PREFS } from "../../src/lib/command-center/notify-prefs";
import { createInMemoryDigestStore } from "../../src/lib/command-center/notify-digest";
import { buildHeartbeat } from "../../src/lib/command-center/health";
import { applyDeliveryOutcomes, MAX_DELIVERY_ATTEMPT_ENTRIES } from "../../src/lib/command-center/notify-delivery";
import { formatJqlSince, isValidTimeZone, zoneOffsetMinutesAt, type FetchLike } from "../../src/lib/command-center/jira/http";
import type { JiraConnectionConfig } from "../../src/lib/command-center/jira/types";
import { ok } from "./harness.mts";

const cfg: JiraConnectionConfig = { baseUrl: "https://example.atlassian.net", email: "a@b.com", apiToken: "tok" };
const ME = "acc-me";
const mention = (id: string) => ({
  id, created: "2026-10-27T10:00:00.000Z", author: { accountId: "other", displayName: "Alice" },
  body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: ME } }, { type: "text", text: ` please look ${id}` }] }] },
});

function world(myTimeZone?: string) {
  const state = { mentioned: [] as string[], assigned: [] as string[], comments: {} as Record<string, unknown[]>, slackUp: true, posts: [] as string[], jqls: [] as string[], myselfCalls: 0 };
  const fetchImpl: FetchLike = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/myself")) { state.myselfCalls++; return { ok: true, status: 200, json: async () => ({ accountId: ME, ...(myTimeZone ? { timeZone: myTimeZone } : {}) }) }; }
    if (u.pathname.endsWith("/search/jql")) {
      const jql = String(JSON.parse(init?.body ?? "{}").jql);
      state.jqls.push(jql);
      const keys = jql.startsWith("assignee") ? state.assigned : state.mentioned;
      return { ok: true, status: 200, json: async () => ({ issues: keys.map((key) => ({ key, fields: { summary: key, assignee: { accountId: ME } } })), isLast: true }) };
    }
    const m = u.pathname.match(/issue\/([^/]+)\/comment/);
    if (m) { const list = state.comments[decodeURIComponent(m[1])] ?? []; return { ok: true, status: 200, json: async () => ({ comments: list, total: list.length }) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const slack = (async (_u: string, init: { body: string }) => {
    if (!state.slackUp) return { ok: false, status: 500, text: async () => "down" };
    state.posts.push(init.body);
    return { ok: true, status: 200, text: async () => "" };
  }) as never;
  return { state, fetchImpl, slack };
}

const prev = process.env.SLACK_WEBHOOK_URL;
process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.example/test";
try {
  {
    const group = "C1 bounded retries";
    const w = world();
    const store = createInMemoryNotifyStore(null);
    const run = (opts = {}) => runServerSideNotifyCheck(w.fetchImpl, cfg, ME, store, w.slack, { learnTimeZone: false, ...opts });
    await run();
    w.state.comments["AB-1"] = [mention("c1")]; w.state.mentioned = ["AB-1"]; w.state.slackUp = false;
    let last = await run();
    ok(group, last.undelivered === 1 && !!last.lastSlackError && !!last.undeliveredSince, "a failed post is counted as undelivered with the Slack error and the streak start");
    const s1 = await store.get();
    ok(group, s1?.retryIssueKeys?.includes("AB-1") === true && s1.notifiedCommentIds.length === 0 && s1.deliveryAttempts?.[0]?.n === 1, "the issue is queued for re-fetch, the comment id is NOT in the baseline, one attempt recorded");
    w.state.mentioned = [];
    for (let i = 0; i < 4; i++) last = await run(); // attempts 2..5
    ok(group, last.undelivered === 1 && !last.droppedUndelivered, "after 5 failed attempts it is still pending");
    last = await run(); // 6th failure
    ok(group, last.droppedUndelivered === 1 && !last.undelivered, `the 6th failed attempt is dropped and counted (dropped=${last.droppedUndelivered})`);
    const s2 = await store.get();
    ok(group, s2?.notifiedCommentIds.includes((s2.notifiedCommentIds[0])) === true && s2.notifiedCommentIds.length === 1 && !s2.retryIssueKeys?.includes("AB-1") && !s2.deliveryAttempts, "a dropped signal enters the baseline and its counter is cleared");
    w.state.slackUp = true;
    const after = await run();
    ok(group, after.notified === 0 && w.state.posts.length === 0, "a dropped signal is never announced later");
  }

  {
    const group = "C1 recovery flood guard";
    const w = world();
    const store = createInMemoryNotifyStore(null);
    const run = () => runServerSideNotifyCheck(w.fetchImpl, cfg, ME, store, w.slack, { learnTimeZone: false });
    await run();
    const keys = Array.from({ length: 30 }, (_, i) => `ZZ-${i + 1}`);
    for (const k of keys) w.state.comments[k] = [mention(`c-${k}`)];
    w.state.mentioned = keys; w.state.slackUp = false;
    await run();
    w.state.slackUp = true; w.state.mentioned = [];
    const r1 = await run();
    const msgs1 = w.state.posts.length;
    ok(group, r1.notified === 10 && msgs1 === 11, `30 queued signals: 10 separate messages + ONE summary (notified=${r1.notified}, messages=${msgs1})`);
    const r2 = await run();
    const r3 = await run();
    const r4 = await run();
    const texts = w.state.posts.map((b) => String(JSON.parse(b).text));
    const lines = texts.filter((t) => !t.startsWith("➕"));
    ok(group, r2.notified === 10 && r3.notified === 10 && r4.notified === 0, `it drains 10 per run (${r2.notified}, ${r3.notified}, ${r4.notified})`);
    ok(group, lines.length === 30 && new Set(lines).size === 30, `every signal is announced exactly once (${lines.length} lines, ${new Set(lines).size} distinct)`);
    ok(group, texts.filter((t) => t.startsWith("➕")).length === 2, "one summary line per run that still had signals waiting");
  }

  {
    const group = "C1 idempotent tick";
    const w = world();
    const store = createInMemoryNotifyStore(null);
    const run = () => runServerSideNotifyCheck(w.fetchImpl, cfg, ME, store, w.slack, { learnTimeZone: false });
    await run();
    w.state.assigned = ["AB-9"]; w.state.comments["AB-2"] = [mention("c2")]; w.state.mentioned = ["AB-2"];
    const a = await run();
    const b = await run();
    ok(group, a.notified === 2 && b.notified === 0 && w.state.posts.length === 2, "the same tick twice with Slack up never duplicates");
  }

  {
    const group = "C1 smart path postmortem";
    const w = world();
    const store = createInMemoryNotifyStore(null);
    const digestStore = createInMemoryDigestStore();
    const smart = { prefsStore: createInMemoryNotifyPrefsStore({ ...DEFAULT_NOTIFY_PREFS, mutedProjects: ["NOPE"] }), digestStore };
    const run = () => runServerSideNotifyCheck(w.fetchImpl, cfg, ME, store, w.slack, { smart, learnTimeZone: false });
    await run();
    w.state.comments["AB-3"] = [mention("c3")]; w.state.mentioned = ["AB-3"]; w.state.slackUp = false;
    const down = await run();
    ok(group, down.notified === 0 && (await digestStore.get()).items.length === 1, "non-default prefs + Slack down: the item stays in the digest queue");
    w.state.slackUp = true; w.state.mentioned = [];
    const up = await run();
    const again = await run();
    ok(group, up.notified === 1 && again.notified === 0 && w.state.posts.length === 1 && (await digestStore.get()).items.length === 0, "it is delivered later exactly once and the queue is empty");
  }

  {
    const group = "C1 heartbeat and old blobs";
    const hb = buildHeartbeat({ startedAt: 0, finishedAt: 1000, notified: 0, warnings: [], previous: null, slack: { undelivered: 2, droppedUndelivered: 0, lastSlackError: "Slack responded 500", undeliveredSince: "2026-10-28T01:00:00.000Z" } });
    ok(group, hb.undelivered === 2 && hb.lastSlackError === "Slack responded 500" && hb.undeliveredSince === "2026-10-28T01:00:00.000Z", "the heartbeat carries { undelivered, lastSlackError, undeliveredSince }");
    const clean = buildHeartbeat({ startedAt: 0, finishedAt: 1000, notified: 1, warnings: [], previous: null, slack: { undelivered: 0, droppedUndelivered: 0 } });
    ok(group, !("undelivered" in clean), "a clean run adds no Slack fields (old readers unchanged)");
    const w = world();
    const store = createInMemoryNotifyStore({ assignedIssueKeys: [], notifiedCommentIds: ["x"], lastCheckedAtIso: "2026-10-27T00:00:00.000Z" }); // a pre-C1 blob
    const r = await runServerSideNotifyCheck(w.fetchImpl, cfg, ME, store, w.slack, { learnTimeZone: false });
    ok(group, !r.error && r.notified === 0 && r.undelivered === undefined, "a blob without deliveryAttempts / zone fields still loads");
    const many = applyDeliveryOutcomes(undefined, Array.from({ length: 150 }, (_, i) => ({ id: `M:${i}`, status: "failed" as const })));
    ok(group, many.attempts.length === MAX_DELIVERY_ATTEMPT_ENTRIES && many.attempts[MAX_DELIVERY_ATTEMPT_ENTRIES - 1].id === "M:149", "attempt counters are capped at 100, newest kept");
  }

  {
    const group = "C1 zone learned from /myself";
    const w = world("America/New_York");
    const store = createInMemoryNotifyStore(null);
    await runServerSideNotifyCheck(w.fetchImpl, cfg, ME, store, w.slack, { now: new Date("2026-10-28T01:00:00.000Z") });
    ok(group, (await store.get())?.jiraTimeZone === "America/New_York" && w.state.myselfCalls === 1, "cold start learns and caches the zone");
    await runServerSideNotifyCheck(w.fetchImpl, cfg, ME, store, w.slack, { now: new Date("2026-10-28T02:00:00.000Z") });
    ok(group, w.state.myselfCalls === 1, "it is cached (no /myself on the next run)");
    const m = w.state.jqls.filter((q) => q.includes("comment ~")).pop() ?? "";
    ok(group, m.includes('updated >= "2026-10-27 20:55"'), `the cached zone drives the cursor: 01:00Z -> 21:00 EDT minus 5 min (${m})`);
    await runServerSideNotifyCheck(w.fetchImpl, cfg, ME, store, w.slack, { now: new Date("2026-11-05T00:00:00.000Z") });
    ok(group, w.state.myselfCalls === 2, "it is re-checked after a week");
    const w2 = world("America/New_York");
    const store2 = createInMemoryNotifyStore(null);
    await runServerSideNotifyCheck(w2.fetchImpl, cfg, ME, store2, w2.slack, { timeZone: "Asia/Ho_Chi_Minh" });
    ok(group, w2.state.myselfCalls === 0, "an explicit zone (env / member profile) wins: no lookup");
  }
} finally {
  if (prev === undefined) delete process.env.SLACK_WEBHOOK_URL; else process.env.SLACK_WEBHOOK_URL = prev;
}

{
  const group = "C1 formatJqlSince table";
  const cases: [string, string | undefined, number | undefined, string | undefined, string][] = [
    // [label, iso, offset, zone, expected]
    ["New York, before fall-back (EDT, UTC-4)", "2026-11-01T04:00:00.000Z", undefined, "America/New_York", "2026-10-31 23:55"],
    ["New York, after fall-back (EST, UTC-5)", "2026-11-01T07:00:00.000Z", undefined, "America/New_York", "2026-11-01 01:55"],
    ["New York, before spring-forward (EST)", "2026-03-08T06:00:00.000Z", undefined, "America/New_York", "2026-03-08 00:55"],
    ["New York, after spring-forward (EDT)", "2026-03-08T08:00:00.000Z", undefined, "America/New_York", "2026-03-08 03:55"],
    ["Ho Chi Minh (UTC+7, no DST)", "2026-10-27T10:15:33.123Z", undefined, "Asia/Ho_Chi_Minh", "2026-10-27 17:10"],
    ["UTC", "2026-10-27T10:15:33.123Z", undefined, "UTC", "2026-10-27 10:10"],
    ["zone wins over a (DST-blind) fixed offset", "2026-07-01T12:00:00.000Z", -300, "America/New_York", "2026-07-01 07:55"],
    ["fixed offset when no zone", "2026-10-27T10:15:33.123Z", 420, undefined, "2026-10-27 17:10"],
    ["invalid zone falls through to the offset", "2026-10-27T10:15:33.123Z", 420, "Not/AZone", "2026-10-27 17:10"],
    ["no zone, no offset: UTC date minus one day", "2026-10-27T10:15:33.123Z", undefined, undefined, "2026-10-26"],
  ];
  for (const [label, iso, off, zone, want] of cases) {
    const got = formatJqlSince(iso, off, zone);
    ok(group, got === want, `${label}: ${got} (want ${want})`);
  }
  ok(group, isValidTimeZone("America/New_York") && !isValidTimeZone("Not/AZone") && !isValidTimeZone("") && !isValidTimeZone(5), "isValidTimeZone");
  ok(group, zoneOffsetMinutesAt("America/New_York", Date.UTC(2026, 6, 1)) === -240 && zoneOffsetMinutesAt("America/New_York", Date.UTC(2026, 0, 1)) === -300, "the same zone has different offsets in summer and winter");

  // The fallback is never later than the local day for any zone >= UTC-12 (check every half hour across a day).
  let worst = "";
  for (let off = -12 * 60; off <= 14 * 60; off += 30) {
    for (let h = 0; h < 24 * 2; h++) {
      const iso = new Date(Date.UTC(2026, 9, 28, 0, 0) + h * 30 * 60_000).toISOString();
      const local = new Date(new Date(iso).getTime() + off * 60_000).toISOString().slice(0, 10);
      const f = formatJqlSince(iso) ?? "";
      if (f > local) worst = `${iso} @${off}: cursor ${f} > local ${local}`;
    }
  }
  ok(group, worst === "", `fallback never later than the local day for any UTC-12..UTC+14 zone ${worst}`);
}

{
  const group = "C1 surfaces";
  const { buildHealthResponse } = await import("../../src/lib/command-center/health-response");
  const { selectServerCheck } = await import("../../src/lib/command-center/health-client");
  const { computeSetupHealthRows } = await import("../../src/components/command-center/SetupHealthBanner");
  const { describeTimeZoneInUse, resolveTimeZoneInUse } = await import("../../src/lib/command-center/time-zone-source");
  const now = new Date("2026-10-28T02:00:00.000Z");
  const hb = { lastRunAt: "2026-10-28T01:55:00.000Z", lastOkAt: "2026-10-28T01:55:00.000Z", durationMs: 10, notified: 0, warnings: [], undelivered: 3, lastSlackError: "Slack responded 500", undeliveredSince: "2026-10-28T01:00:00.000Z" };
  const res = buildHealthResponse({ version: "x", kvConfigured: true, kvReachable: true, jiraConfigured: true, slackConfigured: true, aiAvailable: false, heartbeat: hb, expectedMinutes: 20, now, schedule: { cronHoursUtc: [11], snapshotHourLocal: 17 } });
  const check = selectServerCheck(res);
  ok(group, res.cron.slack?.undelivered === 3 && !!check && check.tone === "amber" && check.tooltip.startsWith("Slack delivery failing since 2026-10-28 01:00 UTC"), `the chip tooltip says Slack delivery is failing since the streak began (${check?.tooltip.slice(0, 70)})`);
  const clean = selectServerCheck(buildHealthResponse({ version: "x", kvConfigured: true, kvReachable: true, jiraConfigured: true, slackConfigured: true, aiAvailable: false, heartbeat: { ...hb, undelivered: undefined, lastSlackError: undefined, undeliveredSince: undefined }, expectedMinutes: 20, now, schedule: { cronHoursUtc: [11], snapshotHourLocal: 17 } }));
  ok(group, clean?.tone === "green" && !clean.tooltip.includes("Slack delivery"), "no Slack failure -> unchanged chip");
  const rows = computeSetupHealthRows({ jiraAccountId: "", slackUserId: "" } as never, "DEMO" as never, { workItems: [] } as never, {} as never, null, { serverCheck: check ?? undefined });
  ok(group, rows.some((r) => r.id === "slack-delivery" && r.text.includes("Slack delivery failing")), "Setup Health shows a Slack delivery row while undelivered > 0");
  const tz = resolveTimeZoneInUse({ learnedZone: "Asia/Ho_Chi_Minh", envOffsetMinutes: 60 });
  ok(group, tz.source === "jira" && describeTimeZoneInUse(tz).includes("Asia/Ho_Chi_Minh") && describeTimeZoneInUse(tz).includes("learned from Jira"), "Setup Health names the zone in use and where it came from");
  ok(group, resolveTimeZoneInUse({ envZone: "UTC", learnedZone: "Asia/Tokyo" }).source === "JIRA_TIMEZONE" && resolveTimeZoneInUse({ envOffsetMinutes: 420 }).source === "JIRA_TIMEZONE_OFFSET_MINUTES" && resolveTimeZoneInUse({}).source === "fallback", "resolution order: env zone > member > learned > offset > fallback");
}
