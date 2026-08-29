// Live Pilot Checklist (V2.0 §13-14, upgraded V2.1 §5). Do NOT implement speculative
// cursor pagination without a live supported Jira environment — instead, make the app
// explicitly ready for the first real pilot by turning already-computed
// conformance/sync/data-health signals into an operator checklist. This is a STATE
// checklist, never a numeric readiness score (V2.1 §5 is explicit about this). Every item
// defaults to NOT_TESTED and only advances once it has genuinely been exercised (a
// conformance run, a real sync, or an observed failure) — never fabricated. This reads
// existing outputs; it does not reimplement or duplicate the conformance harness, sync
// pipeline, or data-health engine.

import type { DataHealth, JiraConformanceReport, JiraSyncState } from "../types";

/** V2.1 §5 — the 6-state operator workflow, not a score:
 *  NOT_TESTED     — nothing has been exercised yet (e.g. Jira not configured)
 *  READY_TO_TEST  — the prerequisite exists (credentials configured / data synced) but
 *                    this specific check hasn't been run yet
 *  TESTING        — a conformance run is currently in flight (client-side only, never
 *                    persisted — this state exists only while the operator is waiting)
 *  PASSED         — genuinely exercised against a live source and it passed
 *  BLOCKED        — a live attempt was genuinely made but couldn't complete (e.g. the live
 *                    HTTP round-trip itself failed — see JiraConformanceReport.source
 *                    "live-failed") — distinct from FAILED, which means it ran and failed
 *  FAILED         — genuinely exercised against a live source and it failed */
export type PilotReadinessStatus = "NOT_TESTED" | "READY_TO_TEST" | "TESTING" | "PASSED" | "BLOCKED" | "FAILED";

export interface PilotCheckItem {
  id: string;
  label: string;
  what: string;
  whyItMatters: string;
  status: PilotReadinessStatus;
  /** EVIDENCE — the concrete observation backing `status`, never a restatement of `what`. */
  detail: string;
  nextAction: string;
}

function conformanceCheckStatus(conformance: JiraConformanceReport | null, capabilitySubstring: string): { status: PilotReadinessStatus; detail: string } {
  if (!conformance) return { status: "NOT_TESTED", detail: "No conformance run recorded yet." };
  const check = conformance.checks.find((c) => c.capability.toLowerCase().includes(capabilitySubstring.toLowerCase()));
  if (!check) return { status: "NOT_TESTED", detail: "No matching conformance check was produced." };
  if (check.status === "PASS") return { status: "PASSED", detail: check.detail };
  if (check.status === "FAIL") return { status: "FAILED", detail: check.detail };
  return { status: "NOT_TESTED", detail: `${check.status}: ${check.detail}` };
}

/** For a check whose evidence can only come from a genuinely LIVE conformance run —
 *  fixture runs keep it at READY_TO_TEST (proves nothing about the real Jira instance),
 *  a live-failed attempt marks it BLOCKED, and TESTING wins while a run is in flight. */
function liveOnlyCheck(opts: {
  jiraConfigured: boolean;
  conformance: JiraConformanceReport | null;
  conformanceRunning: boolean;
  capabilitySubstring: string;
  blockedDetail: string;
}): { status: PilotReadinessStatus; detail: string } {
  const { jiraConfigured, conformance, conformanceRunning, capabilitySubstring, blockedDetail } = opts;
  if (conformanceRunning) return { status: "TESTING", detail: "Conformance check is running…" };
  if (!jiraConfigured) return { status: "NOT_TESTED", detail: "Jira is not configured on the server." };
  if (conformance?.source === "live-failed") return { status: "BLOCKED", detail: blockedDetail };
  if (conformance?.source !== "live") {
    return { status: "READY_TO_TEST", detail: conformance ? "Only exercised against fixtures so far — that proves the code path works, not that this real Jira instance behaves the same way." : "Credentials are configured — run Jira Conformance Check to exercise this." };
  }
  return conformanceCheckStatus(conformance, capabilitySubstring);
}

