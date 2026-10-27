// Jira HTTP logic (BUILD REQUEST V1.3 §4, §11-12, §29) — pagination, error classification,
// incremental-sync JQL construction. Deliberately NOT marked server-only and takes the
// fetch implementation as a parameter: this is what makes pagination/rate-limit/malformed-
// response handling unit-testable with fixtures (§32), without ever touching real
// credentials or process.env. The only caller with real credentials is
// ../../server/jira-client.ts (server-only), which passes the global `fetch` and the
// env-sourced config in.

import {
  jiraChangelogResponseSchema,
  jiraCommentPageResponseSchema,
  jiraProjectSearchResponseSchema,
  jiraSearchJqlResponseSchema,
  jiraSearchResponseSchema,
  type JiraChangelogHistory,
  type JiraComment,
  type JiraConnectionConfig,
  type JiraIssue,
  type JiraProject,
} from "./types";
import type { JiraCapabilityResult, JiraErrorKind } from "../types";

// B2 — resolutiondate / statuscategorychangedate are universal Jira system fields (safe on the
// strict endpoint), fetched so a completion is dated by when it actually happened in Jira.
const ISSUE_FIELDS =
  "summary,status,priority,assignee,duedate,labels,fixVersions,issuetype,issuelinks,project,created,updated,flagged,resolutiondate,statuscategorychangedate";
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

/** B4 — a user-configured custom field id (the sprint field) is only ever accepted in Jira's
 *  own `customfield_<digits>` form, so nothing arbitrary is ever spliced into a request. */
export function isValidCustomFieldId(id: string | undefined): id is string {
  return !!id && /^customfield_\d{1,9}$/.test(id);
}

function withExtraFields(base: string[], extra: string[] | undefined): string[] {
  return [...base, ...(extra ?? []).filter((f) => isValidCustomFieldId(f) && !base.includes(f))];
}
export const JIRA_PAGE_SIZE = 50;
export const JIRA_MAX_ISSUES = 2000; // safety cap — §11 "handle large result sets safely"
// V2.2.1 §4/§5 — every Jira request gets an explicit abort timeout. Without this, a hung
// Jira instance would block the request until Vercel's own platform timeout kills the
// function uncleanly; with it, the request fails fast into the *existing*
// network-error/errorKind classification below (no new error path needed).
export const JIRA_FETCH_TIMEOUT_MS = 20_000;

export type JiraFetchResult<T> =
  | { ok: true; data: T; recordsFetched: number; method?: "jql-cursor" | "classic-offset"; truncated?: boolean }
  | { ok: false; error: string; errorKind: JiraErrorKind };

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; method?: string; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  /** Optional: the real fetch Response has it; fakes may omit it (only Retry-After is read). */
  headers?: { get(name: string): string | null };
}>;

// ===== P2.1 — one request wrapper: bounded retry for transient Jira failures =====
export interface JiraRetryOptions {
  /** Retries after the first attempt (default 3). */
  maxRetries?: number;
  /** Absolute epoch-ms deadline; no retry is started (or slept for) past it. */
  deadline?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** Exponential backoff base (default 300 ms) and cap for any single wait (default 10 s). */
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export const JIRA_RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
const RETRY_MARK = Symbol.for("daily-command.jira-retry");

/** Retry-After as seconds or an HTTP-date -> ms from `nowMs`, or undefined when absent/unparseable. */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

/** Wraps a FetchLike: retries 429/502/503/504 (never on 4xx other than 429, never on a thrown
 *  network error — those keep today's "network-error" classification), honours Retry-After
 *  (capped), otherwise exponential backoff with full jitter, stops at `deadline`. Every attempt
 *  gets its own timeout signal. Wrapping an already-wrapped fetch returns it unchanged. Used by
 *  every fetch*With function in this file; the Jira WRITE route does not go through it. */
export function withJiraRetry(fetchImpl: FetchLike, options: JiraRetryOptions = {}): FetchLike {
  if ((fetchImpl as unknown as Record<symbol, unknown>)[RETRY_MARK]) return fetchImpl;
  const maxRetries = options.maxRetries ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const base = options.baseDelayMs ?? 300;
  const cap = options.maxDelayMs ?? 10_000;
  const wrapped: FetchLike = async (url, init) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(JIRA_FETCH_TIMEOUT_MS) });
      if (res.ok || !JIRA_RETRY_STATUSES.has(res.status) || attempt >= maxRetries) return res;
      const retryAfter = parseRetryAfterMs(res.headers?.get("retry-after"), now());
      const wait = Math.min(cap, retryAfter ?? Math.floor(random() * Math.min(cap, base * 2 ** attempt)));
      if (options.deadline !== undefined && now() + wait >= options.deadline) return res;
      await sleep(wait);
    }
  };
  (wrapped as unknown as Record<symbol, unknown>)[RETRY_MARK] = true;
  return wrapped;
}

