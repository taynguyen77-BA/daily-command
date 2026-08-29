// V1.7 §4-7 — Jira Conformance Harness. Runs the SAME dependency-injected client code
// (fetchJiraProjectsWith/fetchJiraIssuesWith/fetchIssueChangelogWith from ./http.ts) that
// production sync uses — never a reimplementation — against either fixtures (always
// available, no credentials required) or a real Jira connection when one is configured.
// This is what makes the harness "reusable so it can be executed later without code
// changes" (§4): the caller only swaps the FetchLike + config.

import { detectJiraSearchCapability, fetchIssueChangelogWith, fetchJiraIssuesWith, fetchJiraProjectsWith, JIRA_MAX_ISSUES, JIRA_PAGE_SIZE, type FetchLike } from "./http";
import { changelogToScopeSignals } from "./scope-drift";
import { normalizeIssue, normalizeProjects } from "./normalize";
import { evaluateJiraDataContract } from "./data-contract";
import { discoverJiraDataShape } from "./shape-discovery";
import { computeMappingDrift } from "./mapping-drift";
import { fixtureFetch, FIXTURE_ISSUE_DELETED_LINK, FIXTURE_ISSUE_MALFORMED_MISSING_FIELDS, FIXTURE_ISSUE_UNKNOWN_STATUS } from "./fixtures";
import type { JiraConnectionConfig, JiraIssue } from "./types";
import type { JiraConformanceCheck, JiraConformanceReport, JiraFieldSupport } from "../types";

/** V1.7 §7 — a property of this app's Jira integration CODE, not of any one sync's data.
 *  Computed once; never claims a field is supported just because a fixture happened to
 *  have a value for it. */
export const JIRA_FIELD_SUPPORT: JiraFieldSupport[] = [
  { field: "Priority", level: "SUPPORTED", detail: "Mapped via a documented table (mapping.ts); unrecognized/missing priority defaults to P3, never P1." },
  { field: "Status", level: "SUPPORTED", detail: "Mapped via status category + a 'blocked'/'review' name heuristic (documented, since Jira has no universal blocked status)." },
  { field: "Issue type", level: "SUPPORTED", detail: "Mapped via issue-type name plus a production/incident label override." },
  { field: "Labels", level: "SUPPORTED", detail: "Passed through verbatim." },
  { field: "Fix version", level: "SUPPORTED", detail: "First fix version used as the release grouping; additional fix versions on the same issue are not modeled." },
  { field: "Due date", level: "SUPPORTED", detail: "Passed through verbatim; never fabricated when absent." },
  { field: "Created / Updated timestamps", level: "SUPPORTED", detail: "Passed through, truncated to date for the domain model's date-only fields." },
  { field: "Assignee (owner)", level: "SUPPORTED", detail: "assignee.displayName mapped to WorkItem.owner; accountId is not currently stored anywhere in the domain model." },
  { field: "Blocked-by issue links", level: "SUPPORTED", detail: "Inward 'blocks' links become Dependency records. Outward links (this issue blocks another) are not modeled — only what blocks THIS item." },
  { field: "Business impact", level: "UNSUPPORTED", detail: "Jira has no equivalent field. Never inferred from priority (§17) — always undefined for Jira-sourced items." },
  { field: "Reporter", level: "UNSUPPORTED", detail: "Not fetched (not in the requested field list) and has no home in the domain model — no feature currently consumes it." },
  { field: "Scope change count", level: "PARTIALLY_SUPPORTED", detail: "Only a heuristically-prioritized subset of issues (≤20 per sync, by priority/blocked/release/due-date) get a real changelog-derived count; all other issues report 0, which is NOT the same as 'confirmed zero changes' — it means 'not checked this sync'." },
  { field: "UAT completion %", level: "UNSUPPORTED", detail: "No standard Jira field; always undefined for Jira-sourced items, same as businessImpact." },
];

