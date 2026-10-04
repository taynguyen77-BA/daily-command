"use client";

// V2.38 J4 — Meeting notes → decisions / actions / ticket status changes. Paste notes or a
// transcript → a REVIEW screen (edit titles, untick anything) → "Create selected" is the only
// thing that creates records or changes a status. Ticket keys that don't exist here are listed
// as dropped, never created.

import { useState, useSyncExternalStore } from "react";
import { commandCenterStore } from "@/lib/command-center/store";
import { getAIProvider } from "@/lib/command-center/ai";
import { applyMeetingReview, extractMeetingReview, type MeetingReview } from "@/lib/command-center/ai/meeting-actions";
import { todayLocalIso } from "@/lib/command-center/date-utils";
import { Panel, SectionHeading, TrustLabel } from "./ui";

const STATUS_LABEL = { TODO: "To do", IN_PROGRESS: "Start", BLOCKED: "Block", SKIPPED: "Skip", DEFERRED: "Defer", DONE: "Done" } as const;

export function MeetingNotesActions() {
  const state = useSyncExternalStore(commandCenterStore.subscribe, commandCenterStore.getSnapshot, commandCenterStore.getServerSnapshot);
  const [notes, setNotes] = useState("");
  const [review, setReview] = useState<MeetingReview | null>(null);
  const [mode, setMode] = useState<"mock" | "claude">("mock");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  if (!state.features.meetingNotesActions) return null;

  const extract = async () => {
    setBusy(true);
    setDone(null);
    const s = commandCenterStore.getSnapshot();
    const r = await extractMeetingReview({ notes, today: todayLocalIso(), customTerms: s.aiDataProtection.customTerms, knownKeys: new Set(s.data.workItems.map((w) => w.key)), provider: getAIProvider() });
    setReview(r.review);
    setMode(r.mode);
    setBusy(false);
  };

  const patch = <K extends "decisions" | "actions" | "statusChanges">(list: K, id: string, change: Partial<MeetingReview[K][number]>) =>
    setReview((r) => (r ? { ...r, [list]: (r[list] as MeetingReview[K]).map((x) => (x.id === id ? { ...x, ...change } : x)) } : r));

  const create = () => {
    if (!review) return;
    const s = commandCenterStore.getSnapshot();
    const byKey = new Map(s.data.workItems.map((w) => [w.key, w]));
    const fallbackProject = s.data.projects[0]?.id ?? "meeting";
    const r = applyMeetingReview(commandCenterStore, review, {
      today: todayLocalIso(),
      meetingLabel: `meeting notes ${todayLocalIso()}`,
      projectIdFor: (k) => (k ? byKey.get(k)?.projectId : undefined) ?? fallbackProject,
      workItemIdFor: (k) => byKey.get(k)?.id,
    });
    setDone(`Created ${r.decisions} decision(s), ${r.actions} action(s); changed ${r.statusChanges} ticket status(es).`);
    setReview(null);
    setNotes("");
  };

  const selectedCount = review ? [...review.decisions, ...review.actions, ...review.statusChanges].filter((x) => x.selected).length : 0;

  return (
    <Panel className="p-4" data-meeting-notes-actions>
      <SectionHeading title="Meeting notes → actions" subtitle="Paste notes or a transcript. You review everything before anything is created." />
      {!review ? (
        <>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={6} maxLength={20000} placeholder="Paste meeting notes or a transcript…" aria-label="Meeting notes" className="w-full rounded border border-border bg-surface px-2 py-1 text-sm" />
          <div className="mt-2 flex items-center gap-2">
            <button onClick={() => void extract()} disabled={busy || !notes.trim()} className="btn btn-sm btn-primary disabled:opacity-50">
              {busy ? "Reading…" : "Extract"}
            </button>
            {done && <span className="text-xs text-green">{done}</span>}
          </div>
        </>
      ) : (
        <div className="space-y-3 text-sm" data-meeting-review>
          <p className="flex items-center gap-2 text-xs text-text3">
            <TrustLabel kind="ai-draft" /> {mode === "claude" ? "AI extraction — review before creating." : "AI unavailable — only explicit Decision:/Action: lines were picked up."}
          </p>
          {review.droppedKeys.length > 0 && <p className="text-xs text-orange">Unknown ticket keys dropped (not created): {review.droppedKeys.join(", ")}</p>}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-text3">Decisions ({review.decisions.length})</p>
            {review.decisions.map((d) => (
              <label key={d.id} className="mt-1 flex items-center gap-2">
                <input type="checkbox" checked={d.selected} onChange={(e) => patch("decisions", d.id, { selected: e.target.checked })} />
                <input value={d.title} onChange={(e) => patch("decisions", d.id, { title: e.target.value })} aria-label="Decision" className="flex-1 rounded border border-border bg-surface px-1.5 py-0.5" />
              </label>
            ))}
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-text3">Action items ({review.actions.length})</p>
            {review.actions.map((a) => (
              <div key={a.id} className="mt-1 flex flex-wrap items-center gap-2">
                <input type="checkbox" aria-label={`Create action ${a.title}`} checked={a.selected} onChange={(e) => patch("actions", a.id, { selected: e.target.checked })} />
                <input value={a.title} onChange={(e) => patch("actions", a.id, { title: e.target.value })} aria-label="Action" className="min-w-0 flex-1 rounded border border-border bg-surface px-1.5 py-0.5" />
                <input value={a.owner ?? ""} onChange={(e) => patch("actions", a.id, { owner: e.target.value || undefined })} placeholder="owner" aria-label="Owner" className="w-24 rounded border border-border bg-surface px-1.5 py-0.5" />
                <input type="date" value={a.dueDate ?? ""} onChange={(e) => patch("actions", a.id, { dueDate: e.target.value || undefined })} aria-label="Due" title={a.dueText ? `Notes said: ${a.dueText}` : undefined} className="rounded border border-border bg-surface px-1 py-0.5 text-xs" />
                {a.relatedTicketKey && <span className="font-mono text-xs text-text3">{a.relatedTicketKey}</span>}
              </div>
            ))}
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-text3">Ticket status changes ({review.statusChanges.length})</p>
            {review.statusChanges.map((c) => (
              <label key={c.id} className="mt-1 flex flex-wrap items-center gap-2">
                <input type="checkbox" checked={c.selected} onChange={(e) => patch("statusChanges", c.id, { selected: e.target.checked })} />
                <span className="font-mono text-xs">{c.ticketKey}</span> → {STATUS_LABEL[c.status]}
                {c.until && <span className="text-xs text-text3">until {c.until}</span>}
                {c.reason && <span className="text-xs text-text3">— {c.reason}</span>}
              </label>
            ))}
          </div>
          {review.openQuestions.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-text3">Open questions</p>
              <ul className="list-disc pl-5 text-text2">{review.openQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul>
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={create} disabled={selectedCount === 0} className="btn btn-sm btn-primary disabled:opacity-50">
              Create selected ({selectedCount})
            </button>
            <button onClick={() => setReview(null)} className="btn btn-sm btn-ghost">
              Discard
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}
