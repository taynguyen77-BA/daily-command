"use client";

import { useMemo, useState } from "react";
import { useCommandCenter } from "@/components/command-center/use-command-center";
import { ActionOutcomeBadge, EmptyState, Panel, SectionHeading, SeverityBadge } from "@/components/command-center/ui";
import { buildPlan, TIME_BUDGET_LABELS, type PlanCandidate, type TimeBudget } from "@/lib/command-center/action-plan";
import { commandCenterStore } from "@/lib/command-center/store";
import type { ActionOutcomeStatus } from "@/lib/command-center/types";

const BUDGETS: TimeBudget[] = [15, 30, 60, 120, 480];

// V1.5 §18, §52 — "Did It Work?" outcome capture, the second signature interaction.
const OUTCOME_STATUSES: ActionOutcomeStatus[] = ["RESOLVED", "IMPROVED", "PARTIALLY_IMPROVED", "NO_CHANGE", "WORSENED", "UNKNOWN"];

function CandidateRow({ candidate }: { candidate: PlanCandidate }) {
  const { state, store } = useCommandCenter();
  const [note, setNote] = useState(candidate.action?.note ?? "");
  const [showNote, setShowNote] = useState(false);
  // V1.5 — buildPlan() re-synthesizes a fresh, action-less candidate for a still-open work
  // item on every render (the underlying WorkItem doesn't become Done just because a
  // logged Action was completed), so `candidate.action` alone can't be trusted to reflect
  // what THIS row just did. Track the id once ensureActionId() creates/finds one, and read
  // the live record back from the store — that's what actually drives the status badge and
  // the "Did It Work?" capture below.
  const [linkedActionId, setLinkedActionId] = useState<string | undefined>(candidate.action?.id);
  const liveAction = (linkedActionId ? state.data.actions.find((a) => a.id === linkedActionId) : undefined) ?? candidate.action;

  function ensureActionId(): string {
    if (liveAction) return liveAction.id;
    const id = store.addAction({
      title: candidate.title,
      why: candidate.reason,
      relatedWorkItemId: candidate.item?.id,
      estimateMinutes: candidate.estimateMinutes,
    });
    setLinkedActionId(id);
    return id;
  }

  const status = liveAction?.status ?? "open";

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2">
            {candidate.result && <SeverityBadge level={candidate.result.classification} />}
            <span className="text-xs text-text3">{candidate.estimateMinutes} min</span>
            {status !== "open" && (
              <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text3">
                {status}
              </span>
            )}
            {liveAction?.outcomeStatus && <ActionOutcomeBadge status={liveAction.outcomeStatus} />}
          </div>
          <p className="font-display text-sm text-text">{candidate.title}</p>
          <p className="mt-1 text-xs text-text2">{candidate.reason}</p>
        </div>
      </div>

      {showNote && (
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => store.addNoteToAction(ensureActionId(), note)}
          placeholder="Add a note…"
          className="mt-2 h-16 w-full resize-none rounded-md border border-border bg-surface2 p-2 text-xs text-text2"
        />
      )}

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <button onClick={() => store.completeAction(ensureActionId())} className="rounded border border-border px-2 py-1 text-text2 hover:border-green hover:text-green">
          Complete
        </button>
        <button onClick={() => store.deferAction(ensureActionId())} className="rounded border border-border px-2 py-1 text-text2 hover:border-yellow hover:text-yellow">
          Defer
        </button>
        <button onClick={() => store.snoozeAction(ensureActionId())} className="rounded border border-border px-2 py-1 text-text2 hover:border-accent hover:text-accent2">
          Snooze
        </button>
        <button onClick={() => store.markActionBlocked(ensureActionId())} className="rounded border border-border px-2 py-1 text-text2 hover:border-red hover:text-red">
          Mark blocked
        </button>
        <button onClick={() => setShowNote((v) => !v)} className="rounded border border-border px-2 py-1 text-text2 hover:border-accent hover:text-text">
          {showNote ? "Hide note" : "Add note"}
        </button>
      </div>

      {status === "completed" && !liveAction?.outcomeStatus && (
        <div className="mt-3 border-t border-border pt-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text3">Did it work?</p>
          <div className="flex flex-wrap gap-1">
            {OUTCOME_STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => commandCenterStore.recordActionOutcomeStatus(ensureActionId(), s)}
                className="rounded border border-border px-2 py-1 text-[11px] text-text2 hover:border-accent hover:text-text"
              >
                {s.replace(/_/g, " ")}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ActionPlanPage() {
  const { state, today, filteredData, store } = useCommandCenter();
  const [budget, setBudget] = useState<TimeBudget>(30);

  const plan = useMemo(() => (state.loaded ? buildPlan(filteredData, today, budget) : []), [state.loaded, filteredData, today, budget]);

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
            <CandidateRow key={c.id} candidate={c} />
          ))}
        </div>
      )}
    </div>
  );
}
