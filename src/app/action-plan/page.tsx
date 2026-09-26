"use client";

import { useMemo, useState } from "react";
import { useCommandCenter } from "@/components/command-center/use-command-center";
import { EmptyState, Panel, SectionHeading } from "@/components/command-center/ui";
import { PlanCandidateRow } from "@/components/command-center/PlanCandidateRow";
import { buildPlan, TIME_BUDGET_LABELS, type TimeBudget } from "@/lib/command-center/action-plan";

const BUDGETS: TimeBudget[] = [15, 30, 60, 120, 480];

export default function ActionPlanPage() {
  const { state, today, filteredData, workRelevanceIndex, dailyCommandCompletedWorkItemIds, dailyCommandPausedWorkItemIds, store } = useCommandCenter();
  const [budget, setBudget] = useState<TimeBudget>(30);

  const plan = useMemo(
    () => (state.loaded ? buildPlan(filteredData, today, budget, workRelevanceIndex, dailyCommandCompletedWorkItemIds, dailyCommandPausedWorkItemIds) : []),
    [state.loaded, filteredData, today, budget, workRelevanceIndex, dailyCommandCompletedWorkItemIds, dailyCommandPausedWorkItemIds]
  );

  if (!state.loaded) {
    return (
      <EmptyState
        title="No data yet"
        description="Load the demo dataset, or import your own work items from Data & Settings."
        onLoadDemo={() => store.loadDemoData()}
      />
    );
  }

  const totalMinutes = plan.reduce((s, c) => s + c.estimateMinutes, 0);

  return (
    <div className="space-y-4 pb-16">
      <SectionHeading title="Today's Action Plan" subtitle="Selection and ordering are deterministic — by priority, urgency, effort, and dependency risk." />

      <div className="flex flex-wrap gap-1">
        {BUDGETS.map((b) => (
          <button
            key={b}
            onClick={() => setBudget(b)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${budget === b ? "bg-surface2 text-text" : "text-text3 hover:text-text2"}`}
          >
            {TIME_BUDGET_LABELS[b]}
          </button>
        ))}
      </div>

      <Panel className="p-4">
        <p className="text-xs text-text3">
          {plan.length} item(s) selected · {totalMinutes} of {budget} minutes used
        </p>
      </Panel>

      {plan.length === 0 ? (
        <p className="py-10 text-center text-sm text-text3">Nothing fits this time window right now — try a longer budget.</p>
      ) : (
        <div className="space-y-2">
          {plan.map((c) => (
            <PlanCandidateRow key={c.id} candidate={c} />
          ))}
        </div>
      )}
    </div>
  );
}
