// Jira HTTP logic (BUILD REQUEST V1.3 §4, §11-12, §29) — pagination, error classification,
// incremental-sync JQL construction. Deliberately NOT marked server-only and takes the
// fetch implementation as a parameter: this is what makes pagination/rate-limit/malformed-
// response handling unit-testable with fixtures (§32), without ever touching real
// credentials or process.env. The only caller with real credentials is
// ../../server/jira-client.ts (server-only), which passes the global `fetch` and the
// env-sourced config in.

import {
  jiraChangelogResponseSchema,
  jiraProjectSearchResponseSchema,
  jiraSearchResponseSchema,
  type JiraChangelogHistory,
  type JiraConnectionConfig,
  type JiraIssue,
  type JiraProject,
} from "./types";
import type { JiraCapabilityResult, JiraErrorKind } from "../types";

const ISSUE_FIELDS =
  "summary,status,priority,assignee,duedate,labels,fixVersions,issuetype,issuelinks,project,created,updated,flagged";
export const JIRA_PAGE_SIZE = 50;
export const JIRA_MAX_ISSUES = 2000; // safety cap — §11 "handle large result sets safely"

export type JiraFetchResult<T> =
  | { ok: true; data: T; recordsFetched: number }
  | { ok: false; error: string; errorKind: JiraErrorKind };

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; method?: string; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

function authHeader(config: JiraConnectionConfig): string {
  return "Basic " + Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
}

