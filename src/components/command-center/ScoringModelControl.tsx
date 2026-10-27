"use client";

// P3.1 — the priority scoring model switch (Data & Settings → Features). v2 is the default; v1 is the
// original model, kept selectable. A device setting: switching it re-scores Priorities, Action Plan and
// the Command Center immediately, and switching back restores the old order exactly.

import { useCommandCenter } from "./use-command-center";

export function ScoringModelControl() {
  const { state, store } = useCommandCenter();
  const model = state.scoringModel ?? "v2";
  return (
    <div className="mt-4 border-t border-border pt-3 text-sm text-text2" data-scoring-model>
      <label className="flex flex-wrap items-center gap-2">
        <span className="text-text">Priority scoring model</span>
        <select value={model} onChange={(e) => store.setScoringModel(e.target.value === "v1" ? "v1" : "v2")} className="rounded border border-border bg-surface2 px-2 py-1 text-sm" aria-label="Priority scoring model">
          <option value="v2">v2 — uses Jira priority, awaiting-your-reply and status age (default)</option>
          <option value="v1">v1 — original model</option>
        </select>
      </label>
      <p className="mt-1 text-xs text-text3">
        v2 weights: Priority 20 · Deadline 20 · Awaiting you 15 · Blocker 15 · Aging 10 · Change frequency 10 · Dependency 5 · Ownership 5 (Business impact 10 + Priority 10 when a rating exists). Trends do not compare scores across models.
      </p>
    </div>
  );
}
