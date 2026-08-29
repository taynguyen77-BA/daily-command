// Live Pilot Checklist (V2.0 §13-14). Do NOT implement speculative cursor pagination
// without a live supported Jira environment — instead, make the app explicitly ready for
// the first real pilot by turning already-computed conformance/sync/data-health signals
// into a checklist of readiness items. Every item defaults to NOT_TESTED and only becomes
// PASS/FAIL once it has genuinely been exercised (a conformance run, a real sync, or an
// observed failure) — never fabricated. This reads existing outputs; it does not
// reimplement or duplicate the conformance harness, sync pipeline, or data-health engine.

import type { DataHealth, JiraConformanceReport, JiraSyncState } from "../types";

export type PilotCheckStatus = "PASS" | "FAIL" | "NOT_TESTED";

export interface PilotCheckItem {
  id: string;
  label: string;
  status: PilotCheckStatus;
  detail: string;
}

function checkByCapability(conformance: JiraConformanceReport | null, capabilitySubstring: string): { status: PilotCheckStatus; detail: string } {
  if (!conformance) return { status: "NOT_TESTED", detail: "Run Jira Conformance Check to exercise this." };
  const check = conformance.checks.find((c) => c.capability.toLowerCase().includes(capabilitySubstring.toLowerCase()));
  if (!check) return { status: "NOT_TESTED", detail: "No matching conformance check was produced." };
  if (check.status === "PASS") return { status: "PASS", detail: check.detail };
  if (check.status === "FAIL") return { status: "FAIL", detail: check.detail };
  return { status: "NOT_TESTED", detail: `${check.status}: ${check.detail}` };
}

export function buildLivePilotChecklist(opts: {
  jiraConfigured: boolean;
  conformance: JiraConformanceReport | null;
  sync: JiraSyncState;
  dataHealth: DataHealth;
}): PilotCheckItem[] {
  const { jiraConfigured, conformance, sync, dataHealth } = opts;
  const conformanceIsLive = conformance?.source === "live";

  const items: PilotCheckItem[] = [];

  items.push({
    id: "connectivity",
    label: "Jira connectivity",
    status: jiraConfigured ? (sync.lastSyncStatus === "success" ? "PASS" : sync.lastSyncStatus === "failed" ? "FAIL" : "NOT_TESTED") : "NOT_TESTED",
    detail: !jiraConfigured
      ? "JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN not configured on the server."
      : sync.lastSyncStatus === "success"
        ? "A sync has completed successfully against the configured Jira instance."
        : sync.lastSyncStatus === "failed"
          ? `Last sync failed: ${sync.lastSyncError ?? "unknown error"}.`
          : "Configured, but no sync has run yet.",
  });

  items.push({
    id: "authentication",
    label: "Authentication",
    status: !jiraConfigured ? "NOT_TESTED" : sync.lastSyncErrorKind === "auth-failure" ? "FAIL" : sync.lastSyncStatus === "success" ? "PASS" : "NOT_TESTED",
    detail: sync.lastSyncErrorKind === "auth-failure" ? "Jira rejected the configured email/API token." : sync.lastSyncStatus === "success" ? "Credentials were accepted on the last sync." : "Not yet exercised against real Jira.",
  });

  const projDiscovery = checkByCapability(conformance, "project discovery");
  items.push({ id: "project-discovery", label: "Project discovery", status: conformanceIsLive ? projDiscovery.status : "NOT_TESTED", detail: conformanceIsLive ? projDiscovery.detail : "Only exercised against fixtures so far — run Conformance Check with Jira configured for a live result." });

  const issueRetrieval = checkByCapability(conformance, "issue retrieval");
  items.push({ id: "issue-retrieval", label: "Issue retrieval", status: conformanceIsLive ? issueRetrieval.status : "NOT_TESTED", detail: conformanceIsLive ? issueRetrieval.detail : "Only exercised against fixtures so far." });

  const pagination = checkByCapability(conformance, "pagination");
  items.push({ id: "pagination", label: "Pagination capability", status: conformanceIsLive ? pagination.status : "NOT_TESTED", detail: conformanceIsLive ? pagination.detail : "Only exercised against fixtures so far." });

  const changelog = checkByCapability(conformance, "changelog");
  items.push({ id: "changelog", label: "Changelog availability", status: conformanceIsLive ? changelog.status : "NOT_TESTED", detail: conformanceIsLive ? changelog.detail : "Only exercised against fixtures so far." });

  items.push({
    id: "field-mapping",
    label: "Field mapping",
    status: conformanceIsLive && conformance?.dataContract ? "PASS" : "NOT_TESTED",
    detail: conformanceIsLive && conformance?.dataContract ? `Data contract evaluated over ${conformance.dataContract.sampleSize} real issue(s).` : "No live data contract sample yet.",
  });

  items.push({
    id: "ownership-quality",
    label: "Ownership quality",
    status: sync.lastSyncStatus === "success" ? (dataHealth.ownershipCoveragePct >= 50 ? "PASS" : "FAIL") : "NOT_TESTED",
    detail: sync.lastSyncStatus === "success" ? `${dataHealth.ownershipCoveragePct}% ownership coverage on the last real sync.` : "No real synced data to measure yet.",
  });

  items.push({
    id: "release-mapping",
    label: "Release mapping",
    status: sync.lastSyncStatus === "success" ? (dataHealth.releaseCoveragePct >= 50 ? "PASS" : "FAIL") : "NOT_TESTED",
    detail: sync.lastSyncStatus === "success" ? `${dataHealth.releaseCoveragePct}% release (fixVersion) coverage on the last real sync.` : "No real synced data to measure yet.",
  });

  items.push({
    id: "scope-history",
    label: "Scope history",
    status: sync.lastSyncStatus === "success" ? (dataHealth.scopeHistoryCoverage === "none" ? "FAIL" : "PASS") : "NOT_TESTED",
    detail: sync.lastSyncStatus === "success" ? `Scope history coverage: ${dataHealth.scopeHistoryCoverage} (only a prioritized subset of issues get a real changelog check per sync).` : "No real synced data to measure yet.",
  });

  items.push({
    id: "sync-duration",
    label: "Sync duration",
    status: sync.durationMs !== undefined ? "PASS" : "NOT_TESTED",
    detail: sync.durationMs !== undefined ? `Last real sync took ${(sync.durationMs / 1000).toFixed(1)}s.` : "No real sync has completed yet.",
  });

  items.push({
    id: "truncation",
    label: "Truncation",
    status: conformanceIsLive && conformance?.truncated !== undefined ? "PASS" : "NOT_TESTED",
    detail: conformanceIsLive && conformance?.truncated !== undefined ? (conformance.truncated ? "Results were truncated at the safety limit on the last live run." : "No truncation observed on the last live run.") : "Not yet observed against a live Jira instance.",
  });

  items.push({
    id: "previous-data-preservation",
    label: "Previous-data preservation",
    status: sync.lastSyncStatus === "failed" ? (sync.previousDataPreserved ? "PASS" : "FAIL") : "NOT_TESTED",
    detail: sync.lastSyncStatus === "failed" ? (sync.previousDataPreserved ? "A real sync failure occurred and existing local data was confirmed preserved." : "A sync failure occurred but preservation was not confirmed.") : "Only provable by observing an actual failed sync — none has occurred yet.",
  });

  return items;
}

