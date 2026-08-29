"use client";

import { useCommandCenter } from "@/components/command-center/use-command-center";
import { RiskCard } from "@/components/command-center/RiskCard";
import { EmptyState, SectionHeading } from "@/components/command-center/ui";

export default function RisksPage() {
  const { state, derived, proactive, store } = useCommandCenter();

  if (!state.loaded) {
    return (
      <EmptyState
        title="No data yet"
        description="Load the demo dataset, or import your own work items from Data & Settings."
        onLoadDemo={() => store.loadDemoData()}
      />
    );
  }

  const escalationByTitle = new Map((proactive?.riskEscalations ?? []).map((e) => [e.riskTitle, e]));
  const topEscalatingTitle = proactive?.riskEscalations.find((e) => e.trend === "worsening" || e.reopened)?.riskTitle;

  return (
    <div className="space-y-4 pb-16">
      <SectionHeading title="What Might Go Wrong?" subtitle="Detected deterministically from combinations of underlying data — not guesses." />
      {derived.risks.length === 0 ? (
        <p className="py-10 text-center text-sm text-text3">No emerging risks detected.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {derived.risks.map((r) => (
            <RiskCard key={r.id} risk={r} isDemo={state.isDemo} escalation={escalationByTitle.get(r.title)} showAgingAssessment={r.title === topEscalatingTitle} />
          ))}
        </div>
      )}
    </div>
  );
}
