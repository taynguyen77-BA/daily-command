import { ClaudeProvider, checkClaudeAvailability } from "./claude-provider";
import type { AIProvider } from "./provider";

let instance: AIProvider | null = null;

/**
 * Returns the real Claude provider, which transparently falls back to MockAIProvider on
 * any failure — missing/invalid API key, network error, or a malformed model response
 * (see claude-provider.ts). Callers never need to know which one actually answered;
 * `provider.mode` reflects it after each call, for UI labeling only.
 */
export function getAIProvider(): AIProvider {
  if (!instance) instance = new ClaudeProvider();
  return instance;
}

export { checkClaudeAvailability };
export { MockAIProvider } from "./provider";
export type { AIProvider } from "./provider";
