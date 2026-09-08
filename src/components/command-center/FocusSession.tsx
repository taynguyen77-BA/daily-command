"use client";

// Focus Session (V1.6 §16-20) — the primary WOW interaction. Shows only the context
// required to act on ONE item (§17 — hide unrelated project information). [COMPLETE]
// always reuses the existing V1.5 flow for the item's real source (§19): completeAction +
// "Did It Work?" for an Action, DecisionAssistant for a Decision, or
// acknowledge/resolve/create-action for a plain attention item. These are personal
// execution states only — never touches Jira/Risk/Decision status automatically (§18).

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { commandCenterStore } from "@/lib/command-center/store";
import type { ActionOutcomeStatus, FocusSessionState, PersonalFocusCandidate } from "@/lib/command-center/types";
import { useCommandCenter } from "./use-command-center";
import { DecisionAssistant } from "./DecisionAssistant";
import { FocusCategoryBadge, TrustLabel } from "./ui";
import { openSourceHref } from "./personal-focus-helpers";
import { TicketLink } from "./TicketLink";

const OUTCOME_STATUSES: ActionOutcomeStatus[] = ["RESOLVED", "IMPROVED", "PARTIALLY_IMPROVED", "NO_CHANGE", "WORSENED", "UNKNOWN"];

// V2.0 §7 — a short, deterministic set of blocker reasons. Free text is still allowed via
// the optional note, but the reason itself is picked from a fixed list rather than
// free-form (keeps it scannable across the plan / follow-up action title).
const BLOCK_REASONS = ["Waiting on someone else", "Missing information", "Dependency not resolved", "Not enough time today", "Other"] as const;

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
  const [showBlockCapture, setShowBlockCapture] = useState(false);
  const [blockReason, setBlockReason] = useState<string>(BLOCK_REASONS[0]);
  const [blockNote, setBlockNote] = useState("");
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

  useEffect(() => {
    const item = commandCenterStore.getSnapshot().personalPlan.find((p) => p.id === planItemId);
    if (item?.status === "in-progress") {
      setSessionState("IN_PROGRESS");
      return;
    }
    commandCenterStore.startFocusItem(planItemId, today);
    setSessionState("IN_PROGRESS");
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

  const attentionItem = candidate.attentionItemId ? proactive?.attentionQueue.find((a) => a.id === candidate.attentionItemId) : undefined;
  const relatedDecision = candidate.decisionId ? state.data.decisions.find((d) => d.id === candidate.decisionId) : undefined;
  const relatedAction = candidate.actionId ? state.data.actions.find((a) => a.id === candidate.actionId) : undefined;

  function finishAsCompleted() {
    commandCenterStore.completeFocusItem(planItemId, today);
    setSessionState("COMPLETED");
  }

  function complete() {
    if (candidate.actionId) {
      commandCenterStore.completeAction(candidate.actionId);
      finishAsCompleted();
      setShowOutcomeCapture(true);
      return;
    }
    if (candidate.decisionId && attentionItem) {
      setShowDecisionAssistant(true);
      return;
    }
    if (candidate.attentionItemId) {
      commandCenterStore.resolveAttentionItem(candidate.attentionItemId);
      finishAsCompleted();
      return;
    }
    finishAsCompleted();
  }

  function confirmBlock() {
    commandCenterStore.blockFocusItem(planItemId, today, blockReason, blockNote || undefined);
    if (createFollowUp) {
      commandCenterStore.addAction({
        title: `Follow up: ${candidate.title}`,
        why: blockNote || blockReason,
        relatedWorkItemId: relatedAction?.relatedWorkItemId,
        relatedDecisionId: candidate.decisionId,
        source: "system-suggested",
        estimateMinutes: 15,
      });
    }
    setShowBlockCapture(false);
    setSessionState("BLOCKED");
  }

  function skip() {
    commandCenterStore.skipFocusItem(planItemId, today);
    setSessionState("SKIPPED");
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
          <span className="ml-auto rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text3">{sessionState.replace(/_/g, " ")}</span>
        </div>

        {(candidate.projectName || candidate.ticketKey) && (
          <p className="flex items-center gap-2 text-xs text-text3">
            {candidate.projectName}
            {candidate.ticketKey && <TicketLink ticketKey={candidate.ticketKey} url={candidate.ticketUrl} className="text-text3" />}
          </p>
        )}
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
            {blockReason && <p className="mt-1 text-xs text-text3">Reason: {blockReason}{blockNote ? ` — ${blockNote}` : ""}</p>}
          </div>
        )}
        {sessionState === "SKIPPED" && <p className="mt-4 text-sm text-text3">Skipped.</p>}

        {showBlockCapture && (
          <section className="mt-4 border-t border-border pt-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text3">Why is this blocked?</p>
            <select
              value={blockReason}
              onChange={(e) => setBlockReason(e.target.value)}
              className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-text"
            >
              {BLOCK_REASONS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            <textarea
              value={blockNote}
              onChange={(e) => setBlockNote(e.target.value)}
              placeholder="Optional note"
              rows={2}
              className="mt-2 w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-text placeholder:text-text3"
            />
            <label className="mt-2 flex items-center gap-2 text-xs text-text2">
              <input type="checkbox" checked={createFollowUp} onChange={(e) => setCreateFollowUp(e.target.checked)} />
              Create a follow-up action for this
            </label>
            <div className="mt-2 flex gap-2">
              <button onClick={confirmBlock} className="rounded-md bg-red px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
                Confirm blocked
              </button>
              <button onClick={() => setShowBlockCapture(false)} className="rounded-md border border-border px-3 py-1.5 text-sm text-text2 hover:text-text">
                Cancel
              </button>
            </div>
          </section>
        )}

        {(sessionState === "IN_PROGRESS" || sessionState === "READY") && !showBlockCapture && (
          <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
            <Link href={openSourceHref(candidate)} className="rounded-md border border-border px-3 py-1.5 text-sm text-text2 hover:border-accent hover:text-text">
              Open Source
            </Link>
            <button onClick={complete} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent2">
              Complete
            </button>
            <button onClick={() => setShowBlockCapture(true)} className="rounded-md border border-border px-3 py-1.5 text-sm text-text2 hover:border-red hover:text-red">
              Blocked
            </button>
            <button onClick={skip} className="rounded-md border border-border px-3 py-1.5 text-sm text-text2 hover:border-yellow hover:text-yellow">
              Skip
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
          onClose={() => {
            setShowDecisionAssistant(false);
            finishAsCompleted();
          }}
        />
      )}
    </div>
  );
}
