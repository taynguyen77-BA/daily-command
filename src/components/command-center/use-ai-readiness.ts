"use client";

// P3.7 — the ONE hook every AI button uses for its tooltip / "why not": readiness of a feature (and, for
// ticket-scoped buttons, of that ticket's project), from the same facts the readiness matrix shows.

import { useEffect, useState, useSyncExternalStore } from "react";
import { commandCenterStore } from "@/lib/command-center/store";
import { aiReadiness, type AiFeatureId, type AiReadiness } from "@/lib/command-center/ai/readiness";
import { checkAiModelStatus } from "@/lib/command-center/ai/claude-provider";
import { fetchAiUsage } from "@/lib/command-center/ai/ticket-ai-client";
import { projectKeyOf } from "@/lib/command-center/ai/data-protection";

let cache: { at: number; value: Promise<{ ai: Awaited<ReturnType<typeof checkAiModelStatus>>; usage: Awaited<ReturnType<typeof fetchAiUsage>> }> } | null = null;
function statusCached() {
  if (!cache || Date.now() - cache.at > 60_000) cache = { at: Date.now(), value: Promise.all([checkAiModelStatus(), fetchAiUsage()]).then(([ai, usage]) => ({ ai, usage })) };
  return cache.value;
}

export function useAiReadinessFacts() {
  const [facts, setFacts] = useState<Awaited<ReturnType<typeof statusCached>> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void statusCached().then((f) => {
      if (!cancelled) setFacts(f);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return facts;
}

export function useAiReadiness(feature: AiFeatureId, ticketKey?: string): AiReadiness & { ready: boolean; title: string | undefined } {
  const state = useSyncExternalStore(commandCenterStore.subscribe, commandCenterStore.getSnapshot, commandCenterStore.getServerSnapshot);
  const facts = useAiReadinessFacts();
  const r = aiReadiness(feature, {
    features: state.features,
    ai: facts?.ai ? { available: facts.ai.available, ...("aiAllowedProjectKeys" in facts.ai ? { aiAllowedProjectKeys: facts.ai.aiAllowedProjectKeys } : {}) } : null,
    usage: facts?.usage ?? null,
    allowedProjectKeys: state.aiDataProtection.allowedProjectKeys,
    projectKeys: state.data.projects.map((p) => p.sourceId ?? "").filter(Boolean),
    ...(ticketKey ? { projectKey: projectKeyOf(ticketKey) } : {}),
  });
  return { ...r, ready: r.state === "READY", title: r.state === "READY" ? undefined : r.nextStep };
}
