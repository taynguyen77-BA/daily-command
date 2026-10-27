// P2.1 — Jira HTTP resilience: bounded retry, bounded concurrency, deadline, bootstrap window.
import fs from "node:fs";
import path from "node:path";
import { buildIssuesJql, classifyHttpError, fetchIssueCommentsWith, fetchJiraIssuesWith, parseRetryAfterMs, withJiraRetry, type FetchLike } from "../../src/lib/command-center/jira/http";
import { DEFAULT_JIRA_CONCURRENCY, jiraBootstrapDays, jiraConcurrency, mapWithConcurrency } from "../../src/lib/command-center/jira/concurrency";
import { collectCurrentMentions } from "../../src/lib/command-center/cron-notify";
import type { JiraConnectionConfig } from "../../src/lib/command-center/jira/types";
import { ok } from "./harness.mts";
import { strictJiraFake } from "./helpers.mts";

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const cfg: JiraConnectionConfig = { baseUrl: "https://example.atlassian.net", email: "a@b.com", apiToken: "tok" };
const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } });

{
  const group = "P2.1 Retry wrapper";
  const sleeps: number[] = [];
  const opts = { sleep: async (ms: number) => { sleeps.push(ms); }, random: () => 0.5, now: () => 1_000_000 };

  // 429 + Retry-After: 2 -> exactly one retry after >= 2 s
  let calls = 0;
  const f1 = withJiraRetry(async () => (++calls === 1 ? res(429, {}, { "retry-after": "2" }) : res(200)), opts);
  const r1 = await f1("https://x/");
  ok(group, r1.ok && calls === 2 && sleeps.length === 1 && sleeps[0] >= 2000, `429 with Retry-After: 2 -> one retry after ${sleeps[0]} ms`);

  // 3 consecutive 503 -> 4 attempts, same error kind as before
  sleeps.length = 0; calls = 0;
  const always503: FetchLike = async () => { calls++; return res(503); };
  const wrapped = withJiraRetry(always503, opts);
  ok(group, (await wrapped("https://x/")).status === 503 && calls === 4 && sleeps.length === 3, `a persistent 503 is retried 3 times then returned (attempts ${calls})`);
  calls = 0;
  const viaApi = await fetchIssueCommentsWith(withJiraRetry(always503, opts), cfg, "A-1");
  ok(group, !viaApi.ok && viaApi.errorKind === classifyHttpError(503).errorKind, `the exposed error kind is unchanged (${!viaApi.ok ? viaApi.errorKind : "ok"})`);

  // not retried: 400/401/404, thrown network errors
  for (const st of [400, 401, 403, 404, 500]) { calls = 0; await withJiraRetry(async () => { calls++; return res(st); }, opts)("https://x/"); ok(group, calls === 1, `HTTP ${st} is not retried`); }
  let threw = 0;
  let caught = false;
  try { await withJiraRetry(async () => { threw++; throw new Error("net"); }, opts)("https://x/"); } catch { caught = true; }
  ok(group, caught && threw === 1, "a thrown network error is not retried (keeps the existing network-error classification)");

  // backoff: full jitter, exponential, capped; Retry-After capped at 10 s
  sleeps.length = 0; calls = 0;
  await withJiraRetry(async () => { calls++; return res(502); }, { ...opts, random: () => 0.999 })("https://x/");
  ok(group, sleeps.length === 3 && sleeps[0] < 300 && sleeps[1] < 600 && sleeps[2] < 1200 && sleeps[2] > sleeps[0], `full jitter below base*2^n: ${sleeps.join(", ")}`);
  sleeps.length = 0;
  await withJiraRetry(async () => res(429, {}, { "retry-after": "999" }), opts)("https://x/");
  ok(group, sleeps.every((s) => s === 10_000), "a huge Retry-After is capped at 10 s");
  ok(group, parseRetryAfterMs("2", 0) === 2000 && parseRetryAfterMs(new Date(5_000).toUTCString(), 1_000) === 4000 && parseRetryAfterMs("garbage", 0) === undefined && parseRetryAfterMs(null, 0) === undefined, "Retry-After parses seconds and HTTP-dates");

  // deadline
  sleeps.length = 0; calls = 0;
  const rd = await withJiraRetry(async () => { calls++; return res(503, {}, { "retry-after": "5" }); }, { ...opts, deadline: 1_000_000 + 3000 })("https://x/");
  ok(group, rd.status === 503 && calls === 1 && sleeps.length === 0, "no retry is started when the wait would pass the deadline");

  // wrapping twice does not multiply retries
  calls = 0;
  const twice = withJiraRetry(withJiraRetry(async () => { calls++; return res(503); }, opts), opts);
  await twice("https://x/");
  ok(group, calls === 4, "an already-wrapped fetch is not wrapped again");

  // every attempt carries its own timeout signal
  const signals: unknown[] = [];
  await withJiraRetry(async (_u, init) => { signals.push(init?.signal); return res(503); }, opts)("https://x/");
  ok(group, signals.length === 4 && signals.every((s) => s instanceof AbortSignal) && new Set(signals).size === 4, "each attempt gets a fresh AbortSignal");

  // wired into the public fetchers (default wrapper retries a 429 then succeeds); real sleep is short via Retry-After: 0
  calls = 0;
  const sync = await fetchJiraIssuesWith(async (url) => { calls++; return new URL(url).pathname.endsWith("/search/jql") && calls === 1 ? res(429, {}, { "retry-after": "0" }) : res(200, { issues: [], isLast: true }); }, cfg, {});
  ok(group, sync.ok && calls === 2, "fetchJiraIssuesWith retries a transient 429 through the shared wrapper");

  const src = read("src/lib/command-center/jira/http.ts");
  ok(group, (src.match(/await fetchImpl\(/g) ?? []).length === 1 && /return fetchJiraIssuesClassic\(http,/.test(src), "http.ts has a single raw fetchImpl call (inside the wrapper); every fetch*With uses it");
  ok(group, !/withJiraRetry/.test(read("src/lib/command-center/jira/jira-action-provider.ts")) && !/withJiraRetry/.test(read("src/app/api/command-center/jira/write/route.ts")), "the Jira write path never retries");
}

{
  const group = "P2.1 Bounded concurrency";
  let inFlight = 0, peak = 0;
  const delays = [30, 5, 20, 1, 15, 8, 2, 25, 3, 10, 4, 6];
  const run = await mapWithConcurrency(delays, 3, async (d, i) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, d)); inFlight--; return i * 10; });
  ok(group, peak <= 3 && peak > 1, `never more than the limit in flight (peak ${peak})`);
  ok(group, run.results.every((v, i) => v === i * 10) && run.skipped.length === 0 && run.failed.length === 0, "results keep input order");
  const empty = await mapWithConcurrency([], 5, async () => 1);
  ok(group, empty.results.length === 0, "an empty input is fine");
  const failing = await mapWithConcurrency([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error("x"); return n; });
  ok(group, JSON.stringify(failing.results) === "[1,null,3]" && failing.failed.join() === "1", "a throwing item is recorded as failed and does not stop the others");

  // deadline with a fake clock: each item advances the clock by 10; deadline 35 -> 4 items start (0,10,20,30), the rest are skipped
  let clock = 0;
  const dl = await mapWithConcurrency([0, 1, 2, 3, 4, 5, 6], 1, async (n) => { clock += 10; return n; }, { deadline: 35, now: () => clock });
  ok(group, dl.skipped.join() === "4,5,6" && dl.results.slice(0, 4).join() === "0,1,2,3", `items after the deadline are skipped, not started (skipped ${dl.skipped.join()})`);

  ok(group, jiraConcurrency({}) === DEFAULT_JIRA_CONCURRENCY && jiraConcurrency({ JIRA_CONCURRENCY: "8" }) === 8 && jiraConcurrency({ JIRA_CONCURRENCY: "0" }) === 5 && jiraConcurrency({ JIRA_CONCURRENCY: "11" }) === 5 && jiraConcurrency({ JIRA_CONCURRENCY: "x" }) === 5, "JIRA_CONCURRENCY accepts 1-10, default 5");

  // collectCurrentMentions honours the limit and the deadline; unstarted keys are retried later
  let live = 0, top = 0;
  const keys = Array.from({ length: 12 }, (_, i) => `K-${i}`);
  const fetchImpl: FetchLike = async () => { live++; top = Math.max(top, live); await new Promise((r) => setTimeout(r, 3)); live--; return res(200, { comments: [] }); };
  const c = await collectCurrentMentions(fetchImpl, cfg, "acc", keys, "2026-10-27", { concurrency: 4 });
  ok(group, top <= 4 && c.failedKeys.length === 0, `collectCurrentMentions never exceeds the limit (peak ${top})`);
  const late = await collectCurrentMentions(fetchImpl, cfg, "acc", keys, "2026-10-27", { concurrency: 2, deadline: 0 });
  ok(group, late.failedKeys.length === keys.length, "keys not started before the deadline are returned as failed (-> retryIssueKeys)");

  const route = read("src/app/api/command-center/jira/sync/route.ts");
  ok(group, !/Promise\.all/.test(route) && (route.match(/mapWithConcurrency\(/g) ?? []).length === 3, "the sync route has no unbounded Promise.all (changelogs, mention comments, recent candidates are bounded)");
  ok(group, /export const maxDuration = 60/.test(route) && /export const maxDuration = 60/.test(read("src/app/api/command-center/ai/route.ts")), "sync and ai routes export maxDuration = 60");
  ok(group, /partial: true/.test(route) && /SYNC_DEADLINE_MS = 50_000/.test(route) && /\{ deadline \}/.test(route), "the sync route has a 50 s deadline and reports partial");
}

