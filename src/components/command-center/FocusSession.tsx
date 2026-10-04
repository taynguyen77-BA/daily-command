"use client";

// Focus Session (V1.6 §16-20) — the primary WOW interaction. Shows only the context
// required to act on ONE item (§17 — hide unrelated project information). [COMPLETE]
// always reuses the existing V1.5 flow for the item's real source (§19): completeAction +
// "Did It Work?" for an Action, DecisionAssistant for a Decision, or
// acknowledge/resolve/create-action for a plain attention item. These are personal
// execution states only — never touches Jira/Risk/Decision status automatically (§18).
//
// A candidate about a ticket (candidate.ticketKey) moves the TICKET: start/complete/block/skip
// go through store.start/complete/block/skipFocusItem, which call setTicketStatus — so the
// ticket shows the same status on Command Center, My Work, Priorities, Daily Review, Action
// Plan and Attention immediately. A Follow-up Action is created only when the user ticks
// "Create a follow-up action" — never automatically.
//
// E2 — the session shows an outcome only when the store accepted it (handlers live in
// focus-session-handlers.ts); a refused action shows why, with a Reopen button.
// E3 — Block and Skip offer the same reasons as TaskRow (ReasonPickers.tsx); Defer (+date,
// default tomorrow) replaces the old "Not enough time today" block reason.

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { commandCenterStore } from "@/lib/command-center/store";
import type { ActionOutcomeStatus, FocusSessionState, PersonalFocusCandidate, SkipReason, TicketStatusSurface, TicketWorkStatus } from "@/lib/command-center/types";
import { addDays, todayLocalIso } from "@/lib/command-center/date-utils";
import { formatRelativeDateTime } from "@/lib/command-center/relative-time";
import { focusSessionHandlers, type FocusRejection } from "./focus-session-handlers";
import { BlockReasonField, SkipReasonSelect, REASON_FIELD } from "./ReasonPickers";
import { useCommandCenter } from "./use-command-center";
import { DecisionAssistant } from "./DecisionAssistant";
import { FocusCategoryBadge, MetaPill, TrustLabel } from "./ui";
import { openSourceHref } from "./personal-focus-helpers";
import { TaskRow } from "./TaskReferenceRow";

const OUTCOME_STATUSES: ActionOutcomeStatus[] = ["RESOLVED", "IMPROVED", "PARTIALLY_IMPROVED", "NO_CHANGE", "WORSENED", "UNKNOWN"];

const STATUS_LABEL: Record<TicketWorkStatus, string> = { TODO: "To do", IN_PROGRESS: "In progress", BLOCKED: "Blocked", SKIPPED: "Skipped", DEFERRED: "Deferred", DONE: "Done" };
const SURFACE_LABEL: Partial<Record<TicketStatusSurface, string>> = {
  "command-center": "Command Center",
  "my-work": "My Work",
  "focus-session": "a Focus Session",
  "my-day": "My Day",
  "daily-review": "Daily Review",
  priorities: "Priorities",
  "action-plan": "Action Plan",
  attention: "Attention",
  "recent-mentions": "Recent Mentions",
  "related-ticket": "a related-ticket card",
  keyboard: "keyboard triage",
  "ai-brief": "an AI brief suggestion",
  "ai-triage": "AI triage",
  "jira-sync": "a Jira sync",
  migration: "a data migration",
};

