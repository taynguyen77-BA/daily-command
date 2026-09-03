"use client";

import { useEffect, useMemo, useState } from "react";
import { useCommandCenter } from "@/components/command-center/use-command-center";
import { DataImportPanel } from "@/components/command-center/DataImportPanel";
import { AiProviderIndicator, Panel, SectionHeading, TrustLabel } from "@/components/command-center/ui";
import { checkClaudeAvailability } from "@/lib/command-center/ai";
import { checkJiraConfigured, discoverJiraProjects } from "@/lib/command-center/datasource/jira-source";
import { knownJiraProjects } from "@/lib/command-center/jira/project-scope";
import {
  collectObservedStatuses,
  computeOverallWorkRelevanceCoverage,
  computeStatusCoverage,
  countOpenItemsForProjectStatus,
  WORK_RELEVANCE_EXPLANATIONS,
  type WorkRelevanceCoverage,
  type WorkRelevanceCoverageState,
} from "@/lib/command-center/jira/work-relevance";
import { PolicyChangeImpactDialog, type PendingPolicyChange } from "@/components/command-center/PolicyChangeImpactDialog";
import { WorkRelevanceCalibrationPanel } from "@/components/command-center/WorkRelevanceCalibrationPanel";
import { computeCalibrationHealthState, computePolicyReviewSignals } from "@/lib/command-center/jira/work-relevance-calibration";
import { WORK_RELEVANCE_VALUES, type WorkRelevance } from "@/lib/command-center/types";
import { computeDataHealth } from "@/lib/command-center/data-health";
import { getRecentAiTrace, getAiTraceSummary } from "@/lib/command-center/ai/trace";
import { getCacheStats } from "@/lib/command-center/ai/ai-cache";
import { getTodayIso } from "@/lib/command-center/store";
import { computeTrustDiagnostic, type TrustDiagnosticStatus } from "@/lib/command-center/trust-diagnostic";
import { buildLivePilotChecklist, buildDataProtectionChecklist, type PilotReadinessStatus, type PilotCheckItem } from "@/lib/command-center/jira/pilot-checklist";
import { isArtifactStale, rebuildDraftFromSourceRef } from "@/lib/command-center/communicate";
import { computeUsageSummary } from "@/lib/command-center/usage";
import { ArtifactEditor } from "@/components/command-center/ArtifactEditor";
import type { ArtifactDraft, ArtifactRecord, JiraConformanceReport, JiraProjectScopeMode, JiraProjectSummary } from "@/lib/command-center/types";

const PILOT_STATUS_STYLE: Record<PilotReadinessStatus, string> = {
  NOT_TESTED: "text-text3",
  READY_TO_TEST: "text-accent2",
  TESTING: "text-yellow",
  PASSED: "text-green",
  BLOCKED: "text-orange",
  FAILED: "text-red",
};

/** V2.1 §5 — one checklist item rendered as WHAT / WHY IT MATTERS / STATUS / EVIDENCE /
 *  NEXT ACTION, per the spec's worked example. Shared by both the Live Pilot Checklist and
 *  the Real Jira Data Protection checklist so they read identically. */
