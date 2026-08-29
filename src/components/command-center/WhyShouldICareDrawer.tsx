"use client";

// Why Should I Care? (V2.0 §4) — the shared decision-support drawer. FACT/SIGNAL/IMPACT/
// UNKNOWN/NEXT MOVE render immediately and synchronously (deterministic, reused Evidence/
// TrustLabel architecture — see why-should-i-care.ts). An AI recommendation is a clearly
// separate, optional sub-section that only fires when the user explicitly clicks
// "Ask Claude" — see V2.0 §1.4/§4. That call goes through the entity cache (ai-cache.ts)
// so re-opening the drawer with unchanged evidence never re-hits the model.

import { useState } from "react";
import type { AITask } from "@/lib/command-center/ai/schemas";
import { withAICache } from "@/lib/command-center/ai/ai-cache";
import type { WhyShouldICareContent } from "@/lib/command-center/why-should-i-care";
import { AiProviderIndicator, TrustLabel } from "./ui";

export interface AskClaudeConfig {
  task: AITask;
  entityId: string;
  run: () => Promise<{ text: string; confidence: number; insufficientEvidence?: boolean; mode: "mock" | "claude" }>;
  label?: string;
}

interface AiRecommendationState {
  text: string;
  confidence: number;
  insufficientEvidence?: boolean;
  mode: "mock" | "claude";
  cacheState: "cached" | "refreshed";
}

export function WhyShouldICareDrawer({
  content,
  askClaude,
  triggerLabel = "Why should I care?",
}: {
  content: WhyShouldICareContent;
  askClaude?: AskClaudeConfig;
  triggerLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [ai, setAi] = useState<AiRecommendationState | null>(null);
  const [loading, setLoading] = useState(false);

  async function askClaudeNow() {
    if (!askClaude || loading) return;
    setLoading(true);
    try {
      const { value, cacheState } = await withAICache(askClaude.task, askClaude.entityId, content.fact, content.evidence, askClaude.run);
      setAi({ ...value, cacheState });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-2">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-xs font-medium text-accent2 hover:underline">
        {open ? "Hide" : triggerLabel}
      </button>
      {open && (
        <div className="mt-2 space-y-3 rounded-md border border-border bg-surface2 p-3 text-xs">
          <section>
            <p className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide text-text3">
              <TrustLabel kind="calculated" /> Fact
            </p>
            <ul className="space-y-0.5 text-text2">
              {content.fact.length ? content.fact.map((f, i) => <li key={i}>- {f}</li>) : <li>- (none provided)</li>}
            </ul>
          </section>

          <section>
            <p className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide text-text3">
              <TrustLabel kind="calculated" /> Signal
            </p>
            <p className="text-text2">{content.signal}</p>
          </section>

          <section>
            <p className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide text-text3">
              <TrustLabel kind="calculated" /> Impact if nothing changes
            </p>
            <p className="text-text2">{content.impact.unresolvedSignal}</p>
            {content.impact.insufficientEvidence && <p className="mt-1 text-yellow">Insufficient evidence for a confident projection.</p>}
          </section>

          <section>
            <p className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide text-text3">
              <TrustLabel kind="calculated" /> Unknown
            </p>
            <ul className="space-y-0.5 text-text2">
              {content.unknown.length ? content.unknown.map((u, i) => <li key={i}>- {u}</li>) : <li>- Nothing currently flagged as missing.</li>}
            </ul>
          </section>

          <section>
            <p className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide text-text3">
              <TrustLabel kind="calculated" /> Next move
            </p>
            <p className="text-text2">{content.nextMove}</p>
          </section>

          {content.evidence.length > 0 && (
            <section>
              <p className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide text-text3">
                <TrustLabel kind="evidence" /> Evidence
              </p>
              <ul className="space-y-0.5 text-text2">
                {content.evidence.map((e) => (
                  <li key={e.id}>- {e.content}</li>
                ))}
              </ul>
            </section>
          )}

          {askClaude && (
            <section className="border-t border-border pt-2">
              {!ai ? (
                <button onClick={askClaudeNow} disabled={loading} className="text-xs font-medium text-accent2 hover:underline disabled:opacity-50">
                  {loading ? "Asking Claude…" : (askClaude.label ?? "Ask Claude for a recommendation")}
                </button>
              ) : (
                <div>
                  <p className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide text-text3">
                    <TrustLabel kind="ai-recommendation" /> AI recommendation
                    <AiProviderIndicator state={ai.cacheState === "cached" ? "CACHED" : ai.mode === "mock" ? "MOCK_FALLBACK" : "REAL_CLAUDE"} />
                  </p>
                  {ai.insufficientEvidence && <p className="mb-1 text-yellow">Insufficient evidence — best-effort only.</p>}
                  <p className="text-text2">{ai.text}</p>
                  <p className="mt-1 text-text3">Confidence: {Math.round(ai.confidence * 100)}%</p>
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
