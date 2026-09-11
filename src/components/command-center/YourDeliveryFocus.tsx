"use client";

// "YOUR DELIVERY FOCUS" (V1.6 §8-9, §29, §32, §43). Sits between Control Tower and
// Attention on the main Command Center (§43) — the personal layer on top of project
// intelligence, never hiding it.

import { useState } from "react";
import Link from "next/link";
import type { PersonalFocusCandidate, PersonalFocusResult, SkipReason } from "@/lib/command-center/types";
import { isMyActionItem } from "@/lib/command-center/personal-relation";
import { useCommandCenter } from "./use-command-center";
import { PersonalFocusCard } from "./PersonalFocusCard";
import { FocusSession } from "./FocusSession";
import { ensurePlanItemId } from "./personal-focus-helpers";
import { Panel, SectionHeading, TrustLabel } from "./ui";

export function YourDeliveryFocus({ personalFocus, compact = false }: { personalFocus: PersonalFocusResult; compact?: boolean }) {
  const { state, today, store } = useCommandCenter();
  const [session, setSession] = useState<{ candidate: PersonalFocusCandidate; planItemId: string } | null>(null);
  const [showWhyOrder, setShowWhyOrder] = useState(false);
  // V2.14 §4 — display-only: narrows what's rendered below, never re-derives top3/the
  // 30-minute plan (both stay exactly the engine's own selection, just filtered afterward).
  const myActionItemsOnly = state.myActionItemsOnly.myDay;

  function startFocus(candidate: PersonalFocusCandidate) {
    const planItemId = ensurePlanItemId(store, state.personalPlan, candidate, today, personalFocus.candidates.indexOf(candidate));
    setSession({ candidate, planItemId });
  }

  // V2.23 — "I am intentionally not executing this right now" for a candidate that resolves
  // to a real ticket. Never called for a candidate with no single underlying work item.
  function skipCandidate(candidate: PersonalFocusCandidate, reason?: SkipReason) {
    if (!candidate.ticketKey) return;
    store.skipTicketInDailyCommand(candidate.ticketKey, reason);
  }

  const top3 = myActionItemsOnly ? personalFocus.top3.filter((c) => isMyActionItem(c.relation)) : personalFocus.top3;
  const thirtyMinutePlan = myActionItemsOnly ? personalFocus.thirtyMinutePlan.filter((c) => isMyActionItem(c.relation)) : personalFocus.thirtyMinutePlan;
  const thirtyMinutePlanTotalMinutes = myActionItemsOnly ? thirtyMinutePlan.reduce((s, c) => s + c.estimatedMinutes, 0) : personalFocus.thirtyMinutePlanTotalMinutes;

  return (
    <section>
      <SectionHeading
        title="Your Delivery Focus"
        subtitle="Deterministic personal focus — ranked from project intelligence, never a second task system."
        action={
          !compact ? (
            <Link href="/focus" className="text-xs font-medium text-accent2 hover:underline">
              Open My Day →
            </Link>
          ) : undefined
        }
      />

      {top3.length === 0 ? (
        <Panel className="p-6 text-sm text-text3">Nothing currently needs your personal focus.</Panel>
      ) : (
        <>
          <div className="mb-2 flex items-center gap-2">
            <TrustLabel kind="calculated" />
            <button onClick={() => setShowWhyOrder((s) => !s)} aria-expanded={showWhyOrder} className="text-xs font-medium text-accent2 hover:underline">
              {showWhyOrder ? "Hide" : "Why this order?"}
            </button>
          </div>
          {showWhyOrder && (
            <ol className="mb-3 space-y-0.5 rounded-md border border-border bg-surface2 p-3 text-xs text-text2">
              {top3.map((c, i) => (
                <li key={c.id}>
                  {i + 1}. {c.title} — {c.factors.filter((f) => f.available && f.contribution > 0).sort((a, b) => b.contribution - a.contribution)[0]?.detail ?? "baseline priority"} (score {c.score}/100)
                </li>
              ))}
            </ol>
          )}
          <div className="grid gap-3 md:grid-cols-3">
            {top3.map((c) => (
              <PersonalFocusCard key={c.id} candidate={c} onStartFocus={startFocus} onSkip={skipCandidate} />
            ))}
          </div>
        </>
      )}

      {personalFocus.overload && (
        <Panel className="mt-3 border-orange/30 p-4">
          <div className="mb-1 flex items-center gap-2">
            <TrustLabel kind="calculated" />
            <span className="text-xs font-semibold uppercase tracking-wide text-orange">Focus Overload</span>
          </div>
          <p className="text-sm text-text2">{personalFocus.overload.reason}</p>
          <p className="mt-1 text-xs text-text3">Now what: {personalFocus.overload.nowWhat}</p>
        </Panel>
      )}

      {personalFocus.contextSwitch && (
        <Panel className="mt-3 p-4">
          <div className="mb-1 flex items-center gap-2">
            <TrustLabel kind="calculated" />
            <span className="text-xs font-semibold uppercase tracking-wide text-text3">Context Switching</span>
          </div>
          <p className="text-sm text-text2">
            You have {personalFocus.contextSwitch.itemCount} planned item(s) across {personalFocus.contextSwitch.projectCount} project(s).
          </p>
          <p className="mt-1 text-xs text-text3">{personalFocus.contextSwitch.recommendation}</p>
        </Panel>
      )}

      <div className="mt-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text3">If you only have 30 minutes</p>
        {thirtyMinutePlan.length === 0 ? (
          <Panel className="p-4 text-sm text-text3">No personal focus items fit the next 30 minutes.</Panel>
        ) : (
          <Panel className="p-4">
            <ol className="space-y-1 text-sm text-text2">
              {thirtyMinutePlan.map((c, i) => (
                <li key={c.id} className="flex items-center justify-between gap-2">
                  <span>
                    {i + 1}. {c.title} — {c.estimatedMinutes}m
                  </span>
                  <button onClick={() => startFocus(c)} className="rounded border border-border px-2 py-0.5 text-xs text-text2 hover:border-accent hover:text-text">
                    Start
                  </button>
                </li>
              ))}
            </ol>
            <p className="mt-2 text-xs text-text3">Total: {thirtyMinutePlanTotalMinutes} min</p>
          </Panel>
        )}
      </div>

      {session && <FocusSession candidate={session.candidate} planItemId={session.planItemId} onClose={() => setSession(null)} />}
    </section>
  );
}
