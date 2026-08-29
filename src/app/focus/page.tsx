"use client";

// /focus (V1.6 §44-45) — the Personal Focus Page. TODAY / TOP 3 / IF YOU ONLY HAVE 30
// MINUTES / MY AGENDA / BLOCKED / WATCH / COMPLETED. Mobile-safe at 375px (§45): no
// horizontal overflow, evidence stays collapsible, dense tables avoided.

import { useEffect, useRef } from "react";
import { useCommandCenter } from "@/components/command-center/use-command-center";
import { YourDeliveryFocus } from "@/components/command-center/YourDeliveryFocus";
import { MyDayAgenda } from "@/components/command-center/MyDayAgenda";
import { DailyGuidancePanel } from "@/components/command-center/DailyGuidancePanel";
import { EmptyState, Panel, SectionHeading } from "@/components/command-center/ui";

export default function FocusPage() {
  const { state, today, personalFocus, proactive, store } = useCommandCenter();
  const reviewedRef = useRef(false);

  useEffect(() => {
    if (reviewedRef.current) return;
    if (!state.loaded) return;
    const alreadyReviewedToday = state.memoryEvents.some((e) => e.kind === "DAILY_FOCUS_REVIEWED" && e.date === today);
    if (!alreadyReviewedToday) {
      store.recordDailyFocusReviewed(today);
    }
    reviewedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.loaded]);

  if (!state.loaded) {
    return <EmptyState title="No data yet" description="Load the demo dataset to see your personal delivery focus." onLoadDemo={() => store.loadDemoData()} />;
  }

  if (!personalFocus) {
    return <Panel className="p-6 text-sm text-text3">Personal focus is not available yet.</Panel>;
  }

  return (
    <div className="space-y-8 pb-16">
      <SectionHeading title="My Day" subtitle="What should I personally focus on today — connected to project intelligence, not a second task system." />

      {!state.ownerName && (
        <Panel className="border-accent/30 p-4 text-sm text-text2">
          Your identity is not set, so ownership-based ranking (DO NOW) can&apos;t be fully explicit yet.{" "}
          <a href="/data-settings" className="font-medium text-accent2 hover:underline">Set it in Data & Settings</a>.
        </Panel>
      )}

      <YourDeliveryFocus personalFocus={personalFocus} />

      <DailyGuidancePanel personalFocus={personalFocus} planItems={state.personalPlan.filter((p) => p.plannedDate === today)} outcomeScorecard={proactive?.outcomeScorecard} />

      <section>
        <SectionHeading title="My Agenda" subtitle="Reconciled against live project state — plan changes are always surfaced, never silent." />
        <MyDayAgenda personalFocus={personalFocus} />
      </section>

      {personalFocus.projectBalance.length > 0 && (
        <section>
          <SectionHeading title="Attention By Project" subtitle="Descriptive only." />
          <Panel className="p-4">
            <ul className="space-y-1 text-sm text-text2">
              {personalFocus.projectBalance.map((p) => (
                <li key={p.projectId} className="flex items-center justify-between">
                  <span>{p.projectName}</span>
                  <span className="text-text3">{p.pct}%</span>
                </li>
              ))}
            </ul>
          </Panel>
        </section>
      )}
    </div>
  );
}
