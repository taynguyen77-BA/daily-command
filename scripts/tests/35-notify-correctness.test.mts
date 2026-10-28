// P1 — notify correctness (red-first regression tests, seeded by the upgrade review).
// Place at scripts/tests/35-notify-correctness.test.mts and append "./35-notify-correctness.test.mts"
// to FILES in scripts/tests/run.mts (AFTER 34-multi-user-auth).
//
// Bug A (confirmed by repro): cron-notify.ts overwrites `notifiedCommentIds` with only the mention
// ids found in THIS run (issues matching `updated >= lastCheckedAtIso`). A later, unrelated comment on an
// old ticket makes that ticket match again, its old mention is "new" relative to the overwritten
// baseline, and Slack re-announces it.

import { runServerSideNotifyCheck } from "../../src/lib/command-center/cron-notify";
import { createInMemoryNotifyStore } from "../../src/lib/command-center/notify-state";
import type { FetchLike } from "../../src/lib/command-center/jira/http";
import type { JiraConnectionConfig } from "../../src/lib/command-center/jira/types";
import { ok } from "./harness.mts";
import { strictJiraFake } from "./helpers.mts";

const cfg: JiraConnectionConfig = { baseUrl: "https://example.atlassian.net", email: "a@b.com", apiToken: "tok" };
const ME = "acc-me";
const mention = (id: string) => ({
  id, created: "2026-10-20T10:00:00.000Z", author: { accountId: "other", displayName: "Alice" },
  body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: ME } }, { type: "text", text: ` please review ${id}` }] }] },
});
const plain = (id: string) => ({
  id, created: "2026-10-27T09:00:00.000Z", author: { accountId: "other" },
  body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "FYI, no mention here" }] }] },
});

