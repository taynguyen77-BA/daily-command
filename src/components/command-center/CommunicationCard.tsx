"use client";

import { useState } from "react";
import type { Communication } from "@/lib/command-center/types";
import { useCommandCenter } from "./use-command-center";
import { TrustLabel } from "./ui";

export function CommunicationCard({ comm }: { comm: Communication }) {
  const { store } = useCommandCenter();
  const [copied, setCopied] = useState(false);
  const [added, setAdded] = useState(false);

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-1 flex items-center justify-between">
        <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text3">{comm.audience}</span>
        {comm.status !== "open" && (
          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text3">{comm.status}</span>
        )}
      </div>
      <p className="text-sm font-medium text-text">{comm.who}</p>
      <p className="mt-1 text-xs text-text2">
        <span className="text-text3">Why: </span>
        {comm.why}
      </p>
      <p className="mt-1 text-xs text-text2">
        <span className="text-text3">What they need to know: </span>
        {comm.whatTheyNeedToKnow}
      </p>

      <div className="mt-2 rounded-md border border-border bg-surface2 p-2">
        {/* V2.2.1 — Communication.suggestedMessage is either the demo seed or whatever text
            the user's own import/paste provided (see demo-data.ts / import.ts) — it never
            passes through an AI call, so "user input" is the honest label here, not
            "AI recommendation". The genuinely AI-drafted variant lives in TakeActionPanel
            (getAIProvider().generateCommunication), labeled separately there. */}
        <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-text3">
          <TrustLabel kind="user-input" /> Suggested message
        </p>
        <p className="mt-1 text-xs text-text2">{comm.suggestedMessage}</p>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(comm.suggestedMessage);
            setCopied(true);
          }}
          className="rounded border border-border px-2 py-1 text-text2 hover:border-accent hover:text-text"
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
        <button
          onClick={() => {
            store.addAction({
              title: `Follow up: ${comm.who}`,
              why: comm.why,
              relatedWorkItemId: comm.workItemId,
              estimateMinutes: 10,
            });
            setAdded(true);
          }}
          className="rounded border border-border px-2 py-1 text-text2 hover:border-accent hover:text-text"
        >
          {added ? "Added ✓" : "Add to plan"}
        </button>
        <button
          onClick={() => store.updateCommunication(comm.id, { status: "handled" })}
          disabled={comm.status !== "open"}
          className="rounded border border-border px-2 py-1 text-text2 hover:border-green hover:text-green disabled:opacity-50"
        >
          Mark handled
        </button>
        <button
          onClick={() => store.updateCommunication(comm.id, { status: "snoozed" })}
          disabled={comm.status !== "open"}
          className="rounded border border-border px-2 py-1 text-text2 hover:border-accent hover:text-accent2 disabled:opacity-50"
        >
          Snooze
        </button>
      </div>
    </div>
  );
}
