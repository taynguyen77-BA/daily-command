"use client";

import { useState } from "react";
import Link from "next/link";
import type { CommandCenterStore, StoreState } from "@/lib/command-center/store";
import { formatScopeLabel } from "@/lib/command-center/jira/project-scope";
import { EmptyState, Panel, SectionHeading, TrustLabel } from "@/components/command-center/ui";
import { ProjectStory } from "@/components/command-center/ProjectStory";

/** V2.13 §2 — the actual Project Memory body, extracted so it can be rendered both at its
 *  own route (`/memory/page.tsx`, kept working for direct links/bookmarks) and embedded as a
 *  collapsible "Activity Log" section inside Data & Settings (where `/memory` was moved out
 *  of the primary Nav.tsx list to, per the same "hide rarely-opened audit-log-style pages"
 *  reasoning as V2.11 §3B — unlike Delivery Loops/Decision Log, Project Memory is genuinely
 *  auto-populated with real content, so it isn't behind the advanced-sections toggle, just
 *  relocated). No logic changed from the pre-V2.13 `/memory` page — only where it renders. */
export function ProjectMemoryContent({ state, store }: { state: StoreState; store: CommandCenterStore }) {
  const [confirmingClear, setConfirmingClear] = useState(false);
  // V2.4 §14 — "Current scope" / "All projects" over the SAME state.memoryEvents array (no
  // second memory store). Only meaningful under a FOCUSED scope; defaults to showing
  // everything, matching pre-V2.4 behavior, until the user opts into filtering.
  const [scopedView, setScopedView] = useState(false);
  const allEvents = [...state.memoryEvents].reverse(); // newest first

  if (!state.loaded) {
    return (
      <EmptyState
        title="No data yet"
        description="Load the demo dataset, or import your own work items from Data & Settings."
        onLoadDemo={() => store.loadDemoData()}
      />
    );
  }

  const isFocused = state.jiraProjectScope.mode === "FOCUSED";
  // Jira project KEY -> internal Project.id, so `event.projectId` (an internal id) can be
  // checked against the persisted scope's project KEYS.
  const inScopeProjectIds = new Set(
    state.data.projects.filter((p) => p.sourceType === "jira" && p.sourceId && state.jiraProjectScope.projectKeys.includes(p.sourceId)).map((p) => p.id)
  );
  const globalEvents = allEvents.filter((e) => !e.projectId);
  const projectEvents = allEvents.filter((e) => !!e.projectId);
  // §14 "only include events that can be safely associated with the selected project" — an
  // event with no resolvable projectId is NEVER silently assigned to the current scope; it
  // always lives in the separate Global/Unscoped section below instead.
  const timeline = isFocused && scopedView ? projectEvents.filter((e) => inScopeProjectIds.has(e.projectId!)) : projectEvents;
  const projectNameById = new Map(state.data.projects.map((p) => [p.id, p.name]));

  const history = [...state.snapshotHistory].reverse(); // newest first

  return (
    <div className="space-y-6">
      <Panel className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TrustLabel kind="calculated" />
            <span className="text-sm text-text2">{history.length} snapshot(s) stored, {state.eodHistory.length} close-of-day summar(ies)</span>
          </div>
          {!confirmingClear ? (
            <button
              onClick={() => setConfirmingClear(true)}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-text2 hover:border-red hover:text-red"
            >
              Clear memory
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-text2">Delete all snapshots and close-of-day history? Live data is kept.</span>
              <button
                onClick={() => {
                  store.clearMemory();
                  setConfirmingClear(false);
                }}
                className="rounded-md bg-red px-3 py-1.5 text-xs font-medium text-white"
              >
                Yes, clear
              </button>
              <button onClick={() => setConfirmingClear(false)} className="rounded-md border border-border px-3 py-1.5 text-xs text-text2">
                Cancel
              </button>
            </div>
          )}
        </div>
        <p className="text-xs text-text3">
          Decisions live in the <Link href="/decisions" className="text-accent2 hover:underline">Decision Log</Link>, actions in the{" "}
          <Link href="/action-plan" className="text-accent2 hover:underline">Action Plan</Link>, and risks in{" "}
          <Link href="/risks" className="text-accent2 hover:underline">What Might Go Wrong</Link> — this page focuses on the
          historical snapshot record those screens compare against.
        </p>
      </Panel>

      <ProjectStory events={state.memoryEvents} />

      <section>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionHeading title="Timeline" subtitle="V1.4 §41-42 — meaningful proactive-intelligence events only, not every recomputed value." />
          {isFocused && (
            <div role="group" aria-label="Timeline scope" className="flex gap-1 rounded-md border border-border p-0.5">
              <button
                onClick={() => setScopedView(false)}
                aria-pressed={!scopedView}
                className={`rounded px-3 py-1 text-xs font-medium ${!scopedView ? "bg-surface2 text-text" : "text-text3 hover:text-text2"}`}
              >
                All projects
              </button>
              <button
                onClick={() => setScopedView(true)}
                aria-pressed={scopedView}
                className={`rounded px-3 py-1 text-xs font-medium ${scopedView ? "bg-surface2 text-text" : "text-text3 hover:text-text2"}`}
              >
                Current scope ({formatScopeLabel(state.jiraProjectScope, state.data)})
              </button>
            </div>
          )}
        </div>
        {timeline.length === 0 ? (
          <p className="py-6 text-center text-sm text-text3">
            {isFocused && scopedView
              ? "No project-associated events fall inside the current focus scope yet."
              : "No meaningful events recorded yet — drift transitions, risk escalations, and other proactive signals will appear here as they happen."}
          </p>
        ) : (
          <div className="space-y-2">
            {timeline.map((e) => (
              <Panel key={e.id} className="p-4">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text3">{e.date}</span>
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text3">{e.kind.replace(/-/g, " ")}</span>
                  {e.projectId && (
                    <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent2">
                      {projectNameById.get(e.projectId) ?? e.projectId}
                    </span>
                  )}
                </div>
                <p className="mt-1 font-display text-sm text-text">{e.title}</p>
                <p className="mt-1 text-xs text-text2">{e.impact}</p>
                {e.evidence.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-xs text-text3">
                    {e.evidence.map((ev, i) => (
                      <li key={i}>- {ev}</li>
                    ))}
                  </ul>
                )}
              </Panel>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionHeading title="Global / Unscoped" subtitle="V2.4 §14 — events with no reliable single-project association (portfolio-wide drift, releases spanning projects, personal-plan activity). Never silently assigned to a project — always visible here regardless of the toggle above." />
        {globalEvents.length === 0 ? (
          <p className="py-6 text-center text-sm text-text3">No global/unscoped events recorded yet.</p>
        ) : (
          <div className="space-y-2">
            {globalEvents.map((e) => (
              <Panel key={e.id} className="p-4">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text3">{e.date}</span>
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text3">{e.kind.replace(/-/g, " ")}</span>
                </div>
                <p className="mt-1 font-display text-sm text-text">{e.title}</p>
                <p className="mt-1 text-xs text-text2">{e.impact}</p>
                {e.evidence.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-xs text-text3">
                    {e.evidence.map((ev, i) => (
                      <li key={i}>- {ev}</li>
                    ))}
                  </ul>
                )}
              </Panel>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionHeading title="Daily Snapshots" subtitle="Oldest to newest metrics captured at each Close My Day." />
        {history.length === 0 ? (
          <p className="py-6 text-center text-sm text-text3">No snapshots yet — run &quot;Close My Day&quot; from the Command Center to start building history.</p>
        ) : (
          <div className="space-y-2">
            {history.map((snap) => (
              <Panel key={snap.date} className="p-4">
                <p className="font-display text-sm text-text">{snap.date}</p>
                {snap.metrics ? (
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-text2 sm:grid-cols-4">
                    <span>Delivery confidence: {snap.metrics.deliveryConfidence}</span>
                    <span>Attention: {snap.metrics.attentionCount}</span>
                    <span>Blocked: {snap.metrics.blockedCount}</span>
                    <span>Overdue: {snap.metrics.overdueCount}</span>
                    <span>High risks: {snap.metrics.highRiskCount}</span>
                    <span>Open decisions: {snap.metrics.openDecisionsCount}</span>
                    <span>Unresolved deps: {snap.metrics.unresolvedDependenciesCount}</span>
                    <span>Changes: {snap.metrics.meaningfulChangeCount}</span>
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-text3">No metrics recorded for this snapshot (persisted before V1.2).</p>
                )}
              </Panel>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionHeading title="Close-of-Day Summaries" />
        {state.eodHistory.length === 0 ? (
          <p className="py-6 text-center text-sm text-text3">No close-of-day summaries yet.</p>
        ) : (
          <div className="space-y-2">
            {state.eodHistory.map((entry) => (
              <Panel key={entry.date} className="p-4">
                <p className="mb-1 text-xs text-text3">{entry.date}</p>
                <pre className="whitespace-pre-wrap font-sans text-sm text-text2">{entry.summary}</pre>
              </Panel>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
