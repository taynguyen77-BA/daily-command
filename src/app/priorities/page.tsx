"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useCommandCenter } from "@/components/command-center/use-command-center";
import { EmptyState, SectionHeading } from "@/components/command-center/ui";
import { PriorityCard } from "@/components/command-center/PriorityCard";
import { TakeActionPanel } from "@/components/command-center/TakeActionPanel";
import { itemForScore } from "@/lib/command-center/selectors";
import { isOverdue } from "@/lib/command-center/scoring";
import type { PriorityScoreResult, Severity, WorkItem } from "@/lib/command-center/types";

const FILTERS: { key: string; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "CRITICAL", label: "Critical" },
  { key: "HIGH", label: "High" },
  { key: "ON_TRACK", label: "On track" },
  { key: "OVERDUE", label: "Overdue" },
];

function PrioritiesInner() {
  const { state, today, derived, filteredData, store, workRelevanceIndex } = useCommandCenter();
  const searchParams = useSearchParams();
  const [filter, setFilter] = useState<string>(searchParams.get("filter") ?? "ALL");
  const [selected, setSelected] = useState<{ item: WorkItem; result: PriorityScoreResult } | null>(null);

  if (!state.loaded) {
    return (
      <EmptyState
        title="No data yet"
        description="Load the demo dataset, or import your own work items from Data & Settings."
        onLoadDemo={() => store.loadDemoData()}
      />
    );
  }

  const filtered = derived.scores.filter((result) => {
    const item = itemForScore(filteredData, result);
    if (!item) return false;
    if (filter === "ALL") return true;
    if (filter === "OVERDUE") return isOverdue(item, today);
    if (filter === "ON_TRACK") return result.classification === "MEDIUM" || result.classification === "LOW";
    return result.classification === (filter as Severity);
  });

  return (
    <div className="space-y-4 pb-16">
      <SectionHeading title="Priorities" subtitle="Every open work item, scored by the deterministic priority model." />

      <div className="flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              filter === f.key ? "bg-surface2 text-text" : "text-text3 hover:text-text2"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="py-10 text-center text-sm text-text3">No items match this filter.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {filtered.map((result) => {
            const item = itemForScore(filteredData, result);
            if (!item) return null;
            return (
              <PriorityCard
                key={item.id}
                item={item}
                result={result}
                data={filteredData}
                isDemo={state.isDemo}
                onTakeAction={() => setSelected({ item, result })}
                workRelevanceIndex={workRelevanceIndex}
              />
            );
          })}
        </div>
      )}

      <TakeActionPanel item={selected?.item ?? null} result={selected?.result ?? null} onClose={() => setSelected(null)} />
    </div>
  );
}

export default function PrioritiesPage() {
  return (
    <Suspense fallback={null}>
      <PrioritiesInner />
    </Suspense>
  );
}
