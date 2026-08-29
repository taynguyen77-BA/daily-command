// AI Usage Policy (V2.0 §2). An explicit, auditable registry describing how each AI
// method may be invoked — trigger, cache duration, dedupe behavior. Local-only: no
// billing infrastructure, just a data-driven contract that on-demand call sites and the
// entity cache (./ai-cache.ts) both point to, so "how long is this cached for" lives in
// one place instead of being re-decided ad hoc at every call site.

import type { AITask } from "./schemas";

export interface AIUsagePolicyEntry {
  task: AITask;
  // V2.0 §1.4 — every AI task in this app is on-demand; there is no automatic/on-render
  // trigger left after the V2.0 hardening pass.
  trigger: "on-demand";
  maxCallsPerInteraction: number;
  cacheDurationMs: number;
  dedupeInFlight: boolean;
}

const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;

function entry(task: AITask, overrides: Partial<AIUsagePolicyEntry> = {}): AIUsagePolicyEntry {
  return {
    task,
    trigger: "on-demand",
    maxCallsPerInteraction: 1,
    cacheDurationMs: THIRTY_MINUTES_MS,
    dedupeInFlight: true,
    ...overrides,
  };
}

const POLICY: Record<AITask, AIUsagePolicyEntry> = {
  analyzePriorities: entry("analyzePriorities"),
  detectRisks: entry("detectRisks"),
  explainChanges: entry("explainChanges"),
  generateActionPlan: entry("generateActionPlan"),
  generateCommunication: entry("generateCommunication"),
  generateEndOfDaySummary: entry("generateEndOfDaySummary"),
  interpretTrend: entry("interpretTrend"),
  detectDecisionConflicts: entry("detectDecisionConflicts"),
  analyzeActionOutcomes: entry("analyzeActionOutcomes"),
  generateWeeklyReview: entry("generateWeeklyReview"),
  // Command Bar answers age faster — the underlying facts (attention queue, etc.) shift
  // through the day more than a single risk/decision's evidence does.
  answerQuery: entry("answerQuery", { cacheDurationMs: TEN_MINUTES_MS }),
  assessProactive: entry("assessProactive"),
  generateProjectStory: entry("generateProjectStory"),
  generateDecisionOptions: entry("generateDecisionOptions"),
  interpretOutcome: entry("interpretOutcome"),
  generateDailyGuidance: entry("generateDailyGuidance"),
  // V2.2 §8 — artifact drafts are keyed by evidenceVersion like every other cached call;
  // duration matches the other narrative-drafting tasks above.
  generateCommunicationArtifact: entry("generateCommunicationArtifact"),
};

export function getUsagePolicy(task: AITask): AIUsagePolicyEntry {
  return POLICY[task];
}

export type AIDiagnosticState = "AI available" | "AI unavailable" | "Mock fallback" | "Cached result";

/** V2.0 §2 — lightweight, non-secret UI diagnostics. Never exposes API keys or any other
 *  internal state; just enough for a human to understand what answered a given question. */
export function describeAIState(opts: { available: boolean; mode: "mock" | "claude"; servedFromCache: boolean }): AIDiagnosticState {
  if (opts.servedFromCache) return "Cached result";
  if (!opts.available) return "AI unavailable";
  if (opts.mode === "mock") return "Mock fallback";
  return "AI available";
}
