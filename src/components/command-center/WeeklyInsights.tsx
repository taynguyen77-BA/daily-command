"use client";

// V2.38 J6 — Weekly Insights: 3-5 observations (each with its evidence) and 3 suggestions for
// next week, from deterministic facts about this week (ticket history, blockers by person, skip
// reasons, AI-triage acceptance). Saved per week, so the Reports weekly tab can include them.

import { useState, useSyncExternalStore } from "react";
import { commandCenterStore } from "@/lib/command-center/store";
import { getAIProvider } from "@/lib/command-center/ai";
import { buildWeeklyFacts, generateWeeklyInsights, type StoredWeeklyInsights } from "@/lib/command-center/ai/weekly-insights";
import { mondayOf } from "@/lib/command-center/reports";
import { todayLocalIso } from "@/lib/command-center/date-utils";
import { Panel, SectionHeading, TrustLabel } from "./ui";

export function WeeklyInsightsView({ stored }: { stored: StoredWeeklyInsights }) {
  return (
    <div className="space-y-2 text-sm" data-weekly-insights-view>
      <ul className="space-y-1">
        {stored.insights.observations.map((o, i) => (
          <li key={i}>
            <p className="text-text">{o.text}</p>
            <p className="text-xs text-text3">Evidence: {o.evidence.join(" · ")}</p>
          </li>
        ))}
      </ul>
      <p className="text-xs font-semibold uppercase tracking-wide text-text3">Suggestions for next week</p>
      <ul className="list-disc pl-5 text-text2">{stored.insights.suggestions.map((s, i) => <li key={i}>{s}</li>)}</ul>
    </div>
  );
}

export function WeeklyInsights() {
  const state = useSyncExternalStore(commandCenterStore.subscribe, commandCenterStore.getSnapshot, commandCenterStore.getServerSnapshot);
  const [busy, setBusy] = useState(false);
  if (!state.features.weeklyInsights) return null;
  const today = todayLocalIso();
  const weekStart = mondayOf(today);
  const stored = state.aiWeeklyInsights[weekStart];

  const generate = async () => {
    setBusy(true);
    const s = commandCenterStore.getSnapshot();
    const facts = buildWeeklyFacts({ states: s.ticketWorkStates, data: s.data, triageStats: s.aiTriageStats, weekStart, weekEnd: today });
    commandCenterStore.saveWeeklyInsights(await generateWeeklyInsights({ facts, weekStart, weekEnd: today, customTerms: s.aiDataProtection.customTerms, provider: getAIProvider() }));
    setBusy(false);
  };

  return (
    <Panel className="p-4" data-weekly-insights>
      <SectionHeading
        title="Weekly insights"
        subtitle="Patterns in this week's ticket history, blockers, skip reasons and triage — each with its evidence."
        action={
          <button onClick={() => void generate()} disabled={busy} className="btn btn-sm btn-secondary">
            {busy ? "Thinking…" : stored ? "Refresh" : "Generate"}
          </button>
        }
      />
      {stored ? (
        <>
          <p className="mb-2 flex items-center gap-2 text-xs text-text3">
            <TrustLabel kind="ai-assessment" /> {stored.mode === "claude" ? "AI" : "Deterministic (AI not used)"} · {stored.createdAt.slice(0, 16).replace("T", " ")}
          </p>
          <WeeklyInsightsView stored={stored} />
        </>
      ) : (
        <p className="text-sm text-text3">Not generated for this week yet.</p>
      )}
    </Panel>
  );
}
