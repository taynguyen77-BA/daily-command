"use client";

// V2.37 I1 — "Brief" on a ticket row. Shows a stored brief instantly (no Jira fetch, no model
// call) when one exists; marks it "updated since brief" when the synced ticket is newer.
// The first AI use per project shows "What will be sent" first. A suggested status is only a
// button — clicking it is the ordinary status change (history surface "ai-brief").

import { useState, useSyncExternalStore } from "react";
import { commandCenterStore } from "@/lib/command-center/store";
import { getAIProvider } from "@/lib/command-center/ai";
import { loadIssueContext } from "@/lib/command-center/ai/ticket-ai-client";
import { applyBriefSuggestion, openTicketBrief, suggestionLabel, type StoredTicketBrief } from "@/lib/command-center/ai/ticket-brief";
import { todayLocalIso } from "@/lib/command-center/date-utils";
import { TrustLabel } from "./ui";

type Phase = { kind: "closed" } | { kind: "loading" } | { kind: "preview"; preview: string } | { kind: "shown"; stored: StoredTicketBrief; stale: boolean } | { kind: "message"; text: string };

export function TicketBrief({ ticketKey, workItemUpdated }: { ticketKey: string; workItemUpdated?: string }) {
  const state = useSyncExternalStore(commandCenterStore.subscribe, commandCenterStore.getSnapshot, commandCenterStore.getServerSnapshot);
  const [phase, setPhase] = useState<Phase>({ kind: "closed" });
  const [applied, setApplied] = useState<string | null>(null);
  if (!state.features.ticketBrief) return null;

  const open = async (opts: { regenerate?: boolean; previewConfirmed?: boolean } = {}) => {
    setPhase({ kind: "loading" });
    const snapshot = commandCenterStore.getSnapshot();
    if (opts.previewConfirmed) commandCenterStore.acknowledgeAiSendPreview(ticketKey.split("-")[0]);
    const r = await openTicketBrief({
      key: ticketKey,
      workItemUpdated,
      cache: snapshot.aiBriefs,
      settings: commandCenterStore.getSnapshot().aiDataProtection,
      regenerate: opts.regenerate,
      previewConfirmed: opts.previewConfirmed,
      today: todayLocalIso(),
      loadContext: (force) => loadIssueContext(commandCenterStore, ticketKey, { workItemUpdated, force }),
      provider: getAIProvider(),
    });
    if (r.kind === "cached") setPhase({ kind: "shown", stored: r.stored, stale: r.stale });
    else if (r.kind === "generated") {
      commandCenterStore.saveTicketBrief(r.stored);
      setPhase({ kind: "shown", stored: r.stored, stale: false });
    } else if (r.kind === "needs-preview") setPhase({ kind: "preview", preview: r.preview });
    else if (r.kind === "disabled") setPhase({ kind: "message", text: `${r.reason} — allow it in Data & Settings → AI data protection.` });
    else setPhase({ kind: "message", text: r.message });
  };

  if (phase.kind === "closed") {
    return (
      <button onClick={() => void open()} data-ticket-brief-open={ticketKey} className="mt-1 text-xs text-accent2 hover:underline">
        Brief
      </button>
    );
  }

  return (
    <div data-ticket-brief={ticketKey} className="mt-1 rounded-md border border-border bg-surface2 p-2 text-xs text-text2">
      <div className="flex flex-wrap items-center gap-2">
        <TrustLabel kind="ai-assessment" />
        <span className="font-semibold text-text">Brief</span>
        {phase.kind === "shown" && (
          <>
            <span className="text-text3">{phase.stored.mode === "claude" ? "AI" : "Deterministic (AI not used)"} · {phase.stored.createdAt.slice(0, 10)}</span>
            {phase.stale && <span data-brief-stale className="rounded bg-orange/15 px-1.5 py-0.5 text-[10px] font-medium text-orange">Updated since brief</span>}
            <button onClick={() => void open({ regenerate: true })} className="link text-xs">
              Regenerate
            </button>
          </>
        )}
        <button onClick={() => setPhase({ kind: "closed" })} className="ml-auto text-text3 hover:text-text" aria-label="Close brief">
          ✕
        </button>
      </div>
      {phase.kind === "loading" && <p className="mt-1">Loading…</p>}
      {phase.kind === "message" && <p className="mt-1 text-orange">{phase.text}</p>}
      {phase.kind === "preview" && (
        <div className="mt-1">
          <p className="text-text">First AI use for this project — this is exactly what will be sent. Nothing has been sent yet.</p>
          <details className="mt-1">
            <summary className="cursor-pointer text-accent2">What will be sent</summary>
            <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded border border-border bg-surface p-2 font-mono text-[11px]">{phase.preview}</pre>
          </details>
          <div className="mt-1 flex gap-2">
            <button onClick={() => void open({ regenerate: true, previewConfirmed: true })} className="btn btn-sm btn-primary">
              Send
            </button>
            <button onClick={() => setPhase({ kind: "closed" })} className="btn btn-sm btn-ghost">
              Cancel
            </button>
          </div>
        </div>
      )}
      {phase.kind === "shown" && (
        <dl className="mt-1 space-y-1">
          <div>
            <dt className="font-semibold text-text3">What is asked</dt>
            <dd>{phase.stored.brief.whatIsAsked}</dd>
          </div>
          <div>
            <dt className="font-semibold text-text3">Current state</dt>
            <dd>{phase.stored.brief.currentState}</dd>
          </div>
          {phase.stored.brief.waitingOn.length > 0 && (
            <div>
              <dt className="font-semibold text-text3">Waiting on</dt>
              <dd>
                <ul className="list-disc pl-4">
                  {phase.stored.brief.waitingOn.map((w, i) => (
                    <li key={i}>
                      <span className="text-text">{w.who}</span>: {w.what}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
          {phase.stored.brief.openQuestions.length > 0 && (
            <div>
              <dt className="font-semibold text-text3">Open questions</dt>
              <dd>
                <ul className="list-disc pl-4">
                  {phase.stored.brief.openQuestions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
          <div>
            <dt className="font-semibold text-text3">Suggested next step</dt>
            <dd>{phase.stored.brief.suggestedNextStep}</dd>
          </div>
          {phase.stored.brief.suggestedStatus && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                data-brief-suggestion={phase.stored.brief.suggestedStatus.status}
                disabled={!!applied}
                onClick={() => {
                  const s = phase.stored.brief.suggestedStatus!;
                  const changed = applyBriefSuggestion(commandCenterStore, ticketKey, s, todayLocalIso());
                  setApplied(changed ? `${suggestionLabel(s)} — done.` : "Already in that state.");
                }}
                className="btn btn-sm btn-secondary disabled:opacity-50"
              >
                {suggestionLabel(phase.stored.brief.suggestedStatus)}
              </button>
              <span className="text-text3">AI suggestion: {phase.stored.brief.suggestedStatus.reason}</span>
              {applied && <span className="text-green">{applied}</span>}
            </div>
          )}
        </dl>
      )}
    </div>
  );
}
