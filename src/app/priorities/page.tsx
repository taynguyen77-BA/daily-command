"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useCommandCenter } from "@/components/command-center/use-command-center";
import { EmptyState, Filter, FilterPanel, SectionHeading } from "@/components/command-center/ui";
import { PriorityCard } from "@/components/command-center/PriorityCard";
import { TakeActionPanel } from "@/components/command-center/TakeActionPanel";
import { itemForScore } from "@/lib/command-center/selectors";
import { isOverdue } from "@/lib/command-center/scoring";
import { classifyPersonalRelation, isMyActionItem, type PersonalRelationIdentity } from "@/lib/command-center/personal-relation";
import type { PersonalRelation, PriorityScoreResult, Severity, WorkItem } from "@/lib/command-center/types";

const FILTERS: { key: string; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "CRITICAL", label: "Critical" },
  { key: "HIGH", label: "High" },
  { key: "ON_TRACK", label: "On track" },
  { key: "OVERDUE", label: "Overdue" },
];

// V2.14 §3 — same relation filter shape/UX as Attention Queue's, for consistency.
type RelationFilter = "ALL" | "ASSIGNED" | "MENTIONED" | "FOLLOWING";
const RELATIONS: RelationFilter[] = ["ALL", "ASSIGNED", "MENTIONED", "FOLLOWING"];

function matchesRelationFilter(relation: PersonalRelation, filter: RelationFilter): boolean {
  if (filter === "ALL") return true;
  if (filter === "ASSIGNED") return relation === "ASSIGNED" || relation === "ASSIGNED_AND_MENTIONED";
  if (filter === "MENTIONED") return relation === "MENTIONED" || relation === "ASSIGNED_AND_MENTIONED";
  return relation === "FOLLOWING";
}

function PrioritiesInner() {
  const { state, today, derived, filteredData, store, workRelevanceIndex, proactive, personalFocus } = useCommandCenter();
  const searchParams = useSearchParams();
  const [filter, setFilter] = useState<string>(searchParams.get("filter") ?? "ALL");
  const [relationFilter, setRelationFilter] = useState<RelationFilter>("ALL");
  const [selected, setSelected] = useState<{ item: WorkItem; result: PriorityScoreResult } | null>(null);
  const myActionItemsOnly = state.myActionItemsOnly.priorities;

  // V2.14 §3 — built once per render, not re-scanned per item (per Task 1).
  const relationIdentity: PersonalRelationIdentity = useMemo(
    () => ({ displayName: state.ownerName, accountId: state.personalIdentity?.accountId }),
    [state.ownerName, state.personalIdentity?.accountId]
  );
  const mentionedIssueKeys = useMemo(() => new Set(state.mentionEvents.map((m) => m.issueKey)), [state.mentionEvents]);

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
    if (filter !== "ALL") {
      if (filter === "OVERDUE" && !isOverdue(item, today)) return false;
      if (filter === "ON_TRACK" && result.classification !== "MEDIUM" && result.classification !== "LOW") return false;
      if (filter !== "OVERDUE" && filter !== "ON_TRACK" && result.classification !== (filter as Severity)) return false;
    }
    const relation = classifyPersonalRelation(item, relationIdentity, mentionedIssueKeys, item.key);
    if (!matchesRelationFilter(relation, relationFilter)) return false;
    // V2.14 §4 — one more AND condition, narrows only.
    if (myActionItemsOnly && !isMyActionItem(relation)) return false;
    return true;
  });

  return (
    <div className="space-y-4 pb-16">
      <SectionHeading title="Priorities" subtitle="Every open work item, scored by the deterministic priority model." />

      {/* V2.17 Task 3 §3 — severity tabs stay visible (the primary, most-scanned filter on
          this page); Relation + "My action items only" — secondary, lower-traffic — fold
          behind one "Filters" disclosure instead of sitting in the same always-visible row.
          No filtering capability removed, same as the Attention Queue consolidation. */}
      <div className="flex flex-wrap items-center gap-1">
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
        <div className="ml-auto">
          <FilterPanel summary={relationFilter !== "ALL" || myActionItemsOnly ? String([relationFilter !== "ALL", myActionItemsOnly].filter(Boolean).length) : undefined}>
            <Filter
              label="Relation"
              value={relationFilter}
              options={RELATIONS}
              onChange={setRelationFilter}
              labels={{ ALL: "All", ASSIGNED: "Assigned to you", MENTIONED: "Mentioned you", FOLLOWING: "Following" }}
            />
            <label className="flex items-center gap-1.5 text-xs text-text3">
              <input type="checkbox" checked={myActionItemsOnly} onChange={(e) => store.setMyActionItemsOnly("priorities", e.target.checked)} className="h-3.5 w-3.5" />
              My action items only
            </label>
          </FilterPanel>
        </div>
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
                today={today}
                proactive={proactive}
                personalFocus={personalFocus}
                relation={classifyPersonalRelation(item, relationIdentity, mentionedIssueKeys, item.key)}
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
