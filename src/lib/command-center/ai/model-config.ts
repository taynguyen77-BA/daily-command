// C4 — which Claude model answers which AI task. Never hardcoded at the call site: the server
// route reads the model ids from env, falling back to the defaults below. Pure (env passed in)
// so it is unit-testable and so Setup Health can say whether the model was chosen explicitly.
//
// V2.36 H4 — three cost tiers, model ids via env only (never chosen from the browser):
//   fast    ANTHROPIC_MODEL_FAST  short, single-paragraph narration
//   default ANTHROPIC_MODEL       everything else — a mid-cost model by default
//   deep    ANTHROPIC_MODEL_DEEP  only tasks explicitly marked deep (requirement check, release brief)

import type { AITask } from "./schemas";

/** Default tier — a mid-cost model (priorities, risks, decision options, artifacts…). */
export const DEFAULT_AI_MODEL = "claude-sonnet-5-5";
/** Deep tier — only for tasks in DEEP_AI_TASKS. */
export const DEFAULT_AI_MODEL_DEEP = "claude-opus-5-5";
/** Default for short, single-paragraph narration tasks — cheaper and faster. */
export const DEFAULT_AI_MODEL_FAST = "claude-haiku-4-5";

/** Short tasks: one short paragraph over already-computed facts. Everything else uses the
 *  default (reasoning) model. */
export const SHORT_AI_TASKS: ReadonlySet<AITask> = new Set<AITask>([
  "explainChanges",
  "interpretTrend",
  "interpretOutcome",
  "analyzeActionOutcomes",
  "generateEndOfDaySummary",
  "generateDailyGuidance",
  "polishReportSummary",
  // V2.37 I2 — one batched triage call over metadata: fast tier.
  "triageNewItems",
  // V2.38 J5 — turning one sentence into typed operations.
  "parseCommand",
]);

/** Reasoning-heavy tasks — the only ones that get the deep (most expensive) tier. A release
 *  brief task joins this set when it is added. */
export const DEEP_AI_TASKS: ReadonlySet<AITask> = new Set<AITask>(["checkRequirements", "baRequirementCheck", "releaseGoNoGo"]);

export type AiModelTier = "fast" | "default" | "deep";

export interface AiModelEnv {
  ANTHROPIC_MODEL?: string;
  ANTHROPIC_MODEL_FAST?: string;
  ANTHROPIC_MODEL_DEEP?: string;
}

const MODEL_ID = /^[a-z0-9][a-z0-9.\-]{2,80}$/;
const clean = (v: string | undefined) => (v && MODEL_ID.test(v.trim()) ? v.trim() : undefined);

export function aiTaskTier(task: AITask): AiModelTier {
  if (DEEP_AI_TASKS.has(task)) return "deep";
  if (SHORT_AI_TASKS.has(task)) return "fast";
  return "default";
}

export function resolveAiModel(task: AITask, env: AiModelEnv): { model: string; tier: AiModelTier } {
  const tier = aiTaskTier(task);
  if (tier === "deep") return { model: clean(env.ANTHROPIC_MODEL_DEEP) ?? DEFAULT_AI_MODEL_DEEP, tier };
  if (tier === "fast") return { model: clean(env.ANTHROPIC_MODEL_FAST) ?? DEFAULT_AI_MODEL_FAST, tier };
  return { model: clean(env.ANTHROPIC_MODEL) ?? DEFAULT_AI_MODEL, tier };
}

/** What Setup Health / Data & Settings may show — model ids only, never a secret. */
export function aiModelStatus(env: AiModelEnv): { model: string; fastModel: string; deepModel: string; modelFromEnv: boolean; fastModelFromEnv: boolean; deepModelFromEnv: boolean } {
  return {
    model: clean(env.ANTHROPIC_MODEL) ?? DEFAULT_AI_MODEL,
    fastModel: clean(env.ANTHROPIC_MODEL_FAST) ?? DEFAULT_AI_MODEL_FAST,
    deepModel: clean(env.ANTHROPIC_MODEL_DEEP) ?? DEFAULT_AI_MODEL_DEEP,
    modelFromEnv: !!clean(env.ANTHROPIC_MODEL),
    fastModelFromEnv: !!clean(env.ANTHROPIC_MODEL_FAST),
    deepModelFromEnv: !!clean(env.ANTHROPIC_MODEL_DEEP),
  };
}

/** Models whose thinking can't be turned off — their thinking tokens count against
 *  max_tokens, so they need a larger output budget than the visible JSON alone. */
export function isAlwaysThinkingModel(model: string): boolean {
  return /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-1|fable-5)$/.test(model);
}

/** Models that accept the server-side refusal `fallbacks: "default"` parameter (beta
 *  server-side-fallback-2026-07-01). */
export function supportsDefaultFallbacks(model: string): boolean {
  return /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-1)$/.test(model);
}
