"use client";

// V1.5 — one Action Plan candidate row (moved out of action-plan/page.tsx in V2.26 so it is
// renderable on its own; behavior unchanged apart from the TaskReferenceRow ticket line).

import React, { useMemo, useState } from "react";
import { useCommandCenter } from "./use-command-center";
import { ActionOutcomeBadge, MetaPill, SeverityBadge } from "./ui";
import { TaskReferenceRow } from "./TaskReferenceRow";
import type { PlanCandidate } from "@/lib/command-center/action-plan";
import { commandCenterStore } from "@/lib/command-center/store";
import type { Action, ActionOutcomeStatus } from "@/lib/command-center/types";
import { projectActionImpact } from "@/lib/command-center/impact-projection";
import { buildWhyShouldICare } from "@/lib/command-center/why-should-i-care";
import { repeatedlyIneffective } from "@/lib/command-center/action-effectiveness";
import { WhyShouldICareDrawer } from "./WhyShouldICareDrawer";
import { addDays } from "@/lib/command-center/date-utils";

const ACTION_TITLE = "Applies to this action only. It comes back to the plan on the date you pick (default tomorrow); Blocked stays out until you reopen it.";
const COMPLETE_ACTION_TITLE = "Completes this planned action — and, when it is about a ticket, marks the ticket done everywhere.";

// V1.5 §18, §52 — "Did It Work?" outcome capture, the second signature interaction.
const OUTCOME_STATUSES: ActionOutcomeStatus[] = ["RESOLVED", "IMPROVED", "PARTIALLY_IMPROVED", "NO_CHANGE", "WORSENED", "UNKNOWN"];

