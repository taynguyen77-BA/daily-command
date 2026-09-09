"use client";

// V2.0 §1.4 — RiskCard used to call getAIProvider() from a bare useEffect on every mount
// (i.e. once per risk in the rendered list, with zero user gesture). Both AI surfaces here
// are now strictly on-demand: the reasoning explanation lives behind the shared Why Should
// I Care drawer's "Ask Claude" button, and the aging assessment lives behind its own
// button — both routed through the entity cache (ai/ai-cache.ts) so a re-open with
// unchanged evidence never re-hits the model.

import { useMemo, useState } from "react";
import { getAIProvider } from "@/lib/command-center/ai";
import { withAICache } from "@/lib/command-center/ai/ai-cache";
import { evidenceForRisk } from "@/lib/command-center/evidence";
import { projectRiskImpact } from "@/lib/command-center/impact-projection";
import { buildWhyShouldICare } from "@/lib/command-center/why-should-i-care";
import type { ProactiveAssessment, Risk, RiskEscalation } from "@/lib/command-center/types";
import { AiProviderIndicator, ConfidenceTag, MetaPill, RiskBadge, TrustLabel } from "./ui";
import { WhyShouldICareDrawer } from "./WhyShouldICareDrawer";

function RiskAgingAssessment({ risk, escalation }: { risk: Risk; escalation: RiskEscalation }) {
  const [aging, setAging] = useState<ProactiveAssessment | null>(null);
  const [cacheState, setCacheState] = useState<"cached" | "refreshed" | null>(null);
  const [mode, setMode] = useState<"mock" | "claude">("mock");
  const [loading, setLoading] = useState(false);

  async function assess() {
    if (loading) return;
    setLoading(true);
    try {
      const facts = [
        `Risk: ${risk.title}`,
        `Currently ${escalation.currentSeverity}`,
        `Open ${escalation.daysOpen} day(s)`,
        `${escalation.evidenceCount} supporting evidence item(s)`,
      ];
      const trendQualityNote =
        escalation.daysOpen >= 3 ? `Observed across ${escalation.daysOpen} daily snapshots.` : `Only ${escalation.daysOpen} day(s) of history — early signal.`;
      const { value, cacheState: cs } = await withAICache(
        "assessProactive",
        `risk-aging:${risk.id}`,
        facts,
        risk.evidence.map((e) => ({ content: e })),
        () => getAIProvider().assessProactive("risk aging", facts, risk.evidence, trendQualityNote)
      );
      setAging(value);
      setCacheState(cs);
      setMode(getAIProvider().mode);
    } finally {
      setLoading(false);
    }
  }

  if (!aging) {
    return (
      <button onClick={assess} disabled={loading} className="mt-2 text-xs font-medium text-accent2 hover:underline disabled:opacity-50">
        {loading ? "Assessing aging risk…" : "Assess aging risk"}
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-border bg-surface2 p-2 text-xs">
      <div className="mb-1 flex items-center gap-1">
        <TrustLabel kind="ai-assessment" />
        {cacheState && <AiProviderIndicator state={cacheState === "cached" ? "CACHED" : mode === "mock" ? "MOCK_FALLBACK" : "REAL_CLAUDE"} />}
      </div>
      <p className="text-text2">{aging.assessment}</p>
    </div>
  );
}

export function RiskCard({ risk, isDemo, escalation, showAgingAssessment }: { risk: Risk; isDemo: boolean; escalation?: RiskEscalation; showAgingAssessment?: boolean }) {
  const facts = useMemo(
    () => [`Level: ${risk.level}`, `Reason detected: ${risk.reason}`, `Potential impact: ${risk.potentialImpact}`],
    [risk]
  );
  const evidence = useMemo(() => evidenceForRisk(risk, isDemo ? "demo" : "manual"), [risk, isDemo]);
  const content = useMemo(
    () =>
      buildWhyShouldICare({
        fact: facts,
        signal: risk.reason,
        impact: projectRiskImpact(risk),
        unknown: risk.confidence < 0.6 ? ["Confidence in this risk detection is low — more evidence may change the assessment."] : [],
        nextMove: risk.mitigation,
        evidence,
      }),
    [facts, risk, evidence]
  );

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-2 flex items-center gap-2">
        <RiskBadge level={risk.level} />
        {risk.auto === false && <MetaPill>Manually logged</MetaPill>}
        <ConfidenceTag confidence={risk.confidence} />
        {escalation?.reopened && <MetaPill variant="danger">Reopened</MetaPill>}
      </div>
      <h3 className="font-display text-base text-text">{risk.title}</h3>
      <p className="mt-2 text-sm text-text2">{risk.reason}</p>

      {escalation && (
        <p className="mt-1 text-xs text-text3">
          {escalation.trend === "worsening" ? "↑" : escalation.trend === "improving" ? "↓" : "→"} {escalation.trend}
          {escalation.previousSeverity && escalation.previousSeverity !== escalation.currentSeverity ? ` (${escalation.previousSeverity} → ${escalation.currentSeverity})` : ""} — open {escalation.daysOpen} day(s)
        </p>
      )}

      {showAgingAssessment && escalation && <RiskAgingAssessment risk={risk} escalation={escalation} />}

      <WhyShouldICareDrawer
        content={content}
        askClaude={{
          task: "detectRisks",
          entityId: risk.id,
          run: async () => {
            const trace = await getAIProvider().detectRisks(risk, facts, evidence);
            return {
              text: `${trace.inference} ${trace.recommendation}`.trim(),
              confidence: trace.confidence,
              insufficientEvidence: trace.insufficientEvidence,
              mode: getAIProvider().mode,
            };
          },
        }}
      />

      <div className="mt-2 flex items-center gap-1 text-[10px] text-text3">
        <TrustLabel kind="calculated" />
        <span>risk level is deterministic; AI content above is on-demand and clearly labeled.</span>
      </div>
    </div>
  );
}