/** E2 — what the session shows when the store refused an action. Pure (render-testable). */
export function FocusRejectionNotice({ rejection, onReopen, now }: { rejection: FocusRejection; onReopen: () => void; now?: Date }) {
  if (rejection.reason === "not-found") {
    return (
      <p role="alert" data-focus-rejection="not-found" className="mt-4 text-sm text-red">
        This plan item no longer exists (it was removed elsewhere). Nothing was changed.
      </p>
    );
  }
  const when = formatRelativeDateTime(rejection.since, now);
  const where = rejection.surface ? SURFACE_LABEL[rejection.surface] : undefined;
  const changed = [when ? `changed ${when}` : "", where ? `on ${where}` : ""].filter(Boolean).join(" ");
  return (
    <div role="alert" data-focus-rejection="transition-rejected" className="mt-4 rounded-md border border-yellow/40 bg-yellow/10 p-3 text-sm text-text">
      <p>
        This ticket is already {STATUS_LABEL[rejection.current]}
        {changed ? ` (${changed})` : ""}. {rejection.current === "DONE" ? "Reopen it first?" : "Nothing was changed."}
      </p>
      {rejection.current === "DONE" && (
        <button onClick={onReopen} className="btn btn-sm btn-secondary mt-2">
          Reopen
        </button>
      )}
    </div>
  );
}