export function authHeader(config: JiraConnectionConfig): string {
  return "Basic " + Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
}

export function buildUrl(baseUrl: string, path: string, params: Record<string, string>): string {
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
export async function describeJiraError(res: { status: number; json: () => Promise<unknown> }): Promise<{ error: string; errorKind: JiraErrorKind }> {
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

/** Jira's documented JQL date literals: yyyy-MM-dd or yyyy/MM/dd, optionally followed by " HH:mm". */
const JQL_DATE_LITERAL = /^\d{4}[-/]\d{2}[-/]\d{2}( \d{2}:\d{2})?$/;

/** P1.1 — THE single place an `updated >= "..."` value is produced. Accepts an ISO-8601 instant
 *  (converted with buildIncrementalSinceParam's exact semantics: tz offset + 5-minute safety
 *  buffer, `yyyy-MM-dd HH:mm`; day-level when the offset is unknown) OR a value that is already a
 *  JQL date literal (passed through untouched, so a caller that formatted it itself is never
 *  double-buffered). Anything unparseable falls back to nothing (undefined) rather than a string
 *  Jira would reject. Raw ISO strings never reach JQL. */
export function formatJqlSince(sinceIso: string | undefined, timezoneOffsetMinutes?: number): string | undefined {
  if (!sinceIso) return undefined;
  if (JQL_DATE_LITERAL.test(sinceIso)) return sinceIso;
  if (!Number.isFinite(new Date(sinceIso).getTime())) return undefined;
  return buildIncrementalSinceParam(sinceIso, timezoneOffsetMinutes);
}

export function buildIssuesJql(options: { sinceIso?: string; projectKeys?: string[]; timezoneOffsetMinutes?: number; bootstrapDays?: number }): string {
  const clauses: string[] = [];
  if (options.projectKeys && options.projectKeys.length > 0) {
    clauses.push(`project in (${options.projectKeys.map((k) => `"${k}"`).join(",")})`);
  }
  const since = formatJqlSince(options.sinceIso, options.timezoneOffsetMinutes);
  if (since) clauses.push(`updated >= "${since}"`);
  // P2.1 — first/reset sync (no cursor): open tickets + the last N days, so the 2,000-issue cap is
  // not spent on years of closed history. Ascending order + computeResumeCursor still work: the
  // clause only narrows the set. Incremental syncs never get it (their JQL is unchanged).
  else if (options.bootstrapDays && options.bootstrapDays > 0) clauses.push(`(statusCategory != Done OR updated >= -${Math.floor(options.bootstrapDays)}d)`);
  // V2.2.4 — Jira's search/jql endpoint rejects a fully unbounded query (no WHERE clause at
  // all, `order by` only) with 400 "Unbounded JQL queries are not allowed here." This hits a
  // first full sync with no JIRA_PROJECT_KEYS configured — exactly the common case, since
  // that variable is optional and most operators never set it. `project is not EMPTY` is
  // Atlassian's own documented pattern for "I genuinely want every issue, but the API
  // requires SOME restriction": every real issue belongs to a project, so this excludes
  // nothing — it only satisfies the syntactic requirement, never narrows the actual sync
  // scope.
  if (clauses.length === 0) clauses.push("project is not EMPTY");
  // V2.18 §5 — was "order by updated desc". Ascending order is what makes the JIRA_MAX_ISSUES
  // safety cap safe rather than just "usually fine": a capped fetch now always returns the
  // OLDEST unfetched issues in the window first, so the last-fetched issue's `updated` value
  // is a safe, monotonically-non-decreasing resume boundary for the next sync (see
  // computeResumeCursor below and store.ts's syncJira). With descending order, a capped fetch
  // returns the same newest N issues every time and can never make forward progress.
  return `${clauses.join(" AND ")} order by updated asc`;
}

/** V2.18 §5 — resume boundary for a truncated sync: the `updated` timestamp of the
 *  last-fetched issue. With buildIssuesJql's ascending order this is the maximum `updated`
 *  seen in a truncated fetch, so the next sync's `updated >= <this>` picks up exactly where
 *  this one stopped (`>=`, not `>`, so a tie at the boundary is re-fetched and deduped by
 *  store.ts's mergeById, never skipped). Walks backward past any issue missing `updated`
 *  (the field is optional per jira/types.ts's schema). Returns undefined when not truncated,
 *  or when no fetched issue has a resolvable `updated` at all — callers must then not advance
 *  the incremental cursor. */
export function computeResumeCursor(issues: JiraIssue[], truncated: boolean): string | undefined {
  if (!truncated) return undefined;
  for (let i = issues.length - 1; i >= 0; i--) {
    const raw = issues[i]?.fields?.updated;
    if (!raw) continue;
    const ms = new Date(raw).getTime();
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return undefined;
}

export const JIRA_PROJECT_PAGE_SIZE = 50;
export const JIRA_MAX_PROJECTS = 2000; // safety cap, same philosophy as JIRA_MAX_ISSUES

/**
 * V2.3.1 — real production bug fix: this previously fetched only the FIRST page (maxResults:
 * "50") of `GET /rest/api/3/project/search` and returned it as if it were the whole catalog,
 * silently dropping every project past the 50th (in whatever order Jira happened to return
 * them) — a real Jira site with more projects than that would show a "Projects Discovered"
 * count and Focus Project Scope picker that simply omit some real, existing projects (e.g.
 * MCWS) with no visible error. This endpoint is startAt/maxResults paginated exactly like
 * classic issue search, and its response carries `isLast` — this now follows it to the end,
 * same as fetchJiraIssuesClassic below does for issues.
 */
export async function fetchJiraProjectsWith(fetchImpl: FetchLike, config: JiraConnectionConfig): Promise<JiraFetchResult<JiraProject[]>> {
  const http = withJiraRetry(fetchImpl);
  const projects: JiraProject[] = [];
  let startAt = 0;
  try {
    while (projects.length < JIRA_MAX_PROJECTS) {
      const res = await http(buildUrl(config.baseUrl, "/rest/api/3/project/search", { maxResults: String(JIRA_PROJECT_PAGE_SIZE), startAt: String(startAt) }), {
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

      projects.push(...parsed.data.values);
      const fetchedThisPage = parsed.data.values.length;
      startAt += fetchedThisPage;
      // isLast is the authoritative signal (and the schema defaults it to true when a
      // response omits it — see jira/types.ts). `total`, when present, is an independent
      // cross-check so a boundary case (isLast missing on a real exactly-page-size final
      // page) still terminates correctly rather than looping past the real end.
      const reachedTotal = parsed.data.total !== undefined && startAt >= parsed.data.total;
      if (fetchedThisPage === 0 || parsed.data.isLast || reachedTotal || fetchedThisPage < JIRA_PROJECT_PAGE_SIZE) break;
    }
    return { ok: true, data: projects, recordsFetched: projects.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error contacting Jira.", errorKind: "network-error" };
  }
}

export interface FetchIssuesOptions {
  sinceIso?: string;
  projectKeys?: string[];
  /** B4 — extra custom fields to request (validated by isValidCustomFieldId; others dropped). */
  extraFields?: string[];
  /** P2.1 — see buildIssuesJql. Only used when `sinceIso` is absent. */
  bootstrapDays?: number;
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
  const http = withJiraRetry(fetchImpl);
  const jql = buildIssuesJql(options);
  const issues: JiraIssue[] = [];
  let startAt = 0;
  let truncated = false;
  try {
    while (true) {
      const res = await http(
        buildUrl(config.baseUrl, "/rest/api/3/search", { jql, startAt: String(startAt), maxResults: String(JIRA_PAGE_SIZE), fields: withExtraFields(ISSUE_FIELDS.split(","), options.extraFields).join(",") }),
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
      if (fetchedThisPage === 0 || startAt >= parsed.data.total) break; // reached the real end
      // V2.18 §5 — the cap is observed directly at the moment it stops a loop that still had
      // more real pages, rather than inferred afterward from recordsFetched >= JIRA_MAX_ISSUES
      // (which would false-positive on a result of exactly JIRA_MAX_ISSUES real issues).
      if (issues.length >= JIRA_MAX_ISSUES) {
        truncated = true;
        break;
      }
    }
    return { ok: true, data: issues, recordsFetched: issues.length, method: "classic-offset", truncated };
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
/**
 * V2.10 §2 — extracted from the body of what was fetchJiraIssuesWith, so a second caller
 * (fetchMentionedIssuesWith below) can reuse the exact same cursor-pagination/error-
 * classification/timeout logic against a different JQL string, rather than forking a
 * parallel implementation. `classicFallbackOptions`, when provided, preserves
 * fetchJiraIssuesWith's original "first page 404 -> retry via the classic endpoint" behavior
 * unchanged; omitting it (as the mention search does) simply skips that fallback — the
 * classic endpoint has no equivalent of the mention JQL's `comment ~ "accountid:..."` clause
 * to fall back to, and Atlassian has sunset it on Cloud regardless (see fetchJiraIssuesClassic
 * above).
 */
async function fetchIssuesByJqlCursor(
  fetchImpl: FetchLike,
  config: JiraConnectionConfig,
  jql: string,
  classicFallbackOptions?: FetchIssuesOptions
): Promise<JiraFetchResult<JiraIssue[]>> {
  const http = withJiraRetry(fetchImpl);
  const issues: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  let firstPage = true;
  let truncated = false;
  try {
    while (true) {
      const body: Record<string, unknown> = { jql, maxResults: JIRA_PAGE_SIZE, fields: withExtraFields(JQL_SEARCH_FIELDS, classicFallbackOptions?.extraFields) };
      if (nextPageToken) body.nextPageToken = nextPageToken;
      const res = await http(buildUrl(config.baseUrl, "/rest/api/3/search/jql", {}), {
        method: "POST",
        headers: { Authorization: authHeader(config), Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(JIRA_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        if (firstPage && res.status === 404 && classicFallbackOptions) return fetchJiraIssuesClassic(http, config, classicFallbackOptions);
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
      if (fetchedThisPage === 0 || parsed.data.isLast || !parsed.data.nextPageToken) break; // reached the real end
      // V2.18 §5 — same direct-observation fix as fetchJiraIssuesClassic above: the cap is
      // noted at the exact point it stopped a loop that still had a real nextPageToken.
      if (issues.length >= JIRA_MAX_ISSUES) {
        truncated = true;
        break;
      }
      nextPageToken = parsed.data.nextPageToken;
    }
    return { ok: true, data: issues, recordsFetched: issues.length, method: "jql-cursor", truncated };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error contacting Jira.", errorKind: "network-error" };
  }
}

export async function fetchJiraIssuesWith(fetchImpl: FetchLike, config: JiraConnectionConfig, options: FetchIssuesOptions): Promise<JiraFetchResult<JiraIssue[]>> {
  return fetchIssuesByJqlCursor(fetchImpl, config, buildIssuesJql(options), options);
}

/**
 * V2.10 §2 — "who mentioned me in a comment?" A second, SEPARATE search from the main
 * assignee/watch sync above (fetchJiraIssuesWith) — comments are never requested in bulk
 * (see ISSUE_FIELDS's own comment about why "flagged" is the only field excluded from the
 * strict field list; pulling every comment on every issue would be the same mistake at much
 * higher cost). This only asks Jira "which issues have a comment mentioning this account",
 * scoped by the same incremental cursor already computed for the main sync (`sinceIso` —
 * pass buildIncrementalSinceParam's result in directly; this function never recomputes it).
 * The actual comment bodies/excerpts are fetched only for the small set of issue keys this
 * returns — see fetchIssueCommentsWith below.
 *
 * V2.18 §6 — confirmed P1 finding: this had no project restriction at all, unlike the main
 * issue sync (buildIssuesJql's `project in (...)`), so a FOCUSED Focus Project Scope sync
 * still searched every Jira project the account can see for mentions — an out-of-scope
 * project's mention would be fetched and could reach Personal Focus/Attention regardless of
 * scope. `projectKeys`, when passed, adds the identical `project in (...)` clause so a scoped
 * sync never even fetches an out-of-scope mention (see jira/sync/route.ts's caller, which now
 * passes the same `projectKeys` the main issue fetch already uses). Absent/empty means
 * unrestricted, matching buildIssuesJql's own "no keys -> no project clause" contract.
 */
export async function fetchMentionedIssuesWith(
  fetchImpl: FetchLike,
  config: JiraConnectionConfig,
  accountId: string,
  sinceIso?: string,
  projectKeys?: string[],
  /** P1.1 — the Jira user's UTC offset, used when `sinceIso` is an ISO instant (see formatJqlSince). */
  timezoneOffsetMinutes?: number
): Promise<JiraFetchResult<JiraIssue[]>> {
  const safeAccountId = accountId.replace(/"/g, '\\"');
  const clauses = [`comment ~ "accountid:${safeAccountId}"`];
  if (projectKeys && projectKeys.length > 0) {
    clauses.push(`project in (${projectKeys.map((k) => `"${k}"`).join(",")})`);
  }
  const since = formatJqlSince(sinceIso, timezoneOffsetMinutes);
  if (since) clauses.push(`updated >= "${since}"`);
  const jql = `${clauses.join(" AND ")} order by updated desc`;
  return fetchIssuesByJqlCursor(fetchImpl, config, jql);
}

/**
 * V2.13 §2 — "which issues are currently assigned to this account?" A third, separate,
 * narrowly-targeted search, same discipline as fetchMentionedIssuesWith above: the server-side
 * notify check (cron-notify.ts) only needs a handful of issues assigned to ONE person, never
 * the full multi-thousand-issue dataset the main sync fetches — a dedicated `assignee = X`
 * JQL is strictly cheaper than fetching everything and filtering client-side.
 */
export async function fetchAssignedIssuesWith(
  fetchImpl: FetchLike,
  config: JiraConnectionConfig,
  accountId: string,
  options: { includeDoneChangedWithinDays?: number } = {}
): Promise<JiraFetchResult<JiraIssue[]>> {
  const safeAccountId = accountId.replace(/"/g, '\\"');
  // P1.1 — open work only. `statusCategory != Done` (not `resolution = Unresolved`): the status
  // category is exactly what normalize.ts's mapStatus reads to decide "Done", it exists on every
  // Jira Cloud workflow, and it cannot disagree with it — whereas `resolution` is only set by a
  // transition post-function, so custom workflows can have Done statuses with no resolution (they
  // would stay "unresolved" forever) or resolved issues in non-Done statuses. Without this filter
  // the query returned up to 2,000 historical issues on every tick.
  // Edge case (documented, accepted): a ticket that leaves and re-enters the open set (reopened,
  // or moved Done -> To Do) is "newly assigned" again and IS announced once, since it was absent
  // from the previous baseline.
  // `includeDoneChangedWithinDays` (daily report only) also returns issues that turned Done
  // recently, so "closed in Jira" can still be detected; relative `-Nd` JQL, never an ISO date.
  const recentlyDone = options.includeDoneChangedWithinDays;
  const scope = recentlyDone && recentlyDone > 0 ? `(statusCategory != Done OR statusCategoryChangedDate >= -${Math.floor(recentlyDone)}d)` : "statusCategory != Done";
  const jql = `assignee = "${safeAccountId}" AND ${scope} order by updated desc`;
  return fetchIssuesByJqlCursor(fetchImpl, config, jql);
}

export const JIRA_COMMENT_PAGE_SIZE = 100;
export const JIRA_COMMENT_MAX_PAGES = 3;

/**
 * V2.10 §2 — best-effort comment fetch for one issue, same "called only for a small prioritized
 * set of issue keys" discipline as fetchIssueChangelogWith below (only for the keys
 * fetchMentionedIssuesWith returned, never every synced issue).
 *
 * P1.1 — was one unordered page of 100; Jira's default is oldest-first, so in a long thread the
 * NEWEST comments (the ones that mention you) were the ones cut off. Now `orderBy=-created`
 * (newest first) and up to JIRA_COMMENT_MAX_PAGES pages while `total` says more exist. Callers
 * must not assume any ordering (buildMentionEvents / latestOwnCommentAt / detectRepliedMentions
 * compare timestamps, they never index by position). A later page failing fails the whole fetch
 * (the caller retries the issue) rather than silently returning a thread with a hole in it.
 */
export async function fetchIssueCommentsWith(fetchImpl: FetchLike, config: JiraConnectionConfig, issueKey: string): Promise<JiraFetchResult<JiraComment[]>> {
  const http = withJiraRetry(fetchImpl);
  try {
    const comments: JiraComment[] = [];
    for (let page = 0; page < JIRA_COMMENT_MAX_PAGES; page++) {
      const res = await http(
        buildUrl(config.baseUrl, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, { maxResults: String(JIRA_COMMENT_PAGE_SIZE), startAt: String(comments.length), orderBy: "-created" }),
        { headers: { Authorization: authHeader(config), Accept: "application/json" }, signal: AbortSignal.timeout(JIRA_FETCH_TIMEOUT_MS) }
      );
      if (!res.ok) return { ok: false, ...(await describeJiraError(res)) };
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        return { ok: false, error: "Jira returned a response that was not valid JSON.", errorKind: "malformed-response" };
      }
      const parsed = jiraCommentPageResponseSchema.safeParse(json);
      if (!parsed.success) return { ok: false, error: "Jira's comment response did not match the expected shape.", errorKind: "malformed-response" };
      comments.push(...parsed.data.comments);
      const total = typeof parsed.data.total === "number" ? parsed.data.total : comments.length;
      if (parsed.data.comments.length === 0 || comments.length >= total) break;
    }
    return { ok: true, data: comments, recordsFetched: comments.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error contacting Jira.", errorKind: "network-error" };
  }
}

/**
 * P3.2 — the newest `limit` comments of one issue in ONE request (`orderBy=-created`, newest first),
 * for the conversation state (whose turn is it). Unlike fetchIssueCommentsWith it never paginates:
 * the state only needs the latest few comments.
 */
export async function fetchRecentCommentsWith(fetchImpl: FetchLike, config: JiraConnectionConfig, issueKey: string, limit: number = 5): Promise<JiraFetchResult<JiraComment[]>> {
  const http = withJiraRetry(fetchImpl);
  try {
    const res = await http(buildUrl(config.baseUrl, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, { maxResults: String(limit), orderBy: "-created" }), {
      headers: { Authorization: authHeader(config), Accept: "application/json" },
    });
    if (!res.ok) return { ok: false, ...(await describeJiraError(res)) };
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, error: "Jira returned a response that was not valid JSON.", errorKind: "malformed-response" };
    }
    const parsed = jiraCommentPageResponseSchema.safeParse(json);
    if (!parsed.success) return { ok: false, error: "Jira's comment response did not match the expected shape.", errorKind: "malformed-response" };
    return { ok: true, data: parsed.data.comments, recordsFetched: parsed.data.comments.length };
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
  const http = withJiraRetry(fetchImpl);
  try {
    const res = await http(buildUrl(config.baseUrl, "/rest/api/3/search/jql", {}), {
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
  const http = withJiraRetry(fetchImpl);
  try {
    const res = await http(buildUrl(config.baseUrl, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog`, { maxResults: "100" }), {
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
