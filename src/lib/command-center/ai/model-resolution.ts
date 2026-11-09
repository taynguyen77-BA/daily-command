// V2.48.2 — a custom gateway only serves the models it lists. Pick, per tier, the best listed model instead of assuming Claude ids.
// Pure: no I/O. Family hints: fast -> haiku, default -> sonnet, deep -> opus; the highest version in a family wins.

import type { AiModelTier } from "./model-config";

const FAMILY: Record<AiModelTier, RegExp> = { fast: /haiku/i, default: /sonnet/i, deep: /opus/i };

/** Numbers inside the id, compared left to right ("claude-sonnet-4-5" -> [4,5]; "…-20250929" is ignored as a date stamp). */
const version = (id: string): number[] => (id.match(/\d+/g) ?? []).map(Number).filter((n) => n < 1000);
function compareVersionDesc(a: string, b: string): number {
  const va = version(a);
  const vb = version(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] ?? -1) - (va[i] ?? -1);
    if (d !== 0) return d;
  }
  return a.localeCompare(b);
}

// Name hints for gateways that serve non-Claude models: small/fast ids for "fast", large/reasoning ids for "deep".
const HINT: Record<AiModelTier, RegExp> = {
  fast: /haiku|flash|mini|lite|small|nano|turbo|instant/i,
  default: /sonnet|gpt-5|glm|kimi|qwen|deepseek|llama|mistral|gemini/i,
  deep: /opus|pro\b|large|reason|think|\b(70|120|235|405)b|k2|glm-5|gpt-5|ultra|max/i,
};

export function pickModelForTier(tier: AiModelTier, available: string[]): string | null {
  if (available.length === 0) return null;
  const byVersion = (list: string[]) => [...list].sort(compareVersionDesc);
  const family = byVersion(available.filter((m) => FAMILY[tier].test(m)));
  if (family[0]) return family[0];
  const hinted = byVersion(available.filter((m) => HINT[tier].test(m)));
  if (hinted[0]) return hinted[0];
  // Nothing recognisable: the gateway's own first model beats a guaranteed 403.
  return available[0] ?? null;
}

export interface TierResolution { model: string; autoSelected: boolean }

/** For each tier: keep the configured model when the gateway lists it; otherwise pick from the list. The gateway only serves what it lists,
 *  so even a model the user typed is replaced when it is not on the list (and reported as such). `userChosen` is kept for callers that want to know. */
export function resolveTierModels(args: { configured: Record<AiModelTier, string>; userChosen: Partial<Record<AiModelTier, string>>; available: string[] }): Record<AiModelTier, TierResolution> {
  const out = {} as Record<AiModelTier, TierResolution>;
  for (const tier of ["fast", "default", "deep"] as const) {
    const cur = args.configured[tier];
    if (args.available.length === 0 || args.available.includes(cur)) { out[tier] = { model: cur, autoSelected: false }; continue; }
    const pick = pickModelForTier(tier, args.available);
    out[tier] = pick ? { model: pick, autoSelected: true } : { model: cur, autoSelected: false };
  }
  return out;
}