{
  const group = "P1 Notify: no re-announce of old mentions";
  let mentionedNow: string[] = [];
  const comments: Record<string, unknown[]> = { "JPMC-1": [mention("c1")], "JPMC-2": [] };
  const fetchImpl: FetchLike = strictJiraFake(async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/search/jql")) {
      const jql = String(JSON.parse(init?.body ?? "{}").jql);
      const issues = jql.startsWith("assignee") ? [] : mentionedNow.map((key) => ({ key, fields: { summary: key } }));
      return { ok: true, status: 200, json: async () => ({ issues, isLast: true }) };
    }
    const m = u.pathname.match(/issue\/([^/]+)\/comment/);
    if (m) return { ok: true, status: 200, json: async () => ({ comments: comments[decodeURIComponent(m[1])] ?? [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  });
  const slack: string[] = [];
  const slackFetch = async (_u: string, init: { body: string }) => { slack.push(init.body); return { ok: true, status: 200, text: async () => "" }; };
  const prevHook = process.env.SLACK_WEBHOOK_URL;
  process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.example/test";
  try {
    const store = createInMemoryNotifyStore(null);

    mentionedNow = ["JPMC-1"]; // run 1 — cold start baseline contains c1
    await runServerSideNotifyCheck(fetchImpl, cfg, ME, store, slackFetch as never);

    comments["JPMC-2"] = [mention("c2")]; // run 2 — a genuinely new mention on another ticket
    mentionedNow = ["JPMC-2"];
    slack.length = 0;
    const r2 = await runServerSideNotifyCheck(fetchImpl, cfg, ME, store, slackFetch as never);
    ok(group, r2.notified === 1, `run 2 announces exactly the new mention c2 (notified=${r2.notified})`);
    const afterRun2 = (await store.get())!.notifiedCommentIds;
    ok(group, afterRun2.includes("c1") && afterRun2.includes("c2"), `the baseline is a UNION: c1 survives a run that did not touch JPMC-1 (ids: ${afterRun2.join(",")})`);

    comments["JPMC-1"] = [mention("c1"), plain("c3")]; // run 3 — unrelated comment on the OLD ticket
    mentionedNow = ["JPMC-1"];
    slack.length = 0;
    const r3 = await runServerSideNotifyCheck(fetchImpl, cfg, ME, store, slackFetch as never);
    ok(group, r3.notified === 0 && slack.length === 0, `run 3: an unrelated comment on an old ticket announces nothing (notified=${r3.notified}, slack posts=${slack.length})`);
  } finally {
    if (prevHook === undefined) delete process.env.SLACK_WEBHOOK_URL; else process.env.SLACK_WEBHOOK_URL = prevHook;
  }
}

// Bug B (high-probability; confirm with scripts/jira-smoke.mts against a live Jira): the unattended paths
// (cron-notify.ts, server-daily-report.ts) put a raw ISO-8601 string — "2026-10-27T10:15:33.123Z" — into
// `updated >= "..."`. JQL documents only "yyyy-MM-dd", "yyyy/MM/dd", and "... HH:mm" (interpreted in the
// Jira user's timezone). The main sync route converts first (buildIncrementalSinceParam); these paths do not.
// The fake below behaves like Jira's JQL validator, which the existing fakes (they ignore the JQL) never did.
{
  const group = "P1 Notify: JQL date format";
  const fetchImpl = strictJiraFake(async (url) => {
    if (new URL(url).pathname.endsWith("/search/jql")) return { ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) };
    return { ok: true, status: 200, json: async () => ({ comments: [] }) };
  });
  const rejected = fetchImpl.rejected;
  const store = createInMemoryNotifyStore(null);
  await runServerSideNotifyCheck(fetchImpl, cfg, ME, store, (async () => ({ ok: true, status: 200, text: async () => "" })) as never); // cold start
  const second = await runServerSideNotifyCheck(fetchImpl, cfg, ME, store, (async () => ({ ok: true, status: 200, text: async () => "" })) as never);
  ok(group, rejected.length === 0, `no JQL date outside Jira's documented formats is ever sent (rejected: ${rejected.join(", ") || "none"})`);
  ok(group, second.error === undefined, `the second (steady-state) run does not fail (error: ${second.error ?? "none"})`);
}

// Bug C (code reading): a transient comment-fetch failure is swallowed by collectCurrentMentions, yet
// `lastCheckedAtIso` still advances — the issue no longer matches `updated >= lastChecked`, so that
// mention is lost forever. Expected after the fix: the failed issue key is retried on the next run.
{
  const group = "P1 Notify: transient failure is retried";
  let failComments = true;
  const comments = { "JPMC-9": [mention("c9")] } as Record<string, unknown[]>;
  let mentionedNow = ["JPMC-9"];
  const fetchImpl: FetchLike = strictJiraFake(async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/search/jql")) {
      const jql = String(JSON.parse(init?.body ?? "{}").jql);
      const issues = jql.startsWith("assignee") ? [] : mentionedNow.map((key) => ({ key, fields: { summary: key } }));
      return { ok: true, status: 200, json: async () => ({ issues, isLast: true }) };
    }
    if (/issue\/[^/]+\/comment/.test(u.pathname)) {
      if (failComments) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ comments: comments["JPMC-9"] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  const slack: string[] = [];
  const slackFetch = async (_u: string, init: { body: string }) => { slack.push(init.body); return { ok: true, status: 200, text: async () => "" }; };
  const prev = process.env.SLACK_WEBHOOK_URL;
  process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.example/test";
  try {
    const store = createInMemoryNotifyStore({ assignedIssueKeys: [], notifiedCommentIds: [], lastCheckedAtIso: "2026-10-27T08:00:00.000Z" });
    await runServerSideNotifyCheck(fetchImpl, cfg, ME, store, slackFetch as never); // comment fetch 503s
    failComments = false;
    mentionedNow = []; // Jira no longer returns JPMC-9: it has not been updated since the last check
    const r = await runServerSideNotifyCheck(fetchImpl, cfg, ME, store, slackFetch as never);
    ok(group, r.notified === 1, `the mention on the issue whose comment fetch failed is announced on a later run (notified=${r.notified})`);
  } finally {
    if (prev === undefined) delete process.env.SLACK_WEBHOOK_URL; else process.env.SLACK_WEBHOOK_URL = prev;
  }
}

// ===================== P1.1 additions (V2.41) =====================

import { buildIssuesJql, fetchAssignedIssuesWith, fetchIssueCommentsWith, fetchMentionedIssuesWith, formatJqlSince, buildIncrementalSinceParam } from "../../src/lib/command-center/jira/http";
import { buildMentionEvents, latestOwnCommentAt } from "../../src/lib/command-center/jira/mentions";
import { fifoUnion, nextRetryKeys, MAX_NOTIFIED_COMMENT_IDS, MAX_RETRY_ISSUE_KEYS } from "../../src/lib/command-center/notify-baseline";
import { createKvNotifyStore, createKvServerReportStore, type KvLike } from "../../src/lib/command-center/kv/kv-stores";
import { runServerDailySnapshot, createInMemoryServerReportStore } from "../../src/lib/command-center/server-daily-report";
import { runCronTick } from "../../src/lib/command-center/jira/cron-tick";
import { computeNewPersonalSignals } from "../../src/lib/command-center/notify";
import { buildAttentionQueue } from "../../src/lib/command-center/attention-queue";
import { computeDeliveryDrift } from "../../src/lib/command-center/delivery-drift";
import type { AttentionItemState } from "../../src/lib/command-center/types";
import { yesterdayMetrics } from "./helpers.mts";

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const noSlack = (async () => ({ ok: true, status: 200, text: async () => "" })) as never;

{
  const group = "P1.1 JQL date formatter";
  const iso = "2026-10-27T10:15:33.123Z";
  ok(group, formatJqlSince(iso, 420) === buildIncrementalSinceParam(iso, 420) && formatJqlSince(iso, 420) === "2026-10-27 17:10", `an ISO instant uses buildIncrementalSinceParam semantics (tz offset + 5-min buffer): ${formatJqlSince(iso, 420)}`);
  ok(group, formatJqlSince(iso) === "2026-10-26", "unknown zone falls back to the day-level cursor, UTC date minus one day (C1: the UTC date itself skips hours west of UTC)");
  ok(group, formatJqlSince("2026-10-27 17:10", 420) === "2026-10-27 17:10" && formatJqlSince("2026/10/27") === "2026/10/27" && formatJqlSince("2026-10-27") === "2026-10-27", "an already-formatted value passes through (never double-buffered)");
  ok(group, formatJqlSince("not a date", 0) === undefined && formatJqlSince(undefined) === undefined && formatJqlSince("") === undefined, "garbage / empty yields no clause instead of a string Jira rejects");
  ok(group, buildIssuesJql({ sinceIso: iso, timezoneOffsetMinutes: 420 }).includes('updated >= "2026-10-27 17:10"') && buildIssuesJql({ sinceIso: "2026-10-27 17:10" }).includes('updated >= "2026-10-27 17:10"'), "buildIssuesJql normalizes its sinceIso (ISO or pre-formatted)");

  const seen = strictJiraFake(async () => okJson({ issues: [], isLast: true }));
  const mentioned = await fetchMentionedIssuesWith(seen, cfg, ME, iso, undefined, 420);
  const mentionedNoTz = await fetchMentionedIssuesWith(seen, cfg, ME, iso);
  const assigned = await fetchAssignedIssuesWith(seen, cfg, ME);
  ok(group, mentioned.ok && mentionedNoTz.ok && assigned.ok && seen.rejected.length === 0, `fetchMentionedIssuesWith accepts a raw ISO string and never sends it (rejected: ${seen.rejected.join(",") || "none"})`);
  ok(group, seen.jqls[0].includes('updated >= "2026-10-27 17:10"') && seen.jqls[1].includes('updated >= "2026-10-26"'), "the tz offset is honoured when given, day-level (UTC date minus one day) otherwise");
}

{
  const group = "P1.1 Assigned query is bounded";
  const seen = strictJiraFake(async () => okJson({ issues: [], isLast: true }));
  await fetchAssignedIssuesWith(seen, cfg, ME);
  await fetchAssignedIssuesWith(seen, cfg, ME, { includeDoneChangedWithinDays: 14 });
  ok(group, seen.jqls[0].startsWith("assignee") && seen.jqls[0].includes("statusCategory != Done"), `the notify query asks for open work only (${seen.jqls[0]})`);
  ok(group, seen.jqls[1].includes("statusCategory != Done OR statusCategoryChangedDate >= -14d") && !/\d{4}-\d{2}-\d{2}/.test(seen.jqls[1]), `the daily report also gets recently-Done tickets via a relative date (${seen.jqls[1]})`);
}

{
  const group = "P1.1 Reopened ticket re-announced once";
  // Documented edge case: a ticket that leaves and re-enters the open set is "newly assigned" again.
  const issue = (key: string) => ({ key, fields: { summary: key, assignee: { accountId: ME }, status: { name: "In Progress", statusCategory: { key: "indeterminate" } } } });
  let assignedNow = [issue("JPMC-5")];
  const fetchImpl = strictJiraFake(async (url, init) => {
    if (new URL(url).pathname.endsWith("/search/jql")) {
      const jql = String(JSON.parse(init?.body ?? "{}").jql);
      return okJson({ issues: jql.startsWith("assignee") ? assignedNow : [], isLast: true });
    }
    return okJson({ comments: [] });
  });
  const store = createInMemoryNotifyStore(null);
  const run = async () => runServerSideNotifyCheck(fetchImpl, cfg, ME, store, noSlack, { webhookUrl: "https://hooks.slack.example/t" });
  await run(); // cold start
  assignedNow = []; // closed → not returned any more
  const closed = await run();
  assignedNow = [issue("JPMC-5")]; // reopened
  const reopened = await run();
  const again = await run();
  ok(group, closed.notified === 0 && reopened.notified === 1 && again.notified === 0, `closed: ${closed.notified}, reopened: ${reopened.notified}, next: ${again.notified} (0 / 1 / 0)`);
}

{
  const group = "P1.1 Retry keys";
  let failing = true;
  const comments = { "JPMC-9": [mention("c9")] } as Record<string, unknown[]>;
  const fetchImpl = strictJiraFake(async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/search/jql")) {
      const jql = String(JSON.parse(init?.body ?? "{}").jql);
      return okJson({ issues: jql.startsWith("assignee") ? [] : [{ key: "JPMC-9", fields: { summary: "x" } }], isLast: true });
    }
    if (failing) return { ok: false, status: 503, json: async () => ({}) };
    return okJson({ comments: comments["JPMC-9"] });
  });
  const slack: string[] = [];
  const slackFetch = (async (_u: string, init: { body: string }) => { slack.push(init.body); return { ok: true, status: 200, text: async () => "" }; }) as never;
  const store = createInMemoryNotifyStore({ assignedIssueKeys: [], notifiedCommentIds: [], lastCheckedAtIso: "2026-10-27T08:00:00.000Z" });
  const opts = { webhookUrl: "https://hooks.slack.example/t" };
  await runServerSideNotifyCheck(fetchImpl, cfg, ME, store, slackFetch, opts);
  const afterFail = await store.get();
  ok(group, JSON.stringify(afterFail?.retryIssueKeys) === '["JPMC-9"]' && afterFail?.lastCheckedAtIso !== "2026-10-27T08:00:00.000Z", "a failed comment fetch is remembered as a retry key while the cursor still advances");
  const still = await runServerSideNotifyCheck(fetchImpl, cfg, ME, store, slackFetch, opts);
  ok(group, still.notified === 0 && JSON.stringify((await store.get())?.retryIssueKeys) === '["JPMC-9"]', "a key is kept while its fetch keeps failing");
  failing = false;
  const rec = await runServerSideNotifyCheck(fetchImpl, cfg, ME, store, slackFetch, opts);
  const rec2 = await runServerSideNotifyCheck(fetchImpl, cfg, ME, store, slackFetch, opts);
  const final = await store.get();
  ok(group, rec.notified === 1 && rec2.notified === 0 && slack.length === 1, `announced exactly once after recovery (${rec.notified}, then ${rec2.notified}; slack posts ${slack.length})`);
  ok(group, final?.retryIssueKeys === undefined && final?.notifiedCommentIds.includes("c9") === true, "the key is dropped after a successful fetch and the id joins the baseline");

  // Caps
  const ids = Array.from({ length: 1200 }, (_, i) => `id-${i}`);
  const capped = fifoUnion(ids.slice(0, 900), ids.slice(800), MAX_NOTIFIED_COMMENT_IDS);
  ok(group, capped.length === MAX_NOTIFIED_COMMENT_IDS && capped[capped.length - 1] === "id-1199" && !capped.includes("id-0") && new Set(capped).size === capped.length, "the notified-id baseline is a de-duplicated FIFO capped at 1,000 (oldest drop first)");
  const manyFailed = Array.from({ length: 80 }, (_, i) => `K-${i}`);
  const retry = nextRetryKeys(undefined, manyFailed);
  ok(group, retry.length === MAX_RETRY_ISSUE_KEYS && retry[retry.length - 1] === "K-79", "retryIssueKeys never exceeds 50 (FIFO)");
  ok(group, nextRetryKeys(["A", "B"], ["B", "C"]).join() === "B,C", "a previously failing key that succeeded is dropped; a still-failing one is kept; new failures are added");

  // Persisted baseline stays bounded through the real run path.
  const bigStore = createInMemoryNotifyStore({ assignedIssueKeys: [], notifiedCommentIds: ids.slice(0, 1000), lastCheckedAtIso: "2026-10-27T08:00:00.000Z" });
  await runServerSideNotifyCheck(fetchImpl, cfg, ME, bigStore, slackFetch, { webhookUrl: null });
  const big = await bigStore.get();
  ok(group, big!.notifiedCommentIds.length <= MAX_NOTIFIED_COMMENT_IDS && big!.notifiedCommentIds.includes("c9"), "a run on a full baseline stays at <= 1,000 ids");
}

