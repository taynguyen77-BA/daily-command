"use client";

// V1.6 §38-40 — AI Daily Guidance. Strictly on-demand (§59 — never called automatically or
// per-item). Receives only deterministic top focus items, evidence, current plan, and
// recent meaningful outcomes — never raw Jira payload or credentials (§38).

import { useState } from "react";
import { getAIProvider } from "@/lib/command-center/ai";
import type { DailyGuidanceResult, PersonalFocusResult, PersonalPlanItem } from "@/lib/command-center/types";
import type { OutcomeScorecard } from "@/lib/command-center/types";
import { ConfidenceTag, Panel, TrustLabel } from "./ui";

export function DailyGuidancePanel({ personalFocus, planItems, outcomeScorecard }: { personalFocus: PersonalFocusResult; planItems: PersonalPlanItem[]; outcomeScorecard?: OutcomeScorecard }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DailyGuidanceResult | null>(null);

  async function generate() {
    setLoading(true);
    const topFocusFacts = personalFocus.top3.map((c) => `${c.title} (${c.category}, ~${c.estimatedMinutes}m) — ${c.why}`);
    const watchFacts = personalFocus.byCategory.WATCH.slice(0, 5).map((c) => `${c.title} — ${c.why}`);
    const planFacts = planItems.map((p) => `${p.sourceType}:${p.sourceId} — ${p.status}`);
    const recentOutcomeFacts = outcomeScorecard ? [`Did today help: ${outcomeScorecard.didTodayHelp}`, outcomeScorecard.controlEffectiveness] : [];
    const evidenceStrings = personalFocus.top3.flatMap((c) => c.evidence);
    const guidance = await getAIProvider().generateDailyGuidance(topFocusFacts, watchFacts, planFacts, recentOutcomeFacts, evidenceStrings);
    setResult(guidance);
    setLoading(false);
  }

  return (
    <Panel className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <TrustLabel kind="ai-assessment" />
        <span className="text-xs uppercase tracking-wide text-text3">AI daily guidance (on-demand)</span>
      </div>
      {!result ? (
        <button onClick={generate} disabled={loading} className="rounded-md border border-border px-3 py-1.5 text-sm text-text2 hover:border-accent hover:text-text disabled:opacity-60">
          {loading ? "Generating…" : "Generate Daily Guidance"}
        </button>
      ) : (
        <div className="space-y-2 text-sm">
          {result.insufficientEvidence ? (
            <p className="text-text3">{result.summary}</p>
          ) : (
            <>
              <p className="text-text2">{result.summary}</p>
              {result.topFocus.length > 0 && (
                <ul className="list-inside list-disc text-text2">
                  {result.topFocus.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              )}
              <p className="text-text2">
                <span className="text-text3">Recommendation: </span>
                {result.recommendation}
              </p>
              {result.evidenceReferences.length > 0 && (
                <div>
                  <p className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-text3">
                    <TrustLabel kind="evidence" /> Evidence references
                  </p>
                  <ul className="space-y-0.5 text-xs text-text2">
                    {result.evidenceReferences.map((e, i) => (
                      <li key={i}>- {e}</li>
                    ))}
                  </ul>
                </div>
              )}
              <ConfidenceTag confidence={result.confidence} />
            </>
          )}
        </div>
      )}
    </Panel>
  );
}
