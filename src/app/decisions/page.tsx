"use client";

import { useMemo } from "react";
import { useCommandCenter } from "@/components/command-center/use-command-center";
import { DecisionCard } from "@/components/command-center/DecisionCard";
import { EmptyState, SectionHeading } from "@/components/command-center/ui";
import { detectDecisionConflictCandidates } from "@/lib/command-center/decision-conflicts";
import type { Decision, DecisionStatus } from "@/lib/command-center/types";

const GROUPS: { statuses: DecisionStatus[]; label: string }[] = [
  { statuses: ["PROPOSED", "UNDER_REVIEW"], label: "Proposed / Under Review" },
  { statuses: ["ACTIVE", "pending"], label: "Active Decisions" },
  { statuses: ["DECIDED", "IMPLEMENTING", "VALIDATING"], label: "In Flight (V1.5 Decision Loop)" },
  { statuses: ["AT_RISK"], label: "At-Risk Decisions" },
  { statuses: ["EFFECTIVE", "INEFFECTIVE"], label: "Measured Outcomes" },
  { statuses: ["SUPERSEDED"], label: "Superseded Decisions" },
  { statuses: ["REVISIT_REQUIRED"], label: "Decisions To Revisit" },
];

export default function DecisionLogPage() {
  const { state, store, proactive } = useCommandCenter();

  const conflicts = useMemo(
    () => (state.loaded ? detectDecisionConflictCandidates(state.data, state.isDemo ? "demo" : "manual") : []),
    [state.loaded, state.data, state.isDemo]
  );
  const conflictByDecisionId = new Map(conflicts.map((c) => [c.decision.id, c]));
  const radarByDecisionId = new Map((proactive?.decisionRadar ?? []).map((r) => [r.decisionId, r]));
  const effectivenessByDecisionId = new Map((proactive?.decisionEffectiveness ?? []).map((e) => [e.decisionId, e]));

  if (!state.loaded) {
    return (
      <EmptyState
        title="No data yet"
        description="Load the demo dataset, or import your own work items from Data & Settings."
        onLoadDemo={() => store.loadDemoData()}
      />
    );
  }

  const grouped = (statuses: DecisionStatus[]): Decision[] => state.data.decisions.filter((d) => statuses.includes(d.status));
  const shown = new Set(GROUPS.flatMap((g) => g.statuses));
  const other = state.data.decisions.filter((d) => !shown.has(d.status));

  return (
    <div className="space-y-6 pb-16">
      <SectionHeading title="Decision Log" subtitle="Decision Memory — every decision, its status, and whether current data still supports it." />

      {state.data.decisions.length === 0 && (
        <p className="py-10 text-center text-sm text-text3">No decisions recorded yet.</p>
      )}

      {GROUPS.map((group) => {
        const decisions = grouped(group.statuses);
        if (decisions.length === 0) return null;
        return (
          <section key={group.label}>
            <SectionHeading title={group.label} />
            <div className="grid gap-2 md:grid-cols-2">
              {decisions.map((d) => (
                <DecisionCard key={d.id} decision={d} conflict={conflictByDecisionId.get(d.id)} radar={radarByDecisionId.get(d.id)} effectiveness={effectivenessByDecisionId.get(d.id)} />
              ))}
            </div>
          </section>
        );
      })}

      {other.length > 0 && (
        <section>
          <SectionHeading title="Other" subtitle="Legacy status values, still fully visible — nothing is hidden." />
          <div className="grid gap-2 md:grid-cols-2">
            {other.map((d) => (
              <DecisionCard key={d.id} decision={d} conflict={conflictByDecisionId.get(d.id)} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