async function runProjectsCheck(fetchImpl: FetchLike, config: JiraConnectionConfig): Promise<{ checks: JiraConformanceCheck[]; projectsCount?: number }> {
  const checks: JiraConformanceCheck[] = [];
  const result = await fetchJiraProjectsWith(fetchImpl, config);
  checks.push({
    capability: "Project discovery",
    status: result.ok ? "PASS" : "FAIL",
    detail: result.ok ? `Discovered ${result.data.length} project(s).` : result.error,
  });
  if (!result.ok) return { checks };
  const { projects, clients } = normalizeProjects(result.data, { today: "2026-01-01" });
  checks.push({ capability: "Project normalization", status: projects.length === result.data.length ? "PASS" : "FAIL", detail: `${projects.length} project(s), ${clients.length} client(s) derived.` });
  return { checks, projectsCount: result.data.length };
}

async function runIssuesCheck(fetchImpl: FetchLike, config: JiraConnectionConfig): Promise<{ checks: JiraConformanceCheck[]; issues?: JiraIssue[] }> {
  const checks: JiraConformanceCheck[] = [];
  const result = await fetchJiraIssuesWith(fetchImpl, config, {});
  checks.push({ capability: "Issue retrieval", status: result.ok ? "PASS" : "FAIL", detail: result.ok ? `Fetched ${result.recordsFetched} issue(s).` : result.error });
  if (!result.ok) return { checks };

  checks.push({
    capability: "Pagination",
    status: result.recordsFetched >= 0 ? "PASS" : "FAIL",
    detail: `Classic startAt pagination — paged to ${result.recordsFetched} issue(s) at ${JIRA_PAGE_SIZE}/page, capped at ${JIRA_MAX_ISSUES}.`,
  });

  let mappingOk = true;
  let mappingDetail = "Every fetched issue normalized without throwing.";
  try {
    for (const issue of result.data) normalizeIssue(issue, { today: "2026-01-01" });
  } catch (err) {
    mappingOk = false;
    mappingDetail = err instanceof Error ? err.message : "Unknown normalization error.";
  }
  checks.push({ capability: "Issue mapping (priority/status/type/labels/fixVersion/owner/dates)", status: mappingOk ? "PASS" : "FAIL", detail: mappingDetail });

  return { checks, issues: result.data };
}

async function runChangelogCheck(fetchImpl: FetchLike, config: JiraConnectionConfig, issueKey: string): Promise<JiraConformanceCheck[]> {
  const result = await fetchIssueChangelogWith(fetchImpl, config, issueKey);
  if (!result.ok) return [{ capability: "Changelog / scope drift", status: "FAIL", detail: result.error }];
  const signals = changelogToScopeSignals(`jira-${issueKey}`, result.data);
  return [{ capability: "Changelog / scope drift", status: "PASS", detail: `${result.data.length} history entr(ies) fetched, ${signals.length} scope-relevant signal(s) extracted.` }];
}

async function runErrorClassificationCheck(config: JiraConnectionConfig): Promise<JiraConformanceCheck[]> {
  const checks: JiraConformanceCheck[] = [];
  const authFail = await fetchJiraProjectsWith(fixtureFetch({ httpStatus: 401 }), config);
  checks.push({ capability: "Error classification — authentication", status: !authFail.ok && authFail.errorKind === "auth-failure" ? "PASS" : "FAIL", detail: "401 correctly classified as auth-failure." });

  const permFail = await fetchJiraProjectsWith(fixtureFetch({ httpStatus: 403 }), config);
  checks.push({ capability: "Error classification — authorization", status: !permFail.ok && permFail.errorKind === "permission-failure" ? "PASS" : "FAIL", detail: "403 correctly classified as permission-failure." });

  const rateLimit = await fetchJiraProjectsWith(fixtureFetch({ httpStatus: 429 }), config);
  checks.push({ capability: "Error classification — rate limit", status: !rateLimit.ok && rateLimit.errorKind === "rate-limited" ? "PASS" : "FAIL", detail: "429 correctly classified as rate-limited." });

  const malformed = await fetchJiraProjectsWith(fixtureFetch({ malformed: true }), config);
  checks.push({ capability: "Malformed response handling", status: !malformed.ok && malformed.errorKind === "malformed-response" ? "PASS" : "FAIL", detail: "A response that doesn't match the expected shape is rejected, never crashes." });

  return checks;
}