{
  const group = "P2.1 Bootstrap window";
  const incremental = buildIssuesJql({ sinceIso: "2026-10-27 17:10", projectKeys: ["AB"] });
  ok(group, incremental === 'project in ("AB") AND updated >= "2026-10-27 17:10" order by updated asc', "incremental JQL is byte-identical to before");
  ok(group, buildIssuesJql({ sinceIso: "2026-10-27 17:10", bootstrapDays: 90 }) === 'updated >= "2026-10-27 17:10" order by updated asc', "bootstrapDays is ignored once there is a cursor");
  ok(group, buildIssuesJql({}) === "project is not EMPTY order by updated asc" && buildIssuesJql({ bootstrapDays: 0 }) === "project is not EMPTY order by updated asc", "no cursor, no bootstrap: today's JQL");
  ok(group, buildIssuesJql({ bootstrapDays: 90 }) === "(statusCategory != Done OR updated >= -90d) order by updated asc", "first sync gets the bootstrap clause (still bounded, still ascending)");
  ok(group, buildIssuesJql({ projectKeys: ["AB", "CD"], bootstrapDays: 30 }) === 'project in ("AB","CD") AND (statusCategory != Done OR updated >= -30d) order by updated asc', "it composes with the project scope");
  ok(group, jiraBootstrapDays({}) === 90 && jiraBootstrapDays({ JIRA_BOOTSTRAP_DAYS: "0" }) === 0 && jiraBootstrapDays({ JIRA_BOOTSTRAP_DAYS: "30" }) === 30 && jiraBootstrapDays({ JIRA_BOOTSTRAP_DAYS: "abc" }) === 90 && jiraBootstrapDays({ JIRA_BOOTSTRAP_DAYS: "" }) === 90, "JIRA_BOOTSTRAP_DAYS: default 90, 0 disables");
  const seen = strictJiraFake(async () => res(200, { issues: [], isLast: true }));
  const r = await fetchJiraIssuesWith(seen, cfg, { bootstrapDays: 90 });
  ok(group, r.ok && seen.jqls[0].includes("-90d") && seen.rejected.length === 0, "the bootstrap query is accepted by the JQL-validating fake");
  const route = read("src/app/api/command-center/jira/sync/route.ts");
  ok(group, /const bootstrapDays = jqlSinceIso \? 0 : jiraBootstrapDays\(\)/.test(route) && /Initial sync limited to open tickets/.test(route), "only a sync without a cursor uses it, and says so in a warning");
}
