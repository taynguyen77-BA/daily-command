"use client";

// Controlled Ask Claude (V2.0 §11) — "Ask Claude about this", invoked only from a specific
// bounded context (a Decision, a Risk via WhyShouldICareDrawer, an Attention item). Claude
// receives ONLY the facts/evidence the caller already computed — never raw domain objects,
// never a raw Jira payload, never credentials (same discipline as ai-context.ts). This is
// deliberately NOT a chatbot: no free-text input, no conversation history — a fixed menu
// of bounded question types, each a single on-demand call routed through the entity cache.
// Every answer renders Evidence + Unknowns + Recommendation + TrustLabel, per spec.

import { useState } from "react";
import { getAIProvider } from "@/lib/command-center/ai";
import { withAICache } from "@/lib/command-center/ai/ai-cache";
import type { Evidence } from "@/lib/command-center/types";
import { AiProviderIndicator, ConfidenceTag, TrustLabel } from "./ui";

const QUESTION_TYPES = [
  { id: "summarize", label: "Summarize", query: (subject: string) => `Summarize the current situation for: ${subject}` },
  { id: "tradeoffs", label: "Explain trade-offs", query: (subject: string) => `Explain the trade-offs at play for: ${subject}` },
  { id: "missing", label: "What's missing?", query: (subject: string) => `Identify missing information for: ${subject}` },
  { id: "options", label: "Propose options", query: (subject: string) => `Propose options for: ${subject}` },
  { id: "questions", label: "What should I ask?", query: (subject: string) => `Suggest questions to ask about: ${subject}` },
] as const;

interface AnswerState {
  text: string;
  evidence: Evidence[];
  recommendedAction: string;
  confidence: number;
  insufficientEvidence?: boolean;
  cacheState: "cached" | "refreshed";
  mode: "mock" | "claude";
}

export function AskClaudeAbout({ subject, entityId, facts, evidence }: { subject: string; entityId: string; facts: string[]; evidence: Evidence[] }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AnswerState | null>(null);

  async function ask(questionId: string) {
    const q = QUESTION_TYPES.find((t) => t.id === questionId);
    if (!q || loading) return;
    setLoading(questionId);
    try {
      const query = q.query(subject);
      const { value, cacheState } = await withAICache("answerQuery", `${entityId}:${questionId}`, facts, evidence, () =>
        getAIProvider().answerQuery(query, facts, evidence, "")
      );
      setAnswer({
        text: value.answer,
        evidence: value.evidence,
        recommendedAction: value.recommendedAction,
        confidence: value.confidence,
        insufficientEvidence: value.insufficientEvidence,
        cacheState,
        mode: getAIProvider().mode,
      });
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="mt-2">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-xs font-medium text-accent2 hover:underline">
        {open ? "Hide" : "Ask Claude about this"}
      </button>
      {open && (
        <div className="mt-2 space-y-2 rounded-md border border-border bg-surface2 p-3 text-xs">
          <div className="flex flex-wrap gap-1">
            {QUESTION_TYPES.map((t) => (
              <button
                key={t.id}
                onClick={() => ask(t.id)}
                disabled={loading !== null}
                className="rounded border border-border px-2 py-1 text-[11px] text-text2 hover:border-accent hover:text-text disabled:opacity-50"
              >
                {loading === t.id ? "Asking…" : t.label}
              </button>
            ))}
          </div>
          {answer && (
            <div className="space-y-2 border-t border-border pt-2">
              <p className="flex items-center gap-1 font-semibold uppercase tracking-wide text-text3">
                <TrustLabel kind="ai-recommendation" />
                <AiProviderIndicator state={answer.cacheState === "cached" ? "CACHED" : answer.mode === "mock" ? "MOCK_FALLBACK" : "REAL_CLAUDE"} />
              </p>
              {answer.insufficientEvidence && <p className="text-yellow">Insufficient evidence — best-effort only.</p>}
              <p className="text-text2">{answer.text}</p>
              {answer.evidence.length > 0 && (
                <div>
                  <p className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide text-text3">
                    <TrustLabel kind="evidence" /> Evidence
                  </p>
                  <ul className="space-y-0.5 text-text2">
                    {answer.evidence.map((e) => (
                      <li key={e.id}>- {e.content}</li>
                    ))}
                  </ul>
                </div>
              )}
              {answer.recommendedAction && (
                <p className="text-text2">
                  <span className="font-medium text-text3">Recommendation: </span>
                  {answer.recommendedAction}
                </p>
              )}
              <ConfidenceTag confidence={answer.confidence} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
