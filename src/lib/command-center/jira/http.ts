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
  jiraSearchJqlResponseSchema,
  jiraSearchResponseSchema,
  type JiraChangelogHistory,
  type JiraConnectionConfig,
  type JiraIssue,
  type JiraProject,
} from "./types";
import type { JiraCapabilityResult, JiraErrorKind } from "../types";

const ISSUE_FIELDS =
  "summary,status,priority,assignee,duedate,labels,fixVersions,issuetype,issuelinks,project,created,updated,flagged";
// V2.2.3 — `POST /rest/api/3/search/jql` validates every requested field name against the
// instance's real, resolvable field IDs and 400s the WHOLE request if one doesn't resolve
// (unlike the classic GET /rest/api/3/search, which silently ignores an unrecognized field
// name). "flagged" is NOT a real system field — it's always instance-specific custom field
// on real Jira sites (jira/types.ts already documents this: "some instances expose a
// boolean 'Flagged' custom field") — so it's the one entry in ISSUE_FIELDS that can't be
// safely sent to the strict endpoint. Every other field here is a genuine, universal Jira
// system field, safe on any instance. Omitted here only for the request; normalize.ts's
// flagged-based blocked-status detection still works via the status-name heuristic when
// this signal isn't available (see mapping.ts isBlockedByHeuristic).
const JQL_SEARCH_FIELDS = ISSUE_FIELDS.split(",").filter((f) => f !== "flagged");
export const JIRA_PAGE_SIZE = 50;
export const JIRA_MAX_ISSUES = 2000; // safety cap — §11 "handle large result sets safely"
// V2.2.1 §4/§5 — every Jira request gets an explicit abort timeout. Without this, a hung
// Jira instance would block the request until Vercel's own platform timeout kills the
// function uncleanly; with it, the request fails fast into the *existing*
// network-error/errorKind classification below (no new error path needed).
const JIRA_FETCH_TIMEOUT_MS = 20_000;

export type JiraFetchResult<T> =
  | { ok: true; data: T; recordsFetched: number; method?: "jql-cursor" | "classic-offset" }
  | { ok: false; error: string; errorKind: JiraErrorKind };

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; method?: string; body?: string; signal?: AbortSignal }) => Promise<{
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
  // V2.2.2 — Atlassian has fully sunset the classic GET /rest/api/3/search endpoint on Jira
  // Cloud; a real instance now answers it with 410 Gone. fetchJiraIssuesWith below already
  // tries the replacement endpoint first and only falls back to classic search, so a 410
  // reaching this classifier means even that fallback attempt failed — worth a specific,
  // actionable message rather than a generic "unexpected status".
  if (status === 410) return { error: "Jira reports this API endpoint as permanently removed (410 Gone) — it may have been deprecated by Atlassian.", errorKind: "unknown" };
  if (status === 400) return { error: "Jira rejected this request as malformed (400 Bad Request).", errorKind: "unknown" };
  return { error: `Jira API returned an unexpected status (${status}).`, errorKind: "unknown" };
}

/**
 * V2.2.3 — every non-2xx classification above previously discarded the response body, so a
 * real Jira validation error (e.g. "The value 'flagged' does not exist for the field
 * 'fields'.") was reduced to a bare status code with no way to actually diagnose it. Jira's
 * error bodies are consistently shaped as `{ errorMessages: string[], errors: {field: msg} }`
 * — this reads that shape (tolerating anything else, including a non-JSON body) and appends
 * whatever it finds to the status-based message, never replacing it (so a caller can never
 * end up with an empty/missing error).
 */
