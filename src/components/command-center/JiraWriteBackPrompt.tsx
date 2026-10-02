"use client";

// F4 — the confirmation dialog for an optional Jira write-back. It appears only after a Block
// or Done on an allow-listed project with the feature on (store.getPendingJiraWrite), shows
// exactly what would be written, and writes nothing until "Write to Jira" is clicked. Each
// write is logged (store.recordJiraWrite) whatever the outcome. Mounted once, in the header.

import React, { useEffect, useState, useSyncExternalStore } from "react";
import { commandCenterStore } from "@/lib/command-center/store";
import { executeJiraWriteBack, preselectTransition, type JiraWriteBackProposal, type JiraWriteChoices } from "@/lib/command-center/jira/write-back";
import { loadJiraTransitions, sendJiraWrite } from "@/lib/command-center/jira-write-client";
import type { JiraTransition } from "@/lib/command-center/jira/jira-action-provider";

export function JiraWriteBackPrompt() {
  const proposal = useSyncExternalStore(commandCenterStore.subscribe, commandCenterStore.getPendingJiraWrite, commandCenterStore.getServerPendingJiraWrite);
  if (!proposal) return null;
  return <JiraWriteBackDialog key={`${proposal.ticketKey}:${proposal.trigger}`} proposal={proposal} onClose={() => commandCenterStore.clearPendingJiraWrite()} />;
}

export function JiraWriteBackDialog({
  proposal,
  onClose,
  initialTransitions,
}: {
  proposal: JiraWriteBackProposal;
  onClose: () => void;
  /** Render tests pass the transitions instead of loading them. */
  initialTransitions?: JiraTransition[];
}) {
  const comment = proposal.writes.find((w) => w.kind === "comment");
  const flag = proposal.writes.find((w) => w.kind === "flag");
  const transitionWrite = proposal.writes.find((w) => w.kind === "transition");
  const [commentOn, setCommentOn] = useState(!!comment);
  const [commentText, setCommentText] = useState(comment?.kind === "comment" ? comment.text : "");
  const [flagOn, setFlagOn] = useState(!!flag);
  const [transitions, setTransitions] = useState<JiraTransition[] | null>(initialTransitions ?? null);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [transitionId, setTransitionId] = useState<string>("");
  const [remember, setRemember] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!transitionWrite || transitions) return;
    void loadJiraTransitions(proposal.ticketKey).then((r) => {
      if (r.ok) setTransitions(r.transitions);
      else setTransitionError(r.error);
    });
  }, [transitionWrite, transitions, proposal.ticketKey]);
  useEffect(() => {
    if (!transitions || transitionWrite?.kind !== "transition") return;
    const pre = preselectTransition(transitions, transitionWrite.preferredName);
    if (pre) setTransitionId(pre.id);
  }, [transitions, transitionWrite]);

  const chosenTransition = transitions?.find((t) => t.id === transitionId);
  const choices: JiraWriteChoices = {
    comment: commentOn,
    commentText,
    flag: flagOn,
    ...(chosenTransition ? { transition: { id: chosenTransition.id, name: chosenTransition.name } } : {}),
  };
  const nothingChosen = !choices.comment && !choices.flag && !choices.transition;

  async function confirm() {
    setBusy(true);
    if (remember && chosenTransition) {
      const s = commandCenterStore.getSnapshot().jiraWriteBack;
      commandCenterStore.setJiraWriteBackSettings({ doneTransitions: { ...s.doneTransitions, [proposal.projectKey]: chosenTransition.name } });
    }
    const r = await executeJiraWriteBack(proposal, choices, sendJiraWrite, (e) => commandCenterStore.recordJiraWrite(e));
    setBusy(false);
    setResult(r.failed === 0 ? `Written to Jira ✓ (${r.attempted})` : `${r.failed} of ${r.attempted} write(s) failed — see Data & Settings → Jira write-back history.`);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="jira-write-title" data-jira-write-dialog>
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-5">
        <h2 id="jira-write-title" className="font-display text-base text-text">
          Also update {proposal.ticketKey} in Jira?
        </h2>
        <p className="mt-1 text-xs text-text3">Your status here is already saved. Nothing is written to Jira unless you confirm below.</p>

        <div className="mt-3 space-y-3 text-sm text-text2" data-jira-write-preview>
          {comment && (
            <label className="block">
              <span className="flex items-center gap-2">
                <input type="checkbox" checked={commentOn} onChange={(e) => setCommentOn(e.target.checked)} /> Add a comment
              </span>
              <textarea value={commentText} onChange={(e) => setCommentText(e.target.value)} rows={2} maxLength={2000} className="mt-1 w-full rounded border border-border bg-surface2 px-2 py-1 text-sm" />
            </label>
          )}
          {flag && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={flagOn} onChange={(e) => setFlagOn(e.target.checked)} /> Set the Flag (Impediment)
            </label>
          )}
          {transitionWrite && (
            <div>
              <p>Move it in Jira to:</p>
              {transitionError ? (
                <p className="text-xs text-red">Couldn&apos;t load transitions: {transitionError}</p>
              ) : !transitions ? (
                <p className="text-xs text-text3">Loading the transitions available for this ticket…</p>
              ) : (
                <>
                  <select value={transitionId} onChange={(e) => setTransitionId(e.target.value)} className="mt-1 w-full rounded border border-border bg-surface2 px-2 py-1 text-sm" aria-label="Jira transition">
                    <option value="">Don&apos;t transition</option>
                    {transitions.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                        {t.toStatus && t.toStatus !== t.name ? ` → ${t.toStatus}` : ""}
                      </option>
                    ))}
                  </select>
                  {chosenTransition && (
                    <label className="mt-1 flex items-center gap-2 text-xs">
                      <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Offer &ldquo;{chosenTransition.name}&rdquo; for {proposal.projectKey} next time
                    </label>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {result ? (
          <div className="mt-4">
            <p className="text-sm text-text">{result}</p>
            <button onClick={onClose} className="btn btn-primary mt-2">
              Close
            </button>
          </div>
        ) : (
          <div className="mt-4 flex gap-2">
            <button onClick={() => void confirm()} disabled={busy || nothingChosen} className="btn btn-primary">
              {busy ? "Writing…" : "Write to Jira"}
            </button>
            <button onClick={onClose} disabled={busy} className="btn btn-secondary">
              Not now
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
