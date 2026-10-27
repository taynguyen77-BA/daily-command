// P2.5 — the live Jira smoke script, exercised against a local loopback stub (no network beyond 127.0.0.1).
import http from "node:http";
import type { AddressInfo } from "node:net";
import { renderMarkdown, runSmoke, zoneOffsetMinutes, type SmokeEnv } from "../jira-smoke.mts";
import { ok } from "./harness.mts";

interface Seen { method: string; path: string; auth?: string }
const TOKEN = "tok-SUPER-SECRET-12345";
const EMAIL = "smoke@example.test";

function stub(opts: { isoAccepted?: boolean; defaultNewestFirst?: boolean; mentionVisible?: boolean; wrongAccount?: boolean; status401?: boolean } = {}) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", path: url.pathname + (url.search ? "?search" : ""), auth: req.headers.authorization });
      const send = (status: number, json: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(json)); };
      if (opts.status401) return send(401, {});
      if (url.pathname === "/rest/api/3/myself") return send(200, { accountId: opts.wrongAccount ? "someone-else" : "acc-smoke", timeZone: "Asia/Ho_Chi_Minh" }, { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "99" });
      if (url.pathname === "/rest/api/3/search/jql" && req.method === "POST") {
        const q = JSON.parse(body) as { jql: string; nextPageToken?: string; fields?: string[] };
        const m = q.jql.match(/updated >= "([^"]*)"/);
        if (m && !/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(m[1]) && !opts.isoAccepted) return send(400, { errorMessages: [`Date value '${m[1]}' for field 'updated' is invalid.`] });
        if (q.jql.startsWith("comment ~")) return send(200, { issues: opts.mentionVisible === false ? [{ key: "OTHER-1" }] : [{ key: "SMK-2" }, { key: "OTHER-1" }], isLast: true });
        const fields = Object.fromEntries((q.fields ?? []).map((f) => [f, null]));
        return send(200, { issues: [{ key: "SMK-1", fields }], ...(q.nextPageToken ? { isLast: true } : { nextPageToken: "tok2" }) });
      }
      if (/\/rest\/api\/3\/issue\/SMK-1\/comment$/.test(url.pathname)) {
        const asc = [{ created: "2026-10-01T10:00:00.000Z" }, { created: "2026-10-02T10:00:00.000Z" }, { created: "2026-10-03T10:00:00.000Z" }];
        const explicitDesc = url.searchParams.get("orderBy") === "-created";
        const list = explicitDesc || opts.defaultNewestFirst ? [...asc].reverse() : asc;
        return send(200, { comments: list });
      }
      return send(404, {});
    });
  });
  return new Promise<{ base: string; seen: Seen[]; close: () => Promise<void> }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) }))
  );
}

const envFor = (base: string, over: Partial<SmokeEnv> = {}): SmokeEnv => ({ JIRA_BASE_URL: base, JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: TOKEN, SMOKE_ACCOUNT_ID: "acc-smoke", SMOKE_ISSUE_KEY: "SMK-1", SMOKE_MENTION_ISSUE_KEY: "SMK-2", JIRA_TIMEZONE_OFFSET_MINUTES: "420", ...over });
const verdict = (r: Awaited<ReturnType<typeof runSmoke>>, id: string) => r.checks.find((c) => c.id === id)?.verdict;

{
  const group = "P2.5 Smoke script";
  const s = await stub();
  const report = await runSmoke(envFor(s.base));
  const md = renderMarkdown(report);
  const json = JSON.stringify(report);
  ok(group, ["auth", "search", "jql-date-formatted", "jql-date-iso", "tz", "comments", "mentions", "rate"].every((id) => report.checks.some((c) => c.id === id)), "every documented check runs (auth, search, JQL dates, timezone, comments, mentions, rate limits)");
  ok(group, verdict(report, "auth") === "PASS" && verdict(report, "search") === "PASS" && verdict(report, "jql-date-formatted") === "PASS" && verdict(report, "mentions") === "PASS", "a healthy instance passes auth, paging + fields, the formatted date and the mention search");
  ok(group, verdict(report, "jql-date-iso") === "PASS" && report.conclusions.F1 === "CONFIRMED", "ISO timestamp rejected with 400 -> F1 CONFIRMED");
  ok(group, verdict(report, "comments") === "PASS" && report.conclusions.F4 === "CONFIRMED", "default order oldest-first and orderBy=-created newest-first -> F4 CONFIRMED");
  ok(group, verdict(report, "tz") === "PASS", "Asia/Ho_Chi_Minh = UTC+7 = 420 min matches JIRA_TIMEZONE_OFFSET_MINUTES");
  ok(group, /x-ratelimit-limit: 100/.test(md), "rate-limit headers seen are reported");
  ok(group, s.seen.every((r) => r.method === "GET" || (r.method === "POST" && r.path === "/rest/api/3/search/jql")), `read-only: the stub saw only GET and POST /search/jql (${s.seen.map((r) => r.method).filter((v, i, a) => a.indexOf(v) === i).join("+")}, ${s.seen.length} requests)`);
  ok(group, !md.includes(TOKEN) && !json.includes(TOKEN) && !md.includes(Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")) && !json.includes(Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")) && !/Basic\s+[A-Za-z0-9+/=]{8,}/.test(md + json), "neither the token nor the Authorization header appears in stdout or the JSON report");
  ok(group, s.seen.every((r) => r.auth?.startsWith("Basic ")), "every request is authenticated (the header is sent, never printed)");
  await s.close();
}