export function PlanCandidateRow({ candidate }: { candidate: PlanCandidate }) {
  const { state, store, proactive, today } = useCommandCenter();
  const [note, setNote] = useState(candidate.action?.note ?? "");
  const [showNote, setShowNote] = useState(false);
  // G1 — ticketless actions only: the Defer / Snooze / Blocked capture.
  const [picker, setPicker] = useState<"defer" | "snooze" | "blocked" | null>(null);
  const [untilDraft, setUntilDraft] = useState("");
  const [reasonDraft, setReasonDraft] = useState("");
  const closePicker = () => {
    setPicker(null);
    setUntilDraft("");
    setReasonDraft("");
  };
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

  // Completing the planned work on a ticket-backed candidate completes the ticket too (one
  // TicketWorkState, so every list agrees); a ticketless action only completes itself.
  function completeActionAndTicket() {
    store.completeAction(ensureActionId());
    if (candidate.item) store.setTicketStatus(candidate.item.key, "DONE", { surface: "action-plan" });
  }

  // C1 — "If nothing changes" (impact-projection.ts), the same block Risk/Decision cards use.
  // A candidate with no logged Action yet is projected as the open action it would become.
  const impactContent = useMemo(() => {
    const action: Action = liveAction ?? { id: candidate.id, title: candidate.title, why: candidate.reason, status: "open", estimateMinutes: candidate.estimateMinutes, createdAt: today, ...(candidate.item ? { relatedWorkItemId: candidate.item.id } : {}) };
    const impact = projectActionImpact(action);
    return buildWhyShouldICare({
      fact: [`Planned: ${action.title}`, `Estimate: ${candidate.estimateMinutes} min`, `Status: ${action.status}`],
      signal: candidate.reason,
      impact,
      unknown: liveAction ? [] : ["Not yet logged as an Action — no history for it yet."],
      nextMove: action.title,
      evidence: impact.evidence,
    });
  }, [liveAction, candidate, today]);

  // C1 — the same work attempted 3+ times without resolving it (action-effectiveness.ts).
  const repeated = useMemo(() => {
    if (!liveAction || !proactive) return undefined;
    const hit = repeatedlyIneffective(proactive.actionEffectiveness, state.data.actions).find((r) => r.action.id === liveAction.id || (!!liveAction.relatedWorkItemId && r.action.relatedWorkItemId === liveAction.relatedWorkItemId));
    if (!hit) return undefined;
    return state.data.actions.filter((a) => a.status === "completed" && !!liveAction.relatedWorkItemId && a.relatedWorkItemId === liveAction.relatedWorkItemId).length || 1;
  }, [liveAction, proactive, state.data.actions]);

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2">
            {candidate.result && <SeverityBadge level={candidate.result.classification} />}
            <span className="text-xs text-text3">{candidate.estimateMinutes} min</span>
            {status !== "open" && <MetaPill>{status}</MetaPill>}
            {liveAction?.outcomeStatus && <ActionOutcomeBadge status={liveAction.outcomeStatus} />}
            {repeated !== undefined && (
              <span data-repeated-ineffective title="The same work was completed before without resolving the issue — consider a different approach." className="rounded bg-red/15 px-1.5 py-0.5 text-[10px] font-medium text-red">
                ⚠ Repeated without effect ({repeated}×)
              </span>
            )}
          </div>
          {/* V2.26 — a candidate tied to a ticket shows the ticket through the shared
              TaskReferenceRow (Jira link + ticket-level Complete/Skip/Block) instead of plain
              "KEY — title" text. The Action buttons further down stay action-level. */}
          {candidate.item ? (
            <>
              {candidate.action && <p className="font-display text-sm text-text">{candidate.action.title}</p>}
              <p className="eyebrow mt-2">Ticket</p>
              <TaskReferenceRow stacked workItem={candidate.item} as="div" ticketScoped surface="action-plan" />
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

      {/* G1 — one status vocabulary. A ticket-backed candidate's status IS its ticket's: the
          ticket buttons above (TaskReferenceRow) are the only Defer / Block / Skip controls.
          Only a ticketless action has its own Defer (+date) / Snooze (+until) / Blocked
          (+reason), and those wake up on their date. */}
      <p className="eyebrow mt-3">{candidate.item ? "This planned action" : "This action"}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs" data-action-controls={candidate.item ? "ticket-backed" : "ticketless"}>
        {picker === null && (
          <>
            <button onClick={() => completeActionAndTicket()} title={COMPLETE_ACTION_TITLE} className="btn btn-sm btn-secondary">
              Complete action
            </button>
            {!candidate.item && (
              <>
                <button onClick={() => setPicker("defer")} title={ACTION_TITLE} className="btn btn-sm btn-secondary">
                  Defer…
                </button>
                <button onClick={() => setPicker("snooze")} title={ACTION_TITLE} className="btn btn-sm btn-secondary">
                  Snooze…
                </button>
                <button onClick={() => setPicker("blocked")} title={ACTION_TITLE} className="btn btn-sm btn-secondary">
                  Blocked…
                </button>
              </>
            )}
            <button onClick={() => setShowNote((v) => !v)} className="btn btn-sm btn-secondary">
              {showNote ? "Hide note" : "Add note"}
            </button>
          </>
        )}
        {(picker === "defer" || picker === "snooze") && (
          <>
            <input type="date" value={untilDraft} onChange={(e) => setUntilDraft(e.target.value)} aria-label={picker === "defer" ? "Defer until" : "Snooze until"} className="rounded-md border border-border2 bg-surface px-2 py-1 text-xs" />
            <button
              onClick={() => {
                const until = untilDraft || addDays(today, 1);
                if (picker === "defer") store.deferAction(ensureActionId(), until);
                else store.snoozeAction(ensureActionId(), until);
                closePicker();
              }}
              className="btn btn-sm btn-secondary"
            >
              {picker === "defer" ? "Defer" : "Snooze"}
            </button>
            <button onClick={closePicker} className="btn btn-sm btn-ghost">
              Cancel
            </button>
          </>
        )}
        {picker === "blocked" && (
          <>
            <input value={reasonDraft} onChange={(e) => setReasonDraft(e.target.value)} placeholder="Blocked on… (optional)" aria-label="Blocked reason" maxLength={200} className="w-48 rounded-md border border-border2 bg-surface px-2 py-1 text-xs" />
            <button
              onClick={() => {
                store.markActionBlocked(ensureActionId(), reasonDraft || undefined);
                closePicker();
              }}
              className="btn btn-sm btn-secondary"
            >
              Mark blocked
            </button>
            <button onClick={closePicker} className="btn btn-sm btn-ghost">
              Cancel
            </button>
          </>
        )}
      </div>

      <WhyShouldICareDrawer content={impactContent} triggerLabel="If nothing changes" />

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