{
  const group = "P1.1 Old blobs and cold start";
  const mem = new Map<string, unknown>();
  const kv = { get: async (k: string) => mem.get(k) ?? null, set: async (k: string, v: unknown) => { mem.set(k, v); } } as unknown as KvLike;
  const store = createKvNotifyStore(kv);
  const oldBlob = { assignedIssueKeys: ["JPMC-1"], notifiedCommentIds: ["c1"], lastCheckedAtIso: "2026-10-26T08:00:00.000Z" };
  await store.set(oldBlob);
  const loaded = await store.get();
  ok(group, loaded !== null && loaded.notifiedCommentIds[0] === "c1" && loaded.retryIssueKeys === undefined, "an old KV blob without retryIssueKeys still validates and loads");
  await store.set({ ...oldBlob, retryIssueKeys: [1 as unknown as string] });
  ok(group, (await store.get()) === null, "a malformed retryIssueKeys is rejected like any other bad blob");
  await store.set({ ...oldBlob, retryIssueKeys: ["JPMC-2"] });
  ok(group, (await store.get())?.retryIssueKeys?.[0] === "JPMC-2", "a blob with retryIssueKeys loads");

  const slack: string[] = [];
  const slackFetch = (async (_u: string, init: { body: string }) => { slack.push(init.body); return { ok: true, status: 200, text: async () => "" }; }) as never;
  const fetchImpl = strictJiraFake(async (url, init) => {
    if (new URL(url).pathname.endsWith("/search/jql")) {
      const jql = String(JSON.parse(init?.body ?? "{}").jql);
      return okJson({ issues: jql.startsWith("assignee") ? [{ key: "JPMC-1", fields: { summary: "s", assignee: { accountId: ME } } }] : [{ key: "JPMC-1", fields: { summary: "s" } }], isLast: true });
    }
    return okJson({ comments: [mention("c1")] });
  });
  const oldStore = createInMemoryNotifyStore(oldBlob);
  const r = await runServerSideNotifyCheck(fetchImpl, cfg, ME, oldStore, slackFetch, { webhookUrl: "https://hooks.slack.example/t" });
  ok(group, !r.skippedColdStart && r.notified === 0 && slack.length === 0 && r.error === undefined, "the first run on an old blob is a normal run: no re-baseline, no flood");

  const cold = createInMemoryNotifyStore(null);
  slack.length = 0;
  const c = await runServerSideNotifyCheck(fetchImpl, cfg, ME, cold, slackFetch, { webhookUrl: "https://hooks.slack.example/t" });
  ok(group, c.skippedColdStart && c.notified === 0 && slack.length === 0 && (await cold.get())!.notifiedCommentIds.includes("c1"), "cold start sends zero Slack messages and still writes the baseline");
}

