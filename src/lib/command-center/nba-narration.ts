// P3.6 — optional narration of the Next Best Action cards. Deterministic text always exists; when AI is configured
// AND its flag is on, the existing daily-guidance task (fast tier) may phrase it — at most one call per day,
// cached by a hash of the facts. Any failure, mock provider or "insufficient evidence" falls back to the
// deterministic text. Nothing here changes the cards.

import type { NbaCard } from "./next-best-action";

export interface NarrationStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export const NARRATION_STORAGE_KEY = "daily-command:nba-narration:v1";

/** FNV-1a over the facts the narration is built from. */
export function hashFacts(cards: readonly Pick<NbaCard, "kind" | "ticketKey" | "headline" | "why">[]): string {
  const text = cards.map((c) => `${c.kind}|${c.ticketKey}|${c.headline}|${c.why.map((w) => w.content).join(";")}`).join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

export function deterministicNarration(cards: readonly Pick<NbaCard, "headline" | "why">[]): string {
  if (cards.length === 0) return "Nothing needs you right now.";
  return cards.map((c, i) => `${i === 0 ? "Start with" : "Then"}: ${c.headline}. ${c.why[0]?.content ?? ""}`.trim()).join(" ");
}

export interface NarrationResult {
  text: string;
  source: "ai" | "deterministic";
}

interface Cached {
  day: string;
  hash: string;
  text: string;
  source: "ai" | "deterministic";
}

export async function narrateNextBestActions(input: {
  cards: readonly NbaCard[];
  today: string;
  flagOn: boolean;
  aiAvailable: boolean;
  /** The one AI call (generateDailyGuidance): returns the summary text, or null when there is nothing usable. */
  callAi: (facts: { headlines: string[]; evidence: string[] }) => Promise<string | null>;
  storage: NarrationStorage;
}): Promise<NarrationResult> {
  const base = deterministicNarration(input.cards);
  if (!input.flagOn || !input.aiAvailable || input.cards.length === 0) return { text: base, source: "deterministic" };
  const hash = hashFacts(input.cards);
  let cached: Cached | null = null;
  try {
    const raw = input.storage.get(NARRATION_STORAGE_KEY);
    cached = raw ? (JSON.parse(raw) as Cached) : null;
  } catch {
    cached = null;
  }
  if (cached?.day === input.today && cached.hash === hash) return { text: cached.text, source: cached.source }; // same facts today: no call
  if (cached?.day === input.today) return { text: base, source: "deterministic" }; // today's one call is used and the facts moved on: deterministic text, still no call
  let result: NarrationResult = { text: base, source: "deterministic" };
  try {
    const text = await input.callAi({ headlines: input.cards.map((c) => c.headline), evidence: input.cards.flatMap((c) => c.why.map((w) => w.content)) });
    if (text && text.trim()) result = { text: text.trim(), source: "ai" };
  } catch {
    // capped, failed or malformed -> deterministic
  }
  try {
    input.storage.set(NARRATION_STORAGE_KEY, JSON.stringify({ day: input.today, hash, text: result.text, source: result.source } satisfies Cached));
  } catch {
    // storage unavailable: still at most one call per page session by the caller
  }
  return result;
}