export function buildLivePilotChecklist(opts: {
  jiraConfigured: boolean;
  conformance: JiraConformanceReport | null;
  conformanceRunning?: boolean;
  sync: JiraSyncState;
  dataHealth: DataHealth;
}): PilotCheckItem[] {
  const { jiraConfigured, conformance, sync, dataHealth } = opts;
  const conformanceRunning = !!opts.conformanceRunning;
  const liveFailedDetail = `The live connection attempt to ${conformance?.jiraHostname ?? "the configured Jira instance"} did not complete — see the conformance report for the underlying error.`;

  const items: PilotCheckItem[] = [];

  items.push({
    id: "connectivity",
    label: "Jira connectivity",
    what: "Confirms the connector can reach the configured Jira instance at all.",
    whyItMatters: "Everything else in this checklist depends on a working connection — if this fails, nothing downstream can be genuinely tested.",
    status: !jiraConfigured
      ? "NOT_TESTED"
      : sync.lastSyncStatus === "success"
        ? "PASSED"
        : sync.lastSyncStatus === "failed"
          ? "FAILED"
          : "READY_TO_TEST",
    detail: !jiraConfigured
      ? "JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN not configured on the server."
      : sync.lastSyncStatus === "success"
        ? "A sync has completed successfully against the configured Jira instance."
        : sync.lastSyncStatus === "failed"
          ? `Last sync failed: ${sync.lastSyncError ?? "unknown error"}.`
          : "Credentials are configured, but no sync has run yet.",
    nextAction: !jiraConfigured ? "Set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN in the server environment." : sync.lastSyncStatus === "success" ? "None — connectivity is confirmed." : "Run a Jira sync from Data & Settings.",
  });

  items.push({
    id: "authentication",
    label: "Authentication",
    what: "Confirms the configured Jira email/API token is actually accepted.",
    whyItMatters: "A misconfigured or expired token fails silently unless it's actually exercised — this distinguishes 'not configured' from 'configured but rejected.'",
    status: !jiraConfigured ? "NOT_TESTED" : sync.lastSyncErrorKind === "auth-failure" ? "FAILED" : sync.lastSyncStatus === "success" ? "PASSED" : "READY_TO_TEST",
    detail: sync.lastSyncErrorKind === "auth-failure" ? "Jira rejected the configured email/API token." : sync.lastSyncStatus === "success" ? "Credentials were accepted on the last real sync." : "Not yet exercised against real Jira.",
    nextAction: !jiraConfigured ? "Configure credentials first." : sync.lastSyncErrorKind === "auth-failure" ? "Verify the API token hasn't expired and the email matches the token owner." : sync.lastSyncStatus === "success" ? "None." : "Run a Jira sync.",
  });

  const projDiscovery = liveOnlyCheck({ jiraConfigured, conformance, conformanceRunning, capabilitySubstring: "project discovery", blockedDetail: liveFailedDetail });
  items.push({
    id: "project-discovery",
    label: "Jira project discovery",
    what: "Confirms the connector can discover the projects available to this account.",
    whyItMatters: "Confirms the connector can discover the projects available to this account.",
    ...projDiscovery,
    nextAction: projDiscovery.status === "PASSED" ? "None." : projDiscovery.status === "BLOCKED" ? "Check the Jira host/credentials, then re-run Conformance Check." : "Run Jira Conformance after configuring credentials.",
  });

  const issueRetrieval = liveOnlyCheck({ jiraConfigured, conformance, conformanceRunning, capabilitySubstring: "issue retrieval", blockedDetail: liveFailedDetail });
  items.push({
    id: "issue-retrieval",
    label: "Issue retrieval",
    what: "Confirms issues can actually be fetched from the configured Jira instance.",
    whyItMatters: "This is the core read path every other engine in the app depends on.",
    ...issueRetrieval,
    nextAction: issueRetrieval.status === "PASSED" ? "None." : issueRetrieval.status === "BLOCKED" ? "Check the Jira host/credentials, then re-run Conformance Check." : "Run Jira Conformance after configuring credentials.",
  });

  const pagination = liveOnlyCheck({ jiraConfigured, conformance, conformanceRunning, capabilitySubstring: "pagination", blockedDetail: liveFailedDetail });
  items.push({
    id: "pagination",
    label: "Pagination capability",
    what: "Confirms large result sets page correctly rather than silently truncating.",
    whyItMatters: "A pilot project with more issues than one page would silently lose data if pagination were broken.",
    ...pagination,
    nextAction: pagination.status === "PASSED" ? "None." : pagination.status === "BLOCKED" ? "Check the Jira host/credentials, then re-run Conformance Check." : "Run Jira Conformance after configuring credentials.",
  });

  const changelog = liveOnlyCheck({ jiraConfigured, conformance, conformanceRunning, capabilitySubstring: "changelog", blockedDetail: liveFailedDetail });
  items.push({
    id: "changelog",
    label: "Changelog availability",
    what: "Confirms issue changelogs (used for scope-drift detection) are reachable.",
    whyItMatters: "Scope-history coverage depends entirely on this — without it, scope drift can never be detected for real data.",
    ...changelog,
    nextAction: changelog.status === "PASSED" ? "None." : changelog.status === "BLOCKED" ? "Check the Jira host/credentials, then re-run Conformance Check." : "Run Jira Conformance after configuring credentials.",
  });

  const fieldMappingReady = conformanceRunning ? "TESTING" : !jiraConfigured ? "NOT_TESTED" : conformance?.source === "live-failed" ? "BLOCKED" : conformance?.source === "live" && conformance?.dataContract ? "PASSED" : "READY_TO_TEST";
  items.push({
    id: "field-mapping",
    label: "Field mapping",
    what: "Confirms real Jira field values map to this app's domain model without silent data loss.",
    whyItMatters: "Wrong or silently-dropped field mappings would make every downstream intelligence engine wrong without any visible error.",
    status: fieldMappingReady,
    detail: fieldMappingReady === "PASSED" ? `Data contract evaluated over ${conformance!.dataContract!.sampleSize} real issue(s).` : fieldMappingReady === "BLOCKED" ? liveFailedDetail : fieldMappingReady === "READY_TO_TEST" ? "Credentials configured but no live data contract sample yet." : "Jira is not configured.",
    nextAction: fieldMappingReady === "PASSED" ? "None." : fieldMappingReady === "READY_TO_TEST" ? "Run Jira Conformance Check." : fieldMappingReady === "BLOCKED" ? "Check the Jira host/credentials, then re-run Conformance Check." : "Configure Jira credentials.",
  });

  items.push({
    id: "ownership-quality",
    label: "Ownership quality",
    what: "Measures what fraction of real synced work items have an explicit owner.",
    whyItMatters: "Personal Focus can never rank an unowned item as DO_NOW — low ownership coverage silently weakens the app's most valuable surface.",
    status: sync.lastSyncStatus === "success" ? (dataHealth.ownershipCoveragePct >= 50 ? "PASSED" : "FAILED") : jiraConfigured ? "READY_TO_TEST" : "NOT_TESTED",
    detail: sync.lastSyncStatus === "success" ? `${dataHealth.ownershipCoveragePct}% ownership coverage on the last real sync.` : "No real synced data to measure yet.",
    nextAction: sync.lastSyncStatus === "success" ? (dataHealth.ownershipCoveragePct >= 50 ? "None." : "Review unowned items in Data Health.") : "Run a Jira sync.",
  });

  items.push({
    id: "release-mapping",
    label: "Release mapping",
    what: "Measures what fraction of real synced work items map to a release (fixVersion).",
    whyItMatters: "Release Health and drift detection are only as reliable as this coverage.",
    status: sync.lastSyncStatus === "success" ? (dataHealth.releaseCoveragePct >= 50 ? "PASSED" : "FAILED") : jiraConfigured ? "READY_TO_TEST" : "NOT_TESTED",
    detail: sync.lastSyncStatus === "success" ? `${dataHealth.releaseCoveragePct}% release (fixVersion) coverage on the last real sync.` : "No real synced data to measure yet.",
    nextAction: sync.lastSyncStatus === "success" ? (dataHealth.releaseCoveragePct >= 50 ? "None." : "Assign fix versions to unmapped items in Jira.") : "Run a Jira sync.",
  });

  items.push({
    id: "scope-history",
    label: "Scope history",
    what: "Confirms real changelog-derived scope-change signals are actually being captured.",
    whyItMatters: "Decision Radar's staleness+scope-change trigger depends on this being real data, not silent zeros.",
    status: sync.lastSyncStatus === "success" ? (dataHealth.scopeHistoryCoverage === "none" ? "FAILED" : "PASSED") : jiraConfigured ? "READY_TO_TEST" : "NOT_TESTED",
    detail: sync.lastSyncStatus === "success" ? `Scope history coverage: ${dataHealth.scopeHistoryCoverage} (only a prioritized subset of issues get a real changelog check per sync).` : "No real synced data to measure yet.",
    nextAction: sync.lastSyncStatus === "success" ? "None." : "Run a Jira sync.",
  });

  items.push({
    id: "sync-duration",
    label: "Sync duration",
    what: "Records how long a real sync against this Jira instance actually takes.",
    whyItMatters: "A pilot with a much larger dataset than the demo could reveal sync-time issues invisible until measured for real.",
    status: sync.durationMs !== undefined ? "PASSED" : jiraConfigured ? "READY_TO_TEST" : "NOT_TESTED",
    detail: sync.durationMs !== undefined ? `Last real sync took ${(sync.durationMs / 1000).toFixed(1)}s.` : "No real sync has completed yet.",
    nextAction: sync.durationMs !== undefined ? "None." : "Run a Jira sync.",
  });

  const truncationReady = conformanceRunning ? "TESTING" : !jiraConfigured ? "NOT_TESTED" : conformance?.source === "live-failed" ? "BLOCKED" : conformance?.source === "live" && conformance?.truncated !== undefined ? "PASSED" : "READY_TO_TEST";
  items.push({
    id: "truncation",
    label: "Truncation",
    what: "Confirms whether the safety cap on issue count was hit on the last live run.",
    whyItMatters: "A pilot dataset larger than the safety cap would silently drop data unless this is visible.",
    status: truncationReady,
    detail:
      truncationReady === "PASSED"
        ? conformance!.truncated
          ? "Results were truncated at the safety limit on the last live run."
          : "No truncation observed on the last live run."
        : truncationReady === "BLOCKED"
          ? liveFailedDetail
          : "Not yet observed against a live Jira instance.",
    nextAction: truncationReady === "PASSED" ? "None." : truncationReady === "READY_TO_TEST" ? "Run Jira Conformance Check." : truncationReady === "BLOCKED" ? "Check the Jira host/credentials, then re-run Conformance Check." : "Configure Jira credentials.",
  });

  items.push({
    id: "previous-data-preservation",
    label: "Previous-data preservation",
    what: "Confirms a failed sync leaves existing local data untouched rather than corrupting it.",
    whyItMatters: "A pilot user must be able to trust that a flaky connection never destroys their working data.",
    status: sync.lastSyncStatus === "failed" ? (sync.previousDataPreserved ? "PASSED" : "FAILED") : jiraConfigured ? "READY_TO_TEST" : "NOT_TESTED",
    detail: sync.lastSyncStatus === "failed" ? (sync.previousDataPreserved ? "A real sync failure occurred and existing local data was confirmed preserved." : "A sync failure occurred but preservation was not confirmed.") : "Only provable by observing an actual failed sync — none has occurred yet.",
    nextAction: sync.lastSyncStatus === "failed" ? "None." : "Only provable by observing a real sync failure — no action to force this safely.",
  });

  return items;
}

