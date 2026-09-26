"use client";

// V1.5 — one Action Plan candidate row (moved out of action-plan/page.tsx in V2.26 so it is
// renderable on its own; behavior unchanged apart from the TaskReferenceRow ticket line).

import React, { useState } from "react";
import { useCommandCenter } from "./use-command-center";
import { ActionOutcomeBadge, MetaPill, SeverityBadge } from "./ui";
import { TaskReferenceRow } from "./TaskReferenceRow";
import type { PlanCandidate } from "@/lib/command-center/action-plan";
import { commandCenterStore } from "@/lib/command-center/store";
import type { ActionOutcomeStatus } from "@/lib/command-center/types";

const ACTION_TITLE = "Updates only this planned action — the ticket's own state is set with the \u201c… ticket\u201d buttons.";

// V1.5 §18, §52 — "Did It Work?" outcome capture, the second signature interaction.
const OUTCOME_STATUSES: ActionOutcomeStatus[] = ["RESOLVED", "IMPROVED", "PARTIALLY_IMPROVED", "NO_CHANGE", "WORSENED", "UNKNOWN"];

export function PlanCandidateRow({ candidate }: { candidate: PlanCandidate }) {
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
            {status !== "open" && <MetaPill>{status}</MetaPill>}
            {liveAction?.outcomeStatus && <ActionOutcomeBadge status={liveAction.outcomeStatus} />}
          </div>
          {/* V2.26 — a candidate tied to a ticket shows the ticket through the shared
              TaskReferenceRow (Jira link + ticket-level Complete/Skip/Block) instead of plain
              "KEY — title" text. The Action buttons further down stay action-level. */}
          {candidate.item ? (
            <>
              {candidate.action && <p className="font-display text-sm text-text">{candidate.action.title}</p>}
              <TaskReferenceRow workItem={candidate.item} as="div" ticketScoped />
            </>
          ) : (
            <p className="font-display text-sm text-text">{candidate.title}</p>
          )}
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

      {/* Action-level controls: they update this planned Action only. The ticket's own
          Daily Command state is the "… ticket" buttons above (TaskReferenceRow ticketScoped). */}
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <button onClick={() => store.completeAction(ensureActionId())} title={ACTION_TITLE} className="rounded border border-border px-2 py-1 text-text2 hover:border-green hover:text-green">
          Complete action
        </button>
        <button onClick={() => store.deferAction(ensureActionId())} title={ACTION_TITLE} className="rounded border border-border px-2 py-1 text-text2 hover:border-yellow hover:text-yellow">
          Defer action
        </button>
        <button onClick={() => store.snoozeAction(ensureActionId())} title={ACTION_TITLE} className="rounded border border-border px-2 py-1 text-text2 hover:border-accent hover:text-accent2">
          Snooze action
        </button>
        <button onClick={() => store.markActionBlocked(ensureActionId())} title={ACTION_TITLE} className="rounded border border-border px-2 py-1 text-text2 hover:border-red hover:text-red">
          Mark action blocked
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