/** E3 — Block capture: the same reason field as TaskRow's Block picker. */
export function FocusBlockPanel(props: {
  reason: string;
  onReason: (v: string) => void;
  note: string;
  onNote: (v: string) => void;
  createFollowUp: boolean;
  onCreateFollowUp: (v: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="mt-4 border-t border-border pt-3">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text3">Why is this blocked?</p>
      <BlockReasonField listId="focus-block-reasons" value={props.reason} onChange={props.onReason} className={`w-full ${REASON_FIELD}`} />
      <textarea
        value={props.note}
        onChange={(e) => props.onNote(e.target.value)}
        placeholder="Optional note"
        rows={2}
        className="mt-2 w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-text placeholder:text-text3"
      />
      <label className="mt-2 flex items-center gap-2 text-xs text-text2">
        <input type="checkbox" checked={props.createFollowUp} onChange={(e) => props.onCreateFollowUp(e.target.checked)} />
        Create a follow-up action for this
      </label>
      <div className="mt-2 flex gap-2">
        <button onClick={props.onConfirm} className="rounded-md bg-red px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
          Confirm blocked
        </button>
        <button onClick={props.onCancel} className="btn btn-secondary">
          Cancel
        </button>
      </div>
    </section>
  );
}

/** E3 — Skip capture: the same Skip reasons as TaskRow. */
export function FocusSkipPanel({ reason, onReason, onConfirm, onCancel }: { reason: SkipReason | ""; onReason: (v: SkipReason | "") => void; onConfirm: () => void; onCancel: () => void }) {
  return (
    <section className="mt-4 border-t border-border pt-3">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text3">Why skip it?</p>
      <SkipReasonSelect value={reason} onChange={onReason} className={`w-full ${REASON_FIELD}`} />
      <div className="mt-2 flex gap-2">
        <button onClick={onConfirm} className="btn btn-secondary">
          Skip
        </button>
        <button onClick={onCancel} className="btn btn-ghost">
          Cancel
        </button>
      </div>
    </section>
  );
}

/** E3 — Defer capture: comes back to Today on the chosen date (default tomorrow). */
export function FocusDeferPanel({ until, onUntil, onConfirm, onCancel }: { until: string; onUntil: (v: string) => void; onConfirm: () => void; onCancel: () => void }) {
  return (
    <section className="mt-4 border-t border-border pt-3">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text3">Defer until</p>
      <input type="date" value={until} onChange={(e) => onUntil(e.target.value)} aria-label="Defer until" title="Comes back to Today on this date" className={REASON_FIELD} />
      <div className="mt-2 flex gap-2">
        <button onClick={onConfirm} className="btn btn-secondary">
          Defer
        </button>
        <button onClick={onCancel} className="btn btn-ghost">
          Cancel
        </button>
      </div>
    </section>
  );
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function FocusSession({ candidate, planItemId, onClose }: { candidate: PersonalFocusCandidate; planItemId: string; onClose: () => void }) {
  const { today, proactive, state } = useCommandCenter();
  const [sessionState, setSessionState] = useState<FocusSessionState>("READY");
  const [showOutcomeCapture, setShowOutcomeCapture] = useState(false);
  const [showDecisionAssistant, setShowDecisionAssistant] = useState(false);
  const [panel, setPanel] = useState<"none" | "block" | "skip" | "defer">("none");
  const [rejection, setRejection] = useState<FocusRejection | null>(null);
  const [blockReason, setBlockReason] = useState("");
  const [blockNote, setBlockNote] = useState("");
  const [skipReason, setSkipReason] = useState<SkipReason | "">("");
  const [deferUntil, setDeferUntil] = useState(() => addDays(todayLocalIso(), 1));
  const [createFollowUp, setCreateFollowUp] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const startedAtRef = useRef<number>(Date.now());

  useEffect(() => {
    dialogRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const attentionItem = candidate.attentionItemId ? proactive?.attentionQueue.find((a) => a.id === candidate.attentionItemId) : undefined;
  const relatedDecision = candidate.decisionId ? state.data.decisions.find((d) => d.id === candidate.decisionId) : undefined;
  const relatedAction = candidate.actionId ? state.data.actions.find((a) => a.id === candidate.actionId) : undefined;

  const handlers = useMemo(
    () =>
      focusSessionHandlers(
        { store: commandCenterStore, planItemId, today, candidate, hasDecisionAttentionItem: !!attentionItem, relatedWorkItemId: relatedAction?.relatedWorkItemId },
        { setSessionState, setRejection, setShowOutcomeCapture, setShowDecisionAssistant }
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [planItemId, today, candidate, !!attentionItem, relatedAction?.relatedWorkItemId]
  );

  useEffect(() => {
    void handlers.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planItemId]);

  // V2.0 §7 — a simple session-local elapsed-time display. This is a local UX aid, not a
  // persisted measured fact — never presented as anything more than "time in this session".
  useEffect(() => {
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    if (sessionState !== "IN_PROGRESS") return;
    const interval = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planItemId, sessionState === "IN_PROGRESS"]);

  // The capture panel closes either way: on success the outcome shows, on a rejection the
  // rejection notice does (nothing was written).
  async function confirmBlock() {
    await handlers.block(blockReason.trim() || undefined, blockNote.trim() || undefined, createFollowUp);
    setPanel("none");
  }
  async function confirmSkip() {
    await handlers.skip(skipReason || undefined);
    setPanel("none");
  }
  async function confirmDefer() {
    await handlers.defer(deferUntil || undefined);
    setPanel("none");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="focus-session-title"
        tabIndex={-1}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-surface p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center gap-2">
          <TrustLabel kind="calculated" />
          <span className="text-xs uppercase tracking-wide text-text3">Focus Session</span>
          {sessionState === "IN_PROGRESS" && <span className="text-xs font-mono text-text3">{formatElapsed(elapsedMs)}</span>}
          <MetaPill className="ml-auto">{sessionState.replace(/_/g, " ")}</MetaPill>
        </div>

        {candidate.projectName && <p className="text-xs text-text3">{candidate.projectName}</p>}
        {/* The ticket's status as every other list shows it. readOnly: this session's own
            Complete / Blocked / Skip buttons below ARE the ticket actions (AUDIT_TASK_STATE.md §2.6). */}
        {candidate.ticketKey && <TaskRow as="div" ticketKey={candidate.ticketKey} url={candidate.ticketUrl} showTitle={false} signals={candidate.signals} readOnly />}
        <h2 id="focus-session-title" className="mt-1 font-display text-lg text-text">{candidate.title}</h2>
        <div className="mt-1"><FocusCategoryBadge category={candidate.category} /></div>
        {(relatedDecision || relatedAction) && (
          <p className="mt-1 text-xs text-text3">
            {relatedDecision && <>Related decision: {relatedDecision.title} ({relatedDecision.status}) </>}
            {relatedAction && <>Related action: {relatedAction.title} ({relatedAction.status})</>}
          </p>
        )}

        <section className="mt-4">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text3">Why this matters</h3>
          <p className="text-sm text-text2">{candidate.why}</p>
        </section>

        <section className="mt-3">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text3">Objective</h3>
          <p className="text-sm text-text2">{candidate.whyOnMyList}</p>
        </section>

        <section className="mt-3">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text3">Next best action</h3>
          <p className="text-sm text-text2">{candidate.nowWhat}</p>
        </section>

        <section className="mt-3">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text3">Evidence</h3>
          {candidate.evidence.length === 0 ? (
            <p className="text-xs text-text3">(none)</p>
          ) : (
            <ul className="space-y-0.5 text-xs text-text2">
              {candidate.evidence.map((e, i) => (
                <li key={i}>- {e}</li>
              ))}
            </ul>
          )}
        </section>

        <p className="mt-3 text-xs text-text3">Estimated focus: {candidate.estimatedMinutes} min (heuristic)</p>

        {showOutcomeCapture && sessionState === "COMPLETED" && (
          <section className="mt-4 border-t border-border pt-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text3">Did it work?</p>
            <div className="flex flex-wrap gap-1">
              {OUTCOME_STATUSES.map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    if (candidate.actionId) commandCenterStore.recordActionOutcomeStatus(candidate.actionId, s);
                    setShowOutcomeCapture(false);
                  }}
                  className="rounded border border-border px-2 py-1 text-[11px] text-text2 hover:border-accent hover:text-text"
                >
                  {s.replace(/_/g, " ")}
                </button>
              ))}
            </div>
          </section>
        )}

        {sessionState === "COMPLETED" && !showOutcomeCapture && <p className="mt-4 text-sm text-green">Completed.</p>}
        {sessionState === "BLOCKED" && (
          <div className="mt-4 text-sm text-red">
            <p>Marked blocked — this stays visible in My Day until it&apos;s unblocked.</p>
            {(blockReason || blockNote) && <p className="mt-1 text-xs text-text3">Reason: {[blockReason, blockNote].filter(Boolean).join(" — ")}</p>}
          </div>
        )}
        {sessionState === "SKIPPED" && <p className="mt-4 text-sm text-text3">Skipped{skipReason ? ` — ${skipReason}` : ""}.</p>}
        {sessionState === "DEFERRED" && <p className="mt-4 text-sm text-text3">Deferred — back on Today on {deferUntil}.</p>}

        {rejection && <FocusRejectionNotice rejection={rejection} onReopen={() => rejection.reason === "transition-rejected" && void handlers.reopen(rejection.ticketKey)} />}

        {panel === "block" && (
          <FocusBlockPanel
            reason={blockReason}
            onReason={setBlockReason}
            note={blockNote}
            onNote={setBlockNote}
            createFollowUp={createFollowUp}
            onCreateFollowUp={setCreateFollowUp}
            onConfirm={() => void confirmBlock()}
            onCancel={() => setPanel("none")}
          />
        )}
        {panel === "skip" && <FocusSkipPanel reason={skipReason} onReason={setSkipReason} onConfirm={() => void confirmSkip()} onCancel={() => setPanel("none")} />}
        {panel === "defer" && <FocusDeferPanel until={deferUntil} onUntil={setDeferUntil} onConfirm={() => void confirmDefer()} onCancel={() => setPanel("none")} />}

        {(sessionState === "IN_PROGRESS" || sessionState === "READY") && panel === "none" && !rejection && (
          <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
            <Link href={openSourceHref(candidate)} className="btn btn-secondary">
              Open Source
            </Link>
            <button onClick={() => void handlers.complete()} className="btn btn-primary">
              Complete
            </button>
            <button onClick={() => setPanel("block")} className="btn btn-secondary">
              Blocked
            </button>
            <button onClick={() => setPanel("skip")} className="btn btn-secondary">
              Skip
            </button>
            <button onClick={() => setPanel("defer")} className="btn btn-secondary">
              Defer
            </button>
          </div>
        )}

        <button onClick={onClose} className="mt-4 w-full rounded-md border border-border px-4 py-2 text-sm text-text2 hover:text-text">
          End Session
        </button>
      </div>

      {showDecisionAssistant && attentionItem && (
        <DecisionAssistant
          item={attentionItem}
          onClose={() => void handlers.finishDecision()}
        />
      )}
    </div>
  );
}
