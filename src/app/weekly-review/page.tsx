"use client";

import { useMemo, useState } from "react";
import { useCommandCenter } from "@/components/command-center/use-command-center";
import { getAIProvider } from "@/lib/command-center/ai";
import { buildWeeklyReviewFacts, type WeeklyReviewFacts } from "@/lib/command-center/weekly-review";
import { buildPersonalDeliveryReviewFacts } from "@/lib/command-center/personal-patterns";
import { getTodayIso } from "@/lib/command-center/store";
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
  const { state, today, personalFocus, proactive, store } = useCommandCenter();
  const [reviewText, setReviewText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // V1.6 §46-49 — "My Delivery Review". Purely deterministic — arithmetic over
  // PersonalPlanItem history, no AI, no productivity scoring.
  const personalReview = useMemo(
    () => (personalFocus && proactive ? buildPersonalDeliveryReviewFacts(state.personalPlan, personalFocus.candidates, proactive.actionEffectiveness, state.data, 7, today) : null),
    [personalFocus, proactive, state.personalPlan, state.data, today]
  );

  // V2.0 §17 — DELIVERY section data. This is the same deterministic fact-building the AI
  // narrative below is grounded in, computed eagerly (no AI call) so DELIVERY renders
  // immediately without requiring "Generate Weekly Review" first.
  const facts: WeeklyReviewFacts | null = useMemo(
    () => (state.loaded ? buildWeeklyReviewFacts(state.data, state.snapshotHistory, today, state.isDemo ? "demo" : "manual") : null),
    [state.loaded, state.data, state.snapshotHistory, today, state.isDemo]
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
    const builtFacts = buildWeeklyReviewFacts(state.data, state.snapshotHistory, today, state.isDemo ? "demo" : "manual");
    const text = await getAIProvider().generateWeeklyReview(builtFacts);
    setReviewText(text);
    setLoading(false);
  }

  return (
    <div className="space-y-4 pb-16">
      <SectionHeading title="Weekly Review" subtitle="Grounded in the daily snapshots this app has stored — never fabricated." />

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
