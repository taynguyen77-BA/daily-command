// P2.5 — read-only smoke test against a REAL Jira Cloud instance. It settles, in one run, what the
// code only infers: whether an ISO timestamp in JQL is rejected (finding F1), whether comments come
// back oldest-first by default (F4), the timezone offset, mention-search indexing lag and rate-limit
// headers. NOT part of `npm test` or CI.
//
//   JIRA_BASE_URL=https://acme.atlassian.net JIRA_EMAIL=you@acme.com JIRA_API_TOKEN=... \
//   SMOKE_ACCOUNT_ID=... [SMOKE_ISSUE_KEY=ABC-1] [SMOKE_MENTION_ISSUE_KEY=ABC-2] [JIRA_TIMEZONE_OFFSET_MINUTES=420] \
//   npm run smoke:jira
//
// Read-only by construction: request() refuses anything except GET and POST /search/jql (a read).
// The token and the Authorization header are never printed or written.

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { buildIncrementalSinceParam } from "../src/lib/command-center/jira/http";

export type Verdict = "PASS" | "WARN" | "FAIL";
export interface SmokeCheck {
  id: string;
  title: string;
  verdict: Verdict;
  status?: string;
  detail: string;
}
export interface SmokeReport {
  generatedAt: string;
  baseUrlHost: string;
  checks: SmokeCheck[];
  conclusions: { F1: string; F4: string };
  rateLimitHeaders: Record<string, string>;
}

export interface SmokeEnv {
  JIRA_BASE_URL?: string;
  JIRA_EMAIL?: string;
  JIRA_API_TOKEN?: string;
  SMOKE_ACCOUNT_ID?: string;
  SMOKE_ISSUE_KEY?: string;
  SMOKE_MENTION_ISSUE_KEY?: string;
  JIRA_TIMEZONE_OFFSET_MINUTES?: string;
}

type Res = { status: number; headers: Headers; json: () => Promise<unknown> };
type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Res>;

const RATE_HEADER = /^(x-ratelimit|ratelimit|retry-after|x-beta-rate-limit)/i;

/** Offset (minutes east of UTC) of an IANA zone at `at`, via Intl — no dependency. */
export function zoneOffsetMinutes(timeZone: string, at: Date): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
    return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
  } catch {
    return undefined;
  }
}