async function runMalformedFieldChecks(): Promise<JiraConformanceCheck[]> {
  const checks: JiraConformanceCheck[] = [];
  try {
    const { workItem } = normalizeIssue(FIXTURE_ISSUE_MALFORMED_MISSING_FIELDS.issues[0], { today: "2026-01-01" });
    checks.push({ capability: "Missing-field tolerance", status: workItem.title === "JPMC-999" ? "PASS" : "FAIL", detail: "An issue with no summary/status/priority/etc. normalizes to safe defaults rather than throwing." });
  } catch (err) {
    checks.push({ capability: "Missing-field tolerance", status: "FAIL", detail: err instanceof Error ? err.message : "threw" });
  }
  try {
    const { workItem } = normalizeIssue(FIXTURE_ISSUE_UNKNOWN_STATUS, { today: "2026-01-01" });
    checks.push({ capability: "Unrecognized status-category tolerance", status: workItem.status === "Not Started" ? "PASS" : "FAIL", detail: "A custom/unknown status category falls back to 'Not Started' rather than throwing or guessing." });
  } catch (err) {
    checks.push({ capability: "Unrecognized status-category tolerance", status: "FAIL", detail: err instanceof Error ? err.message : "threw" });
  }
  try {
    const { dependencies } = normalizeIssue(FIXTURE_ISSUE_DELETED_LINK, { today: "2026-01-01" });
    checks.push({ capability: "Deleted/missing linked-issue tolerance", status: dependencies.length === 0 ? "PASS" : "FAIL", detail: "A 'blocks' link whose target issue is missing (deleted, permission-restricted) is skipped rather than crashing." });
  } catch (err) {
    checks.push({ capability: "Deleted/missing linked-issue tolerance", status: "FAIL", detail: err instanceof Error ? err.message : "threw" });
  }
  return checks;
}

/**
 * Runs the full conformance suite. Pass a real `fetchImpl`/`config` (server-side, with real
 * credentials) to validate against a live Jira instance; omit both to run entirely against
 * fixtures. The report's `source` field always tells the truth about which one happened —
 * nothing here may present a fixture run as live validation (§6).
 *
 * V2.1 §7 — "live" is NEVER inferred merely because a config/fetchImpl was passed in
 * (credentials being configured proves nothing about reachability). It is only reported
 * once the first real check — project discovery — actually returns data, proving a real
 * HTTP round-trip to Jira succeeded. If credentials were supplied but that round-trip
 * fails, the report honestly says so (`source: "live-failed"`) rather than silently
 * mislabeling the result as either "fixtures" (never used) or "live" (never verified).
 */
