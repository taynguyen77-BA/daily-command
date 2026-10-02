// G2 — server-side gate for Jira write-back: JIRA_WRITE_ENABLED, JIRA_WRITE_PROJECT_KEYS,
// JIRA_WRITE_SECRET (constant-time; never CRON_SECRET / APP_STATE_SECRET for a write), rate
// limit, append-only server log, Setup Health when the client is on but the server isn't.
// Run through scripts/tests/run.mts (npm test).

import fs from "node:fs";
import path from "node:path";
import { createInMemoryJiraWriteLog, createWriteRateLimiter, handleJiraWriteRequest, JIRA_WRITE_LOG_DETAIL_MAX, JIRA_WRITE_RATE_LIMIT, readJiraWriteConfig, type JiraWriteGateRequest } from "../../src/lib/command-center/jira/write-gate";
import { HttpJiraActionProvider } from "../../src/lib/command-center/jira/jira-action-provider";
import { computeSetupHealthRows } from "../../src/components/command-center/SetupHealthBanner";
import { buildWorkRelevanceIndex } from "../../src/lib/command-center/jira/work-relevance";
import { emptyData } from "../../src/lib/command-center/types";
import type { FetchLike } from "../../src/lib/command-center/jira/http";
import { ok } from "./harness.mts";

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const ENV = { JIRA_WRITE_ENABLED: "true", JIRA_WRITE_PROJECT_KEYS: "PAY, ops", JIRA_WRITE_SECRET: "write-s3cret", APP_STATE_SECRET: "app-s3cret", CRON_SECRET: "cron-s3cret" };

/** A gate over a fake Jira that counts every request it receives. */
function gate(env: Record<string, string | undefined> = ENV, opts: { status?: number; limit?: number } = {}) {
  const jiraCalls: { url: string; method?: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    jiraCalls.push({ url, method: init?.method });
    const status = opts.status ?? (url.endsWith("/transitions") && init?.method === "GET" ? 200 : 204);
    return { ok: status < 300, status, json: async () => (status >= 300 ? { errorMessages: ["Nope"] } : { transitions: [{ id: "31", name: "Done" }] }) };
  };
  const log = createInMemoryJiraWriteLog();
  let nowMs = Date.parse("2026-10-07T09:00:00.000Z");
  const deps = { env, provider: new HttpJiraActionProvider(fetchImpl, { baseUrl: "https://acme.atlassian.net", email: "a@b.c", apiToken: "t" }), limiter: createWriteRateLimiter(opts.limit ?? JIRA_WRITE_RATE_LIMIT), log, now: () => new Date(nowMs) };
  return { jiraCalls, log, call: (req: JiraWriteGateRequest, auth: string | null) => handleJiraWriteRequest(req, auth, deps), advance: (ms: number) => (nowMs += ms) };
}
const comment: JiraWriteGateRequest = { action: "comment", issueKey: "PAY-12", text: "Blocked: Waiting on Anna" };
const WRITES: JiraWriteGateRequest[] = [comment, { action: "flag", issueKey: "PAY-12", fieldId: "customfield_10021" }, { action: "transition", issueKey: "PAY-12", transitionId: "31" }];

// ----- Configuration -----
{
  const group = "G2 Server gate config";
  const c = readJiraWriteConfig(ENV);
  ok(group, c.enabled && c.projectKeys.join() === "PAY,OPS" && c.secretConfigured && c.missing.length === 0, "JIRA_WRITE_PROJECT_KEYS is a comma list (trimmed, upper-cased)");
  ok(group, JSON.stringify(readJiraWriteConfig({}).missing) === JSON.stringify(["JIRA_WRITE_ENABLED=true", "JIRA_WRITE_PROJECT_KEYS", "JIRA_WRITE_SECRET"]), "nothing set → all three named exactly");
  ok(group, !readJiraWriteConfig({ ...ENV, JIRA_WRITE_ENABLED: "yes" }).enabled && !readJiraWriteConfig({ ...ENV, JIRA_WRITE_ENABLED: "1" }).enabled, "only JIRA_WRITE_ENABLED=true enables (default false)");
  ok(group, JSON.stringify(readJiraWriteConfig({ ...ENV, JIRA_WRITE_PROJECT_KEYS: " , " }).missing) === JSON.stringify(["JIRA_WRITE_PROJECT_KEYS"]), "enabled without project keys → JIRA_WRITE_PROJECT_KEYS is reported missing");
}

