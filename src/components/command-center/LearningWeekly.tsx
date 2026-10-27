"use client";

// P3.3 — Weekly Review: what learning moved (up AND down, so nothing is de-prioritised silently), and — after
// 14 days of shadow data — a proposal to switch learning on, with the evidence of what would change.

import { useCommandCenter } from "./use-command-center";
import { learnedAdjustmentsFor } from "@/lib/command-center/scoring-context";
import { asLearnedMode, learningMoves, shouldProposeLearningOn } from "@/lib/command-center/learned-adjustments";
import { Panel, SectionHeading, TrustLabel } from "./ui";

export function LearningWeekly() {
  const { state, store, today } = useCommandCenter();
  const mode = asLearnedMode(state.learnedPriority);
  if (mode === "off" || (state.scoringModel ?? "v2") !== "v2") return null;
  const adjustments = learnedAdjustmentsFor(state, today);
  const { raised, lowered } = learningMoves(adjustments, 3);
  if (raised.length === 0 && lowered.length === 0) return null;
  const propose = shouldProposeLearningOn(mode, state.learnedShadowSince, adjustments, today);
  const list = (rows: typeof raised, sign: string) => (
    <ul className="space-y-1 text-sm text-text2">
      {rows.map((a) => (
        <li key={a.groupKey}>
          <span className="tabular text-text">{sign}{Math.abs(a.delta)}</span> {a.projectLabel} {a.priority} {a.issueType} — {a.evidence}
        </li>
      ))}
    </ul>
  );
  return (
    <section data-learning-weekly>
      <SectionHeading title={mode === "on" ? "What learning changed this week" : "What learning would change (shadow mode)"} subtitle="From your own history, with sample sizes. Both directions are shown, so nothing is pushed down silently." action={<TrustLabel kind="learned" />} />
      <Panel className="space-y-3 p-4">
        {raised.length > 0 && (
          <div>
            <p className="eyebrow">Moved up</p>
            {list(raised, "+")}
          </div>
        )}
        {lowered.length > 0 && (
          <div>
            <p className="eyebrow">Moved down (never for overdue, blocked, P1 or awaiting-you-past-SLA tickets)</p>
            {list(lowered, "−")}
          </div>
        )}
        {propose && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3 text-sm text-text2" data-learning-propose>
            <span>You have had learning in shadow mode for 14 days or more. Apply these adjustments to your scores?</span>
            <button onClick={() => store.setLearnedPriority("on")} className="btn btn-sm btn-secondary">Switch learning on</button>
          </div>
        )}
      </Panel>
    </section>
  );
}
