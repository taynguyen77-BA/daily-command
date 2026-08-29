// V1.8 §18 — "Why can't I trust this?" A lightweight, actionable trust diagnostic that
// composes EXISTING signals only (data-health.ts, freshness.ts, JiraSyncState, AI provider
// state) — no new scoring/intelligence engine, no blended trust "score". Pure function so
// it's deterministically testable, same pattern as data-health.ts.

import type { AiProviderState, DataHealth, DataSourceType, JiraSyncState } from "./types";

export type TrustDiagnosticStatus = "good" | "warn" | "bad" | "info";

export interface TrustDiagnosticEntry {
  category: "Data" | "Coverage" | "Ownership" | "Jira" | "Scope" | "AI" | "Evidence";
  status: TrustDiagnosticStatus;
  answer: string;
}

export interface TrustDiagnosticInput {
  dataHealth: DataHealth;
  dataSource: DataSourceType;
  jiraSync: JiraSyncState;
  claudeAvailable: boolean | null;
  latestAiProviderState?: AiProviderState;
}

export function computeTrustDiagnostic(input: TrustDiagnosticInput): TrustDiagnosticEntry[] {
  const { dataHealth, dataSource, jiraSync, claudeAvailable, latestAiProviderState } = input;

  const entries: TrustDiagnosticEntry[] = [];

  entries.push({
    category: "Data",
    status: dataHealth.freshness === "fresh" ? "good" : dataHealth.freshness === "aging" ? "warn" : dataHealth.freshness === "stale" ? "bad" : "info",
    answer:
      dataHealth.freshness === "unknown"
        ? "No sync timestamp recorded yet — freshness unknown."
        : dataHealth.freshness === "fresh"
        ? "Data was synced recently."
        : dataHealth.freshness === "aging"
        ? "Data is aging — still usable, but worth a refresh soon."
        : "Data is stale — conclusions drawn from it may be outdated. Refresh before relying on it.",
  });

  const weakestCoverage = Math.min(dataHealth.ownershipCoveragePct, dataHealth.dueDateCoveragePct, dataHealth.releaseCoveragePct);
  entries.push({
    category: "Coverage",
    status: dataHealth.totalWorkItems === 0 ? "info" : weakestCoverage >= 90 ? "good" : weakestCoverage >= 60 ? "warn" : "bad",
    answer:
      dataHealth.totalWorkItems === 0
        ? "No open work items to evaluate coverage for."
        : `Ownership ${dataHealth.ownershipCoveragePct}%, due dates ${dataHealth.dueDateCoveragePct}%, release mapping ${dataHealth.releaseCoveragePct}%. See Data Health below for exactly which items are missing what.`,
  });

  entries.push({
    category: "Ownership",
    status: dataHealth.totalWorkItems === 0 ? "info" : dataHealth.ownershipCoveragePct === 100 ? "good" : dataHealth.ownershipCoveragePct >= 70 ? "warn" : "bad",
    answer:
      dataHealth.totalWorkItems === 0
        ? "No open work items to assess ownership for."
        : dataHealth.ownershipCoveragePct === 100
        ? "Every open item has an explicit owner."
        : `${dataHealth.ownershipCoveragePct}% of open items have an explicit owner — the rest are never guessed, only reported as unowned.`,
  });

  entries.push({
    category: "Jira",
    status: dataSource !== "jira" ? "info" : jiraSync.lastSyncStatus === "success" ? "good" : jiraSync.lastSyncStatus === "failed" ? "bad" : "warn",
    answer:
      dataSource !== "jira"
        ? "Active data source is not Jira — this doesn't apply."
        : jiraSync.lastSyncStatus === "success"
        ? `Last sync succeeded${jiraSync.lastSyncCompletedAt ? ` at ${new Date(jiraSync.lastSyncCompletedAt).toLocaleString()}` : ""}.`
        : jiraSync.lastSyncStatus === "failed"
        ? `Last sync failed${jiraSync.lastSyncError ? `: ${jiraSync.lastSyncError}` : ""}. Previous data was preserved — nothing was lost.`
        : "Jira has never been synced yet.",
  });

  entries.push({
    category: "Scope",
    status: dataHealth.scopeHistoryCoverage === "full" ? "good" : dataHealth.scopeHistoryCoverage === "partial" ? "warn" : "info",
    answer:
      dataHealth.scopeHistoryCoverage === "full"
        ? "Change history is complete for every open item."
        : dataHealth.scopeHistoryCoverage === "partial"
        ? "Change history is partial — only a prioritized subset of Jira issues gets a real changelog check each sync."
        : "No change-history signal is available yet for this dataset.",
  });

  entries.push({
    category: "AI",
    status: claudeAvailable === null ? "info" : claudeAvailable ? (latestAiProviderState === "MOCK_FALLBACK" ? "warn" : "good") : "info",
    answer:
      claudeAvailable === null
        ? "Checking AI provider configuration…"
        : !claudeAvailable
        ? "No ANTHROPIC_API_KEY configured — every AI-labeled output this session is Mock AI (deterministic, local, clearly labeled), not real Claude."
        : latestAiProviderState === "MOCK_FALLBACK"
        ? "Claude is configured, but the most recent call fell back to Mock (network/schema failure) — check AI Trust below."
        : "Claude is configured and the most recent AI call used it.",
  });

  entries.push({
    category: "Evidence",
    status: "info",
    answer: "Every calculated value in this app carries a trust label; click 'Why' on any card to inspect the underlying facts it was computed from.",
  });

  return entries;
}
