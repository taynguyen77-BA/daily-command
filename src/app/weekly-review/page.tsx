"use client";

import { useMemo, useState } from "react";
import { useCommandCenter } from "@/components/command-center/use-command-center";
import { getAIProvider } from "@/lib/command-center/ai";
import { buildWeeklyReviewFacts, type WeeklyReviewFacts } from "@/lib/command-center/weekly-review";
import { buildPersonalDeliveryReviewFacts } from "@/lib/command-center/personal-patterns";
import { getTodayIso } from "@/lib/command-center/store";
import { buildWeeklyReportSummary, last7DaysEnding, weeklyReportToMarkdown } from "@/lib/command-center/daily-report";
import { EmptyState, Panel, SectionHeading, TrustLabel } from "@/components/command-center/ui";

function renderReview(text: string) {
  const sections = text.split(/(?=^## )/m).filter(Boolean);
  return (
    <div className="space-y-4">
      {sections.map((section, i) => {
        const [headerLine, ...rest] = section.split("\n");
        const header = headerLine.replace(/^##\s*/, "").trim();
        return (
          <div key={i}>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text3">{header || "Summary"}</h3>
            <p className="whitespace-pre-wrap text-sm text-text2">{rest.join("\n").trim()}</p>
          </div>
        );
      })}
    </div>
  );
}

export default function WeeklyReviewPage() {
  const { state, today, filteredData, personalFocus, proactive, store } = useCommandCenter();
  const [reviewText, setReviewText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [weeklyReportCopied, setWeeklyReportCopied] = useState(false);

  // V2.17 Task 2 point 3 — computed on demand over the 7 relevant already-persisted
  // DailyReportSnapshots, never a redundant separately-persisted weekly blob. Distinct from
  // `facts`/`personalReview` below: those recompute live from current data.actions/decisions
  // (fine for their own AI-narrative purpose), whereas this aggregates only already-frozen,
  // point-in-time snapshots — the only one of the three that satisfies "stays stable after a
  // later sync changes live ticket data".
  const weeklyReport = useMemo(() => buildWeeklyReportSummary(last7DaysEnding(today), state.dailyReports), [today, state.dailyReports]);

  async function copyWeeklyReportMarkdown() {
    await navigator.clipboard.writeText(weeklyReportToMarkdown(weeklyReport));
    setWeeklyReportCopied(true);
  }

  // V1.6 §46-49 — "My Delivery Review". Purely deterministic — arithmetic over
  // PersonalPlanItem history, no AI, no productivity scoring.
  // V2.3 §11, §16 — reads `filteredData` (Focus Project Scope + the global filter already
  // applied), not raw `state.data`, so an out-of-scope Jira project never reaches this
  // AI-context-feeding fact builder.
  const personalReview = useMemo(
    () => (personalFocus && proactive ? buildPersonalDeliveryReviewFacts(state.personalPlan, personalFocus.candidates, proactive.actionEffectiveness, filteredData, 7, today) : null),
    [personalFocus, proactive, state.personalPlan, filteredData, today]
  );

  // V2.0 §17 — DELIVERY section data. This is the same deterministic fact-building the AI
  // narrative below is grounded in, computed eagerly (no AI call) so DELIVERY renders
  // immediately without requiring "Generate Weekly Review" first.
  const facts: WeeklyReviewFacts | null = useMemo(
    () => (state.loaded ? buildWeeklyReviewFacts(filteredData, state.snapshotHistory, today, state.isDemo ? "demo" : "manual") : null),
    [state.loaded, filteredData, state.snapshotHistory, today, state.isDemo]
  );
  const stalledLoopsCount = proactive?.deliveryLoops.filter((l) => l.health === "STALLED").length ?? 0;

  if (!state.loaded) {
    return (
      <EmptyState
        title="No data yet"
        description="Load the demo dataset, or import your own work items from Data & Settings."
        onLoadDemo={() => store.loadDemoData()}
      />
    );
  }

  async function generate() {
    setLoading(true);
    const today = getTodayIso();
    const builtFacts = buildWeeklyReviewFacts(filteredData, state.snapshotHistory, today, state.isDemo ? "demo" : "manual");
    const text = await getAIProvider().generateWeeklyReview(builtFacts);
    setReviewText(text);
    setLoading(false);
  }

  return (
    <div className="space-y-4 pb-16">
      <SectionHeading title="Weekly Review" subtitle="Grounded in the daily snapshots this app has stored — never fabricated." />

      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="font-display text-sm text-text">WEEKLY REPORT</p>
          <button onClick={copyWeeklyReportMarkdown} className="rounded-md border border-border px-2 py-1 text-xs font-medium text-text2 hover:border-accent hover:text-text">
            {weeklyReportCopied ? "Copied ✓" : "Copy as Markdown"}
          </button>
        </div>
        <Panel className="p-5">
          <div className="mb-2 flex items-center gap-2">
            <TrustLabel kind="calculated" />
            <span className="text-xs text-text3">
              {weeklyReport.snapshots.length} of {weeklyReport.dateRange.length} day(s) in this range have a Daily Report — generate one from Close Day for a day that&apos;s missing.
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm text-text2 sm:grid-cols-3">
            <span>Completed: {weeklyReport.totalCompleted}</span>
            <span>Decisions: {weeklyReport.totalDecisions}</span>
            <span>Outcomes recorded: {weeklyReport.totalOutcomes}</span>
          </div>
          {/* V2.21 §11 — Daily/Weekly evidence reconciliation: this "Completed" count and the
              DELIVERY section's "Actions completed" below are DELIBERATELY built from
              different evidence and may not match — this line makes that explicit instead of
              leaving two same-looking numbers to silently disagree. This one is the frozen,
              append-only completion record for each calendar day this range actually has a
              Daily Report for (never re-derived from today's live ticket/action state). */}
          <p className="mt-2 text-[11px] text-text3">
            From {weeklyReport.dateRange[0]} to {weeklyReport.dateRange[weeklyReport.dateRange.length - 1]} — recorded completion events on the day they happened, frozen at Close Day. Distinct from DELIVERY&apos;s live count below.
          </p>
          {weeklyReport.byProject.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-text2">
              {weeklyReport.byProject.map((p) => (
                <li key={p.projectName}>{p.projectName}: {p.count}</li>
              ))}
            </ul>
          )}
        </Panel>
      </section>

      <section>
        <p className="font-display text-sm text-text">DELIVERY</p>
        {!facts || !facts.hasEnoughHistory ? (
          <p className="py-4 text-sm text-text3">
            Only {state.snapshotHistory.length} snapshot(s) stored — run &quot;Close My Day&quot; on at least 2 different days for a full delivery review.
          </p>
        ) : (
          <Panel className="mt-2 p-5">
            <div className="mb-2 flex items-center gap-2">
              <TrustLabel kind="calculated" />
              <span className="text-xs text-text3">Last {facts.windowDays} day(s) of stored history.</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm text-text2 sm:grid-cols-3">
              <span>Projects touched: {personalReview?.projectsWorkedIn.length ?? 0}</span>
              <span>Decisions made: {facts.decisionsMade.length}</span>
              <span>Actions completed: {facts.actionsCompleted.length}</span>
              <span>Stalled loops: {stalledLoopsCount}</span>
              <span>Recurring risks: {facts.recurringRisks.length}</span>
            </div>
            {/* V2.21 §11 — the counterpart note to WEEKLY REPORT's own: this count is a LIVE
                read of current ticket/action state over the last {facts.windowDays} day(s) of
                actual stored snapshot history (which can be shorter or longer than a fixed
                7-day range — see "hasEnoughHistory" above), not a frozen daily record. The two
                sections can legitimately disagree; this is not a bug in either one. */}
            <p className="mt-2 text-[11px] text-text3">
              Live count over the last {facts.windowDays} day(s) of stored snapshot history — recomputed from today&apos;s ticket/action state, not frozen at the time of completion. Distinct from WEEKLY REPORT&apos;s recorded-events count above.
            </p>
            {facts.recurringRisks.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs text-text2">
                {facts.recurringRisks.map((r, i) => (
                  <li key={i}>{r.title}</li>
                ))}
              </ul>
            )}

            <div className="mt-3 border-t border-border pt-3">
              {!reviewText ? (
                <button
                  onClick={generate}
                  disabled={loading}
                  className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-accent2 hover:border-accent hover:text-text disabled:opacity-60"
                >
                  {loading ? "Generating…" : "Generate AI narrative"}
                </button>
              ) : (
                <>
                  <div className="mb-2 flex items-center gap-2">
                    <TrustLabel kind="ai-assessment" />
                    <span className="text-xs text-text3">AI-narrated from the deterministic facts above.</span>
                  </div>
                  {renderReview(reviewText)}
                </>
              )}
            </div>
          </Panel>
        )}
      </section>

      <section>
        <p className="font-display text-sm text-text">PERSONAL EXECUTION</p>
        {!personalReview ? (
          <p className="py-4 text-sm text-text3">Personal delivery history is not available yet.</p>
        ) : (
          <Panel className="mt-2 p-5">
            <div className="mb-2 flex items-center gap-2">
              <TrustLabel kind="calculated" />
              <span className="text-xs text-text3">Last {personalReview.windowDays} day(s) — deterministic, arithmetic only. Never a productivity score.</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm text-text2 sm:grid-cols-5">
              <span>Planned: {personalReview.plannedCount}</span>
              <span>Completed: {personalReview.completedCount}</span>
              <span>Blocked: {personalReview.blockedCount}</span>
              <span>Skipped: {personalReview.skippedCount}</span>
              <span>Carried forward: {personalReview.deferredCount}</span>
            </div>
            {/* V2.21 §11 — a third, independent evidence source (Personal Plan items you
                explicitly planned — not every Action or memory event), so this "Completed"
                count is expected to differ from both counts above too. */}
            <p className="mt-2 text-[11px] text-text3">
              Personal Plan items you explicitly planned and completed this window — a narrower population than either count above, which is expected.
            </p>
            <p className="mt-3 text-sm text-text2">
              Across: {personalReview.projectsWorkedIn.join(", ") || "no projects"}. Actions: {personalReview.effectiveActionsCount} effective, {personalReview.ineffectiveActionsCount} ineffective. Decision loops completed: {personalReview.decisionsReviewedCount}.
            </p>

            {personalReview.stillRelevantSkipped.length > 0 && (
              <div className="mt-3 border-t border-border pt-3">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text3">Skipped — still relevant</p>
                <ul className="space-y-0.5 text-sm text-text2">
                  {personalReview.stillRelevantSkipped.map((s, i) => (
                    <li key={i}>{s.title}</li>
                  ))}
                </ul>
              </div>
            )}
          </Panel>
        )}
      </section>

      <section>
        <p className="font-display text-sm text-text">PATTERNS</p>
        {!personalReview || personalReview.patterns.length === 0 ? (
          <p className="py-4 text-sm text-text3">No repeating patterns detected this window.</p>
        ) : (
          <Panel className="mt-2 p-5">
            <div className="mb-2 flex items-center gap-2">
              <TrustLabel kind="calculated" />
              <span className="text-xs text-text3">Evidence first, never a trait judgment.</span>
            </div>
            <ul className="space-y-1 text-sm text-text2">
              {personalReview.patterns.map((p) => (
                <li key={p.id}>{p.title}</li>
              ))}
            </ul>
          </Panel>
        )}
      </section>
    </div>
  );
}
