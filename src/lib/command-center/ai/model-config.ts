// C4 — which Claude model answers which AI task. Never hardcoded at the call site: the server
// route reads ANTHROPIC_MODEL (reasoning tasks) and ANTHROPIC_MODEL_FAST (short narration
// tasks), falling back to the defaults below. Pure (env passed in) so it is unit-testable and
// so Setup Health can say whether the model was chosen explicitly.

import type { AITask } from "./schemas";

/** Default for reasoning-heavy tasks (priorities, risks, decision options, artifacts…). */
export const DEFAULT_AI_MODEL = "claude-opus-5-5";
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
]);

export interface AiModelEnv {
  ANTHROPIC_MODEL?: string;
  ANTHROPIC_MODEL_FAST?: string;
}

const MODEL_ID = /^[a-z0-9][a-z0-9.\-]{2,80}$/;
const clean = (v: string | undefined) => (v && MODEL_ID.test(v.trim()) ? v.trim() : undefined);

export function resolveAiModel(task: AITask, env: AiModelEnv): { model: string; tier: "default" | "fast" } {
  if (SHORT_AI_TASKS.has(task)) return { model: clean(env.ANTHROPIC_MODEL_FAST) ?? DEFAULT_AI_MODEL_FAST, tier: "fast" };
  return { model: clean(env.ANTHROPIC_MODEL) ?? DEFAULT_AI_MODEL, tier: "default" };
}

/** What Setup Health / Data & Settings may show — model ids only, never a secret. */
export function aiModelStatus(env: AiModelEnv): { model: string; fastModel: string; modelFromEnv: boolean; fastModelFromEnv: boolean } {
  return {
    model: clean(env.ANTHROPIC_MODEL) ?? DEFAULT_AI_MODEL,
    fastModel: clean(env.ANTHROPIC_MODEL_FAST) ?? DEFAULT_AI_MODEL_FAST,
    modelFromEnv: !!clean(env.ANTHROPIC_MODEL),
    fastModelFromEnv: !!clean(env.ANTHROPIC_MODEL_FAST),
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