function buildUrl(baseUrl: string, path: string, params: Record<string, string>): string {
  const url = new URL(path, baseUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

export function classifyHttpError(status: number): { error: string; errorKind: JiraErrorKind } {
  if (status === 401) return { error: "Jira rejected the configured credentials.", errorKind: "auth-failure" };
  if (status === 403) return { error: "The configured Jira account lacks permission for this request.", errorKind: "permission-failure" };
  if (status === 429) return { error: "Jira rate limit exceeded — try again shortly.", errorKind: "rate-limited" };
  return { error: `Jira API returned an unexpected status (${status}).`, errorKind: "unknown" };
}

/**
 * V1.7 §10 — incremental-sync cursor hardening. Jira's `updated` field has minute-level
 * granularity, and JQL bare date/time literals are interpreted in the *Jira instance's own
 * configured timezone* — information this app cannot discover from the client side. The
 * original V1.3 approach truncated the cursor to a bare calendar date (`updated >= "yyyy-
 * MM-dd"`), which is timezone-safe by construction (a day-literal's worst-case
 * misinterpretation is still bounded to roughly one day) but re-fetches an entire day's
 * issues on every sync within that day.
 *
 * When the operator supplies JIRA_TIMEZONE_OFFSET_MINUTES (their instance's configured
 * offset from UTC), this computes a much tighter minute-precision cursor instead — the
 * last-sync instant converted into that timezone's wall-clock time, minus a
 * `SAFETY_BUFFER_MINUTES` margin so an issue updated in the same minute as the previous
 * sync (a real race — Jira's `updated` cannot distinguish sub-minute ordering) is never
 * missed. `>=` semantics mean the buffer only ever causes a few already-synced issues to
 * be re-fetched and deduped by store.ts's mergeById — it can never cause data loss.
 *
 * Without a configured offset, this falls back unchanged to the original day-level cursor
 * — strictly no less safe than before, just not more precise. This is the honest choice:
 * inventing minute-precision without knowing the real timezone would trade a small,
 * bounded redundancy for an unbounded (up to ~14h) risk of silently skipping issues.
 */
const SAFETY_BUFFER_MINUTES = 5;

export function buildIncrementalSinceParam(lastSyncCompletedAtIso: string, timezoneOffsetMinutes?: number): string {
  if (timezoneOffsetMinutes === undefined || !Number.isFinite(timezoneOffsetMinutes)) {
    return lastSyncCompletedAtIso.slice(0, 10); // unchanged fallback — safe, day-level
  }
  const lastSyncMs = new Date(lastSyncCompletedAtIso).getTime();
  if (!Number.isFinite(lastSyncMs)) return lastSyncCompletedAtIso.slice(0, 10);
  const bufferedMs = lastSyncMs + timezoneOffsetMinutes * 60_000 - SAFETY_BUFFER_MINUTES * 60_000;
  const local = new Date(bufferedMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

export function buildIssuesJql(options: { sinceIso?: string; projectKeys?: string[] }): string {
  const clauses: string[] = [];
  if (options.projectKeys && options.projectKeys.length > 0) {
    clauses.push(`project in (${options.projectKeys.map((k) => `"${k}"`).join(",")})`);
  }
  if (options.sinceIso) clauses.push(`updated >= "${options.sinceIso}"`);
  return clauses.length > 0 ? `${clauses.join(" AND ")} order by updated desc` : "order by updated desc";
}

export async function fetchJiraProjectsWith(fetchImpl: FetchLike, config: JiraConnectionConfig): Promise<JiraFetchResult<JiraProject[]>> {
  try {
    const res = await fetchImpl(buildUrl(config.baseUrl, "/rest/api/3/project/search", { maxResults: "50" }), {
      headers: { Authorization: authHeader(config), Accept: "application/json" },
    });
    if (!res.ok) return { ok: false, ...classifyHttpError(res.status) };
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, error: "Jira returned a response that was not valid JSON.", errorKind: "malformed-response" };
    }
    const parsed = jiraProjectSearchResponseSchema.safeParse(json);
    if (!parsed.success) return { ok: false, error: "Jira's project response did not match the expected shape.", errorKind: "malformed-response" };
    return { ok: true, data: parsed.data.values, recordsFetched: parsed.data.values.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error contacting Jira.", errorKind: "network-error" };
  }
}

export interface FetchIssuesOptions {
  sinceIso?: string;
  projectKeys?: string[];
}

export async function fetchJiraIssuesWith(fetchImpl: FetchLike, config: JiraConnectionConfig, options: FetchIssuesOptions): Promise<JiraFetchResult<JiraIssue[]>> {
  const jql = buildIssuesJql(options);
  const issues: JiraIssue[] = [];
  let startAt = 0;
  try {
    while (issues.length < JIRA_MAX_ISSUES) {
      const res = await fetchImpl(
        buildUrl(config.baseUrl, "/rest/api/3/search", { jql, startAt: String(startAt), maxResults: String(JIRA_PAGE_SIZE), fields: ISSUE_FIELDS }),
        { headers: { Authorization: authHeader(config), Accept: "application/json" } }
      );
      if (!res.ok) return { ok: false, ...classifyHttpError(res.status) };
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        return { ok: false, error: "Jira returned a response that was not valid JSON.", errorKind: "malformed-response" };
      }
      const parsed = jiraSearchResponseSchema.safeParse(json);
      if (!parsed.success) return { ok: false, error: "Jira's search response did not match the expected shape.", errorKind: "malformed-response" };

      issues.push(...parsed.data.issues);
      const fetchedThisPage = parsed.data.issues.length;
      startAt += fetchedThisPage;
      if (fetchedThisPage === 0 || startAt >= parsed.data.total) break;
    }
    return { ok: true, data: issues, recordsFetched: issues.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error contacting Jira.", errorKind: "network-error" };
  }
}

/**
 * V1.8 §5 — cursor-based pagination capability probe. Jira Cloud's enhanced JQL search
 * (`POST /rest/api/3/search/jql`, cursor/nextPageToken-based) coexists with the classic
 * `GET /rest/api/3/search` (startAt-based, still used exclusively by Server/Data Center
 * instances). Whether cursor pagination can be used is a property of the connected
 * instance, not something this app can decide in advance — so this issues one minimal,
 * side-effect-free probe request (maxResults: 0) and classifies the real response rather
 * than assuming. A 404 means the endpoint genuinely doesn't exist (UNSUPPORTED); a
 * successful response means it does (SUPPORTED); anything that prevents a clear read
 * (auth failure, rate limit, network error, unexpected status) is reported as UNKNOWN —
 * §5 explicitly forbids inventing a workaround instead of admitting "we don't know yet".
 */
export async function detectJiraSearchCapability(fetchImpl: FetchLike, config: JiraConnectionConfig): Promise<JiraCapabilityResult> {
  try {
    const res = await fetchImpl(buildUrl(config.baseUrl, "/rest/api/3/search/jql", {}), {
      method: "POST",
      headers: { Authorization: authHeader(config), Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ jql: "order by updated desc", maxResults: 0 }),
    });
    if (res.status === 404) {
      return { capability: "UNSUPPORTED", detail: "This Jira instance does not expose /rest/api/3/search/jql — cursor-based pagination is unavailable here; classic startAt pagination remains in use." };
    }
    if (res.ok) {
      return { capability: "SUPPORTED", detail: "This Jira instance responded successfully to /rest/api/3/search/jql — cursor-based pagination is available." };
    }
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      return { capability: "UNKNOWN", detail: `Could not confirm capability — the probe request itself was rejected (HTTP ${res.status}) before the endpoint's existence could be determined.` };
    }
    return { capability: "UNKNOWN", detail: `Jira responded with an unexpected status (HTTP ${res.status}) to the capability probe — not enough information to classify.` };
  } catch (err) {
    return { capability: "UNKNOWN", detail: err instanceof Error ? `Network error during capability probe: ${err.message}` : "Network error during capability probe." };
  }
}

/**
 * V1.4 §32 — single-page changelog fetch for one issue. Deliberately not paginated deeper
 * than the first page (100 entries): this is a best-effort scope-drift signal, not a full
 * audit trail, and callers only ever invoke this for a small prioritized set of issues
 * (never every issue — see the sync route and jira/scope-drift.ts).
 */
export async function fetchIssueChangelogWith(fetchImpl: FetchLike, config: JiraConnectionConfig, issueKey: string): Promise<JiraFetchResult<JiraChangelogHistory[]>> {
  try {
    const res = await fetchImpl(buildUrl(config.baseUrl, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog`, { maxResults: "100" }), {
      headers: { Authorization: authHeader(config), Accept: "application/json" },
    });
    if (!res.ok) return { ok: false, ...classifyHttpError(res.status) };
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, error: "Jira returned a response that was not valid JSON.", errorKind: "malformed-response" };
    }
    const parsed = jiraChangelogResponseSchema.safeParse(json);
    if (!parsed.success) return { ok: false, error: "Jira's changelog response did not match the expected shape.", errorKind: "malformed-response" };
    return { ok: true, data: parsed.data.values, recordsFetched: parsed.data.values.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error contacting Jira.", errorKind: "network-error" };
  }
}