{
  const group = "P1.1 Timezone threading";
  const iso = "2026-10-27T10:15:33.123Z";
  const fetchImpl = strictJiraFake(async () => okJson({ issues: [], isLast: true }));
  const store = createInMemoryNotifyStore({ assignedIssueKeys: [], notifiedCommentIds: [], lastCheckedAtIso: iso });
  await runCronTick(fetchImpl, cfg, ME, { notifyStore: store, timezoneOffsetMinutes: 420 });
  const cursor = fetchImpl.jqls.find((j) => j.startsWith("comment"));
  ok(group, cursor?.includes('updated >= "2026-10-27 17:10"') === true, `runCronTick threads the member's timezone into the notify cursor (${cursor})`);

  const reportFetch = strictJiraFake(async () => okJson({ issues: [], isLast: true }));
  const reportStore = createInMemoryServerReportStore({ baseline: { assignedOpenKeys: [], assignedAllKeys: [], seenMentionCommentIds: [], lastRunIso: iso }, reports: {} });
  const res = await runServerDailySnapshot(reportFetch, cfg, ME, reportStore, { now: new Date("2026-10-28T11:00:00.000Z"), timezoneOffsetMinutes: 420 });
  const rcursor = reportFetch.jqls.find((j) => j.startsWith("comment"));
  ok(group, res.error === undefined && res.written && rcursor?.includes('updated >= "2026-10-27 17:10"') === true && reportFetch.rejected.length === 0, `the daily snapshot formats its cursor too (${rcursor})`);
}