// V2.0 §14, upgraded V2.1 — Real Jira Data Protection checklist. The first two rows are
// structural guarantees of this codebase (server-only credential handling, ai-context.ts
// never passing raw Jira payloads to Claude) — always true by construction, not
// data-dependent, so they're reported PASSED unconditionally (backed by the
// credential-safety static scan in the test suite, not by anything this function
// computes). The last two depend on a real live conformance run having actually produced
// data, so they stay READY_TO_TEST/BLOCKED/NOT_TESTED accordingly until then.
export function buildDataProtectionChecklist(conformance: JiraConformanceReport | null, jiraConfigured = false, conformanceRunning = false): PilotCheckItem[] {
  const status = conformanceRunning ? "TESTING" : !jiraConfigured ? "NOT_TESTED" : conformance?.source === "live-failed" ? "BLOCKED" : conformance?.source === "live" ? "PASSED" : "READY_TO_TEST";
  return [
    {
      id: "credential-isolation",
      label: "Credential fields never reach client state",
      what: "Confirms Jira credentials never leave the server.",
      whyItMatters: "A pilot user must be able to trust their API token is never exposed to the browser, logs, or this app's own diagnostics.",
      status: "PASSED",
      detail: "Jira credentials are read server-only (src/lib/server/jira-client.ts) and never returned in any API response or stored client-side.",
      nextAction: "None — this is a structural guarantee, verified by the credential-safety static scan.",
    },
    {
      id: "no-raw-payload-to-ai",
      label: "Raw Jira payload never reaches Claude",
      what: "Confirms Claude only ever receives pre-extracted facts/evidence, never a raw Jira issue object.",
      whyItMatters: "Prevents accidental leakage of unreviewed Jira field content into an external AI call.",
      status: "PASSED",
      detail: "ai-context.ts and every AIProvider method only ever receive pre-extracted facts/evidence strings — never a raw JiraIssue object.",
      nextAction: "None — this is a structural guarantee, verified by the credential-safety static scan.",
    },
    {
      id: "unmapped-fields-visible",
      label: "Unmapped fields are visible",
      what: "Confirms fields this app doesn't map are surfaced, not silently dropped.",
      whyItMatters: "Silent field loss would be invisible without this check.",
      status,
      detail: status === "PASSED" ? `${conformance!.fieldSupport.length} field(s) reported with explicit support level.` : status === "BLOCKED" ? "The live connection attempt failed — see the conformance report." : "Run Conformance Check against a live Jira instance to confirm.",
      nextAction: status === "PASSED" ? "None." : status === "NOT_TESTED" ? "Configure Jira credentials." : "Run Jira Conformance Check.",
    },
    {
      id: "mapping-drift-surfaced",
      label: "Mapping drift is surfaced",
      what: "Confirms unexpected/unrecognized field values are flagged, not silently guessed.",
      whyItMatters: "Mapping drift left invisible would make Priority/Status/Type classification silently wrong for real data.",
      status,
      detail: status === "PASSED" ? `Mapping drift evaluated over ${conformance!.mappingDrift?.sampleSize ?? 0} real issue(s).` : status === "BLOCKED" ? "The live connection attempt failed — see the conformance report." : "Run Conformance Check against a live Jira instance to confirm.",
      nextAction: status === "PASSED" ? "None." : status === "NOT_TESTED" ? "Configure Jira credentials." : "Run Jira Conformance Check.",
    },
  ];
}