async function describeJiraError(res: { status: number; json: () => Promise<unknown> }): Promise<{ error: string; errorKind: JiraErrorKind }> {
  const base = classifyHttpError(res.status);
  try {
    const body = (await res.json()) as unknown;
    if (typeof body !== "object" || body === null) return base;
    const details: string[] = [];
    const errorMessages = (body as { errorMessages?: unknown }).errorMessages;
    if (Array.isArray(errorMessages)) details.push(...errorMessages.filter((m): m is string => typeof m === "string"));
    const errors = (body as { errors?: unknown }).errors;
    if (typeof errors === "object" && errors !== null) {
      for (const [field, msg] of Object.entries(errors as Record<string, unknown>)) {
        if (typeof msg === "string") details.push(`${field}: ${msg}`);
      }
    }
    return details.length > 0 ? { error: `${base.error} ${details.join(" ")}`, errorKind: base.errorKind } : base;
  } catch {
    return base; // body wasn't readable/JSON (e.g. an HTML error page) — the status-based message still stands
  }
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
  // V2.2.4 — Jira's search/jql endpoint rejects a fully unbounded query (no WHERE clause at
  // all, `order by` only) with 400 "Unbounded JQL queries are not allowed here." This hits a
  // first full sync with no JIRA_PROJECT_KEYS configured — exactly the common case, since
  // that variable is optional and most operators never set it. `project is not EMPTY` is
  // Atlassian's own documented pattern for "I genuinely want every issue, but the API
  // requires SOME restriction": every real issue belongs to a project, so this excludes
  // nothing — it only satisfies the syntactic requirement, never narrows the actual sync
  // scope.
  if (clauses.length === 0) clauses.push("project is not EMPTY");
  return `${clauses.join(" AND ")} order by updated desc`;
}

