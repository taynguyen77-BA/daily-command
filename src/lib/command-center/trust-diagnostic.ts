// V1.8 §18 — "Why can't I trust this?" A lightweight, actionable trust diagnostic that
// composes EXISTING signals only (data-health.ts, freshness.ts, JiraSyncState, AI provider
// state) — no new scoring/intelligence engine, no blended trust "score". Pure function so
// it's deterministically testable, same pattern as data-health.ts.

import type { AiProviderState, DataHealth, DataSourceType, JiraProjectScope, JiraSyncState } from "./types";

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
  // V2.3 §18 — optional; when provided, the existing "Jira" entry below also answers "why
  // am I not seeing this Jira project?" without a second blended score.
  jiraProjectScope?: JiraProjectScope;
}

export function computeTrustDiagnostic(input: TrustDiagnosticInput): TrustDiagnosticEntry[] {
  const { dataHealth, dataSource, jiraSync, claudeAvailable, latestAiProviderState, jiraProjectScope } = input;

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

  // V2.3 §18 — "Why am I not seeing this Jira project?" gets an honest, always-available
  // answer: "It is outside the current Focus Project Scope." appended to the existing Jira
  // sync status, never a separate blended score.
  const scopeSuffix =
    dataSource === "jira" && jiraProjectScope
      ? jiraProjectScope.mode === "FOCUSED"
        ? ` Focus Project Scope: FOCUSED — ${jiraProjectScope.projectKeys.length} project(s) selected. A project not in this list is outside the current scope.`
        : " Focus Project Scope: ALL Jira projects."
      : "";
  entries.push({
    category: "Jira",
    // V2.18 §5 — "partial" is its own status, distinct from both "good" (a partial sync is
    // real but incomplete data) and "bad" (nothing was lost — it just isn't finished yet).
    status:
      dataSource !== "jira"
        ? "info"
        : jiraSync.lastSyncStatus === "success"
        ? "good"
        : jiraSync.lastSyncStatus === "partial"
        ? "warn"
        : jiraSync.lastSyncStatus === "failed"
        ? "bad"
        : "warn",
    answer:
      (dataSource !== "jira"
        ? "Active data source is not Jira — this doesn't apply."
        : jiraSync.lastSyncStatus === "success"
        ? `Last sync succeeded${jiraSync.lastSyncCompletedAt ? ` at ${new Date(jiraSync.lastSyncCompletedAt).toLocaleString()}` : ""}.`
        : jiraSync.lastSyncStatus === "partial"
        ? `Last sync was partial — it reached the Jira safety cap${jiraSync.recordsFetched !== undefined ? ` (${jiraSync.recordsFetched} issue(s) fetched)` : ""}. It will automatically resume and complete on the next sync.`
        : jiraSync.lastSyncStatus === "failed"
        ? `Last sync failed${jiraSync.lastSyncError ? `: ${jiraSync.lastSyncError}` : ""}. Previous data was preserved — nothing was lost.`
        : "Jira has never been synced yet.") + scopeSuffix,
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

  // V2.1 §6/§14 — CALL_FAILED and VALIDATION_FAILED are both "the most recent call fell
  // back to Mock," just with a distinguishable reason (surfaced in AI Trust below); the
  // "Why can't I trust this?" summary treats them the same as the legacy MOCK_FALLBACK
  // value for this one-line rollup.
  const latestCallFellBack = latestAiProviderState === "MOCK_FALLBACK" || latestAiProviderState === "CALL_FAILED" || latestAiProviderState === "VALIDATION_FAILED";
  entries.push({
    category: "AI",
    status: claudeAvailable === null ? "info" : claudeAvailable ? (latestCallFellBack ? "warn" : "good") : "info",
    answer:
      claudeAvailable === null
        ? "Checking AI provider configuration…"
        : !claudeAvailable
        ? "No ANTHROPIC_API_KEY configured — every AI-labeled output this session is Mock AI (deterministic, local, clearly labeled), not real Claude."
        : latestAiProviderState === "VALIDATION_FAILED"
        ? "Claude is configured, but the most recent call's response failed validation and fell back to Mock — check AI Trust below."
        : latestAiProviderState === "CALL_FAILED"
        ? "Claude is configured, but the most recent call itself failed (network/API error) and fell back to Mock — check AI Trust below."
        : latestCallFellBack
        ? "Claude is configured, but the most recent call fell back to Mock — check AI Trust below."
        : "Claude is configured and the most recent AI call used it.",
  });

  entries.push({
    category: "Evidence",
    status: "info",
    answer: "Every calculated value in this app carries a trust label; click 'Why' on any card to inspect the underlying facts it was computed from.",
  });

  return entries;
}

// V2.1 §10 — "Before You Trust This Data": a compact rollup shown BEFORE Personal Focus /
// Control Tower, purely derived from dataHealth's already-computed coverage percentages
// (and, when available, the Jira field-support count from a conformance run) — no new
// scoring, no blended score. Every row is independently banded; the one worst dimension
// drives the single Impact/Recommended line so this stays a glance-able summary, not
// another dashboard.
export type TrustSummaryStatus = "GOOD" | "REVIEW" | "LIMITED";

export interface TrustSummaryRow {
  label: string;
  value: string;
  status: TrustSummaryStatus;
}

export interface TrustSummary {
  rows: TrustSummaryRow[];
  impact: string;
  recommended: string;
  hasData: boolean;
}

function pctBand(pct: number): TrustSummaryStatus {
  return pct >= 90 ? "GOOD" : pct >= 60 ? "REVIEW" : "LIMITED";
}

const SEVERITY: Record<TrustSummaryStatus, number> = { GOOD: 0, REVIEW: 1, LIMITED: 2 };

const IMPACT_BY_ROW: Record<string, string> = {
  Ownership: "Personal Focus may be less reliable for items without an explicit owner — they can never rank as DO_NOW.",
  "Due dates": "Deadline-driven surfaces (Personal Focus, Command Bar deadline conflicts) may be missing items with no due date recorded.",
  Release: "Release Health and delivery-drift detection may be less reliable for items with no release mapped.",
  "Scope history": "Decision Radar's staleness+scope-change signal may under-detect for issues that never got a real changelog check this sync.",
  Mappings: "Some Jira field values may not be mapping to this app's domain model as expected.",
};

export function buildBeforeYouTrustSummary(dataHealth: DataHealth, fieldSupportSummary?: { supported: number; total: number }): TrustSummary {
  if (dataHealth.totalWorkItems === 0) {
    return { rows: [], impact: "No open work items to evaluate yet.", recommended: "Load or sync data to see a trust summary.", hasData: false };
  }

  const rows: TrustSummaryRow[] = [
    { label: "Ownership", value: `${dataHealth.ownershipCoveragePct}%`, status: pctBand(dataHealth.ownershipCoveragePct) },
    { label: "Due dates", value: `${dataHealth.dueDateCoveragePct}%`, status: pctBand(dataHealth.dueDateCoveragePct) },
    { label: "Release", value: `${dataHealth.releaseCoveragePct}%`, status: pctBand(dataHealth.releaseCoveragePct) },
    {
      label: "Scope history",
      value: dataHealth.scopeHistoryCoverage.toUpperCase(),
      status: dataHealth.scopeHistoryCoverage === "full" ? "GOOD" : dataHealth.scopeHistoryCoverage === "partial" ? "REVIEW" : "LIMITED",
    },
  ];
  if (fieldSupportSummary) {
    rows.push({
      label: "Mappings",
      value: `${fieldSupportSummary.supported}/${fieldSupportSummary.total}`,
      status: pctBand(fieldSupportSummary.total > 0 ? (fieldSupportSummary.supported / fieldSupportSummary.total) * 100 : 100),
    });
  }

  const worst = [...rows].sort((a, b) => SEVERITY[b.status] - SEVERITY[a.status])[0];
  const impact = worst.status === "GOOD" ? "Data quality looks solid across every tracked dimension." : (IMPACT_BY_ROW[worst.label] ?? "Some intelligence surfaces may be less reliable for the affected items.");
  const recommended = worst.status === "GOOD" ? "None — no action needed." : "Review affected items in Data Health.";

  return { rows, impact, recommended, hasData: true };
}
