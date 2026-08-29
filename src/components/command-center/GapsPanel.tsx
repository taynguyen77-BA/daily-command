"use client";

import { useState } from "react";
import { detectGaps, type Gap } from "@/lib/command-center/gap-detection";
import { getTodayIso } from "@/lib/command-center/store";
import { useCommandCenter } from "./use-command-center";
import { ConfidenceTag, Panel, SectionHeading, TrustLabel } from "./ui";

function GapCard({ gap }: { gap: Gap }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-1 flex items-center gap-2">
        <TrustLabel kind="calculated" />
        <ConfidenceTag confidence={gap.confidence} />
      </div>
      <p className="font-display text-sm text-text">{gap.title}</p>
      <p className="mt-1 text-xs text-text2">{gap.why}</p>
      <div className="mt-2 rounded-md border border-border bg-surface2 p-2">
        <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-text3">
          <TrustLabel kind="ai-recommendation" /> Recommended action
        </p>
        <p className="mt-1 text-xs text-text2">{gap.recommendedAction}</p>
      </div>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="mt-2 text-xs font-medium text-accent2 hover:underline">
        {open ? "Hide evidence" : "Why am I seeing this?"}
      </button>
      {open && (
        <ul className="mt-2 space-y-0.5 rounded-md border border-border bg-surface2 p-2 text-xs text-text2">
          {gap.evidence.map((e) => (
            <li key={e.id}>- {e.content}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function GapsPanel() {
  const { state, filteredData } = useCommandCenter();
  const [gaps, setGaps] = useState<Gap[] | null>(null);

  function run() {
    setGaps(detectGaps(filteredData, getTodayIso(), state.isDemo ? "demo" : "manual"));
  }

  return (
    <Panel className="p-4">
      <SectionHeading
        title="What Did We Forget?"
        subtitle="A deterministic pre-flight check across requirements, ownership, dependencies, and risk mitigation."
        action={
          <button
            onClick={run}
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text2 hover:border-accent hover:text-text"
          >
            Check For Gaps
          </button>
        }
      />
      {gaps === null ? (
        <p className="text-sm text-text3">Run the check to surface anything that may have been missed.</p>
      ) : gaps.length === 0 ? (
        <p className="text-sm text-text3">No gaps detected against the current checklist.</p>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          {gaps.map((g) => (
            <GapCard key={g.id} gap={g} />
          ))}
        </div>
      )}
    </Panel>
  );
}