{
  const group = "P1.1 Daily report retries failed comment fetches";
  let failing = true;
  const fetchImpl = strictJiraFake(async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/search/jql")) {
      const jql = String(JSON.parse(init?.body ?? "{}").jql);
      return okJson({ issues: jql.startsWith("assignee") ? [] : (failing ? [{ key: "SR-4", fields: { summary: "x" } }] : []), isLast: true });
    }
    if (failing) return { ok: false, status: 503, json: async () => ({}) };
    return okJson({ comments: [mention("d1")] });
  });
  const store = createInMemoryServerReportStore({ baseline: { assignedOpenKeys: [], assignedAllKeys: [], seenMentionCommentIds: [], lastRunIso: "2026-10-26T11:00:00.000Z" }, reports: {} });
  await runServerDailySnapshot(fetchImpl, cfg, ME, store, { now: new Date("2026-10-27T11:00:00.000Z") });
  ok(group, JSON.stringify((await store.get())?.baseline?.retryIssueKeys) === '["SR-4"]', "a failed comment fetch is remembered in the report baseline");
  failing = false;
  await runServerDailySnapshot(fetchImpl, cfg, ME, store, { now: new Date("2026-10-28T11:00:00.000Z") });
  const st = await store.get();
  ok(group, st?.reports["2026-10-28"]?.newMentions.some((m) => m.mention?.commentId === "d1") === true && st?.baseline?.retryIssueKeys === undefined, "the mention appears in the next report and the retry key is cleared");
  const kvMem = new Map<string, unknown>();
  const kvReport = createKvServerReportStore({ get: async (k: string) => kvMem.get(k) ?? null, set: async (k: string, v: unknown) => { kvMem.set(k, v); } } as unknown as KvLike);
  await kvReport.set({ baseline: { assignedOpenKeys: [], assignedAllKeys: [], seenMentionCommentIds: [], lastRunIso: "x" }, reports: {} });
  ok(group, (await kvReport.get())?.baseline?.retryIssueKeys === undefined, "an old report blob (no retryIssueKeys) still loads");
}