export async function fetchJiraProjectsWith(fetchImpl: FetchLike, config: JiraConnectionConfig): Promise<JiraFetchResult<JiraProject[]>> {
  try {
    const res = await fetchImpl(buildUrl(config.baseUrl, "/rest/api/3/project/search", { maxResults: "50" }), {
      headers: { Authorization: authHeader(config), Accept: "application/json" },
      signal: AbortSignal.timeout(JIRA_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, ...(await describeJiraError(res)) };
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

/**
 * Classic, offset/startAt-based issue search — the ORIGINAL endpoint this app used, kept
 * only as a fallback (see fetchJiraIssuesWith below) for a Jira instance that genuinely
 * doesn't expose the replacement endpoint. Atlassian has sunset this endpoint on Jira
 * Cloud (a real instance answers with 410 Gone as of late 2025), so this path is no longer
 * expected to succeed against Cloud — it exists purely as a defensive fallback, tried only
 * when the replacement endpoint itself reports 404 (genuinely not present).
 */
async function fetchJiraIssuesClassic(fetchImpl: FetchLike, config: JiraConnectionConfig, options: FetchIssuesOptions): Promise<JiraFetchResult<JiraIssue[]>> {
  const jql = buildIssuesJql(options);
  const issues: JiraIssue[] = [];
  let startAt = 0;
  try {
    while (issues.length < JIRA_MAX_ISSUES) {
      const res = await fetchImpl(
        buildUrl(config.baseUrl, "/rest/api/3/search", { jql, startAt: String(startAt), maxResults: String(JIRA_PAGE_SIZE), fields: ISSUE_FIELDS }),
        { headers: { Authorization: authHeader(config), Accept: "application/json" }, signal: AbortSignal.timeout(JIRA_FETCH_TIMEOUT_MS) }
      );
      if (!res.ok) return { ok: false, ...(await describeJiraError(res)) };
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
    return { ok: true, data: issues, recordsFetched: issues.length, method: "classic-offset" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error contacting Jira.", errorKind: "network-error" };
  }
}

/**
 * V2.2.2 — root-cause fix for a real production bug: Jira Cloud now answers the classic
 * `GET /rest/api/3/search` endpoint this app originally used with 410 Gone (Atlassian
 * sunset it in favor of `POST /rest/api/3/search/jql`, cursor/`nextPageToken`-based rather
 * than offset/`startAt`-based), so every real sync was failing with "Jira API returned an
 * unexpected status (410)" despite fully correct credentials.
 *
 * This now tries the replacement endpoint first — the only one any current Jira Cloud site
 * actually supports. It falls back to fetchJiraIssuesClassic ONLY when the very FIRST page
 * of the replacement endpoint reports 404 (this exact instance genuinely doesn't expose it
 * at all — never on 410, which means "existed but this request is gone", not "doesn't exist
 * here"). Once pagination is under way, a later-page failure is reported as-is rather than
 * silently restarting via the other endpoint, which could otherwise return a subtly
 * different result set mid-fetch.
 */
export async function fetchJiraIssuesWith(fetchImpl: FetchLike, config: JiraConnectionConfig, options: FetchIssuesOptions): Promise<JiraFetchResult<JiraIssue[]>> {
  const jql = buildIssuesJql(options);
  const issues: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  let firstPage = true;
  try {
    while (issues.length < JIRA_MAX_ISSUES) {
      const body: Record<string, unknown> = { jql, maxResults: JIRA_PAGE_SIZE, fields: JQL_SEARCH_FIELDS };
      if (nextPageToken) body.nextPageToken = nextPageToken;
      const res = await fetchImpl(buildUrl(config.baseUrl, "/rest/api/3/search/jql", {}), {
        method: "POST",
        headers: { Authorization: authHeader(config), Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(JIRA_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        if (firstPage && res.status === 404) return fetchJiraIssuesClassic(fetchImpl, config, options);
        return { ok: false, ...(await describeJiraError(res)) };
      }
      firstPage = false;
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        return { ok: false, error: "Jira returned a response that was not valid JSON.", errorKind: "malformed-response" };
      }
      const parsed = jiraSearchJqlResponseSchema.safeParse(json);
      if (!parsed.success) return { ok: false, error: "Jira's search response did not match the expected shape.", errorKind: "malformed-response" };

      issues.push(...parsed.data.issues);
      const fetchedThisPage = parsed.data.issues.length;
      if (fetchedThisPage === 0 || parsed.data.isLast || !parsed.data.nextPageToken) break;
      nextPageToken = parsed.data.nextPageToken;
    }
    return { ok: true, data: issues, recordsFetched: issues.length, method: "jql-cursor" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error contacting Jira.", errorKind: "network-error" };
  }
}

/**
 * V1.8 §5, updated V2.2.2 — cursor-based pagination capability probe. `POST
 * /rest/api/3/search/jql` is now fetchJiraIssuesWith's PRIMARY endpoint (Atlassian has
 * sunset the classic `GET /rest/api/3/search` on Jira Cloud — it now answers 410 Gone); the
 * classic endpoint remains only as a same-fetch fallback for an instance that genuinely
 * doesn't expose the replacement (404 on it). This probe still exists as a standalone,
 * side-effect-free diagnostic for the Conformance panel (issues one minimal request,
 * maxResults: 0) rather than requiring a real sync attempt just to answer "which one will
 * this instance use". A 404 means the endpoint genuinely doesn't exist (UNSUPPORTED); a
 * successful response means it does (SUPPORTED); anything that prevents a clear read
 * (auth failure, rate limit, network error, unexpected status) is reported as UNKNOWN —
 * §5 explicitly forbids inventing a workaround instead of admitting "we don't know yet".
 */
export async function detectJiraSearchCapability(fetchImpl: FetchLike, config: JiraConnectionConfig): Promise<JiraCapabilityResult> {
  try {
    const res = await fetchImpl(buildUrl(config.baseUrl, "/rest/api/3/search/jql", {}), {
      method: "POST",
      headers: { Authorization: authHeader(config), Accept: "application/json", "Content-Type": "application/json" },
      // V2.2.4 — matches buildIssuesJql's own bounded-query workaround; a bare "order by"
      // JQL here would itself be rejected as unbounded (400), which previously made this
      // probe misreport a genuinely working instance as UNKNOWN instead of SUPPORTED.
      body: JSON.stringify({ jql: "project is not EMPTY order by updated desc", maxResults: 0 }),
      signal: AbortSignal.timeout(JIRA_FETCH_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(JIRA_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, ...(await describeJiraError(res)) };
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