{
  const group = "P2.5 Refuted and degraded outcomes";
  const s = await stub({ isoAccepted: true, defaultNewestFirst: true, mentionVisible: false });
  const r = await runSmoke(envFor(s.base, { JIRA_TIMEZONE_OFFSET_MINUTES: "-300" }));
  ok(group, verdict(r, "jql-date-iso") === "WARN" && r.conclusions.F1 === "REFUTED", "ISO accepted -> WARN and F1 REFUTED");
  ok(group, r.conclusions.F4 === "REFUTED", "default already newest-first -> F4 REFUTED");
  ok(group, verdict(r, "mentions") === "WARN" && verdict(r, "tz") === "WARN", "mention not returned (index lag) and a mismatching offset are WARNs, not failures");
  ok(group, !r.checks.some((c) => c.verdict === "FAIL"), "no FAIL -> exit code 0");
  await s.close();

  const s2 = await stub({ wrongAccount: true });
  const bad = await runSmoke(envFor(s2.base));
  ok(group, verdict(bad, "auth") === "FAIL" && bad.checks.some((c) => c.verdict === "FAIL"), "an accountId mismatch FAILs (exit code 1)");
  await s2.close();

  const s3 = await stub({ status401: true });
  const denied = await runSmoke(envFor(s3.base));
  ok(group, verdict(denied, "auth") === "FAIL" && denied.checks.length <= 3 && s3.seen.length === 1, "a 401 stops after the auth check");
  await s3.close();

  const missing = await runSmoke({ JIRA_BASE_URL: "http://127.0.0.1:1" });
  ok(group, verdict(missing, "env") === "FAIL" && missing.checks.length <= 2, "missing environment is a FAIL naming the variables");

  const optional = await stub();
  const noOptionals = await runSmoke(envFor(optional.base, { SMOKE_ISSUE_KEY: undefined, SMOKE_MENTION_ISSUE_KEY: undefined, JIRA_TIMEZONE_OFFSET_MINUTES: undefined }));
  ok(group, verdict(noOptionals, "comments") === "WARN" && verdict(noOptionals, "mentions") === "WARN" && noOptionals.conclusions.F4 === "inconclusive", "optional keys missing -> those checks are skipped with a WARN");
  await optional.close();
}

{
  const group = "P2.5 Read-only guard";
  let threw = "";
  try {
    await runSmoke(envFor("http://127.0.0.1:1"), { fetcher: async (_u, init) => { if (init.method !== "GET" && init.method !== "POST") throw new Error("never"); return { status: 200, headers: new Headers(), json: async () => ({ accountId: "acc-smoke" }) }; } });
  } catch (e) { threw = (e as Error).message; }
  ok(group, threw === "", "normal runs never trip the guard");
  const fs = await import("node:fs");
  const src = fs.readFileSync("scripts/jira-smoke.mts", "utf8");
  ok(group, /refusing \$\{method\}/.test(src) && !/method: "(PUT|DELETE|PATCH)"/.test(src), "request() refuses everything except GET and POST /search/jql");
  ok(group, zoneOffsetMinutes("Asia/Ho_Chi_Minh", new Date("2026-10-27T00:00:00Z")) === 420 && zoneOffsetMinutes("America/New_York", new Date("2026-01-15T12:00:00Z")) === -300 && zoneOffsetMinutes("Not/AZone", new Date()) === undefined, "zoneOffsetMinutes: UTC+7, UTC-5 (winter), unknown zone");
  ok(group, /"smoke:jira": "tsx scripts\/jira-smoke\.mts"/.test(fs.readFileSync("package.json", "utf8")) && /smoke-report\.json/.test(fs.readFileSync(".gitignore", "utf8")), "npm script exists and the report is gitignored");
  ok(group, !/jira-smoke/.test(fs.readFileSync("scripts/tests/run.mts", "utf8").replace("41-jira-smoke.test.mts", "")) && !/smoke/.test(fs.readFileSync(".github/workflows/ci.yml", "utf8")), "the script itself is not part of the runner or CI (only its stub test is)");
}