{
  const group = "P1.1 Long comment threads";
  const total = 130;
  // Jira semantics: orderBy=-created → newest first; startAt/maxResults page through it.
  const all = Array.from({ length: total }, (_, i) => {
    const n = i + 1; // c1 oldest … c130 newest
    return n === total ? mention(`c${n}`) : { ...plain(`c${n}`), created: `2026-10-${String(1 + Math.floor(i / 10)).padStart(2, "0")}T0${i % 10}:00:00.000Z` };
  });
  (all[total - 1] as { created: string }).created = "2026-10-27T12:00:00.000Z";
  const requests: URL[] = [];
  const fetchImpl = strictJiraFake(async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/search/jql")) {
      const jql = String(JSON.parse(init?.body ?? "{}").jql);
      return okJson({ issues: jql.startsWith("assignee") ? [] : [{ key: "JPMC-7", fields: { summary: "long" } }], isLast: true });
    }
    requests.push(u);
    const startAt = Number(u.searchParams.get("startAt") ?? 0);
    const max = Number(u.searchParams.get("maxResults") ?? 50);
    const ordered = u.searchParams.get("orderBy") === "-created" ? [...all].reverse() : all; // Jira default is oldest-first
    return okJson({ comments: ordered.slice(startAt, startAt + max), startAt, maxResults: max, total });
  });
  const res = await fetchIssueCommentsWith(fetchImpl, cfg, "JPMC-7");
  ok(group, res.ok && res.data.length === total && requests.length === 2 && requests.every((r) => r.searchParams.get("orderBy") === "-created"), `paginates a ${total}-comment thread with orderBy=-created (${requests.length} requests)`);
  const events = res.ok ? buildMentionEvents("JPMC-7", res.data, ME, { today: "2026-10-27" }) : [];
  ok(group, events.some((e) => e.commentId === "c130"), "the newest mention (comment 130) is detected");

  const slack: string[] = [];
  const slackFetch = (async (_u: string, init: { body: string }) => { slack.push(init.body); return { ok: true, status: 200, text: async () => "" }; }) as never;
  const store = createInMemoryNotifyStore({ assignedIssueKeys: [], notifiedCommentIds: [], lastCheckedAtIso: "2026-10-27T08:00:00.000Z" });
  const r = await runServerSideNotifyCheck(fetchImpl, cfg, ME, store, slackFetch, { webhookUrl: "https://hooks.slack.example/t" });
  ok(group, r.notified === 1 && slack.length === 1, `the cron announces the newest mention on a ${total}-comment thread (notified=${r.notified})`);

  // Pagination is capped at 3 pages and a failing later page fails the fetch (the caller retries).
  const endless = strictJiraFake(async (url) => { const u = new URL(url); requests.push(u); return okJson({ comments: [plain("x")], startAt: 0, maxResults: 1, total: 99999 }); });
  requests.length = 0;
  const capped = await fetchIssueCommentsWith(endless, cfg, "JPMC-7");
  ok(group, capped.ok && requests.length === 3, "at most 3 pages are fetched");
  let calls = 0;
  const flaky = strictJiraFake(async () => (++calls === 2 ? { ok: false, status: 500, json: async () => ({}) } : okJson({ comments: [plain("y")], startAt: 0, maxResults: 1, total: 500 })));
  ok(group, !(await fetchIssueCommentsWith(flaky, cfg, "JPMC-7")).ok, "a failing later page fails the whole fetch rather than returning a thread with a hole");

  // Order independence of the consumers.
  const asc = all.slice(-3);
  const desc = [...asc].reverse();
  const ownA = { id: "o1", created: "2026-10-27T13:00:00.000Z", author: { accountId: ME }, body: plain("o1").body };
  ok(group, JSON.stringify(buildMentionEvents("K-1", asc as never, ME, { today: "t" }).map((e) => e.commentId)) === JSON.stringify(buildMentionEvents("K-1", desc as never, ME, { today: "t" }).map((e) => e.commentId).reverse()), "buildMentionEvents yields the same events for either order");
  ok(group, latestOwnCommentAt([ownA, ...asc] as never, ME) === latestOwnCommentAt([...desc, ownA] as never, ME), "latestOwnCommentAt takes the maximum, so it is order-independent");
}

