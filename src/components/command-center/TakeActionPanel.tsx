"use client";

import { useEffect, useRef, useState } from "react";
import { getAIProvider } from "@/lib/command-center/ai";
import type { PriorityScoreResult, WorkItem } from "@/lib/command-center/types";
import { useCommandCenter } from "./use-command-center";
import { AiProviderIndicator, ConfidenceTag, SeverityBadge, TrustLabel } from "./ui";
import { TicketLink } from "./TicketLink";

export function TakeActionPanel({
  item,
  result,
  onClose,
}: {
  item: WorkItem | null;
  result: PriorityScoreResult | null;
  onClose: () => void;
}) {
  const { state, store } = useCommandCenter();
  const [message, setMessage] = useState<string>("");
  const [messageMode, setMessageMode] = useState<"mock" | "claude" | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [savedActionId, setSavedActionId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Bug fix (V2.13) — "Mark as handled" used to only flip local component state, so it was
  // silently forgotten the moment the panel closed: no Action record was created, nothing
  // persisted, nothing else in the app could ever know this item had been handled. It now
  // reuses the exact same ensureActionId + completeAction path action-plan.tsx's "Complete"
  // already relies on, so a real, persisted Action record backs the badge below, and
  // reopening this item (or seeing it on the Action Plan) reflects the same completed state.
  const existingAction = item ? state.data.actions.find((a) => a.relatedWorkItemId === item.id && a.status !== "completed") : undefined;
  const completedAction = item
    ? [...state.data.actions].reverse().find((a) => a.relatedWorkItemId === item.id && a.status === "completed")
    : undefined;
  const handled = !!completedAction;

  useEffect(() => {
    if (!item) return;
    dialogRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  useEffect(() => {
    setMessage("");
    setMessageMode(null);
    setCopied(false);
    setSavedActionId(null);
    if (!item) return;
    setLoading(true);
    const why = result?.reasoning ?? "This item needs attention.";
    const provider = getAIProvider();
    provider
      .generateCommunication(item, item.owner ? "the item owner" : "the relevant team", why)
      .then((m) => {
        setMessage(m);
        setMessageMode(provider.mode);
      })
      .finally(() => setLoading(false));
  }, [item, result]);

  if (!item) return null;

  const recommendedStep = item.blocked
    ? "Unblock the dependency or escalate for a resolution date."
    : !item.owner
    ? "Assign an owner today."
    : item.dueDate
    ? "Confirm remaining scope with the team before the due date."
    : "Review current status and confirm next steps with the owner.";

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="take-action-panel-title"
        tabIndex={-1}
        className="flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border bg-surface p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <TicketLink ticketKey={item.key} url={item.sourceUrl} className="font-mono text-xs text-text3" />
            <h2 id="take-action-panel-title" className="font-display text-lg text-text">{item.title}</h2>
          </div>
          <button onClick={onClose} className="text-text3 hover:text-text" aria-label="Close">
            ✕
          </button>
        </div>

        {result && (
          <div className="mb-4 flex items-center gap-2">
            <SeverityBadge level={result.classification} />
            <span className="text-sm text-text2">{result.score}/100</span>
            <ConfidenceTag confidence={result.confidence} />
          </div>
        )}

        <section className="mb-4">
          <h3 className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-text3">
            <TrustLabel kind="calculated" /> Recommended next step
          </h3>
          <p className="text-sm text-text2">{recommendedStep}</p>
        </section>

        <section className="mb-4">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text3">Why</h3>
          <p className="text-sm text-text2">{result?.reasoning ?? "No scoring data available."}</p>
        </section>

        <section className="mb-4">
          <h3 className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-text3">
            <TrustLabel kind="ai-recommendation" /> Suggested communication
            {messageMode && <AiProviderIndicator state={messageMode === "mock" ? "MOCK_FALLBACK" : "REAL_CLAUDE"} />}
          </h3>
          {loading ? (
            <p className="text-sm text-text3">Drafting…</p>
          ) : (
            <textarea
              readOnly
              value={message}
              className="h-28 w-full resize-none rounded-md border border-border bg-surface2 p-2 text-sm text-text2"
            />
          )}
        </section>

        {handled && <p className="mb-2 text-xs text-green">Marked as handled — recorded as a completed action, visible on the Action Plan.</p>}

        <div className="mt-auto flex flex-wrap gap-2 border-t border-border pt-4">
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(message);
              setCopied(true);
            }}
            disabled={!message}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-text2 hover:border-accent hover:text-text disabled:opacity-50"
          >
            {copied ? "Copied ✓" : "Copy message"}
          </button>
          <button
            onClick={() => {
              const id = store.addAction({
                title: recommendedStep,
                why: result?.reasoning ?? "",
                relatedWorkItemId: item.id,
                estimateMinutes: item.blocked ? 15 : 10,
              });
              setSavedActionId(id);
            }}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-text2 hover:border-accent hover:text-text"
          >
            {savedActionId ? "Added ✓" : "Add to today's plan"}
          </button>
          <button
            onClick={() => {
              const id = savedActionId ?? existingAction?.id ?? store.addAction({
                title: recommendedStep,
                why: result?.reasoning ?? "",
                relatedWorkItemId: item.id,
                estimateMinutes: item.blocked ? 15 : 10,
              });
              store.completeAction(id);
            }}
            disabled={handled}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent2 disabled:opacity-50"
          >
            {handled ? "Handled ✓" : "Mark as handled"}
          </button>
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-text3 hover:text-text2">
            Snooze
          </button>
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-text3 hover:text-text2">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
