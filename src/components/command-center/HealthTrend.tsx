"use client";

// V2.0 §1.4 — used to call getAIProvider().interpretTrend() automatically from useEffect
// on every mount. Deterministic trend data (below) still renders immediately; the AI
// interpretation is now behind an explicit button, routed through the entity cache.

import { useState } from "react";
import { getAIProvider } from "@/lib/command-center/ai";
import { withAICache } from "@/lib/command-center/ai/ai-cache";
import type { HealthTrend as HealthTrendType, TrendInterpretation } from "@/lib/command-center/types";
import { AiProviderIndicator, ConfidenceTag, Panel, SectionHeading, TrustLabel } from "./ui";

export function HealthTrend({ trend, currentConfidence }: { trend: HealthTrendType; currentConfidence: number }) {
  const [interp, setInterp] = useState<TrendInterpretation | null>(null);
  const [cacheState, setCacheState] = useState<"cached" | "refreshed" | null>(null);
  const [mode, setMode] = useState<"mock" | "claude">("mock");
  const [loading, setLoading] = useState(false);

  async function explain() {
    if (loading) return;
    setLoading(true);
    try {
      const facts = trend.deltas.map((d) => `${d.label}: ${d.before} -> ${d.after} (${d.delta})`);
      const { value, cacheState: cs } = await withAICache(
        "interpretTrend",
        `health-trend:${trend.overall}`,
        facts,
        facts.map((f) => ({ content: f })),
        () => getAIProvider().interpretTrend(trend, currentConfidence)
      );
      setInterp(value);
      setCacheState(cs);
      setMode(getAIProvider().mode);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section>
      <SectionHeading title="Health Trend" subtitle="Today vs. the last snapshot." />
      <Panel className="p-4">
        {!trend.hasHistory ? (
          <p className="text-sm text-text3">No previous snapshot yet — run &quot;Close My Day&quot; to start tracking trends.</p>
        ) : (
          <>
            <div className="mb-3 flex items-center gap-2">
              <TrustLabel kind="calculated" />
              <span className={`text-sm font-medium ${trend.overall === "improving" ? "text-green" : trend.overall === "deteriorating" ? "text-red" : "text-text2"}`}>
                Overall: {trend.overall}
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {trend.deltas.map((d) => (
                <div key={d.label} className="rounded-md border border-border bg-surface2 px-3 py-2 text-sm">
                  <p className="text-text3">{d.label}</p>
                  <p className={d.direction === "improving" ? "text-green" : d.direction === "deteriorating" ? "text-red" : "text-text2"}>
                    {d.before} → {d.after} ({d.delta > 0 ? "+" : ""}
                    {d.delta})
                  </p>
                </div>
              ))}
            </div>

            {!interp ? (
              <button onClick={explain} disabled={loading} className="mt-4 text-sm font-medium text-accent2 hover:underline disabled:opacity-50">
                {loading ? "Asking Claude…" : "Explain this trend"}
              </button>
            ) : (
              <div className="mt-4 space-y-2 border-t border-border pt-4 text-sm">
                {interp.insufficientHistory ? (
                  <p className="text-text3">{interp.recommendedResponse}</p>
                ) : (
                  <>
                    <p className="flex items-center gap-1">
                      <TrustLabel kind="ai-assessment" />
                      {cacheState && <AiProviderIndicator state={cacheState === "cached" ? "CACHED" : mode === "mock" ? "MOCK_FALLBACK" : "REAL_CLAUDE"} />}
                      <span className="text-text2">{interp.whyItMatters}</span>
                    </p>
                    <p className="text-text2">
                      <span className="text-text3">Likely impact: </span>
                      {interp.likelyImpact}
                    </p>
                    <p>
                      <TrustLabel kind="ai-recommendation" /> <span className="text-text2">{interp.recommendedResponse}</span>
                    </p>
                    <ConfidenceTag confidence={interp.confidence} />
                  </>
                )}
              </div>
            )}
          </>
        )}
      </Panel>
    </section>
  );
}
