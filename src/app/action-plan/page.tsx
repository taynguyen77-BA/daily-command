"use client";

import { useMemo } from "react";
import { useCommandCenter } from "@/components/command-center/use-command-center";
import { EmptyState, Panel, SectionHeading } from "@/components/command-center/ui";
import { PlanCandidateRow } from "@/components/command-center/PlanCandidateRow";
import { actionsNotInTodaysPlan, buildPlan, TIME_BUDGET_LABELS, type TimeBudget } from "@/lib/command-center/action-plan";

const BUDGETS: TimeBudget[] = [15, 30, 60, 120, 480];

export default function ActionPlanPage() {
  const { state, today, filteredData, workRelevanceIndex, dailyCommandCompletedWorkItemIds, dailyCommandPausedWorkItemIds, store } = useCommandCenter();
  // F1 — persisted, shared with Morning Mode's plan step.
  const budget: TimeBudget = state.timeBudgetMinutes ?? 30;
  const setBudget = (b: TimeBudget) => store.setTimeBudget(b);

  const plan = useMemo(
    () => (state.loaded ? buildPlan(filteredData, today, budget, workRelevanceIndex, dailyCommandCompletedWorkItemIds, dailyCommandPausedWorkItemIds) : []),
    [state.loaded, filteredData, today, budget, workRelevanceIndex, dailyCommandCompletedWorkItemIds, dailyCommandPausedWorkItemIds]
  );

  // G1 — ticketless actions set aside (deferred / snoozed until a later date, or blocked).
  const notInPlan = useMemo(() => (state.loaded ? actionsNotInTodaysPlan(filteredData.actions, today) : []), [state.loaded, filteredData.actions, today]);

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
      <SectionHeading level="page" title="Today's Action Plan" subtitle="Selection and ordering are deterministic — by priority, urgency, effort, and dependency risk." />

      <div className="seg">
        {BUDGETS.map((b) => (
          <button
            key={b}
            onClick={() => setBudget(b)}
            aria-pressed={budget === b}
            className={`seg-item ${budget === b ? "seg-item-active" : ""}`}
          >
            {TIME_BUDGET_LABELS[b]}
          </button>
        ))}
      </div>

      <Panel className="p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm text-text2">
            {plan.length} item(s) selected · {totalMinutes} of {budget} minutes used
          </p>
          <p className="tabular text-xs text-text3">{Math.min(100, Math.round((totalMinutes / budget) * 100))}% of the time budget</p>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface2" role="progressbar" aria-label="Time budget used" aria-valuemin={0} aria-valuemax={budget} aria-valuenow={totalMinutes}>
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.min(100, (totalMinutes / budget) * 100)}%` }} />
        </div>
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

      {notInPlan.length > 0 && (
        <section data-not-in-plan>
          <SectionHeading title={`Not in today's plan (${notInPlan.length})`} subtitle="Actions you set aside. Deferred and snoozed ones come back on their date by themselves; blocked ones stay here until you reopen them." />
          <Panel className="p-4">
            <ul>
              {notInPlan.map((n) => (
                <li key={n.action.id} data-not-in-plan-action={n.action.id} className="flex flex-wrap items-center gap-2 border-b border-border py-2 text-sm last:border-b-0">
                  <span className="min-w-0 flex-1 text-text">{n.action.title}</span>
                  <span className="text-xs text-text3">
                    {n.status === "blocked" ? `Blocked${n.reason ? ` — ${n.reason}` : ""}` : `${n.status === "deferred" ? "Deferred" : "Snoozed"}${n.until ? ` until ${n.until}` : ""}`}
                  </span>
                  <button onClick={() => store.reopenAction(n.action.id)} className="btn btn-sm btn-secondary">
                    Reopen
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
        </section>
      )}
    </div>
  );
}
