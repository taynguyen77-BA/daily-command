"use client";

// Project Story (V1.4 §43). A compact AI-narrated paragraph over the Project Memory
// timeline (store.memoryEvents) — every sentence must trace to a memory event; renders
// the deterministic "insufficient history" message when fewer than 3 meaningful days exist.
//
// V2.0 §1.4 — used to call getAIProvider().generateProjectStory() automatically from
// useEffect on every mount. Now strictly on-demand behind a button, routed through the
// entity cache so re-visiting the page with unchanged history never re-hits the model.

import { useState } from "react";
import { getAIProvider } from "@/lib/command-center/ai";
import { withAICache } from "@/lib/command-center/ai/ai-cache";
import type { MemoryEvent, ProjectStoryResult } from "@/lib/command-center/types";
import { AiProviderIndicator, ConfidenceTag, Panel, TrustLabel } from "./ui";

export function ProjectStory({ events }: { events: MemoryEvent[] }) {
  const [result, setResult] = useState<ProjectStoryResult | null>(null);
  const [cacheState, setCacheState] = useState<"cached" | "refreshed" | null>(null);
  const [mode, setMode] = useState<"mock" | "claude">("mock");
  const [loading, setLoading] = useState(false);
  const distinctDays = new Set(events.map((e) => e.date)).size;
  const hasEnoughHistory = distinctDays >= 3;

  async function tellStory() {
    if (loading) return;
    setLoading(true);
    try {
      const timelineFacts = events.slice(-20).map((e) => `${e.date}: ${e.title} — ${e.impact}`);
      const evidenceStrings = events.slice(-20).flatMap((e) => e.evidence);
      const { value, cacheState: cs } = await withAICache(
        "generateProjectStory",
        `project-story:${events.length}`,
        timelineFacts,
        timelineFacts.map((f) => ({ content: f })),
        () => getAIProvider().generateProjectStory(timelineFacts, evidenceStrings, hasEnoughHistory)
      );
      setResult(value);
      setCacheState(cs);
      setMode(getAIProvider().mode);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Panel className="p-5">
      <div className="mb-2 flex items-center gap-2">
        <TrustLabel kind="ai-assessment" />
        <span className="text-xs text-text3">Project story</span>
        {cacheState && <AiProviderIndicator state={cacheState === "cached" ? "CACHED" : mode === "mock" ? "MOCK_FALLBACK" : "REAL_CLAUDE"} />}
      </div>
      {!result ? (
        <button onClick={tellStory} disabled={loading} className="text-sm font-medium text-accent2 hover:underline disabled:opacity-50">
          {loading ? "Asking Claude…" : "Tell my project's story"}
        </button>
      ) : (
        <>
          <p className="text-sm text-text2">{result.narrative}</p>
          <div className="mt-2">
            <ConfidenceTag confidence={result.confidence} />
          </div>
        </>
      )}
    </Panel>
  );
}
