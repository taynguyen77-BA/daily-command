// Round-2 review seeds (red-first). Place at scripts/tests/50-delivery-and-cursor.test.mts and append
// "./50-delivery-and-cursor.test.mts" to FILES in run.mts (after 49-ai-readiness).
//
// R1  A Slack outage must not swallow notifications: a mention / assignment that was NOT delivered stays "new"
//     and is announced on a later run (today the baseline advances regardless, so it is lost forever).
// R2  The day-level JQL fallback (no JIRA_TIMEZONE_OFFSET_MINUTES) must never start later than the user's local
//     day for ANY timezone west of UTC; today it uses the UTC date, which skips up to ~12h of updates.

import { runServerSideNotifyCheck } from "../../src/lib/command-center/cron-notify";
import { createInMemoryNotifyStore } from "../../src/lib/command-center/notify-state";
import { formatJqlSince, type FetchLike } from "../../src/lib/command-center/jira/http";
import type { JiraConnectionConfig } from "../../src/lib/command-center/jira/types";
import { ok } from "./harness.mts";

const cfg: JiraConnectionConfig = { baseUrl: "https://example.atlassian.net", email: "a@b.com", apiToken: "tok" };
const ME = "acc-me";
const mention = (id: string) => ({
  id, created: "2026-10-27T10:00:00.000Z", author: { accountId: "other", displayName: "Alice" },
  body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: ME } }, { type: "text", text: ` please look ${id}` }] }] },
});

function world() {
  const state = { mentioned: [] as string[], assigned: [] as string[], comments: {} as Record<string, unknown[]>, slackUp: true, posts: [] as string[] };
  const fetchImpl: FetchLike = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/search/jql")) {
      const jql = String(JSON.parse(init?.body ?? "{}").jql);
      const keys = jql.startsWith("assignee") ? state.assigned : state.mentioned;
      return { ok: true, status: 200, json: async () => ({ issues: keys.map((key) => ({ key, fields: { summary: key, assignee: { accountId: ME } } })), isLast: true }) };
    }
    const m = u.pathname.match(/issue\/([^/]+)\/comment/);
    if (m) { const list = state.comments[decodeURIComponent(m[1])] ?? []; return { ok: true, status: 200, json: async () => ({ comments: list, total: list.length }) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const slack = async (_u: string, init: { body: string }) => {
    if (!state.slackUp) return { ok: false, status: 500, text: async () => "down" };
    state.posts.push(init.body);
    return { ok: true, status: 200, text: async () => "" };
  };
  return { state, fetchImpl, slack: slack as never };
}

{
  const group = "R1 Slack outage does not lose notifications";
  const prev = process.env.SLACK_WEBHOOK_URL;
  process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.example/test";
  try {
    // --- a mention ---
    const w = world();
    const store = createInMemoryNotifyStore(null);
    await runServerSideNotifyCheck(w.fetchImpl, cfg, ME, store, w.slack); // cold start
    w.state.comments["JPMC-5"] = [mention("c5")]; w.state.mentioned = ["JPMC-5"]; w.state.slackUp = false;
    const down = await runServerSideNotifyCheck(w.fetchImpl, cfg, ME, store, w.slack);
    ok(group, down.notified === 0, "Slack down: nothing is delivered");
    w.state.slackUp = true; w.state.mentioned = []; // the ticket is NOT touched again — only the retry can find it
    const up = await runServerSideNotifyCheck(w.fetchImpl, cfg, ME, store, w.slack);
    ok(group, up.notified === 1 && w.state.posts.length === 1, `the undelivered mention is announced once Slack is back (notified=${up.notified}, posts=${w.state.posts.length})`);
    const again = await runServerSideNotifyCheck(w.fetchImpl, cfg, ME, store, w.slack);
    ok(group, again.notified === 0 && w.state.posts.length === 1, "and never twice");

    // --- an assignment ---
    const w2 = world();
    const store2 = createInMemoryNotifyStore(null);
    await runServerSideNotifyCheck(w2.fetchImpl, cfg, ME, store2, w2.slack); // cold start (nothing assigned)
    w2.state.assigned = ["JPMC-7"]; w2.state.slackUp = false;
    await runServerSideNotifyCheck(w2.fetchImpl, cfg, ME, store2, w2.slack);
    w2.state.slackUp = true;
    const up2 = await runServerSideNotifyCheck(w2.fetchImpl, cfg, ME, store2, w2.slack);
    ok(group, up2.notified === 1, `an assignment missed during an outage is announced later (notified=${up2.notified})`);

    // --- no webhook configured at all: state still advances (a webhook added later must not flood) ---
    delete process.env.SLACK_WEBHOOK_URL;
    const w3 = world();
    const store3 = createInMemoryNotifyStore(null);
    await runServerSideNotifyCheck(w3.fetchImpl, cfg, ME, store3, w3.slack);
    w3.state.comments["JPMC-8"] = [mention("c8")]; w3.state.mentioned = ["JPMC-8"];
    await runServerSideNotifyCheck(w3.fetchImpl, cfg, ME, store3, w3.slack);
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.example/test";
    w3.state.mentioned = ["JPMC-8"];
    const late = await runServerSideNotifyCheck(w3.fetchImpl, cfg, ME, store3, w3.slack);
    ok(group, late.notified === 0, "with NO webhook configured the baseline advances (a webhook added later does not flood old signals)");
  } finally {
    if (prev === undefined) delete process.env.SLACK_WEBHOOK_URL; else process.env.SLACK_WEBHOOK_URL = prev;
  }
}

{
  const group = "R2 JQL day-level fallback is timezone-safe";
  // 01:00Z on Oct 28 is 21:00 on Oct 27 in New York (UTC-4) and 17:00 on Oct 27 in Los Angeles (UTC-8).
  const since = formatJqlSince("2026-10-28T01:00:00.000Z", undefined) ?? "";
  ok(group, /^\d{4}-\d{2}-\d{2}/.test(since) && since.slice(0, 10) <= "2026-10-27", `without an offset the cursor is not later than the user's local day (got "${since}")`);
  const ny = formatJqlSince("2026-10-28T01:00:00.000Z", -240) ?? "";
  ok(group, ny.startsWith("2026-10-27 20:"), `with an explicit offset the cursor is local time minus the safety buffer (got "${ny}")`);
}