function PilotChecklistRow({ item }: { item: PilotCheckItem }) {
  return (
    <div className="rounded-md border border-border bg-surface2 p-3 text-xs">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-medium text-text">{item.label}</span>
        <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${PILOT_STATUS_STYLE[item.status]}`}>{item.status.replace(/_/g, " ")}</span>
      </div>
      <p className="text-text2">{item.what}</p>
      <p className="mt-1 text-text3">Why it matters: {item.whyItMatters}</p>
      <p className="mt-1 text-text2">Evidence: {item.detail}</p>
      {item.nextAction !== "None." && item.nextAction !== "None — this is a structural guarantee, verified by the credential-safety static scan." && <p className="mt-1 text-accent2">→ {item.nextAction}</p>}
    </div>
  );
}

// V2.2 §16-17 — one row of Artifact History. "Reopen" rebuilds a fresh draft from the
// record's sourceRef (when the source kind supports it — see rebuildDraftFromSourceRef)
// and compares evidenceVersion to detect staleness (§17); it never silently swaps the
// saved content — the editor shows a banner and the user explicitly chooses to refresh.
function ArtifactHistoryRow({
  record,
  onReopen,
  onDelete,
}: {
  record: ArtifactRecord;
  onReopen: (draft: ArtifactDraft, staleness: "fresh" | "stale" | "unavailable") => void;
  onDelete: () => void;
}) {
  const { filteredData, derived, proactive, personalFocus, today } = useCommandCenter();

  function reopen() {
    if (!proactive) {
      onReopen(record, "unavailable");
      return;
    }
    const fresh = rebuildDraftFromSourceRef(record.sourceRef, record.sourceContext, filteredData, derived, proactive, personalFocus, today);
    if (!fresh) {
      onReopen(record, "unavailable");
      return;
    }
    onReopen(record, isArtifactStale(record.evidenceVersion, fresh.evidenceVersion) ? "stale" : "fresh");
  }

  return (
    <div className="flex items-center justify-between rounded-md border border-border bg-surface2 p-3 text-xs">
      <div>
        <p className="font-medium text-text">
          {record.type.replace(/_/g, " ")} — {record.sourceContext}
        </p>
        <p className="text-text3">{new Date(record.createdAt).toLocaleString()}</p>
      </div>
      <div className="flex gap-2">
        <button onClick={reopen} className="rounded border border-border px-2 py-1 text-text2 hover:border-accent hover:text-text">
          Reopen
        </button>
        <button onClick={onDelete} className="rounded border border-border px-2 py-1 text-text2 hover:border-red hover:text-red">
          Delete
        </button>
      </div>
    </div>
  );
}

// V2.3 — Focus Project Scope picker. Lives inside Data & Settings (§6 — no new settings
// page). Local editing state is separate from the persisted `state.jiraProjectScope` until
// "Save Focus" is clicked (§10 — narrowing scope must be an explicit, deliberate action, not
// something that fires on every checkbox click). Project discovery (§5) is fetched on demand
// (only when the FOCUSED picker is opened), never on every render, and never fetches issues.
function JiraProjectScopePanel({
  state,
  store,
  jiraConfigured,
}: {
  state: ReturnType<typeof useCommandCenter>["state"];
  store: ReturnType<typeof useCommandCenter>["store"];
  jiraConfigured: boolean | undefined;
}) {
  const persisted = state.jiraProjectScope;
  const [mode, setMode] = useState<JiraProjectScopeMode>(persisted.mode);
  const [selected, setSelected] = useState<Set<string>>(new Set(persisted.projectKeys));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [discovered, setDiscovered] = useState<JiraProjectSummary[] | null>(null);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Fallback catalog from whatever Jira projects this browser has already synced (§12 "if
  // imported/synced data already contains project identifiers, the scope abstraction may be
  // reused") — shown immediately, before/if live discovery hasn't run yet this session.
  const knownProjects = useMemo(() => knownJiraProjects(state.data), [state.data]);
  const catalog = discovered ?? knownProjects;
  const visibleCatalog = search.trim() ? catalog.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()) || p.key.toLowerCase().includes(search.toLowerCase())) : catalog;

  async function openPicker() {
    setPickerOpen((o) => !o);
    if (discovered !== null || discoverLoading) return;
    setDiscoverLoading(true);
    setDiscoverError(null);
    const result = await discoverJiraProjects();
    setDiscoverLoading(false);
    if (!result.ok) {
      setDiscoverError(result.error ?? "Could not discover Jira projects.");
      return;
    }
    setDiscovered(result.projects ?? []);
  }

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setSaved(false);
  }

  function save() {
    store.setJiraProjectScope(mode, mode === "FOCUSED" ? Array.from(selected) : undefined);
    setSaved(true);
  }

  const dirty = mode !== persisted.mode || (mode === "FOCUSED" && (selected.size !== persisted.projectKeys.length || !persisted.projectKeys.every((k) => selected.has(k))));

  if (!jiraConfigured) {
    return (
      <Panel className="p-5">
        <SectionHeading title="Jira Project Scope" subtitle="Choose which Jira projects Daily Command Center should sync and analyze. Projects outside this scope will not be included in delivery intelligence." />
        <p className="text-sm text-text3">Project scope is available for Jira data. Configure Jira above to enable it.</p>
      </Panel>
    );
  }

  return (
    <Panel className="p-5">
      <SectionHeading
        title="Jira Project Scope"
        subtitle="Choose which Jira projects Daily Command Center should sync and analyze. Projects outside this scope will not be included in delivery intelligence."
      />
      <div className="space-y-3 text-sm">
        <div role="radiogroup" aria-label="Project scope mode" className="flex flex-col gap-2 sm:flex-row sm:gap-4">
          <label className="flex items-center gap-2 text-text2">
            <input type="radio" name="jira-scope-mode" checked={mode === "ALL"} onChange={() => { setMode("ALL"); setSaved(false); }} />
            All Jira Projects
          </label>
          <label className="flex items-center gap-2 text-text2">
            <input type="radio" name="jira-scope-mode" checked={mode === "FOCUSED"} onChange={() => { setMode("FOCUSED"); setSaved(false); }} />
            Focused Projects
          </label>
        </div>

        {mode === "ALL" && (
          <p className="rounded-md border border-yellow/30 bg-yellow/5 p-2.5 text-xs text-text2">
            Daily Command Center will include all discoverable Jira projects. For large Jira environments, Focus Projects is recommended.
          </p>
        )}

        {mode === "FOCUSED" && (
          <div className="space-y-2">
            <p className="text-xs text-text3">Only selected projects will be included in Jira sync and downstream delivery intelligence.</p>
            <button
              onClick={openPicker}
              aria-expanded={pickerOpen}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-text2 hover:border-accent hover:text-text"
            >
              {pickerOpen ? "Hide project picker" : `Select projects (${selected.size} selected)`}
            </button>
            {pickerOpen && (
              <div className="rounded-md border border-border bg-surface2 p-3">
                <label htmlFor="jira-scope-search" className="sr-only">
                  Search projects
                </label>
                <input
                  id="jira-scope-search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search projects…"
                  className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text placeholder:text-text3"
                />
                <div className="mt-2 max-h-64 space-y-0.5 overflow-y-auto" role="group" aria-label="Focus project selection">
                  {discoverLoading && <p className="p-2 text-xs text-text3">Discovering Jira projects…</p>}
                  {discoverError && <p className="p-2 text-xs text-red">{discoverError} — showing previously-synced projects instead.</p>}
                  {!discoverLoading && visibleCatalog.length === 0 && <p className="p-2 text-xs text-text3">No matching projects.</p>}
                  {visibleCatalog.map((p) => (
                    <label key={p.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-text2 hover:bg-surface">
                      <input type="checkbox" checked={selected.has(p.key)} onChange={() => toggle(p.key)} aria-label={`${p.name} (${p.key})`} />
                      <span className="font-mono text-text3">{p.key}</span>
                      <span className="truncate text-text">{p.name}</span>
                    </label>
                  ))}
                </div>
                <p className="mt-2 text-xs font-medium text-text2">{selected.size} project{selected.size === 1 ? "" : "s"} selected</p>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            onClick={save}
            disabled={mode === "FOCUSED" && selected.size === 0}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save Focus
          </button>
          {dirty && !saved && <span className="text-xs text-yellow">Unsaved changes</span>}
          {saved && !dirty && <span className="text-xs text-green">Saved</span>}
        </div>

        <div className="rounded-md border border-border bg-surface2 p-2.5 text-xs">
          <p className="text-text3">Current scope</p>
          {persisted.mode === "ALL" ? (
            <p className="mt-0.5 text-text">ALL — every discoverable Jira project.</p>
          ) : persisted.projectKeys.length === 0 ? (
            <p className="mt-0.5 text-red">
              No Focus Projects selected. Daily Command Center cannot build Jira-based delivery intelligence until at least one project is selected.
            </p>
          ) : (
            <p className="mt-0.5 text-text">{persisted.projectKeys.join(" · ")}</p>
          )}
        </div>
      </div>
    </Panel>
  );
}

const RELEVANCE_SELECT_STYLE: Record<WorkRelevance, string> = {
  ACTIONABLE: "text-green",
  WAITING: "text-yellow",
  OBSERVE: "text-accent2",
  COMPLETED: "text-text3",
  EXCLUDED: "text-red",
  UNKNOWN: "text-text3",
};

// V2.6 §4 — coverage state labels/colors, reused wherever a WorkRelevanceCoverage is shown.
const COVERAGE_STATE_LABEL: Record<WorkRelevanceCoverageState, string> = {
  FULLY_CLASSIFIED: "Fully classified",
  PARTIALLY_CLASSIFIED: "Partially classified",
  NOT_CLASSIFIED: "Not classified",
  NO_JIRA_DATA: "No Jira data",
};
const COVERAGE_STATE_STYLE: Record<WorkRelevanceCoverageState, string> = {
  FULLY_CLASSIFIED: "text-green",
  PARTIALLY_CLASSIFIED: "text-yellow",
  NOT_CLASSIFIED: "text-red",
  NO_JIRA_DATA: "text-text3",
};

function CoverageStatBar({ coverage }: { coverage: WorkRelevanceCoverage }) {
  return (
    <div className="rounded-md border border-border bg-surface p-2.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-text2">
          {coverage.observedStatusCount} observed status{coverage.observedStatusCount === 1 ? "" : "es"} · {coverage.classifiedStatusCount} classified · {coverage.unclassifiedStatusCount} unclassified
        </p>
        <span className={`font-display ${COVERAGE_STATE_STYLE[coverage.state]}`}>
          {coverage.state === "NO_JIRA_DATA" ? COVERAGE_STATE_LABEL[coverage.state] : `${coverage.coveragePct}% policy coverage`}
        </span>
      </div>
      {coverage.state !== "NO_JIRA_DATA" && coverage.state !== "FULLY_CLASSIFIED" && (
        <p className="mt-1 text-text3">
          ⚠ {coverage.unclassifiedStatusCount} status{coverage.unclassifiedStatusCount === 1 ? "" : "es"} need{coverage.unclassifiedStatusCount === 1 ? "s" : ""} classification
        </p>
      )}
    </div>
  );
}

// V2.5 — Work Relevance & Jira Status Policy. Lives inside Data & Settings, right beside
// Jira Project Scope (§8 "no new settings page"). One project at a time, statuses derived
// from OBSERVED Jira data (§6), grouped by their current classification so the layout
// matches the spec's own worked example.
// V2.6 — calibration layer on top: (1) restricted to the existing Focus Project Scope by
// default with an ALL-mode warning (§11), (2) a deterministic coverage readout per project
// (§3-4), (3) a status change no longer applies immediately — it opens a Policy Change
// Impact Preview computed from CURRENT data, and only takes effect on explicit "Apply
// Policy Change" (§8-9). store.setJiraStatusRelevance (the only place a classification is
// ever set — see jira/work-relevance.ts) is unchanged; this panel just gates the call
// behind a confirmation step.
function JiraWorkRelevancePolicyPanel({
  state,
  store,
  jiraConfigured,
  workRelevanceIndex,
}: {
  state: ReturnType<typeof useCommandCenter>["state"];
  store: ReturnType<typeof useCommandCenter>["store"];
  jiraConfigured: boolean | undefined;
  workRelevanceIndex: ReturnType<typeof useCommandCenter>["workRelevanceIndex"];
}) {
  const allKnownProjects = useMemo(() => knownJiraProjects(state.data), [state.data]);
  // V2.6 §11 — "primarily operate against the user's existing jiraProjectScope"; FOCUSED
  // narrows the picker to those projects, ALL shows every known project with a warning.
  const isFocusedScope = state.jiraProjectScope.mode === "FOCUSED";
  const projects = useMemo(
    () => (isFocusedScope ? allKnownProjects.filter((p) => state.jiraProjectScope.projectKeys.includes(p.key)) : allKnownProjects),
    [allKnownProjects, isFocusedScope, state.jiraProjectScope.projectKeys]
  );
  const [selectedProject, setSelectedProject] = useState<string>("");
  const activeProjectKey = selectedProject && projects.some((p) => p.key === selectedProject) ? selectedProject : projects[0]?.key ?? "";

  const observedStatuses = useMemo(() => (activeProjectKey ? collectObservedStatuses(state.data, activeProjectKey) : []), [state.data, activeProjectKey]);
  const statusMap = state.jiraWorkRelevancePolicy[activeProjectKey]?.statusMap ?? {};
  const coverage = useMemo(() => (activeProjectKey ? computeStatusCoverage(state.data, workRelevanceIndex, activeProjectKey) : null), [state.data, workRelevanceIndex, activeProjectKey]);

  const [pendingChange, setPendingChange] = useState<PendingPolicyChange | null>(null);

  function requestChange(status: string, next: WorkRelevance) {
    const current = statusMap[status] ?? "UNKNOWN";
    if (current === next) return;
    setPendingChange({
      projectKey: activeProjectKey,
      status,
      from: current,
      to: next,
      // §8 — always a live count over current data, never invented; countOpenItemsForProjectStatus
      // can't fail here (it's plain arithmetic over `state.data`), so this is never null in
      // practice — the dialog still handles null defensively per §8 "Impact unavailable".
      affectedCount: countOpenItemsForProjectStatus(state.data, activeProjectKey, status),
    });
  }

  function applyPendingChange() {
    if (!pendingChange) return;
    store.setJiraStatusRelevance(pendingChange.projectKey, pendingChange.status, pendingChange.to);
    setPendingChange(null);
  }

  const groups: Record<WorkRelevance, string[]> = { ACTIONABLE: [], WAITING: [], OBSERVE: [], COMPLETED: [], EXCLUDED: [], UNKNOWN: [] };
  for (const status of observedStatuses) groups[statusMap[status] ?? "UNKNOWN"].push(status);

  if (!jiraConfigured) {
    return (
      <Panel className="p-5" id="jira-work-relevance-policy-panel">
        <SectionHeading
          title="Jira Work Relevance Policy"
          subtitle="A Jira workflow status is delivery/process state, not automatically a task for you. Classify each observed status per project so Daily Command Center knows the difference."
        />
        <p className="text-sm text-text3">Work Relevance Policy is available for Jira data. Configure Jira above to enable it.</p>
      </Panel>
    );
  }

  return (
    <Panel className="p-5" id="jira-work-relevance-policy-panel">
      <SectionHeading
        title="Jira Work Relevance Policy"
        subtitle="A Jira workflow status is delivery/process state, not automatically a task for you. Classify each observed status per project so Daily Command Center knows the difference."
      />
      {!isFocusedScope && (
        <p className="mb-3 rounded-md border border-yellow/30 bg-yellow/5 p-2.5 text-xs text-text2">
          Your Jira Project Scope is ALL PROJECTS — this panel may show a large status vocabulary across every synced project. Consider Focus Projects above to narrow it.
        </p>
      )}
      {allKnownProjects.length === 0 ? (
        <p className="text-sm text-text3">No Jira projects known yet — sync Jira first, then return here to classify its statuses.</p>
      ) : projects.length === 0 ? (
        <p className="text-sm text-text3">No Focus Projects are selected yet, so there&apos;s nothing to classify. Select at least one project in Jira Project Scope above.</p>
      ) : (
        <div className="space-y-3 text-sm">
          <label className="flex items-center gap-2 text-xs text-text2">
            Project
            <select
              value={activeProjectKey}
              onChange={(e) => setSelectedProject(e.target.value)}
              className="rounded-md border border-border bg-surface2 px-2 py-1 text-xs text-text"
            >
              {projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name} ({p.key})
                </option>
              ))}
            </select>
          </label>

          {coverage && <CoverageStatBar coverage={coverage} />}

          {observedStatuses.length === 0 ? (
            <p className="text-xs text-text3">No Jira statuses observed yet for {activeProjectKey} — sync Jira to populate this list.</p>
          ) : (
            <div className="space-y-3">
              {WORK_RELEVANCE_VALUES.map((relevance) => {
                const statuses = groups[relevance];
                if (statuses.length === 0) return null;
                return (
                  <div key={relevance} className="rounded-md border border-border bg-surface2 p-3">
                    <p className={`text-xs font-semibold uppercase tracking-wide ${RELEVANCE_SELECT_STYLE[relevance]}`}>
                      {relevance === "UNKNOWN" ? "UNMAPPED" : relevance}
                    </p>
                    <p className="mt-0.5 text-xs text-text3">{WORK_RELEVANCE_EXPLANATIONS[relevance]}</p>
                    <div className="mt-2 space-y-1.5">
                      {statuses.map((status) => (
                        <div key={status} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-surface px-2.5 py-1.5">
                          <span className="font-mono text-xs text-text">{status}</span>
                          <select
                            value={statusMap[status] ?? "UNKNOWN"}
                            onChange={(e) => requestChange(status, e.target.value as WorkRelevance)}
                            aria-label={`Classify Jira status "${status}" for ${activeProjectKey}`}
                            className="rounded border border-border bg-surface2 px-2 py-1 text-xs text-text"
                          >
                            {WORK_RELEVANCE_VALUES.map((v) => (
                              <option key={v} value={v}>
                                {v === "UNKNOWN" ? "Unclassified" : v}
                              </option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {pendingChange && <PolicyChangeImpactDialog change={pendingChange} onCancel={() => setPendingChange(null)} onApply={applyPendingChange} />}
    </Panel>
  );
}

const TRUST_STATUS_STYLE: Record<TrustDiagnosticStatus, string> = {
  good: "text-green",
  warn: "text-yellow",
  bad: "text-red",
  info: "text-text3",
};

const JIRA_ERROR_HELP: Record<string, string> = {
  "not-configured": "Set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN in the server environment.",
  "invalid-url": "JIRA_BASE_URL is not a valid URL.",
  "auth-failure": "Jira rejected the configured email/API token.",
  "permission-failure": "The configured Jira account lacks permission for this request.",
  "rate-limited": "Jira's rate limit was hit — try again shortly.",
  "network-error": "Could not reach the configured Jira base URL.",
  "malformed-response": "Jira returned a response this app didn't recognize.",
  unknown: "An unexpected error occurred.",
};

export default function DataSettingsPage() {
  const { state, store, scopedData, filteredData, derived, proactive, personalFocus, today, workRelevanceIndex } = useCommandCenter();
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [claudeAvailable, setClaudeAvailable] = useState<boolean | null>(null);
  const [jiraStatus, setJiraStatus] = useState<{ configured: boolean; baseUrlHost?: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncElapsedSec, setSyncElapsedSec] = useState(0);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [conformance, setConformance] = useState<JiraConformanceReport | null>(null);
  const [conformanceLoading, setConformanceLoading] = useState(false);
  const [aiTraceTick, setAiTraceTick] = useState(0);
  const [emailDraft, setEmailDraft] = useState(state.personalIdentity?.email ?? "");
  const [pendingFirstSync, setPendingFirstSync] = useState(false);
  const [pendingFullSync, setPendingFullSync] = useState(false);
  const [reopening, setReopening] = useState<{ record: ArtifactRecord; draft: ArtifactDraft; staleness: "fresh" | "stale" | "unavailable"; nonce: number } | null>(null);

  useEffect(() => {
    checkClaudeAvailability().then(setClaudeAvailable);
    checkJiraConfigured().then(setJiraStatus);
  }, []);

  // V2.9 §F-03 fix — a real sync against a large Jira instance can run for minutes with a
  // single fetch/response (no server-sent progress events to listen for). The only honest
  // client-side signal available without a backend change is elapsed time, so make that
  // visible rather than leaving a static "Syncing…" label the only sign of life.
  useEffect(() => {
    if (!syncing) return;
    setSyncElapsedSec(0);
    const start = Date.now();
    const id = window.setInterval(() => setSyncElapsedSec(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [syncing]);

  // aiTraceTick is a deliberate cache-buster: getRecentAiTrace() reads a module-level log
  // this component doesn't own.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const aiTrace = useMemo(() => getRecentAiTrace(), [aiTraceTick]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const aiTraceSummary = useMemo(() => getAiTraceSummary(getTodayIso()), [aiTraceTick]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cacheStats = useMemo(() => getCacheStats(), [aiTraceTick]);
  // V2.9 §F-02 fix — computed from scopedData (Jira Project Scope already enforced), so
  // Ownership/Due dates/Release/Scope-history/Open-work-items match the "Current dataset"
  // counts above and every other scoped screen, instead of silently reporting global figures
  // across every project this browser has ever synced under a label that doesn't say so.
  const dataHealth = useMemo(
    () => computeDataHealth(scopedData, state.dataSource, state.jiraSync.lastSyncCompletedAt, undefined, workRelevanceIndex),
    [scopedData, state.dataSource, state.jiraSync.lastSyncCompletedAt, workRelevanceIndex]
  );
  // V2.6 §10 — Data Health's own Work Relevance dimension: scoped to Focus Projects when
  // FOCUSED, every known project when ALL. Plain arithmetic (§4), never blended into any
  // other Data Health dimension.
  const workRelevanceCoverage = useMemo(
    () => computeOverallWorkRelevanceCoverage(state.data, workRelevanceIndex, state.jiraProjectScope.mode === "FOCUSED" ? state.jiraProjectScope.projectKeys : undefined),
    [state.data, workRelevanceIndex, state.jiraProjectScope]
  );
  // V2.7 §12 — Data Health's own calibration dimension. §16 — synthetic (demo/import) data
  // is never presented as if it reflects real operating behavior, so calibration is simply
  // unavailable rather than showing a fabricated state for it.
  const isSyntheticData = state.isDemo || state.dataSource !== "jira";
  const calibrationHealthState = useMemo(() => {
    if (isSyntheticData) return null;
    const scopeKeys = state.jiraProjectScope.mode === "FOCUSED" ? state.jiraProjectScope.projectKeys : undefined;
    return computeCalibrationHealthState(computePolicyReviewSignals(state.data, workRelevanceIndex, scopeKeys));
  }, [isSyntheticData, state.data, workRelevanceIndex, state.jiraProjectScope]);
  const trustDiagnostic = useMemo(
    () =>
      computeTrustDiagnostic({
        dataHealth,
        dataSource: state.dataSource,
        jiraSync: state.jiraSync,
        claudeAvailable,
        latestAiProviderState: aiTrace[0]?.providerState,
        jiraProjectScope: state.jiraProjectScope,
      }),
    [dataHealth, state.dataSource, state.jiraSync, claudeAvailable, aiTrace, state.jiraProjectScope]
  );
  const pilotChecklist = useMemo(
    () => buildLivePilotChecklist({ jiraConfigured: !!jiraStatus?.configured, conformance, conformanceRunning: conformanceLoading, sync: state.jiraSync, dataHealth }),
    [jiraStatus, conformance, conformanceLoading, state.jiraSync, dataHealth]
  );
  const dataProtectionChecklist = useMemo(
    () => buildDataProtectionChecklist(conformance, !!jiraStatus?.configured, conformanceLoading),
    [conformance, jiraStatus, conformanceLoading]
  );
  const [expandedRemediation, setExpandedRemediation] = useState<number | null>(null);

  async function runConformance() {
    setConformanceLoading(true);
    try {
      // V2.3 §19 — the currently-configured Focus Project Scope is sent along so a live
      // conformance run honestly reports against the same scope production sync would use.
      const params = new URLSearchParams({ scopeMode: state.jiraProjectScope.mode });
      if (state.jiraProjectScope.mode === "FOCUSED") {
        for (const key of state.jiraProjectScope.projectKeys) params.append("projectKey", key);
      }
      const res = await fetch(`/api/command-center/jira/conformance?${params.toString()}`);
      setConformance((await res.json()) as JiraConformanceReport);
    } finally {
      setConformanceLoading(false);
    }
  }

  // V2.9 §F-02 fix — "Current dataset" now reports the Jira Project Scope-enforced view
  // (scopedData), matching what every other screen in the app actually shows, instead of
  // every record ever locally stored (state.data) — which kept reading e.g. "342 clients"
  // after scope was narrowed to 2 Focus Projects, because narrowing scope never deletes the
  // wider sync's local data (§10, by design). rawCounts is still surfaced below whenever it
  // differs, so nothing about what's actually stored locally is hidden — only relabeled.
  const counts: [string, number][] = [
    ["Clients", scopedData.clients.length],
    ["Projects", scopedData.projects.length],
    ["Work items", scopedData.workItems.length],
    ["Requirements", scopedData.requirements.length],
    ["Risks (manual)", scopedData.risks.length],
    ["Dependencies", scopedData.dependencies.length],
    ["Decisions", scopedData.decisions.length],
    ["Actions", scopedData.actions.length],
    ["Communications", scopedData.communications.length],
  ];
  const rawStoredCounts = {
    clients: state.data.clients.length,
    projects: state.data.projects.length,
    workItems: state.data.workItems.length,
  };
  const scopeHidesStoredData =
    state.jiraProjectScope.mode === "FOCUSED" &&
    (rawStoredCounts.clients > scopedData.clients.length ||
      rawStoredCounts.projects > scopedData.projects.length ||
      rawStoredCounts.workItems > scopedData.workItems.length);

  // V2.1 §8 — gate the FIRST sync against a real Jira instance behind an explicit
  // confirmation; every sync after that (lastSyncStatus no longer "never") proceeds
  // directly, since the underlying read-only guarantee doesn't change between syncs.
  function requestSync(full: boolean) {
    if (state.jiraSync.lastSyncStatus === "never") {
      setPendingFullSync(full);
      setPendingFirstSync(true);
      return;
    }
    runSync(full);
  }

  async function runSync(full: boolean) {
    setSyncing(true);
    setSyncMessage(null);
    const result = await store.syncJira({ full });
    setSyncing(false);
    if (!result.ok) {
      setSyncMessage(`Sync failed: ${result.error ?? "unknown error"}`);
      return;
    }
    const sync = store.getSnapshot().jiraSync;
    setSyncMessage(
      `Imported: ${sync.recordsFetched ?? 0} issues. New: ${sync.recordsCreated ?? 0}. Updated: ${sync.recordsUpdated ?? 0}. Unchanged: ${sync.recordsUnchanged ?? 0}.`
    );
  }

  // V1.7 §8 — a compact, honest sync summary. Never overloads the UI (§8 "do not overload").
  const sync = state.jiraSync;

  return (
    <div className="space-y-6 pb-16">
      <SectionHeading title="Data & Settings" />

      <Panel className="p-5">
        <SectionHeading title="Why can't I trust this?" subtitle="A quick, actionable answer for each trust dimension — composed from the signals below, never a separate blended score." />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {trustDiagnostic.map((entry) => (
            <div key={entry.category} className="rounded-md border border-border bg-surface2 p-2.5 text-xs">
              <p className={`font-semibold ${TRUST_STATUS_STYLE[entry.status]}`}>{entry.category}</p>
              <p className="mt-0.5 text-text2">{entry.answer}</p>
            </div>
          ))}
        </div>
      </Panel>

      <Panel className="p-5">
        <SectionHeading title="Who are you?" subtitle="A lightweight local identity — no account, no authentication. The only source of explicit personal ownership; never inferred from names, titles, or roles." />
        <p className="mb-2 text-xs text-text3">
          Display name must exactly match the <span className="font-mono">owner</span> field on your work items/actions/decisions for a DO NOW recommendation to treat an item as explicitly yours. If related items disagree on owner, that&apos;s reported as OWNER UNCLEAR rather than guessed.
        </p>
        <div className="flex max-w-md flex-col gap-2 sm:flex-row">
          <input
            defaultValue={state.personalIdentity?.displayName ?? state.ownerName ?? ""}
            onBlur={(e) => store.setPersonalIdentity(e.target.value ? { displayName: e.target.value, email: emailDraft || undefined } : undefined)}
            placeholder="Display name, exactly as it appears in owner fields"
            className="flex-1 rounded-md border border-border bg-surface2 px-3 py-2 text-sm text-text placeholder:text-text3"
          />
          <input
            value={emailDraft}
            onChange={(e) => setEmailDraft(e.target.value)}
            onBlur={() => state.personalIdentity && store.setPersonalIdentity({ displayName: state.personalIdentity.displayName, email: emailDraft || undefined })}
            placeholder="Email (optional)"
            className="flex-1 rounded-md border border-border bg-surface2 px-3 py-2 text-sm text-text placeholder:text-text3"
          />
        </div>
      </Panel>

      <Panel className="p-5">
        <SectionHeading title="Current dataset" action={state.isDemo ? (
          <span className="rounded border border-accent/30 bg-accent/10 px-2 py-0.5 text-xs text-accent2">DEMO DATA</span>
        ) : undefined} />
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
          {counts.map(([label, n]) => (
            <div key={label} className="rounded-md border border-border bg-surface2 px-3 py-2">
              <p className="text-text3">{label}</p>
              <p className="font-display text-lg text-text">{n}</p>
            </div>
          ))}
        </div>
        {scopeHidesStoredData && (
          <p className="mt-3 text-xs text-text3">
            Scoped to your current Jira Project Scope (Focused). This browser also still holds {rawStoredCounts.clients} client(s) / {rawStoredCounts.projects} project(s) / {rawStoredCounts.workItems} work item(s) from a wider sync — narrowing scope never deletes local data. Run <span className="font-mono">Full re-sync</span> to re-pull only the current scope, or <span className="font-mono">Reset all data</span> to clear everything.
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={() => store.loadDemoData()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent2"
          >
            Load Demo Data
          </button>
          {!confirmingReset ? (
            <button
              onClick={() => setConfirmingReset(true)}
              className="rounded-md border border-border px-4 py-2 text-sm text-text2 hover:border-red hover:text-red"
            >
              Reset all data
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm text-text2">Erase everything in this browser?</span>
              <button
                onClick={() => {
                  store.resetAll();
                  setConfirmingReset(false);
                }}
                className="rounded-md bg-red px-3 py-1.5 text-sm font-medium text-white"
              >
                Yes, reset
              </button>
              <button onClick={() => setConfirmingReset(false)} className="rounded-md border border-border px-3 py-1.5 text-sm text-text2">
                Cancel
              </button>
            </div>
          )}
        </div>
      </Panel>

      <Panel className="p-5">
        <SectionHeading title="Data Source" subtitle="Demo, Local Import, or Jira — switching sources never corrupts existing data." />
        <p className="mb-3 text-sm text-text2">
          Active source: <span className="font-mono text-text">{state.dataSource}</span>
        </p>

        <div className="rounded-md border border-border bg-surface2 p-3 text-sm">
          <p className="mb-1 flex items-center gap-2">
            <TrustLabel kind="calculated" />
            <span className="font-medium text-text">Jira</span>
          </p>
          {jiraStatus === null ? (
            <p className="text-text3">Checking configuration…</p>
          ) : !jiraStatus.configured ? (
            <p className="text-text3">
              Not configured. Set <span className="font-mono">JIRA_BASE_URL</span>, <span className="font-mono">JIRA_EMAIL</span>, and{" "}
              <span className="font-mono">JIRA_API_TOKEN</span> in the server environment to enable syncing. The app continues working in
              Demo / Local Import mode until then.
            </p>
          ) : (
            <div className="space-y-1 text-text2">
              <p>Configured: <span className="text-green">yes</span></p>
              <p>Base URL: <span className="font-mono">{jiraStatus.baseUrlHost}</span></p>
              <p>Authentication: Server-side (credentials never sent to this browser)</p>
              <p>Last sync: {state.jiraSync.lastSyncCompletedAt ? new Date(state.jiraSync.lastSyncCompletedAt).toLocaleString() : "never"}</p>
              <p>
                Status:{" "}
                {state.jiraSync.lastSyncStatus === "success" && <span className="text-green">Connected</span>}
                {state.jiraSync.lastSyncStatus === "failed" && <span className="text-red">Sync failed</span>}
                {state.jiraSync.lastSyncStatus === "never" && <span className="text-text3">Not yet synced</span>}
              </p>
              {state.jiraSync.lastSyncStatus === "failed" && state.jiraSync.lastSyncError && (
                <p className="text-red">
                  {state.jiraSync.lastSyncError} {state.jiraSync.lastSyncErrorKind && JIRA_ERROR_HELP[state.jiraSync.lastSyncErrorKind]}
                  <br />
                  <span className="text-text3">Previous data was kept — nothing was lost.</span>
                </p>
              )}

              {/* V2.1 §8 — Live Pilot Safety: before the FIRST sync against this Jira
                  instance, require an explicit read-only confirmation. Subsequent syncs
                  (once lastSyncStatus is no longer "never") proceed directly — the
                  guarantee itself never changes (syncJira() is unconditionally read-only),
                  this only makes it visible and requires acknowledgment once. */}
              {pendingFirstSync ? (
                <div className="mt-3 rounded-md border border-accent/30 bg-accent/5 p-3 text-xs">
                  <p className="font-medium text-text">You are about to connect this Command Center to Jira.</p>
                  <p className="mt-2 text-text2">What will happen:</p>
                  <ul className="mt-1 list-inside list-disc space-y-0.5 text-text2">
                    <li>Read Jira projects and issues</li>
                    <li>Normalize them into the local project state</li>
                    <li>No Jira data will be modified</li>
                    <li>No Jira issues will be created or updated</li>
                    <li>Existing local data will be preserved if sync fails</li>
                  </ul>
                  {state.jiraProjectScope.mode === "ALL" && (
                    <p className="mt-2 rounded border border-yellow/30 bg-yellow/5 p-2 text-text2">
                      Your Jira Project Scope is currently <span className="font-mono">All Projects</span>. On a large Jira instance this can take several minutes and pull in every project you have access to — including ones you don&apos;t work on. If you only work on a few client projects, cancel and set <span className="font-mono">Focus Projects</span> below first; you can always sync All Projects later.
                    </p>
                  )}
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => {
                        setPendingFirstSync(false);
                        runSync(pendingFullSync);
                      }}
                      className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent2"
                    >
                      Yes, connect to Jira
                    </button>
                    <button onClick={() => setPendingFirstSync(false)} className="rounded-md border border-border px-3 py-1.5 text-xs text-text2 hover:text-text">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={() => requestSync(false)}
                    disabled={syncing}
                    className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent2 disabled:opacity-60"
                  >
                    {syncing ? `Syncing… (${syncElapsedSec}s)` : "Sync Jira"}
                  </button>
                  <button
                    onClick={() => requestSync(true)}
                    disabled={syncing}
                    className="rounded-md border border-border px-3 py-1.5 text-xs text-text2 hover:border-accent hover:text-text disabled:opacity-60"
                  >
                    Full re-sync
                  </button>
                  {state.dataSource === "jira" && (
                    <button
                      onClick={() => store.disconnectJira()}
                      className="rounded-md border border-border px-3 py-1.5 text-xs text-text2 hover:border-red hover:text-red"
                    >
                      Disconnect
                    </button>
                  )}
                </div>
              )}
              {syncing && (
                <p className="mt-2 text-xs text-text3">
                  {syncElapsedSec}s elapsed — a large Jira instance can take several minutes on a first sync. Read-only the whole time; switching to another page in this app is safe, but closing this browser tab will cancel the sync in progress.
                </p>
              )}
              {syncMessage && <p className="mt-2 text-xs text-text3">{syncMessage}</p>}

              {sync.lastSyncStatus === "success" && (
                <div className="mt-3 grid grid-cols-2 gap-2 rounded-md border border-border bg-surface p-3 text-xs sm:grid-cols-4">
                  <span>Issues fetched: {sync.recordsFetched ?? 0}</span>
                  <span>Issues changed: {(sync.recordsCreated ?? 0) + (sync.recordsUpdated ?? 0)}</span>
                  <span>Projects: {sync.projectsDiscovered ?? "—"}</span>
                  <span>Jira scope: {sync.scopeMode === "FOCUSED" ? `Focused (${sync.focusedProjectCount ?? 0})` : "All"}</span>
                  <span>Scope changes: {sync.scopeChangesDetected ?? "—"}</span>
                  <span>Pages: {sync.pages ?? "—"}</span>
                  <span>Changelog requests: {sync.changelogRequests ?? "—"}</span>
                  <span>Duration: {sync.durationMs !== undefined ? `${(sync.durationMs / 1000).toFixed(1)}s` : "—"}</span>
                  <span className="col-span-2 sm:col-span-4">Last successful sync: {sync.lastSyncCompletedAt ? new Date(sync.lastSyncCompletedAt).toLocaleTimeString() : "—"}</span>
                  {sync.warnings && sync.warnings.length > 0 && (
                    <div className="col-span-2 text-yellow sm:col-span-4">
                      {sync.warnings.map((w, i) => (
                        <p key={i}>⚠ {w}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </Panel>

      <JiraProjectScopePanel state={state} store={store} jiraConfigured={jiraStatus?.configured} />

      <JiraWorkRelevancePolicyPanel state={state} store={store} jiraConfigured={jiraStatus?.configured} workRelevanceIndex={workRelevanceIndex} />

      <WorkRelevanceCalibrationPanel
        data={state.data}
        isDemo={state.isDemo}
        dataSourceIsJira={state.dataSource === "jira"}
        jiraConfigured={jiraStatus?.configured}
        jiraProjectScope={state.jiraProjectScope}
        workRelevanceIndex={workRelevanceIndex}
        today={today}
      />

      <Panel className="p-5">
        <SectionHeading title="Jira Conformance" subtitle="Runs the same connector code (pagination, mapping, error classification) against fixtures — or, when Jira is configured, the real API — never a reimplementation." />
        <button onClick={runConformance} disabled={conformanceLoading} className="rounded-md border border-border px-3 py-1.5 text-sm text-text2 hover:border-accent hover:text-text disabled:opacity-60">
          {conformanceLoading ? "Running…" : "Run Conformance Check"}
        </button>
        {conformance && (
          <div className="mt-3 space-y-3 text-sm">
            <p className="text-xs">
              <span
                className={`rounded border px-1.5 py-0.5 font-mono font-semibold ${
                  conformance.source === "live" ? "border-green/40 text-green" : conformance.source === "live-failed" ? "border-red/40 text-red" : "border-border text-text2"
                }`}
              >
                {conformance.modeLabel ?? (conformance.source === "live" ? "LIVE JIRA MODE" : conformance.source === "live-failed" ? "LIVE ATTEMPT FAILED" : "FIXTURE MODE")}
              </span>
              <span className="ml-2 text-text3">Generated {new Date(conformance.generatedAt).toLocaleTimeString()}</span>
              {conformance.durationMs !== undefined && <span className="ml-2 text-text3">· {conformance.durationMs}ms</span>}
            </p>
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              {conformance.jiraHostname && (
                <div className="rounded-md border border-border bg-surface2 px-2 py-1.5">
                  <p className="text-text3">Jira host</p>
                  <p className="font-mono text-text">{conformance.jiraHostname}</p>
                </div>
              )}
              <div className="rounded-md border border-border bg-surface2 px-2 py-1.5">
                <p className="text-text3">Projects</p>
                <p className="font-display text-text">
                  {conformance.projectsDiscovered ?? "—"}
                  {conformance.scopeMode === "FOCUSED" && <span className="ml-1 text-xs text-text3">({conformance.focusedProjectCount ?? 0} in scope)</span>}
                </p>
              </div>
              <div className="rounded-md border border-border bg-surface2 px-2 py-1.5">
                <p className="text-text3">Issues</p>
                <p className="font-display text-text">{conformance.issuesFetched ?? "—"}</p>
              </div>
              <div className="rounded-md border border-border bg-surface2 px-2 py-1.5">
                <p className="text-text3">Truncated</p>
                <p className={`font-display ${conformance.truncated ? "text-yellow" : "text-text"}`}>{conformance.truncated === undefined ? "—" : conformance.truncated ? "Yes — results truncated at safety limit" : "No"}</p>
              </div>
            </div>
            {conformance.paginationBehavior && <p className="text-xs text-text3">Pagination: {conformance.paginationBehavior}</p>}
            {conformance.changelogBehavior && <p className="text-xs text-text3">Changelog/scope history: {conformance.changelogBehavior}</p>}
            {conformance.cursorCapability && (
              <p className="text-xs text-text3">
                Cursor-pagination capability:{" "}
                <span className={conformance.cursorCapability.capability === "SUPPORTED" ? "text-green" : conformance.cursorCapability.capability === "UNSUPPORTED" ? "text-text2" : "text-yellow"}>
                  {conformance.cursorCapability.capability}
                </span>{" "}
                — {conformance.cursorCapability.detail}
              </p>
            )}
            <div className="space-y-1">
              {conformance.checks.map((c, i) => (
                <p key={i} className="text-xs">
                  <span className={c.status === "PASS" ? "text-green" : c.status === "FAIL" ? "text-red" : c.status === "PARTIAL" || c.status === "UNKNOWN" ? "text-yellow" : "text-text3"}>{c.status}</span> <span className="text-text2">{c.capability}</span> — <span className="text-text3">{c.detail}</span>
                </p>
              ))}
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text3">Field quality (code capability)</p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[400px] text-xs">
                  <caption className="sr-only">Field quality — per-field support level and detail, a property of this app&apos;s connector code, not of any one sync&apos;s data.</caption>
                  <thead>
                    <tr className="border-b border-border text-left text-text3">
                      <th scope="col" className="py-1 pr-3 font-semibold">Field</th>
                      <th scope="col" className="py-1 pr-3 font-semibold">Support level</th>
                      <th scope="col" className="py-1 font-semibold">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {conformance.fieldSupport.map((f, i) => (
                      <tr key={i} className="border-b border-border last:border-0">
                        <td className="py-1 pr-3 font-medium text-text">{f.field}</td>
                        <td className={`py-1 pr-3 ${f.level === "SUPPORTED" ? "text-green" : f.level === "PARTIALLY_SUPPORTED" ? "text-yellow" : f.level === "UNSUPPORTED" ? "text-red" : "text-text3"}`}>{f.level.replace(/_/g, " ")}</td>
                        <td className="py-1 text-text3">{f.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {conformance.dataContract && (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text3">Data contract (this sample, {conformance.dataContract.sampleSize} issue(s))</p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[400px] text-xs">
                    <caption className="sr-only">Data contract — per-field support level observed on this {conformance.dataContract.sampleSize}-issue sample.</caption>
                    <thead>
                      <tr className="border-b border-border text-left text-text3">
                        <th scope="col" className="py-1 pr-3 font-semibold">Field</th>
                        <th scope="col" className="py-1 pr-3 font-semibold">Support level</th>
                        <th scope="col" className="py-1 font-semibold">Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {conformance.dataContract.fields.map((f, i) => (
                        <tr key={i} className="border-b border-border last:border-0">
                          <td className="py-1 pr-3 font-medium text-text">{f.field}</td>
                          <td className={`py-1 pr-3 ${f.level === "SUPPORTED" ? "text-green" : f.level === "PARTIALLY_SUPPORTED" ? "text-yellow" : f.level === "UNSUPPORTED" ? "text-red" : "text-yellow"}`}>{f.level.replace(/_/g, " ")}</td>
                          <td className="py-1 text-text3">{f.detail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {conformance.mappingDrift && (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text3">Mapping drift (this sample, {conformance.mappingDrift.sampleSize} issue(s))</p>
                <div className="space-y-2">
                  {conformance.mappingDrift.fields.map((f) => (
                    <div key={f.field} className="overflow-x-auto">
                      <p className="text-xs font-medium text-text2">{f.field}</p>
                      <table className="w-full min-w-[400px] text-xs">
                        <caption className="sr-only">Mapping drift for the {f.field} field — observed values, occurrence counts, and mapping confidence.</caption>
                        <thead>
                          <tr className="border-b border-border text-left text-text3">
                            <th scope="col" className="py-1 pr-3 font-semibold">Observed value</th>
                            <th scope="col" className="py-1 pr-3 font-semibold">Count</th>
                            <th scope="col" className="py-1 pr-3 font-semibold">Maps to</th>
                            <th scope="col" className="py-1 font-semibold">Confidence</th>
                          </tr>
                        </thead>
                        <tbody>
                          {f.values.map((v, i) => (
                            <tr key={i} className="border-b border-border last:border-0">
                              <td className="py-1 pr-3 text-text">{v.observedValue}</td>
                              <td className="py-1 pr-3 text-text3">{v.occurrences}</td>
                              <td className="py-1 pr-3 text-text2">{v.mappedTo}</td>
                              <td className={`py-1 ${v.confidence === "SUPPORTED" ? "text-green" : "text-yellow"}`} title={v.reason}>{v.confidence}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {conformance.shapeDiscovery && conformance.shapeDiscovery.observations.some((o) => o.category !== "EXPECTED") && (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text3">Real data shape discovery — non-EXPECTED observations</p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[400px] text-xs">
                    <caption className="sr-only">Real data shape discovery — field values that were AMBIGUOUS, a NEW_VARIATION, UNSUPPORTED, or a BUG, excluding EXPECTED observations.</caption>
                    <thead>
                      <tr className="border-b border-border text-left text-text3">
                        <th scope="col" className="py-1 pr-3 font-semibold">Field</th>
                        <th scope="col" className="py-1 pr-3 font-semibold">Observed value</th>
                        <th scope="col" className="py-1 pr-3 font-semibold">Category</th>
                        <th scope="col" className="py-1 font-semibold">Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {conformance.shapeDiscovery.observations
                        .filter((o) => o.category !== "EXPECTED")
                        .map((o, i) => (
                          <tr key={i} className="border-b border-border last:border-0">
                            <td className="py-1 pr-3 text-text">{o.field}</td>
                            <td className="py-1 pr-3 text-text2">{o.observedValue}</td>
                            <td className={`py-1 pr-3 ${o.category === "BUG" ? "text-red" : o.category === "AMBIGUOUS" ? "text-yellow" : "text-text2"}`}>{o.category.replace(/_/g, " ")}</td>
                            <td className="py-1 text-text3">{o.detail}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <p className="text-xs text-text3">{conformance.credentialSafety}</p>
          </div>
        )}
      </Panel>

      <Panel className="p-5">
        <SectionHeading title="Data Health" subtitle="Explicit dimensions, never a single blended score." />
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <div className="rounded-md border border-border bg-surface2 px-3 py-2">
            <p className="text-text3">Freshness</p>
            <p className="font-display text-text">{dataHealth.freshness}</p>
          </div>
          <div className="rounded-md border border-border bg-surface2 px-3 py-2">
            <p className="text-text3">Ownership</p>
            <p className="font-display text-text">{dataHealth.ownershipCoveragePct}%</p>
          </div>
          <div className="rounded-md border border-border bg-surface2 px-3 py-2">
            <p className="text-text3">Due dates</p>
            <p className="font-display text-text">{dataHealth.dueDateCoveragePct}%</p>
          </div>
          <div className="rounded-md border border-border bg-surface2 px-3 py-2">
            <p className="text-text3">Release mapping</p>
            <p className="font-display text-text">{dataHealth.releaseCoveragePct}%</p>
          </div>
          <div className="rounded-md border border-border bg-surface2 px-3 py-2">
            <p className="text-text3">Scope history</p>
            <p className="font-display text-text capitalize">{dataHealth.scopeHistoryCoverage}</p>
          </div>
          <div className="rounded-md border border-border bg-surface2 px-3 py-2">
            <p className="text-text3">Open work items</p>
            <p className="font-display text-text">{dataHealth.totalWorkItems}</p>
          </div>
          {dataHealth.unclassifiedJiraStatusCount !== undefined && (
            <div className="rounded-md border border-border bg-surface2 px-3 py-2">
              <p className="text-text3">Jira work relevance</p>
              {workRelevanceCoverage.state === "NO_JIRA_DATA" ? (
                <p className="font-display text-text3">No Jira data</p>
              ) : (
                <p className={`font-display ${dataHealth.unclassifiedJiraStatusCount > 0 ? "text-yellow" : "text-text"}`}>{workRelevanceCoverage.coveragePct}% classified</p>
              )}
            </div>
          )}
          {dataHealth.unclassifiedJiraStatusCount !== undefined && (
            <div className="rounded-md border border-border bg-surface2 px-3 py-2">
              <p className="text-text3">Work relevance calibration</p>
              <p
                className={`font-display ${
                  calibrationHealthState === "REVIEW" ? "text-yellow" : calibrationHealthState === "HEALTHY" ? "text-text" : "text-text3"
                }`}
              >
                {calibrationHealthState === null ? "N/A (synthetic data)" : calibrationHealthState === "HEALTHY" ? "Healthy" : calibrationHealthState === "REVIEW" ? "Review" : "Insufficient evidence"}
              </p>
            </div>
          )}
        </div>
        {dataHealth.unclassifiedJiraStatusCount !== undefined && workRelevanceCoverage.state !== "NO_JIRA_DATA" && workRelevanceCoverage.state !== "FULLY_CLASSIFIED" && (
          <div className="mt-3 rounded-md border border-border bg-surface2 p-3 text-xs">
            <p className="font-semibold uppercase tracking-wide text-text3">Jira Work Relevance</p>
            <p className="mt-1 text-text2">
              {workRelevanceCoverage.coveragePct}% classified — {workRelevanceCoverage.unclassifiedStatusCount} observed status{workRelevanceCoverage.unclassifiedStatusCount === 1 ? "" : "es"} unclassified.
            </p>
            <button
              onClick={() => document.getElementById("jira-work-relevance-policy-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="mt-2 font-medium text-accent2 hover:underline"
            >
              Review affected statuses
            </button>
          </div>
        )}
        {calibrationHealthState === "REVIEW" && (
          <div className="mt-3 rounded-md border border-border bg-surface2 p-3 text-xs">
            <p className="font-semibold uppercase tracking-wide text-text3">Work Relevance Calibration</p>
            <p className="mt-1 text-text2">Some statuses show behavior worth reviewing — real Action evidence doesn&apos;t line up with the current policy for at least one observed status.</p>
            <button
              onClick={() => document.getElementById("work-relevance-calibration-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="mt-2 font-medium text-accent2 hover:underline"
            >
              Review calibration
            </button>
          </div>
        )}
        {/* V2.3 §17 — makes scope visible in Data Health without introducing a blended
            "scope score"; a plain fact, styled like the trust-diagnostic rows above. */}
        {state.dataSource === "jira" && (
          <div className="mt-3 rounded-md border border-border bg-surface2 p-3 text-xs">
            <p className="font-semibold uppercase tracking-wide text-text3">Jira Scope</p>
            {state.jiraProjectScope.mode === "FOCUSED" ? (
              <p className="mt-1 text-text2">
                <span className="text-text">FOCUSED</span> — {state.jiraProjectScope.projectKeys.length} of {state.jiraSync.projectsDiscovered ?? "—"} Jira projects selected.
                <br />
                <span className="text-text3">Why it matters: Daily Command Center analyzes only these projects.</span>
              </p>
            ) : (
              <p className="mt-1 text-text2">
                <span className="text-text">ALL PROJECTS</span> — {state.jiraSync.projectsDiscovered ?? "—"} Jira projects available.
                <br />
                <span className="text-yellow">Large Jira environments may increase sync volume and processing time — consider Select Focus Projects above.</span>
              </p>
            )}
          </div>
        )}
        {dataHealth.remediation && dataHealth.remediation.length > 0 && (
          <div className="mt-4 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-text3">What to do about it</p>
            {dataHealth.remediation.map((r, i) => (
              <div key={i} className="rounded-md border border-border bg-surface2 p-3 text-xs">
                <p className="font-medium text-text">{r.dimension}</p>
                <p className="mt-1 text-text2">{r.what}</p>
                <p className="mt-1 text-text3">Why it matters: {r.whyItMatters}</p>
                <p className="mt-1 text-accent2">→ {r.whatToDo}</p>
                {r.affectedItemIds.length > 0 && (
                  <>
                    <button
                      onClick={() => setExpandedRemediation(expandedRemediation === i ? null : i)}
                      aria-expanded={expandedRemediation === i}
                      className="mt-2 font-medium text-accent2 hover:underline"
                    >
                      {expandedRemediation === i ? "Hide" : `Review affected items (${r.affectedItemIds.length})`}
                    </button>
                    {expandedRemediation === i && (
                      <ul className="mt-2 space-y-0.5 rounded border border-border bg-surface p-2 text-text2">
                        {state.data.workItems
                          .filter((w) => r.affectedItemIds.includes(w.id))
                          .map((w) => (
                            <li key={w.id}>{w.key} — {w.title}</li>
                          ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel className="p-5">
        <SectionHeading title="Pilot Readiness" subtitle="A checklist, not a score. Every item defaults to NOT TESTED until genuinely exercised — never fabricated." />
        <div className="space-y-2">
          {pilotChecklist.map((c) => (
            <PilotChecklistRow key={c.id} item={c} />
          ))}
        </div>
      </Panel>

      <Panel className="p-5">
        <SectionHeading title="Real Jira Data Protection" subtitle="Read-only remains the rule — no write-back. These checks confirm credentials/raw payloads stay isolated and drift stays visible." />
        <div className="space-y-2">
          {dataProtectionChecklist.map((c) => (
            <PilotChecklistRow key={c.id} item={c} />
          ))}
        </div>
      </Panel>

      <DataImportPanel />

      <Panel className="p-5">
        <SectionHeading title="AI provider" />
        <p className="text-sm text-text2">
          Server API key configured:{" "}
          <span className="font-mono text-text">
            {claudeAvailable === null ? "checking…" : claudeAvailable ? "yes" : "no"}
          </span>
        </p>
        <p className="mt-1 text-sm text-text3">
          {claudeAvailable
            ? "A real Claude provider is configured on the server (ANTHROPIC_API_KEY). Every AI call still validates the model's response before use, and falls back to Mock AI automatically if a call ever fails or returns malformed output."
            : "No ANTHROPIC_API_KEY is set on the server, so every AI call runs in Mock AI — development mode: summarization, risk explanation, and communication drafting are generated locally from the deterministic scoring/risk/change engines. No external model is called, and no data leaves this browser."}
        </p>
        <p className="mt-2 text-xs text-text3">
          Both API keys, when set, live only in the server environment — neither is ever sent to or readable by the browser.
          Slack, Confluence, and email integrations are not implemented — this is a future capability. Jira write-back
          (updating, commenting on, or transitioning issues) is also not implemented — every Jira interaction in this app is
          read-only; all actions on real tickets remain something you do yourself.
        </p>
      </Panel>

      <Panel className="p-5">
        <SectionHeading
          title="AI Trust (dev)"
          subtitle="Local diagnostic only — mode/schema/fallback status for recent AI calls. Never persisted, never includes prompts or credentials."
          action={
            <button onClick={() => setAiTraceTick((t) => t + 1)} className="rounded-md border border-border px-2 py-1 text-xs text-text2 hover:border-accent hover:text-text">
              Refresh
            </button>
          }
        />
        {/* V2.1 §13-14 — richer session diagnostics, still reusing existing trace/cache
            infrastructure (no new monitoring system). "Evaluation: PASS/WARN/FAIL" is
            deliberately NOT shown here — evaluateAiResponse() needs the original
            facts/evidence, which the trace never stores by design (privacy/size), so a
            live per-call evaluation count can't be honestly computed from trace alone
            without an invasive signature change across every provider method. */}
        <div className="mb-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
          <div className="rounded-md border border-border bg-surface2 px-2 py-1.5">
            <p className="text-text3">Provider</p>
            <p className="font-display text-text">{claudeAvailable ? "Configured" : "Not configured"}</p>
          </div>
          <div className="rounded-md border border-border bg-surface2 px-2 py-1.5">
            <p className="text-text3">Calls today</p>
            <p className="font-display text-text">{aiTraceSummary.callsToday}</p>
          </div>
          <div className="rounded-md border border-border bg-surface2 px-2 py-1.5">
            <p className="text-text3">Cache hits</p>
            <p className="font-display text-text">{cacheStats.hits}</p>
          </div>
          <div className="rounded-md border border-border bg-surface2 px-2 py-1.5">
            <p className="text-text3">Cache misses</p>
            <p className="font-display text-text">{cacheStats.misses}</p>
          </div>
          <div className="rounded-md border border-border bg-surface2 px-2 py-1.5">
            <p className="text-text3">Failed validation</p>
            <p className={`font-display ${aiTraceSummary.failedValidationCount > 0 ? "text-red" : "text-text"}`}>{aiTraceSummary.failedValidationCount}</p>
          </div>
        </div>
        {aiTrace.length === 0 ? (
          <p className="text-sm text-text3">No AI calls recorded yet this session — ask the Command Bar a question or open a Focus Session to generate one.</p>
        ) : (
          <div className="space-y-1">
            {aiTrace.map((t) => (
              <p key={t.id} className="flex flex-wrap items-center gap-x-2 text-xs text-text2">
                <span className="font-mono text-text3">{new Date(t.timestamp).toLocaleTimeString()}</span> {t.task}
                <AiProviderIndicator state={t.providerState ?? (t.mode === "claude" ? "REAL_CLAUDE" : "MOCK_FALLBACK")} />
                <span>schema: <span className={t.schemaValid ? "text-green" : "text-red"}>{t.schemaValid ? "valid" : "invalid"}</span></span>
                <span>fallback: <span className={t.fallbackUsed ? "text-yellow" : "text-text3"}>{t.fallbackUsed ? "yes" : "no"}</span></span>
                <span>evidence refs: {t.evidenceReferenceCount}</span>
              </p>
            ))}
          </div>
        )}
      </Panel>

      <Panel className="p-5">
        <SectionHeading title="Artifact History" subtitle="Local, bounded (last 30) — an artifact is a rendering, never a second source of truth (§16)." />
        {state.artifacts.length === 0 ? (
          <p className="text-sm text-text3">No artifacts saved yet — use a &quot;Create Update&quot; action anywhere in the Command Center.</p>
        ) : (
          <div className="space-y-2">
            {[...state.artifacts].reverse().map((record) => (
              <ArtifactHistoryRow
                key={record.id}
                record={record}
                onDelete={() => store.deleteArtifact(record.id)}
                onReopen={(draft, staleness) => setReopening({ record, draft, staleness, nonce: Date.now() })}
              />
            ))}
          </div>
        )}
      </Panel>

      <Panel className="p-5">
        <SectionHeading title="Your Usage" subtitle="Local usage data only — not a product analytics backend, and not statistically significant." />
        {(() => {
          const usage = computeUsageSummary(state.usageCounters);
          return (
            <div className="space-y-1 text-sm text-text2">
              <p>Most used: <span className="text-text">{usage.mostUsedSurface ? `${usage.mostUsedSurface.label} (${usage.mostUsedSurface.count})` : "Not enough data yet"}</span></p>
              <p>Most used artifact: <span className="text-text">{usage.mostUsedArtifactType ? `${usage.mostUsedArtifactType.label} (${usage.mostUsedArtifactType.count})` : "Not enough data yet"}</span></p>
              <p>Most used command: <span className="text-text">{usage.mostUsedCommand ? `${usage.mostUsedCommand.label} (${usage.mostUsedCommand.count})` : "Not enough data yet"}</span></p>
              <p>Unused: <span className="text-text">{usage.unusedSurfaces.length > 0 ? usage.unusedSurfaces.join(", ") : "None — every surface has been used"}</span></p>
            </div>
          );
        })()}
      </Panel>

      {reopening && (
        <ArtifactEditor
          key={reopening.nonce}
          draft={reopening.draft}
          recordId={reopening.record.id}
          initialAiDraft={reopening.record.aiDraftText}
          initialEditedText={reopening.record.editedText}
          staleness={{
            status: reopening.staleness,
            onRefresh:
              reopening.staleness === "stale" && proactive
                ? () => {
                    const fresh = rebuildDraftFromSourceRef(reopening.record.sourceRef, reopening.record.sourceContext, filteredData, derived, proactive, personalFocus, today);
                    if (fresh) setReopening({ record: reopening.record, draft: fresh, staleness: "fresh", nonce: Date.now() });
                  }
                : undefined,
          }}
          onClose={() => setReopening(null)}
        />
      )}
    </div>
  );
}
