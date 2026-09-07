"use client";

// Attention Queue — full list (V1.4 §22-26, §38-40). Condensed version lives on the main
// dashboard (AttentionQueuePanel); this page adds category/severity/lifecycle filters and
// the full lifecycle control set.

import { useState } from "react";
import { useCommandCenter } from "@/components/command-center/use-command-center";
import { AttentionItemCard } from "@/components/command-center/AttentionQueuePanel";
import { EmptyState, Panel, SectionHeading } from "@/components/command-center/ui";
import type { AttentionCategory, AttentionLifecycle, AttentionSeverity } from "@/lib/command-center/types";

type LifecycleFilter = AttentionLifecycle | "ALL" | "ACTIVE_DEFAULT";

// V2.10 §5 — MENTION/ASSIGNMENT appended, never inserted among the original six.
const CATEGORIES: (AttentionCategory | "ALL")[] = ["ALL", "DRIFT", "RISK", "DEPENDENCY", "DECISION", "ACTION", "COMMUNICATION", "MENTION", "ASSIGNMENT"];
const SEVERITIES: (AttentionSeverity | "ALL")[] = ["ALL", "CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
const LIFECYCLES: LifecycleFilter[] = ["ACTIVE_DEFAULT", "NEW", "ACTIVE", "ACKNOWLEDGED", "SNOOZED", "RESOLVED", "REOPENED", "ALL"];

export default function AttentionPage() {
  const { state, proactive, store } = useCommandCenter();
  const [category, setCategory] = useState<AttentionCategory | "ALL">("ALL");
  const [severity, setSeverity] = useState<AttentionSeverity | "ALL">("ALL");
  const [lifecycle, setLifecycle] = useState<LifecycleFilter>("ACTIVE_DEFAULT");

  if (!state.loaded) {
    return <EmptyState title="No data yet" description="Load the demo dataset to see the Attention Queue in action." onLoadDemo={() => store.loadDemoData()} />;
  }

  const items = (proactive?.attentionQueue ?? []).filter((i) => {
    if (category !== "ALL" && i.category !== category) return false;
    if (severity !== "ALL" && i.severity !== severity) return false;
    if (lifecycle === "ACTIVE_DEFAULT") return i.lifecycle !== "SNOOZED" && i.lifecycle !== "RESOLVED";
    if (lifecycle !== "ALL" && i.lifecycle !== lifecycle) return false;
    return true;
  });

  return (
    <div className="space-y-6 pb-16">
      <SectionHeading title="Attention Queue" subtitle="Every proactive signal, deduplicated and priority-ordered — see the main dashboard for the condensed view." />

      <Panel className="flex flex-wrap gap-4 p-4">
        <Filter
          label="Category"
          value={category}
          options={CATEGORIES}
          onChange={(v) => setCategory(v as AttentionCategory | "ALL")}
          labels={{ MENTION: "Mentioned me", ASSIGNMENT: "Assigned to me" }}
        />
        <Filter label="Severity" value={severity} options={SEVERITIES} onChange={(v) => setSeverity(v as AttentionSeverity | "ALL")} />
        <Filter label="Lifecycle" value={lifecycle} options={LIFECYCLES} onChange={setLifecycle} labels={{ ACTIVE_DEFAULT: "Active (default)" }} />
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

function Filter<T extends string>({ label, value, options, onChange, labels }: { label: string; value: T; options: T[]; onChange: (v: T) => void; labels?: Partial<Record<T, string>> }) {
  return (
    <label className="flex items-center gap-2 text-xs text-text3">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className="rounded-md border border-border bg-surface2 px-2 py-1 text-sm text-text">
        {options.map((o) => (
          <option key={o} value={o}>
            {labels?.[o] ?? o}
          </option>
        ))}
      </select>
    </label>
  );
}
