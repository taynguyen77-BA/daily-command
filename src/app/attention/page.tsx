"use client";

// Attention Queue — full list (V1.4 §22-26, §38-40). Condensed version lives on the main
// dashboard (AttentionQueuePanel); this page adds category/severity/lifecycle filters and
// the full lifecycle control set.

import { useState } from "react";
import { useCommandCenter } from "@/components/command-center/use-command-center";
import { AttentionItemCard } from "@/components/command-center/AttentionQueuePanel";
import { EmptyState, Filter, Panel, SectionHeading } from "@/components/command-center/ui";
import { isMyActionItem } from "@/lib/command-center/personal-relation";
import type { AttentionCategory, AttentionLifecycle, AttentionSeverity, PersonalRelation } from "@/lib/command-center/types";

type LifecycleFilter = AttentionLifecycle | "ALL" | "ACTIVE_DEFAULT";
// V2.14 §3 — a second, independent filter, combined with category/severity/lifecycle via AND
// (never OR): "Assigned to you"/"Mentioned you" each match their own relation AND the
// combined ASSIGNED_AND_MENTIONED value, since a mention on an item that's also assigned to
// you is legitimately both.
type RelationFilter = "ALL" | "ASSIGNED" | "MENTIONED" | "FOLLOWING";

// V2.10 §5 — MENTION/ASSIGNMENT appended, never inserted among the original six.
const CATEGORIES: (AttentionCategory | "ALL")[] = ["ALL", "DRIFT", "RISK", "DEPENDENCY", "DECISION", "ACTION", "COMMUNICATION", "MENTION", "ASSIGNMENT"];
const SEVERITIES: (AttentionSeverity | "ALL")[] = ["ALL", "CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
const LIFECYCLES: LifecycleFilter[] = ["ACTIVE_DEFAULT", "NEW", "ACTIVE", "ACKNOWLEDGED", "SNOOZED", "RESOLVED", "REOPENED", "ALL"];
const RELATIONS: RelationFilter[] = ["ALL", "ASSIGNED", "MENTIONED", "FOLLOWING"];

function matchesRelationFilter(relation: PersonalRelation | undefined, filter: RelationFilter): boolean {
  if (filter === "ALL") return true;
  if (!relation) return false;
  if (filter === "ASSIGNED") return relation === "ASSIGNED" || relation === "ASSIGNED_AND_MENTIONED";
  if (filter === "MENTIONED") return relation === "MENTIONED" || relation === "ASSIGNED_AND_MENTIONED";
  return relation === "FOLLOWING";
}

export default function AttentionPage() {
  const { state, proactive, store } = useCommandCenter();
  const [category, setCategory] = useState<AttentionCategory | "ALL">("ALL");
  const [severity, setSeverity] = useState<AttentionSeverity | "ALL">("ALL");
  const [lifecycle, setLifecycle] = useState<LifecycleFilter>("ACTIVE_DEFAULT");
  const [relation, setRelation] = useState<RelationFilter>("ALL");
  const myActionItemsOnly = state.myActionItemsOnly.attention;

  if (!state.loaded) {
    return <EmptyState title="No data yet" description="Load the demo dataset to see the Attention Queue in action." onLoadDemo={() => store.loadDemoData()} />;
  }

  const items = (proactive?.attentionQueue ?? []).filter((i) => {
    if (category !== "ALL" && i.category !== category) return false;
    if (severity !== "ALL" && i.severity !== severity) return false;
    if (lifecycle === "ACTIVE_DEFAULT") {
      if (i.lifecycle === "SNOOZED" || i.lifecycle === "RESOLVED") return false;
    } else if (lifecycle !== "ALL" && i.lifecycle !== lifecycle) return false;
    if (!matchesRelationFilter(i.relation, relation)) return false;
    // V2.14 §4 — one more AND condition, narrows only, never widens whatever else is selected.
    if (myActionItemsOnly && !isMyActionItem(i.relation)) return false;
    return true;
  });

  return (
    <div className="space-y-6 pb-16">
      <SectionHeading title="Attention Queue" subtitle="Every proactive signal, deduplicated and priority-ordered — see the main dashboard for the condensed view." />

      <Panel className="flex flex-wrap items-center gap-4 p-4">
        <Filter
          label="Category"
          value={category}
          options={CATEGORIES}
          onChange={(v) => setCategory(v as AttentionCategory | "ALL")}
          labels={{ MENTION: "Mentioned me", ASSIGNMENT: "Assigned to me" }}
        />
        <Filter label="Severity" value={severity} options={SEVERITIES} onChange={(v) => setSeverity(v as AttentionSeverity | "ALL")} />
        <Filter label="Lifecycle" value={lifecycle} options={LIFECYCLES} onChange={setLifecycle} labels={{ ACTIVE_DEFAULT: "Active (default)" }} />
        <Filter
          label="Relation"
          value={relation}
          options={RELATIONS}
          onChange={setRelation}
          labels={{ ALL: "All", ASSIGNED: "Assigned to you", MENTIONED: "Mentioned you", FOLLOWING: "Following" }}
        />
        <label className="ml-auto flex items-center gap-1.5 text-xs text-text3">
          <input type="checkbox" checked={myActionItemsOnly} onChange={(e) => store.setMyActionItemsOnly("attention", e.target.checked)} className="h-3.5 w-3.5" />
          My action items only
        </label>
      </Panel>

      {items.length === 0 ? (
        <Panel className="p-6 text-sm text-text3">No attention items match these filters.</Panel>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {items.map((item) => (
            <AttentionItemCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
