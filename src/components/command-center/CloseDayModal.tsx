"use client";

// End-of-Day Control Review (V1.5 §31-33). Upgrades "Close My Day" into a review of what
// changed/improved/worsened, decisions made, actions completed/failed, risks remaining,
// open loops, and the carry-into-tomorrow list — plus the deterministic Outcome Scorecard
// and "Did Today Help?" — all before generating tomorrow's starting point.

import { useEffect, useRef, useState } from "react";
import { useCommandCenter } from "./use-command-center";
import { getAIProvider } from "@/lib/command-center/ai";
import type { EodEntry } from "@/lib/command-center/store";
import { buildSnapshotMetrics, compareSnapshots } from "@/lib/command-center/memory";
import { dailyReportToMarkdown, summarizeDailyReport } from "@/lib/command-center/daily-report";
import type { DailyReportSnapshot } from "@/lib/command-center/types";
import { AiProviderIndicator, LoopHealthBadge, TrustLabel } from "./ui";

export function CloseDayModal({ onClose }: { onClose: () => void }) {
  const { state, today, previousSnapshot, filteredData, derived, proactive, personalFocus, store } = useCommandCenter();
  const [entry, setEntry] = useState<EodEntry | null>(null);
  const [entryMode, setEntryMode] = useState<"mock" | "claude" | null>(null);
  const [loading, setLoading] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  // V2.17 Task 2 — Daily Report: an immutable point-in-time snapshot of today's memoryEvents
  // (store.ts's generateDailyReport). Seeded from state.dailyReports in case today's report
  // was already generated earlier this session — never silently regenerated on remount.
  const [dailyReport, setDailyReport] = useState<DailyReportSnapshot | null>(state.dailyReports[today] ?? null);
  const [reportCopied, setReportCopied] = useState(false);

  function generateDailyReport() {
    setDailyReport(store.generateDailyReport(today));
    setReportCopied(false);
  }

  async function copyDailyReportMarkdown() {
    if (!dailyReport) return;
    await navigator.clipboard.writeText(dailyReportToMarkdown(dailyReport));
    setReportCopied(true);
  }

  useEffect(() => {
    dialogRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const deferred = state.data.actions.filter((a) => a.status === "deferred");
  const blocked = state.data.actions.filter((a) => a.status === "blocked");
  const decisionsToday = state.data.decisions.filter((d) => d.date === today);
  const decisionsPending = state.data.decisions.filter((d) => d.status === "pending" || d.status === "ACTIVE" || d.status === "PROPOSED" || d.status === "UNDER_REVIEW");
  const decisionsOutcomeKnown = state.data.decisions.filter((d) => !!d.outcomeStatus && d.outcomeStatus !== "UNKNOWN");
  const decisionsOutcomeUnknown = state.data.decisions.filter((d) => d.date && !d.outcomeStatus);
  // V2.1 §4 — Action Effectiveness Consistency. Both this ACTIONS section and the Outcome
  // Scorecard below now read from the SAME today-filtered array (proactive.ts) with the
  // SAME strict per-class predicate, so these numbers can never disagree again — see
  // proactive.ts's actionEffectivenessToday for the fix.
  const actionsToday = proactive?.actionEffectivenessToday ?? [];
  const effectiveActions = actionsToday.filter((r) => r.classification === "EFFECTIVE");
  const partiallyEffectiveActions = actionsToday.filter((r) => r.classification === "PARTIALLY_EFFECTIVE");
  const failedActions = actionsToday.filter((r) => r.classification === "INEFFECTIVE");
  const unknownOutcomeActions = actionsToday.filter((r) => r.classification === "UNKNOWN");
  const allLoops = proactive?.deliveryLoops ?? [];
  const openLoops = allLoops.filter((l) => l.health === "STALLED" || l.health === "AT_RISK");
  const completedLoops = allLoops.filter((l) => l.health === "COMPLETED");
  const stalledLoops = allLoops.filter((l) => l.health === "STALLED");
  const scorecard = proactive?.outcomeScorecard;
  const newPriorityTomorrow = personalFocus?.top3 ?? [];
  const watchTomorrow = personalFocus?.byCategory.WATCH.slice(0, 3) ?? [];

  const currentMetrics = buildSnapshotMetrics(filteredData, today, derived.changes.length);
  const trend = compareSnapshots(currentMetrics, previousSnapshot?.metrics);
  const stableMetricsCount = trend.deltas.filter((d) => d.direction === "stable").length;

  async function run() {
    setLoading(true);
    const result = await store.closeDay();
    setEntry(result);
    setEntryMode(getAIProvider().mode);
    setLoading(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-day-modal-title"
        tabIndex={-1}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-surface p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="close-day-modal-title" className="font-display text-lg text-text">Delivery Day Review</h2>
        <p className="mt-1 text-sm text-text3">Review today&apos;s outcomes before you go.</p>

        <div className="mt-4 space-y-5 text-sm">
          <section>
            <p className="font-display text-sm text-text">TODAY&apos;S CONTROL</p>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-text3">What got better</p>
                <ul className="mt-1 space-y-0.5 text-xs text-text2">
                  {trend.gettingBetter.length === 0 ? <li>None.</li> : trend.gettingBetter.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-text3">What got worse</p>
                <ul className="mt-1 space-y-0.5 text-xs text-text2">
                  {trend.gettingWorse.length === 0 ? <li>None.</li> : trend.gettingWorse.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-text3">Unchanged</p>
                <p className="mt-1 text-xs text-text2">{trend.hasHistory ? `${stableMetricsCount} metric(s) held steady.` : "No previous snapshot to compare against yet."}</p>
              </div>
            </div>
            <p className="mt-2 text-xs text-text2">{derived.risks.length} open risk(s) remaining.</p>
          </section>

          <section>
            <p className="font-display text-sm text-text">DECISIONS</p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-text3">Made today</p>
                <p className="mt-1 text-xs text-text2">{decisionsToday.length === 0 ? "None." : decisionsToday.map((d) => d.title).join("; ")}</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-text3">Pending</p>
                <p className="mt-1 text-xs text-text2">{decisionsPending.length} decision(s) awaiting action.</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-text3">Outcome known</p>
                <p className="mt-1 text-xs text-text2">{decisionsOutcomeKnown.length} decision(s).</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-text3">Outcome unknown</p>
                <p className="mt-1 text-xs text-text2">{decisionsOutcomeUnknown.length} decision(s) made but not yet measured.</p>
              </div>
            </div>
          </section>

          <section>
            <p className="font-display text-sm text-text">ACTIONS</p>
            <p className="mt-1 text-xs text-text3">Actions completed today — same classification the Outcome Scorecard below uses, so these numbers always agree.</p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-text3">Completed</p>
                <p className="mt-1 text-xs text-text2">{actionsToday.length} action(s).</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-text3">Effective</p>
                <p className="mt-1 text-xs text-text2">{effectiveActions.length} action(s).</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-text3">Partially effective</p>
                <p className="mt-1 text-xs text-text2">{partiallyEffectiveActions.length} action(s).</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-text3">Ineffective</p>
                <p className="mt-1 text-xs text-text2">{failedActions.length} action(s).</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-text3">Unknown</p>
                <p className="mt-1 text-xs text-text2">{unknownOutcomeActions.length} action(s) not yet classified.</p>
              </div>
            </div>
          </section>

          <section>
            <p className="font-display text-sm text-text">DELIVERY LOOPS</p>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-text3">Completed</p>
                <p className="mt-1 text-xs text-text2">{completedLoops.length} loop(s).</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-text3">Stalled</p>
                <p className="mt-1 text-xs text-text2">{stalledLoops.length} loop(s).</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-text3">Still open</p>
                <p className="mt-1 text-xs text-text2">{openLoops.length} loop(s).</p>
              </div>
            </div>
            {openLoops.length > 0 && (
              <ul className="mt-2 space-y-1">
                {openLoops.map((l) => (
                  <li key={l.id} className="flex items-center gap-2 text-xs text-text2">
                    <LoopHealthBadge health={l.health} /> {l.issue}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <p className="font-display text-sm text-text">TOMORROW</p>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-text3">Carry forward</p>
                <p className="mt-1 text-xs text-text2">{deferred.length} deferred, {blocked.length} blocked.</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-text3">New priority</p>
                <ul className="mt-1 space-y-0.5 text-xs text-text2">
                  {newPriorityTomorrow.length === 0 ? <li>None flagged yet.</li> : newPriorityTomorrow.map((c) => <li key={c.id}>{c.title}</li>)}
                </ul>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-text3">Watch</p>
                <ul className="mt-1 space-y-0.5 text-xs text-text2">
                  {watchTomorrow.length === 0 ? <li>Nothing on watch.</li> : watchTomorrow.map((c) => <li key={c.id}>{c.title}</li>)}
                </ul>
              </div>
            </div>
          </section>

          {scorecard && (
            <section className="rounded-md border border-border bg-surface2 p-3">
              <div className="mb-2 flex items-center gap-2">
                <TrustLabel kind="calculated" />
                <span className="text-xs font-semibold uppercase tracking-wide text-text3">Outcome scorecard</span>
              </div>
              <div className="grid grid-cols-2 gap-1 text-xs text-text2 sm:grid-cols-4">
                <span>Risks: {scorecard.risksDelta >= 0 ? "-" : "+"}{Math.abs(scorecard.risksDelta)}</span>
                <span>Blockers: {scorecard.blockersDelta >= 0 ? "-" : "+"}{Math.abs(scorecard.blockersDelta)}</span>
                <span>Confidence: {scorecard.confidenceDelta >= 0 ? "+" : ""}{scorecard.confidenceDelta}</span>
                <span>Dependencies: {scorecard.dependenciesDelta >= 0 ? "-" : "+"}{Math.abs(scorecard.dependenciesDelta)}</span>
              </div>
              <p className="mt-2 text-xs text-text2">
                {scorecard.actionsCompleted} action(s) completed · {scorecard.actionsEffective} effective · {scorecard.actionsIneffective} ineffective
              </p>
              <p className="mt-2 text-sm font-medium text-text">Did today help? {scorecard.didTodayHelp}</p>
              <p className="mt-1 text-xs text-text3">{scorecard.controlEffectiveness}</p>
            </section>
          )}

          <section className="rounded-md border border-border bg-surface2 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <TrustLabel kind="calculated" />
                <span className="text-xs font-semibold uppercase tracking-wide text-text3">Daily Report</span>
              </div>
              {!dailyReport ? (
                <button onClick={generateDailyReport} className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-white hover:bg-accent2">
                  Generate Daily Report
                </button>
              ) : (
                <button onClick={copyDailyReportMarkdown} className="rounded-md border border-border px-2 py-1 text-xs font-medium text-text2 hover:border-accent hover:text-text">
                  {reportCopied ? "Copied ✓" : "Copy as Markdown"}
                </button>
              )}
            </div>
            {!dailyReport ? (
              <p className="text-xs text-text3">A point-in-time snapshot of today&apos;s completed work and decisions — stays stable even after later syncs change live ticket data.</p>
            ) : (
              (() => {
                const summary = summarizeDailyReport(dailyReport);
                return (
                  <div className="space-y-1 text-xs text-text2">
                    <p>{summary.completed.length} completed · {summary.decisions.length} decision(s) · {summary.outcomes.length} outcome(s) recorded.</p>
                    {summary.completed.length === 0 && summary.decisions.length === 0 && <p className="text-text3">Nothing recorded yet today.</p>}
                  </div>
                );
              })()
            )}
          </section>
        </div>

        {!entry ? (
          <button
            onClick={run}
            disabled={loading}
            className="mt-5 w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent2 disabled:opacity-60"
          >
            {loading ? "Generating…" : "Generate Tomorrow's Starting Point"}
          </button>
        ) : (
          <div className="mt-5">
            <p className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-text3">
              <TrustLabel kind="ai-recommendation" /> Tomorrow&apos;s starting point
              {entryMode && <AiProviderIndicator state={entryMode === "mock" ? "MOCK_FALLBACK" : "REAL_CLAUDE"} />}
            </p>
            <pre className="whitespace-pre-wrap rounded-md border border-border bg-surface2 p-3 font-sans text-sm text-text2">
              {entry.summary}
            </pre>
          </div>
        )}

        <button onClick={onClose} className="mt-4 w-full rounded-md border border-border px-4 py-2 text-sm text-text2 hover:text-text">
          Close
        </button>
      </div>
    </div>
  );
}
