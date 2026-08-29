"use client";

import { buildExecutiveView } from "@/lib/command-center/executive";
import type { DerivedData } from "@/lib/command-center/selectors";
import type { ProactiveIntelligence } from "@/lib/command-center/proactive";
import type { CommandCenterData, MemoryEvent, PersonalFocusResult } from "@/lib/command-center/types";
import { DriftBadge, FocusCategoryBadge, HeatBadge, LoopHealthBadge, Panel, RiskBadge, SectionHeading, TrajectoryBadge, TrustLabel } from "./ui";
import { ProjectStory } from "./ProjectStory";

export function ExecutiveView({
  data,
  derived,
  proactive,
  personalFocus,
  memoryEvents,
}: {
  data: CommandCenterData;
  derived: DerivedData;
  proactive: ProactiveIntelligence | null;
  personalFocus?: PersonalFocusResult | null;
  memoryEvents: MemoryEvent[];
}) {
  const view = buildExecutiveView(data, derived.scores, derived.risks, derived.changes, derived.kpis.overdue);
  const confidenceColor = view.deliveryConfidence >= 80 ? "text-green" : view.deliveryConfidence >= 60 ? "text-yellow" : view.deliveryConfidence >= 40 ? "text-orange" : "text-red";

  const topDrift = proactive?.attentionQueue.find((a) => a.category === "DRIFT");
  const topDrifts = proactive?.attentionQueue.filter((a) => a.category === "DRIFT").slice(0, 3) ?? [];
  const dependencies = proactive?.dependencyRadar.filter((d) => d.heat !== "LOW").slice(0, 5) ?? [];
  const ineffectiveActions = proactive?.attentionQueue.filter((a) => a.category === "ACTION").slice(0, 5) ?? [];
  const stakeholders = proactive?.stakeholderAttention.slice(0, 5) ?? [];
  const stalledLoops = proactive?.deliveryLoops.filter((l) => l.health === "STALLED" || l.health === "AT_RISK").slice(0, 5) ?? [];
  const scorecard = proactive?.outcomeScorecard;

  return (
    <div className="space-y-6">
      <ProjectStory events={memoryEvents} />

      {/* V1.6 §41 — compact only, 1-3 items. Executive Mode stays project/portfolio-oriented. */}
      {personalFocus && personalFocus.top3.length > 0 && (
        <Panel className="p-4">
          <div className="mb-2 flex items-center gap-2">
            <TrustLabel kind="calculated" />
            <span className="text-xs text-text3">Personal focus</span>
          </div>
          <ul className="space-y-1 text-sm text-text2">
            {personalFocus.top3.map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <FocusCategoryBadge category={c.category} />
                <span>{c.title}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel className="p-5">
        <div className="flex items-center gap-2">
          <TrustLabel kind="calculated" />
          <span className="text-xs text-text3">Delivery confidence</span>
        </div>
        <p className={`font-display text-4xl font-semibold ${confidenceColor}`}>{view.deliveryConfidence}/100</p>
        <p className="mt-3 text-sm text-text2">{view.summary}</p>
        {proactive && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <span className="text-xs text-text3">Trajectory:</span>
            <TrajectoryBadge level={proactive.trajectory.level} />
            <span className="text-xs text-text3">({proactive.trajectory.trendQuality} trend, {proactive.trajectory.snapshotsUsed} snapshot(s))</span>
            {topDrift && (
              <>
                <span className="text-xs text-text3">· Top drift:</span>
                <span className="text-xs text-text2">{topDrift.what}</span>
              </>
            )}
          </div>
        )}
      </Panel>

      {scorecard && (
        <Panel className="p-5">
          <div className="mb-2 flex items-center gap-2">
            <TrustLabel kind="calculated" />
            <span className="text-xs text-text3">Outcome scorecard &amp; control effectiveness</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm text-text2 sm:grid-cols-4">
            <span>Risks: {scorecard.risksDelta >= 0 ? "-" : "+"}{Math.abs(scorecard.risksDelta)}</span>
            <span>Blockers: {scorecard.blockersDelta >= 0 ? "-" : "+"}{Math.abs(scorecard.blockersDelta)}</span>
            <span>Confidence: {scorecard.confidenceDelta >= 0 ? "+" : ""}{scorecard.confidenceDelta}</span>
            <span>Dependencies: {scorecard.dependenciesDelta >= 0 ? "-" : "+"}{Math.abs(scorecard.dependenciesDelta)}</span>
          </div>
          <p className="mt-3 text-sm text-text">Did today help? {scorecard.didTodayHelp}</p>
          <p className="mt-1 text-xs text-text3">{scorecard.controlEffectiveness}</p>
        </Panel>
      )}

      <section>
        <SectionHeading title="Stalled Loops" subtitle="Decision -> Action -> Outcome loops that need a nudge." />
        {stalledLoops.length === 0 ? (
          <p className="text-sm text-text3">No stalled or at-risk loops.</p>
        ) : (
          <ul className="space-y-1 text-sm text-text2">
            {stalledLoops.map((l) => (
              <li key={l.id} className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
                <LoopHealthBadge health={l.health} />
                <span className="font-medium text-text">{l.issue}</span> — {l.why}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHeading title="Top 3 Drifts" subtitle="Delivery and release drift — deterministic, evidence-backed." />
        {topDrifts.length === 0 ? (
          <p className="text-sm text-text3">Nothing is currently drifting.</p>
        ) : (
          <div className="grid gap-2 md:grid-cols-3">
            {topDrifts.map((d) => (
              <Panel key={d.id} className="p-4">
                <DriftBadge level={d.severity === "CRITICAL" ? "SEVERE" : "DRIFTING"} />
                <p className="mt-1 font-display text-sm text-text">{d.what}</p>
                <p className="mt-1 text-xs text-text2">{d.why}</p>
              </Panel>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionHeading title="Dependencies" subtitle="Dependency Radar — MEDIUM heat and above." />
        {dependencies.length === 0 ? (
          <p className="text-sm text-text3">No dependencies currently need escalation.</p>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {dependencies.map((d) => (
              <Panel key={d.dependencyId} className="p-4">
                <HeatBadge heat={d.heat} />
                <p className="mt-1 font-display text-sm text-text">Dependency on {d.dependsOnTeam}</p>
                <p className="mt-1 text-xs text-text2">{d.recommended}</p>
              </Panel>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionHeading title="Actions Not Working" subtitle="Action Effectiveness — completed actions that didn't resolve the underlying issue." />
        {ineffectiveActions.length === 0 ? (
          <p className="text-sm text-text3">No ineffective actions detected.</p>
        ) : (
          <ul className="space-y-1 text-sm text-text2">
            {ineffectiveActions.map((a) => (
              <li key={a.id} className="rounded-md border border-border bg-surface px-3 py-2">
                <span className="font-medium text-text">{a.what}</span> — {a.impact}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHeading title="Stakeholder Attention" subtitle="Ownership gaps and concentration — literal fields only, no inferred hierarchy." />
        {stakeholders.length === 0 ? (
          <p className="text-sm text-text3">No ownership gaps detected.</p>
        ) : (
          <ul className="space-y-1 text-sm text-text2">
            {stakeholders.map((s, i) => (
              <li key={i} className="rounded-md border border-border bg-surface px-3 py-2">
                {s.reason}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHeading title="Major Risks" />
        {view.majorRisks.length === 0 ? (
          <p className="text-sm text-text3">No high-severity risks right now.</p>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {view.majorRisks.map((r) => (
              <Panel key={r.id} className="p-4">
                <RiskBadge level={r.level} />
                <p className="mt-1 font-display text-sm text-text">{r.title}</p>
                <p className="mt-1 text-xs text-text2">{r.potentialImpact}</p>
              </Panel>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionHeading title="Major Changes" />
        {view.majorChanges.length === 0 ? (
          <p className="text-sm text-text3">No delivery-impacting changes right now.</p>
        ) : (
          <ul className="space-y-1 text-sm text-text2">
            {view.majorChanges.map((c) => (
              <li key={c.id} className="rounded-md border border-border bg-surface px-3 py-2">
                <span className="font-medium text-text">{c.entityLabel}</span> — {c.field}: {c.before} → {c.after}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHeading title="Decisions Needed" />
        {view.decisionsNeeded.length === 0 ? (
          <p className="text-sm text-text3">No pending decisions.</p>
        ) : (
          <ul className="space-y-1 text-sm text-text2">
            {view.decisionsNeeded.map((d) => (
              <li key={d.id} className="rounded-md border border-border bg-surface px-3 py-2">
                <span className="font-medium text-text">{d.title}</span>
                {d.dueDate && <span className="text-text3"> — due {d.dueDate}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