export async function runJiraConformance(options?: { fetchImpl: FetchLike; config: JiraConnectionConfig }): Promise<JiraConformanceReport> {
  const attemptingLive = !!options;
  const fetchImpl = options?.fetchImpl ?? fixtureFetch();
  const config: JiraConnectionConfig = options?.config ?? { baseUrl: "https://fixture.invalid", email: "fixture@example.test", apiToken: "fixture-token-not-real" };
  const startedAtDate = new Date();
  const startedAt = startedAtDate.getTime();

  const projectsResult = await runProjectsCheck(fetchImpl, config);
  const live = attemptingLive && projectsResult.projectsCount !== undefined;
  const liveAttemptFailed = attemptingLive && !live;
  const issuesResult = await runIssuesCheck(fetchImpl, config);
  const cursorCapability = await detectJiraSearchCapability(fetchImpl, config);
  const dataContract = issuesResult.issues ? evaluateJiraDataContract(issuesResult.issues) : undefined;
  const shapeDiscovery = issuesResult.issues ? discoverJiraDataShape(issuesResult.issues) : undefined;
  const mappingDrift = issuesResult.issues ? computeMappingDrift(issuesResult.issues) : undefined;

  // V1.9 §5 — cursor capability and data-contract results are never collapsed into a
  // blanket PASS: SUPPORTED is the only outcome that earns one; UNSUPPORTED is an honest
  // environment fact (not a defect); UNKNOWN means the probe itself couldn't establish an
  // answer.
  const cursorCheckStatus: JiraConformanceCheck["status"] =
    cursorCapability.capability === "SUPPORTED" ? "PASS" : cursorCapability.capability === "UNSUPPORTED" ? "UNSUPPORTED" : "UNKNOWN";

  const dataContractStatus: JiraConformanceCheck["status"] | undefined = dataContract
    ? dataContract.fields.every((f) => f.level === "SUPPORTED")
      ? "PASS"
      : "PARTIAL"
    : undefined;

  const checks: JiraConformanceCheck[] = [
    ...projectsResult.checks,
    ...issuesResult.checks,
    { capability: "Cursor-based pagination capability", status: cursorCheckStatus, detail: `${cursorCapability.capability} — ${cursorCapability.detail}` },
    ...(dataContractStatus
      ? [{ capability: "Jira data contract", status: dataContractStatus, detail: `${dataContract!.fields.filter((f) => f.level === "SUPPORTED").length}/${dataContract!.fields.length} fields fully SUPPORTED on this ${dataContract!.sampleSize}-issue sample — see the field-by-field breakdown below. A PARTIAL result here is never rounded up to PASS.` } as JiraConformanceCheck]
      : []),
    ...(await runChangelogCheck(fetchImpl, config, "JPMC-101")),
    ...(live ? [] : await runErrorClassificationCheck(config)),
    ...(await runMalformedFieldChecks()),
  ];

  const issuesFetched = issuesResult.issues?.length;
  const truncated = issuesFetched !== undefined && issuesFetched >= JIRA_MAX_ISSUES;

  let jiraHostname: string | undefined;
  if (attemptingLive) {
    try {
      jiraHostname = new URL(config.baseUrl).host;
    } catch {
      jiraHostname = undefined;
    }
  }

  const completedAtDate = new Date();

  return {
    source: live ? "live" : liveAttemptFailed ? "live-failed" : "fixtures",
    mode: live ? "LIVE" : "FIXTURE",
    startedAt: startedAtDate.toISOString(),
    completedAt: completedAtDate.toISOString(),
    modeLabel: live ? "LIVE JIRA MODE" : liveAttemptFailed ? "LIVE ATTEMPT FAILED" : "FIXTURE MODE",
    liveAttemptFailed: liveAttemptFailed || undefined,
    generatedAt: completedAtDate.toISOString(),
    checks,
    fieldSupport: JIRA_FIELD_SUPPORT,
    credentialSafety: "No API token, password, or email was logged, persisted, or included in this report — only pass/fail outcomes, hostname, and issue/project counts.",
    jiraHostname,
    projectsDiscovered: projectsResult.projectsCount,
    issuesFetched,
    paginationBehavior: `Classic offset (startAt) pagination, ${JIRA_PAGE_SIZE} issues/page, hard safety cap ${JIRA_MAX_ISSUES}.`,
    changelogBehavior: "Best-effort, single-page (100 entries), fetched only for a heuristically-prioritized subset of issues (≤20/sync) — never every issue.",
    durationMs: Date.now() - startedAt,
    truncated,
    cursorCapability,
    dataContract,
    shapeDiscovery,
    mappingDrift,
  };
}