{
  const group = "P1.1 Browser notify path (audit)";
  // Audit result: the browser path keeps a grow-only attentionState keyed by id (buildAttentionQueue
  // spreads the prior state), so there is no overwrite pattern; and an id it already knows is never
  // re-announced. The one asymmetry — delivery is fire-and-forget, the state commits regardless of the
  // POST outcome — is documented behaviour (use-command-center.ts sendSlackNotifications), not changed.
  const baseInputs = { drift: computeDeliveryDrift([], yesterdayMetrics), releaseDrift: [], riskEscalations: [], openRisks: [], dependencyRadar: [], decisionRadar: [], ineffectiveActions: [], stakeholderAttention: [], communicationPriority: [] };
  const withMention = { ...baseInputs, mentionEvents: [{ issueKey: "JPMC-1", commentId: "c1", excerpt: "hi", mentionedAt: "2026-10-20T10:00:00.000Z" }] };
  const known: Record<string, AttentionItemState> = { "MENTION:jpmc-1:c1": { lifecycle: "ACTIVE", firstSeenDate: "2026-10-20", lastSeenDate: "2026-10-26", lastSeverity: "HIGH" } };

  const dropped = buildAttentionQueue(baseInputs, known, "2026-10-27"); // the mention is absent from this sync's queue
  ok(group, Object.keys(dropped.nextAttentionState).some((id) => id.startsWith("MENTION:")), "an id that disappears from one queue stays in the committed attention state (not overwritten away)");
  const back = buildAttentionQueue(withMention, dropped.nextAttentionState, "2026-10-28"); // …and later returns
  ok(group, back.items.length === 1 && back.items[0].lifecycle === "REOPENED", "when it returns it is REOPENED, never NEW");
  ok(group, computeNewPersonalSignals(dropped.nextAttentionState, back.items).length === 0, "so it is not announced again");
  const fresh = buildAttentionQueue({ ...withMention, mentionEvents: [{ issueKey: "JPMC-2", commentId: "c2", excerpt: "new", mentionedAt: "2026-10-28T10:00:00.000Z" }] }, known, "2026-10-28");
  ok(group, computeNewPersonalSignals(known, fresh.items).map((i) => i.id).join() === "MENTION:jpmc-2:c2", "a genuinely new mention still is announced exactly once");
  ok(group, computeNewPersonalSignals({}, fresh.items).length === 0, "cold start (no prior personal signal) announces nothing");
}
