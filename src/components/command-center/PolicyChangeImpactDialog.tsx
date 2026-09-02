"use client";

// V2.6 §8-9 — Policy Change Impact Preview. A status-policy change must never silently take
// effect: this dialog shows Current -> New, a deterministic affected-item count computed
// from the CURRENT data (never guessed), the surfaces that read Work Relevance, and an
// explicit statement that this changes Daily Command's interpretation only — never Jira
// itself (§9: no Jira write, no transition, no automatic action creation). Same fixed-overlay/
// role="dialog"/Escape-to-close convention as every other panel in this app (see
// TakeActionPanel.tsx) — no new dialog architecture.

import { useEffect, useRef } from "react";
import type { WorkRelevance } from "@/lib/command-center/types";

const RELEVANCE_LABEL: Record<WorkRelevance, string> = {
  ACTIONABLE: "ACTIONABLE",
  WAITING: "WAITING",
  OBSERVE: "OBSERVE",
  COMPLETED: "COMPLETED",
  EXCLUDED: "EXCLUDED",
  UNKNOWN: "Unclassified",
};

export interface PendingPolicyChange {
  projectKey: string;
  status: string;
  from: WorkRelevance;
  to: WorkRelevance;
  affectedCount: number | null; // null = impact could not be calculated (§8 — never invent a number)
}

export function PolicyChangeImpactDialog({ change, onCancel, onApply }: { change: PendingPolicyChange; onCancel: () => void; onApply: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="policy-change-impact-title"
        tabIndex={-1}
        className="w-full max-w-md rounded-lg border border-border bg-surface p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="policy-change-impact-title" className="font-display text-base text-text">
          Change Work Relevance
        </h2>
        <p className="mt-1 font-mono text-xs text-text3">
          {change.projectKey} — &quot;{change.status}&quot;
        </p>

        <div className="mt-4 flex items-center gap-3 text-sm">
          <div className="rounded-md border border-border bg-surface2 px-3 py-2">
            <p className="text-xs text-text3">Current</p>
            <p className="font-display text-text">{RELEVANCE_LABEL[change.from]}</p>
          </div>
          <span className="text-text3">→</span>
          <div className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2">
            <p className="text-xs text-text3">New</p>
            <p className="font-display text-accent2">{RELEVANCE_LABEL[change.to]}</p>
          </div>
        </div>

        <div className="mt-4 rounded-md border border-border bg-surface2 p-3 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-text3">This change may affect</p>
          {change.affectedCount === null ? (
            <p className="mt-1 text-yellow">Impact unavailable — could not be calculated from current data.</p>
          ) : (
            <p className="mt-1 text-text">
              {change.affectedCount} work item{change.affectedCount === 1 ? "" : "s"} currently in this status.
            </p>
          )}
          <p className="mt-2 text-xs text-text3">Surfaces:</p>
          <ul className="mt-0.5 space-y-0.5 text-xs text-text2">
            <li>• Personal Focus</li>
            <li>• Action Plan</li>
            <li>• First 30 Minutes</li>
            <li>• Command Bar next-actions</li>
          </ul>
        </div>

        <p className="mt-3 text-xs text-text3">
          This changes how Daily Command Center interprets this Jira status. It does not change the Jira ticket or Jira status.
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-md border border-border px-3 py-1.5 text-sm text-text2 hover:border-accent hover:text-text">
            Cancel
          </button>
          <button onClick={onApply} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent2">
            Apply Policy Change
          </button>
        </div>
      </div>
    </div>
  );
}