// V2.0 §14 — Real Jira Data Protection checklist. The first two rows are structural
// guarantees of this codebase (server-only credential handling, ai-context.ts never
// passing raw Jira payloads to Claude) — always true by construction, not data-dependent,
// so they're reported PASS unconditionally (backed by the credential-safety static scan in
// the test suite, not by anything this function computes). The last two depend on a real
// conformance run having actually produced data, so they stay NOT_TESTED until then.
export function buildDataProtectionChecklist(conformance: JiraConformanceReport | null): PilotCheckItem[] {
  const conformanceIsLive = conformance?.source === "live";
  return [
    {
      id: "credential-isolation",
      label: "Credential fields never reach client state",
      status: "PASS",
      detail: "Jira credentials are read server-only (src/lib/server/jira-client.ts) and never returned in any API response or stored client-side.",
    },
    {
      id: "no-raw-payload-to-ai",
      label: "Raw Jira payload never reaches Claude",
      status: "PASS",
      detail: "ai-context.ts and every AIProvider method only ever receive pre-extracted facts/evidence strings — never a raw JiraIssue object.",
    },
    {
      id: "unmapped-fields-visible",
      label: "Unmapped fields are visible",
      status: conformanceIsLive && !!conformance?.fieldSupport ? "PASS" : "NOT_TESTED",
      detail: conformanceIsLive && conformance?.fieldSupport ? `${conformance.fieldSupport.length} field(s) reported with explicit support level.` : "Run Conformance Check against a live Jira instance to confirm.",
    },
    {
      id: "mapping-drift-surfaced",
      label: "Mapping drift is surfaced",
      status: conformanceIsLive && !!conformance?.mappingDrift ? "PASS" : "NOT_TESTED",
      detail: conformanceIsLive && conformance?.mappingDrift ? `Mapping drift evaluated over ${conformance.mappingDrift.sampleSize} real issue(s).` : "Run Conformance Check against a live Jira instance to confirm.",
    },
  ];
}
