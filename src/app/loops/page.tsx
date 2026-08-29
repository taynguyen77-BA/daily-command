"use client";

// Delivery Loops (V1.5 §26-29) — a visible OBSERVE -> DECIDE -> ACT -> MEASURE loop per
// decision that's actually in flight (or urgently needs one).
//
// V2.0 §8 — implements the V1.5 recommendation: a STALLED loop with no active action now
// offers "Create Follow-up Action". The action is created through the existing Action
// model (store.addAction) with source: "system-suggested" — no second task system. The
// user must confirm the title/owner/due-date before anything is created.

import { useState } from "react";
import { useCommandCenter } from "@/components/command-center/use-command-center";
import { EmptyState, LoopHealthBadge, Panel, SectionHeading } from "@/components/command-center/ui";
import type { DeliveryLoop } from "@/lib/command-center/types";

function CreateFollowUpAction({ loop, onDone }: { loop: DeliveryLoop; onDone: () => void }) {
  const { store } = useCommandCenter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(loop.nowWhat || `Follow up: ${loop.issue}`);
  const [owner, setOwner] = useState("");
  const [dueDate, setDueDate] = useState("");

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="mt-2 rounded-md border border-border px-2 py-1 text-xs font-medium text-accent2 hover:border-accent hover:text-text">
        Create Follow-up Action
      </button>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border bg-surface2 p-2">
      <label className="block text-[11px] text-text3">
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-0.5 w-full rounded border border-border bg-surface px-2 py-1 text-xs text-text" />
      </label>
      <label className="block text-[11px] text-text3">
        Owner (optional)
        <input value={owner} onChange={(e) => setOwner(e.target.value)} className="mt-0.5 w-full rounded border border-border bg-surface px-2 py-1 text-xs text-text" placeholder="Not set" />
      </label>
      <label className="block text-[11px] text-text3">
        Due date (optional — never invented)
        <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="mt-0.5 w-full rounded border border-border bg-surface px-2 py-1 text-xs text-text" />
      </label>
      <div className="flex gap-2">
        <button
          onClick={() => {
            store.addAction({
              title: title.trim() || `Follow up: ${loop.issue}`,
              why: loop.why,
              owner: owner.trim() || undefined,
              dueDate: dueDate || undefined,
              relatedDecisionId: loop.decision?.id,
              source: "system-suggested",
              estimateMinutes: 15,
            });
            setOpen(false);
            onDone();
          }}
          className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-white hover:bg-accent2"
        >
          Confirm &amp; create
        </button>
        <button onClick={() => setOpen(false)} className="rounded-md border border-border px-2 py-1 text-xs text-text2 hover:text-text">
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function DeliveryLoopsPage() {
  const { state, proactive, store } = useCommandCenter();
  const [justCreated, setJustCreated] = useState<Set<string>>(new Set());

  if (!state.loaded) {
    return <EmptyState title="No data yet" description="Load the demo dataset to see Delivery Loops in action." onLoadDemo={() => store.loadDemoData()} />;
  }

  const loops = proactive?.deliveryLoops ?? [];

  return (
    <div className="space-y-6 pb-16">
      <SectionHeading title="Delivery Loops" subtitle="Attention -> Decision -> Action -> Outcome. Where is each management loop stuck?" />

      {loops.length === 0 ? (
        <Panel className="p-6 text-sm text-text3">No active decision loops right now.</Panel>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {loops.map((loop) => (
            <Panel key={loop.id} className="p-4">
              <div className="mb-1 flex items-center gap-2">
                <LoopHealthBadge health={loop.health} />
              </div>
              <p className="font-display text-sm text-text">{loop.issue}</p>
              <dl className="mt-2 space-y-1 text-xs text-text2">
                <div>
                  <dt className="inline text-text3">Decision: </dt>
                  <dd className="inline">{loop.decision?.title ?? "—"} {loop.decision ? `(${loop.decision.status})` : ""}</dd>
                </div>
                <div>
                  <dt className="inline text-text3">Action: </dt>
                  <dd className="inline">{loop.action ? `${loop.action.title} (${loop.action.status})` : "Pending"}</dd>
                </div>
                <div>
                  <dt className="inline text-text3">Outcome: </dt>
                  <dd className="inline">{loop.outcomeStatus ?? "Unknown"}</dd>
                </div>
              </dl>
              <p className="mt-2 text-xs text-text2">{loop.why}</p>
              <p className="mt-1 text-xs font-medium text-accent2">Now what: {loop.nowWhat}</p>

              {loop.health === "STALLED" && !loop.action && !justCreated.has(loop.id) && (
                <CreateFollowUpAction loop={loop} onDone={() => setJustCreated((s) => new Set(s).add(loop.id))} />
              )}
              {justCreated.has(loop.id) && <p className="mt-2 text-xs text-green">Follow-up action created — it now appears in Personal Focus, Action Plan, and Project Memory.</p>}
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
