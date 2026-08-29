"use client";

import { useEffect, useMemo, useState } from "react";
import { useCommandCenter } from "@/components/command-center/use-command-center";
import { DataImportPanel } from "@/components/command-center/DataImportPanel";
import { AiProviderIndicator, Panel, SectionHeading, TrustLabel } from "@/components/command-center/ui";
import { checkClaudeAvailability } from "@/lib/command-center/ai";
import { checkJiraConfigured } from "@/lib/command-center/datasource/jira-source";
import { computeDataHealth } from "@/lib/command-center/data-health";
import { getRecentAiTrace } from "@/lib/command-center/ai/trace";
import { computeTrustDiagnostic, type TrustDiagnosticStatus } from "@/lib/command-center/trust-diagnostic";
import { buildLivePilotChecklist, buildDataProtectionChecklist, type PilotCheckStatus } from "@/lib/command-center/jira/pilot-checklist";
import type { JiraConformanceReport } from "@/lib/command-center/types";

const PILOT_STATUS_STYLE: Record<PilotCheckStatus, string> = {
  PASS: "text-green",
  FAIL: "text-red",
  NOT_TESTED: "text-text3",
};

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
  const { state, store } = useCommandCenter();
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [claudeAvailable, setClaudeAvailable] = useState<boolean | null>(null);
  const [jiraStatus, setJiraStatus] = useState<{ configured: boolean; baseUrlHost?: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [conformance, setConformance] = useState<JiraConformanceReport | null>(null);
  const [conformanceLoading, setConformanceLoading] = useState(false);
  const [aiTraceTick, setAiTraceTick] = useState(0);
  const [emailDraft, setEmailDraft] = useState(state.personalIdentity?.email ?? "");

  useEffect(() => {
    checkClaudeAvailability().then(setClaudeAvailable);
    checkJiraConfigured().then(setJiraStatus);
  }, []);

  // aiTraceTick is a deliberate cache-buster: getRecentAiTrace() reads a module-level log
  // this component doesn't own.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const aiTrace = useMemo(() => getRecentAiTrace(), [aiTraceTick]);
  const dataHealth = useMemo(() => computeDataHealth(state.data, state.dataSource, state.jiraSync.lastSyncCompletedAt), [state.data, state.dataSource, state.jiraSync.lastSyncCompletedAt]);
  const trustDiagnostic = useMemo(
    () => computeTrustDiagnostic({ dataHealth, dataSource: state.dataSource, jiraSync: state.jiraSync, claudeAvailable, latestAiProviderState: aiTrace[0]?.providerState }),
    [dataHealth, state.dataSource, state.jiraSync, claudeAvailable, aiTrace]
  );
  const pilotChecklist = useMemo(
    () => buildLivePilotChecklist({ jiraConfigured: !!jiraStatus?.configured, conformance, sync: state.jiraSync, dataHealth }),
    [jiraStatus, conformance, state.jiraSync, dataHealth]
  );
  const dataProtectionChecklist = useMemo(() => buildDataProtectionChecklist(conformance), [conformance]);
  const [expandedRemediation, setExpandedRemediation] = useState<number | null>(null);

  async function runConformance() {
    setConformanceLoading(true);
    try {
      const res = await fetch("/api/command-center/jira/conformance");
      setConformance((await res.json()) as JiraConformanceReport);
    } finally {
      setConformanceLoading(false);
    }
  }

  const counts: [string, number][] = [
    ["Clients", state.data.clients.length],
    ["Projects", state.data.projects.length],
    ["Work items", state.data.workItems.length],
    ["Requirements", state.data.requirements.length],
    ["Risks (manual)", state.data.risks.length],
    ["Dependencies", state.data.dependencies.length],
    ["Decisions", state.data.decisions.length],
    ["Actions", state.data.actions.length],
    ["Communications", state.data.communications.length],
  ];

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

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => runSync(false)}
                  disabled={syncing}
                  className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent2 disabled:opacity-60"
                >
                  {syncing ? "Syncing…" : "Sync Jira"}
                </button>
                <button
                  onClick={() => runSync(true)}
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
              {syncMessage && <p className="mt-2 text-xs text-text3">{syncMessage}</p>}

              {sync.lastSyncStatus === "success" && (
                <div className="mt-3 grid grid-cols-2 gap-2 rounded-md border border-border bg-surface p-3 text-xs sm:grid-cols-4">
                  <span>Issues fetched: {sync.recordsFetched ?? 0}</span>
                  <span>Issues changed: {(sync.recordsCreated ?? 0) + (sync.recordsUpdated ?? 0)}</span>
                  <span>Projects: {sync.projectsDiscovered ?? "—"}</span>
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

      <Panel className="p-5">
        <SectionHeading title="Jira Conformance" subtitle="Runs the same connector code (pagination, mapping, error classification) against fixtures — or, when Jira is configured, the real API — never a reimplementation." />
        <button onClick={runConformance} disabled={conformanceLoading} className="rounded-md border border-border px-3 py-1.5 text-sm text-text2 hover:border-accent hover:text-text disabled:opacity-60">
          {conformanceLoading ? "Running…" : "Run Conformance Check"}
        </button>
        {conformance && (
          <div className="mt-3 space-y-3 text-sm">
            <p className="text-xs">
              <span className={`rounded border px-1.5 py-0.5 font-mono font-semibold ${conformance.source === "live" ? "border-green/40 text-green" : "border-border text-text2"}`}>
                {conformance.modeLabel ?? (conformance.source === "live" ? "LIVE JIRA MODE" : "FIXTURE MODE")}
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
                <p className="font-display text-text">{conformance.projectsDiscovered ?? "—"}</p>
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
        </div>
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
        <SectionHeading title="Live Pilot Checklist" subtitle="Ready for the first real Jira pilot? Every item defaults to NOT TESTED until genuinely exercised — never fabricated." />
        <div className="space-y-1.5">
          {pilotChecklist.map((c) => (
            <p key={c.id} className="text-xs">
              <span className={`font-semibold ${PILOT_STATUS_STYLE[c.status]}`}>{c.status.replace(/_/g, " ")}</span> <span className="text-text2">{c.label}</span> — <span className="text-text3">{c.detail}</span>
            </p>
          ))}
        </div>
      </Panel>

      <Panel className="p-5">
        <SectionHeading title="Real Jira Data Protection" subtitle="Read-only remains the rule — no write-back. These checks confirm credentials/raw payloads stay isolated and drift stays visible." />
        <div className="space-y-1.5">
          {dataProtectionChecklist.map((c) => (
            <p key={c.id} className="text-xs">
              <span className={`font-semibold ${PILOT_STATUS_STYLE[c.status]}`}>{c.status.replace(/_/g, " ")}</span> <span className="text-text2">{c.label}</span> — <span className="text-text3">{c.detail}</span>
            </p>
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
    </div>
  );
}
