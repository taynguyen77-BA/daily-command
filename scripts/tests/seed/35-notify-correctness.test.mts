// P1 — notify correctness (red-first regression tests, seeded by the upgrade review).
// Place at scripts/tests/35-notify-correctness.test.mts and append "./35-notify-correctness.test.mts"
// to FILES in scripts/tests/run.mts (AFTER 34-multi-user-auth).
//
// Bug A (confirmed by repro): cron-notify.ts overwrites `notifiedCommentIds` with only the mention
// ids found in THIS run (issues matching `updated >= lastCheckedAtIso`). A later, unrelated comment on an
// old ticket makes that ticket match again, its old mention is "new" relative to the overwritten
// baseline, and Slack re-announces it.

import { runServerSideNotifyCheck } from "../../../src/lib/command-center/cron-notify";
import { createInMemoryNotifyStore } from "../../../src/lib/command-center/notify-state";
import type { FetchLike } from "../../../src/lib/command-center/jira/http";
import type { JiraConnectionConfig } from "../../../src/lib/command-center/jira/types";
import { ok } from "../harness.mts";

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
  const fetchImpl: FetchLike = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/search/jql")) {
      const jql = String(JSON.parse(init?.body ?? "{}").jql);
      const issues = jql.startsWith("assignee") ? [] : mentionedNow.map((key) => ({ key, fields: { summary: key } }));
      return { ok: true, status: 200, json: async () => ({ issues, isLast: true }) };
    }
    const m = u.pathname.match(/issue\/([^/]+)\/comment/);
    if (m) return { ok: true, status: 200, json: async () => ({ comments: comments[decodeURIComponent(m[1])] ?? [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
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
  const JQL_DATE = /^\d{4}[-/]\d{2}[-/]\d{2}( \d{2}:\d{2})?$/;
  const rejected: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/search/jql")) {
      const jql = String(JSON.parse(init?.body ?? "{}").jql);
      const m = jql.match(/updated >= "([^"]*)"/);
      if (m && !JQL_DATE.test(m[1])) {
        rejected.push(m[1]);
        return { ok: false, status: 400, json: async () => ({ errorMessages: [`Date value '${m[1]}' for field 'updated' is invalid.`] }) };
      }
      return { ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) };
    }
    return { ok: true, status: 200, json: async () => ({ comments: [] }) };
  };
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
  const fetchImpl: FetchLike = async (url, init) => {
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
  };
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