// ----- AC: JIRA_WRITE_ENABLED unset → 503 regardless of client toggle -----
{
  const group = "G2 Disabled server";
  const g = gate({ ...ENV, JIRA_WRITE_ENABLED: undefined });
  for (const req of [...WRITES, { action: "list-transitions" as const, issueKey: "PAY-12" }]) {
    const r = await g.call(req, "Bearer write-s3cret");
    ok(group, r.status === 503 && /JIRA_WRITE_ENABLED=true/.test(String(r.body.error)), `${req.action}: 503 naming JIRA_WRITE_ENABLED, even with the right secret`);
  }
  ok(group, g.jiraCalls.length === 0 && g.log.entries.length === 0, "nothing sent to Jira");
  const noSecret = gate({ ...ENV, JIRA_WRITE_SECRET: undefined });
  ok(group, (await noSecret.call(comment, "Bearer app-s3cret")).status === 503, "enabled but no JIRA_WRITE_SECRET → 503");
}

// ----- AC: APP_STATE_SECRET or CRON_SECRET → 401 for comment/flag/transition -----
{
  const group = "G2 Write secret";
  const g = gate();
  for (const req of WRITES) {
    for (const [label, auth] of [["APP_STATE_SECRET", "Bearer app-s3cret"], ["CRON_SECRET", "Bearer cron-s3cret"], ["no header", null], ["wrong secret", "Bearer write-s3creT"], ["secret without Bearer", "write-s3cret"]] as const) {
      ok(group, (await g.call(req, auth)).status === 401, `${req.action} with ${label} → 401`);
    }
  }
  ok(group, g.jiraCalls.length === 0, "none of those reached Jira");
  ok(group, (await g.call({ action: "list-transitions", issueKey: "PAY-12" }, "Bearer app-s3cret")).status === 200 && g.jiraCalls.length === 1 && g.jiraCalls[0].method === "GET", "list-transitions (read-only) accepts the APP_STATE_SECRET pairing");
  ok(group, (await g.call({ action: "list-transitions", issueKey: "PAY-12" }, "Bearer cron-s3cret")).status === 401, "…but never CRON_SECRET");
  const src = read("src/lib/command-center/jira/write-gate.ts");
  ok(group, /bearerMatches\(authorization, writeSecret\)/.test(src) && !/CRON_SECRET/.test(src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")), "constant-time check against JIRA_WRITE_SECRET; CRON_SECRET appears nowhere in the gate's code");
}

// ----- AC: allowed secret but project not in list → 403, nothing sent to Jira -----
{
  const group = "G2 Project allow-list";
  const g = gate();
  const r = await g.call({ action: "comment", issueKey: "HR-7", text: "x" }, "Bearer write-s3cret");
  ok(group, r.status === 403 && /HR is not in this server's JIRA_WRITE_PROJECT_KEYS/.test(String(r.body.error)), "an issue outside JIRA_WRITE_PROJECT_KEYS → 403");
  ok(group, (await g.call({ action: "list-transitions", issueKey: "HR-7" }, "Bearer write-s3cret")).status === 403, "…reading its transitions too");
  ok(group, g.jiraCalls.length === 0, "nothing sent to Jira");
  ok(group, g.log.entries.length === 1 && g.log.entries[0].outcome === "forbidden" && g.log.entries[0].issueKey === "HR-7", "the refused write is in the server log");
}

// ----- AC: every successful write appears in the server log -----
{
  const group = "G2 Server log";
  const g = gate();
  for (const req of WRITES) ok(group, (await g.call(req, "Bearer write-s3cret")).status === 200, `${req.action} with JIRA_WRITE_SECRET on an allowed project → 200`);
  ok(group, g.jiraCalls.length === 3, "each reached Jira exactly once");
  const okEntries = g.log.entries.filter((e) => e.outcome === "ok");
  ok(group, okEntries.map((e) => e.action).join() === "comment,flag,transition" && okEntries.every((e) => e.issueKey === "PAY-12" && !!e.at), "every successful write is logged (time, issue key, action, outcome)");
  ok(group, okEntries[0].detail === "Blocked: Waiting on Anna" && okEntries[2].detail === "transition 31", "with what was written");
  const long = "x".repeat(500);
  await g.call({ action: "comment", issueKey: "PAY-12", text: long }, "Bearer write-s3cret");
  ok(group, g.log.entries.at(-1)!.detail!.length === JIRA_WRITE_LOG_DETAIL_MAX && !g.log.entries.at(-1)!.detail!.includes(long), "never more than 200 characters of comment text");
  const failing = gate(ENV, { status: 400 });
  const f = await failing.call(comment, "Bearer write-s3cret");
  ok(group, f.status === 502 && failing.log.entries[0].outcome === "failed" && /400: Nope/.test(failing.log.entries[0].detail ?? ""), "a Jira refusal → 502, logged as failed with Jira's message");
  const store = read("src/lib/server/jira-write-log-store.ts");
  ok(group, /kv\.rpush\(LOG_KEY/.test(store) && !/kv\.(set|lset|lrem)\(LOG_KEY/.test(store), "the KV log is append-only (rpush; trimmed to the newest entries, never edited)");
  const panel = read("src/components/command-center/JiraWriteBackPanel.tsx");
  ok(group, /data-jira-write-server-log/.test(panel) && /checkJiraWriteServerStatus/.test(panel), "Data & Settings shows the server log");
}

// ----- Rate limit -----
{
  const group = "G2 Rate limit";
  const g = gate(ENV, { limit: 3 });
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) statuses.push((await g.call(comment, "Bearer write-s3cret")).status);
  ok(group, statuses.join() === "200,200,200,429", `writes past the limit → 429 (${statuses.join()})`);
  ok(group, g.jiraCalls.length === 3 && g.log.entries.at(-1)!.outcome === "rate-limited", "the refused one never reached Jira, and is logged");
  g.advance(60 * 60 * 1000 + 1);
  ok(group, (await g.call(comment, "Bearer write-s3cret")).status === 200, "the window slides: an hour later writes go through again");
  ok(group, JIRA_WRITE_RATE_LIMIT === 30, "default: 30 writes per hour per server instance");
}

// ----- Route, client pairing, Setup Health -----
{
  const group = "G2 Wiring & Setup Health";
  const route = read("src/app/api/command-center/jira/write/route.ts");
  ok(group, /const limiter = createWriteRateLimiter\(\);/.test(route) && /log: createJiraWriteLogStore\(\)/.test(route) && /export async function GET/.test(route), "the route uses the gate, one limiter per instance, the KV log, and exposes a status GET");
  const client = read("src/lib/command-center/jira-write-client.ts");
  ok(group, /return post<\{ ok: boolean; error\?: string \}>\(req, jiraWriteAuthHeader\(\)\);/.test(client), "writes send only this device's JIRA_WRITE_SECRET pairing");
  const pairing = read("src/lib/command-center/device-pairing.ts");
  ok(group, /const JIRA_WRITE_KEY = "command-center:jira-write-secret:v1";/.test(pairing) && /window\.localStorage\.setItem\(JIRA_WRITE_KEY/.test(pairing), "paired per device, stored only in that device's localStorage, separate from the sync pairing");
  const idx = buildWorkRelevanceIndex({});
  const rows = (jiraWrite: Parameters<typeof computeSetupHealthRows>[5] extends infer E ? (E extends { jiraWrite?: infer J } ? J : never) : never) =>
    computeSetupHealthRows({ displayName: "A", accountId: "x" } as never, "jira", emptyData(), idx, { configured: true, serverSideNotifyActive: true } as never, { jiraWrite }).filter((r) => r.id.startsWith("jira-write"));
  const off = rows({ clientOn: true, server: { missing: ["JIRA_WRITE_ENABLED=true", "JIRA_WRITE_SECRET"] }, devicePaired: true });
  ok(group, off.length === 1 && /set JIRA_WRITE_ENABLED=true, JIRA_WRITE_SECRET on the server/.test(off[0].text), `client on, server off → Setup Health names the exact missing variables ("${off[0]?.text}")`);
  ok(group, /isn't paired with JIRA_WRITE_SECRET/.test(rows({ clientOn: true, server: { missing: [] }, devicePaired: false })[0]?.text ?? ""), "server ready but this device unpaired → says so");
  ok(group, rows({ clientOn: false, server: { missing: ["JIRA_WRITE_ENABLED=true"] }, devicePaired: false }).length === 0 && rows({ clientOn: true, server: null, devicePaired: false }).length === 0 && rows({ clientOn: true, server: { missing: [] }, devicePaired: true }).length === 0, "nothing when the client switch is off, the status is unknown, or everything is ready");
  const readme = read("README.md");
  ok(group, ["JIRA_WRITE_ENABLED", "JIRA_WRITE_PROJECT_KEYS", "JIRA_WRITE_SECRET"].every((v) => readme.includes(`\`${v}\``)), "README documents the three variables");
}