export async function runSmoke(env: SmokeEnv, options: { fetcher?: Fetcher; now?: () => Date } = {}): Promise<SmokeReport> {
  const now = options.now ?? (() => new Date());
  const baseUrl = (env.JIRA_BASE_URL ?? "").replace(/\/$/, "");
  const secrets = [env.JIRA_API_TOKEN, env.JIRA_EMAIL && env.JIRA_API_TOKEN ? Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString("base64") : undefined].filter((s): s is string => !!s);
  const redact = (text: string) => secrets.reduce((t, s) => t.split(s).join("[redacted]"), text).replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic [redacted]");
  const auth = "Basic " + Buffer.from(`${env.JIRA_EMAIL ?? ""}:${env.JIRA_API_TOKEN ?? ""}`).toString("base64");
  const fetcher: Fetcher = options.fetcher ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }) as unknown as Promise<Res>);
  const rateHeaders: Record<string, string> = {};
  const checks: SmokeCheck[] = [];
  const add = (c: SmokeCheck) => checks.push({ ...c, detail: redact(c.detail) });

  /** The only way this script talks to Jira. Reads only. */
  async function request(method: "GET" | "POST", pathAndQuery: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const pathname = pathAndQuery.split("?")[0];
    if (!(method === "GET" || (method === "POST" && pathname === "/rest/api/3/search/jql"))) throw new Error(`jira-smoke is read-only: refusing ${method} ${pathname}`);
    const res = await fetcher(baseUrl + pathAndQuery, { method, headers: { Authorization: auth, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    res.headers.forEach((v, k) => { if (RATE_HEADER.test(k)) rateHeaders[k.toLowerCase()] = v; });
    let json: unknown = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, json };
  }
  const search = (jql: string, extra: Record<string, unknown> = {}) => request("POST", "/rest/api/3/search/jql", { jql, maxResults: 5, fields: ["summary", "updated"], ...extra });

  const missing = (["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "SMOKE_ACCOUNT_ID"] as const).filter((k) => !env[k]);
  if (missing.length > 0) {
    add({ id: "env", title: "Environment", verdict: "FAIL", detail: `Missing: ${missing.join(", ")}` });
    return finish();
  }

  // a. auth
  let myTimeZone: string | undefined;
  try {
    const r = await request("GET", "/rest/api/3/myself");
    const j = (r.json ?? {}) as { accountId?: string; timeZone?: string };
    myTimeZone = j.timeZone;
    add({ id: "auth", title: "Auth: GET /myself matches SMOKE_ACCOUNT_ID", verdict: r.status === 200 && j.accountId === env.SMOKE_ACCOUNT_ID ? "PASS" : "FAIL", status: String(r.status), detail: r.status !== 200 ? `HTTP ${r.status}` : j.accountId === env.SMOKE_ACCOUNT_ID ? "accountId matches" : "authenticated, but accountId differs from SMOKE_ACCOUNT_ID" });
    if (r.status === 401 || r.status === 403) return finish();
  } catch (e) {
    add({ id: "auth", title: "Auth", verdict: "FAIL", detail: `Network error: ${(e as Error).message}` });
    return finish();
  }

  // b. search paging + fields
  try {
    const fields = ["priority", "resolutiondate", "statuscategorychangedate", "updated"];
    const p1 = await search("project is not EMPTY order by updated desc", { fields });
    const j1 = (p1.json ?? {}) as { issues?: { fields?: Record<string, unknown> }[]; nextPageToken?: string };
    let pages = 1;
    let paging = "single page (no nextPageToken)";
    if (p1.status === 200 && j1.nextPageToken) {
      const p2 = await search("project is not EMPTY order by updated desc", { fields, nextPageToken: j1.nextPageToken });
      pages = p2.status === 200 ? 2 : 1;
      paging = p2.status === 200 ? "followed nextPageToken once" : `second page failed (HTTP ${p2.status})`;
    }
    const first = j1.issues?.[0]?.fields ?? {};
    const present = fields.filter((f) => f in first);
    const verdict: Verdict = p1.status !== 200 ? "FAIL" : (j1.issues?.length ?? 0) === 0 ? "WARN" : present.length === fields.length ? "PASS" : "WARN";
    add({ id: "search", title: "Search: POST /search/jql paging + fields", verdict, status: String(p1.status), detail: p1.status !== 200 ? `HTTP ${p1.status}` : `${j1.issues?.length ?? 0} issue(s), ${paging} (${pages} page(s)); fields present on the first issue: ${present.join(", ") || "none"}${present.length < fields.length ? ` — missing: ${fields.filter((f) => !present.includes(f)).join(", ")}` : ""}` });
  } catch (e) {
    add({ id: "search", title: "Search", verdict: "FAIL", detail: `Network error: ${(e as Error).message}` });
  }

  // c. JQL dates
  try {
    const at = now();
    const dayAgo = new Date(at.getTime() - 86_400_000).toISOString();
    const formatted = buildIncrementalSinceParam(dayAgo, 0);
    const f = await search(`updated >= "${formatted}" order by updated desc`);
    add({ id: "jql-date-formatted", title: `JQL date "yyyy-MM-dd HH:mm" is accepted`, verdict: f.status === 200 ? "PASS" : "FAIL", status: String(f.status), detail: `updated >= "${formatted}" -> HTTP ${f.status}` });
    const iso = await search(`updated >= "${dayAgo}" order by updated desc`);
    add({
      id: "jql-date-iso",
      title: "JQL date as ISO-8601 with T and Z (finding F1)",
      verdict: iso.status === 400 ? "PASS" : iso.status === 200 ? "WARN" : "FAIL",
      status: String(iso.status),
      detail: iso.status === 400 ? `ISO value rejected (HTTP 400): F1 CONFIRMED — the formatter is required` : iso.status === 200 ? `ISO value accepted (HTTP 200): F1 REFUTED on this instance (keep the formatter anyway: only the documented formats are guaranteed)` : `unexpected HTTP ${iso.status}`,
    });
    const configured = env.JIRA_TIMEZONE_OFFSET_MINUTES !== undefined && env.JIRA_TIMEZONE_OFFSET_MINUTES !== "" ? Number(env.JIRA_TIMEZONE_OFFSET_MINUTES) : undefined;
    const actual = myTimeZone ? zoneOffsetMinutes(myTimeZone, at) : undefined;
    add({
      id: "tz",
      title: "User-timezone offset vs JIRA_TIMEZONE_OFFSET_MINUTES",
      // C1: the server now learns the zone from /myself, so an unset offset is fine; only a DISAGREEMENT (the DST symptom) warns.
      verdict: actual === undefined ? "WARN" : configured === undefined || configured === actual ? "PASS" : "WARN",
      detail: actual === undefined ? "/myself returned no usable timeZone" : `Jira user timeZone ${myTimeZone} is UTC${actual >= 0 ? "+" : ""}${actual / 60} now (${actual} min); ${configured === undefined ? "JIRA_TIMEZONE_OFFSET_MINUTES is not set (the server uses the zone learned from /myself)" : configured === actual ? "matches JIRA_TIMEZONE_OFFSET_MINUTES" : `JIRA_TIMEZONE_OFFSET_MINUTES=${configured} differs (a DST change can cause this)`}`,
    });
  } catch (e) {
    add({ id: "jql-date", title: "JQL dates", verdict: "FAIL", detail: `Network error: ${(e as Error).message}` });
  }

  // d. comment order
  if (!env.SMOKE_ISSUE_KEY) {
    add({ id: "comments", title: "Comment order (finding F4)", verdict: "WARN", detail: "SMOKE_ISSUE_KEY not set — skipped" });
  } else {
    try {
      const p = `/rest/api/3/issue/${encodeURIComponent(env.SMOKE_ISSUE_KEY)}/comment`;
      const def = await request("GET", `${p}?maxResults=50`);
      const desc = await request("GET", `${p}?maxResults=50&orderBy=-created`);
      const createdOf = (r: { json: unknown }) => ((r.json as { comments?: { created?: string }[] } | null)?.comments ?? []).map((c) => c.created ?? "");
      const a = createdOf(def), b = createdOf(desc);
      if (def.status !== 200 || desc.status !== 200) add({ id: "comments", title: "Comment order (finding F4)", verdict: "FAIL", status: `${def.status}/${desc.status}`, detail: `HTTP ${def.status} (default) / ${desc.status} (orderBy=-created)` });
      else if (a.length < 2) add({ id: "comments", title: "Comment order (finding F4)", verdict: "WARN", detail: `only ${a.length} comment(s) on ${env.SMOKE_ISSUE_KEY} — cannot tell the order; use an issue with several comments` });
      else {
        const defaultOldestFirst = a[0] <= a[a.length - 1];
        const descNewestFirst = b[0] >= b[b.length - 1];
        add({ id: "comments", title: "Comment order (finding F4)", verdict: descNewestFirst ? "PASS" : "FAIL", status: "200", detail: `default order is ${defaultOldestFirst ? "OLDEST-first: F4 CONFIRMED (long threads would cut off the newest comments without orderBy=-created)" : "NEWEST-first: F4 REFUTED"}; orderBy=-created is ${descNewestFirst ? "newest-first (as the code assumes)" : "NOT newest-first (the code's assumption is wrong)"}` });
      }
    } catch (e) {
      add({ id: "comments", title: "Comment order", verdict: "FAIL", detail: `Network error: ${(e as Error).message}` });
    }
  }

  // e. mentions
  if (!env.SMOKE_MENTION_ISSUE_KEY) {
    add({ id: "mentions", title: "Mention search finds the known mention", verdict: "WARN", detail: "SMOKE_MENTION_ISSUE_KEY not set — skipped" });
  } else {
    try {
      const safe = env.SMOKE_ACCOUNT_ID!.replace(/"/g, '\\"');
      const r = await search(`comment ~ "accountid:${safe}" order by updated desc`, { maxResults: 50 });
      const keys = ((r.json as { issues?: { key?: string }[] } | null)?.issues ?? []).map((i) => i.key);
      add({ id: "mentions", title: "Mention search finds the known mention", verdict: r.status !== 200 ? "FAIL" : keys.includes(env.SMOKE_MENTION_ISSUE_KEY) ? "PASS" : "WARN", status: String(r.status), detail: r.status !== 200 ? `HTTP ${r.status}` : keys.includes(env.SMOKE_MENTION_ISSUE_KEY) ? `${env.SMOKE_MENTION_ISSUE_KEY} is returned (${keys.length} issue(s) total)` : `${env.SMOKE_MENTION_ISSUE_KEY} NOT returned among ${keys.length} issue(s) — likely search-index lag for a recent comment (the recency fallback exists for this)` });
    } catch (e) {
      add({ id: "mentions", title: "Mention search", verdict: "FAIL", detail: `Network error: ${(e as Error).message}` });
    }
  }

  return finish();

  function finish(): SmokeReport {
    const by = (id: string) => checks.find((c) => c.id === id);
    const f1 = by("jql-date-iso"), f4 = by("comments");
    add({ id: "rate", title: "Rate-limit headers seen", verdict: "PASS", detail: Object.keys(rateHeaders).length === 0 ? "none of X-RateLimit-* / Retry-After appeared on these responses" : Object.entries(rateHeaders).map(([k, v]) => `${k}: ${v}`).join("; ") });
    return {
      generatedAt: now().toISOString(),
      baseUrlHost: (() => { try { return new URL(baseUrl).host; } catch { return ""; } })(),
      checks,
      conclusions: {
        F1: !f1 ? "not checked" : f1.detail.includes("CONFIRMED") ? "CONFIRMED" : f1.detail.includes("REFUTED") ? "REFUTED" : "inconclusive",
        F4: !f4 ? "not checked" : f4.detail.includes("CONFIRMED") ? "CONFIRMED" : f4.detail.includes("REFUTED") ? "REFUTED" : "inconclusive",
      },
      rateLimitHeaders: rateHeaders,
    };
  }
}

export function renderMarkdown(report: SmokeReport): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const rows = report.checks.map((c) => `| ${c.verdict} | ${esc(c.title)} | ${c.status ?? ""} | ${esc(c.detail)} |`);
  return [`# Jira smoke report — ${report.baseUrlHost || "(no host)"} — ${report.generatedAt}`, "", "| Result | Check | HTTP | Detail |", "|---|---|---|---|", ...rows, "", `**F1 (ISO timestamp rejected by JQL):** ${report.conclusions.F1}`, `**F4 (comments oldest-first by default):** ${report.conclusions.F4}`, ""].join("\n");
}

async function main() {
  const report = await runSmoke(process.env as SmokeEnv);
  console.log(renderMarkdown(report));
  fs.writeFileSync("smoke-report.json", JSON.stringify(report, null, 2));
  process.exit(report.checks.some((c) => c.verdict === "FAIL") ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
