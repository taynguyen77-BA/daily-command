// P3.6 — optional narration of the Next Best Action cards. Deterministic text always exists; when AI is configured
// AND its flag is on, the existing daily-guidance task (fast tier) may phrase it — at most one call per day,
// cached by a hash of the facts. Any failure, mock provider or "insufficient evidence" falls back to the
// deterministic text. Nothing here changes the cards.

import type { NbaCard } from "./next-best-action";
import { isTransientAiFailure, type AiFailureReason } from "./ai/outcome";

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
  /** V2.49 A1 — why the AI wording was not used (so the UI can say so quietly). */
  failure?: AiFailureReason;
  httpStatus?: number;
}

interface Cached {
  day: string;
  hash: string;
  text: string;
  source: "ai" | "deterministic";
  /** V2.49 A1 (optional — an old {day, hash, text, source} blob still loads; it counts as one finished attempt). */
  attempts?: number;
  failure?: AiFailureReason;
}

/** What the one AI call reports: the summary text (or null), plus the typed reason when the call failed. */
export type NarrationCallResult = string | null | { text: string | null; reason?: AiFailureReason; httpStatus?: number };

/** At most this many AI attempts per day (a transient failure may be retried once). */
export const NARRATION_MAX_ATTEMPTS_PER_DAY = 2;

export async function narrateNextBestActions(input: {
  cards: readonly NbaCard[];
  today: string;
  flagOn: boolean;
  aiAvailable: boolean;
  /** The one AI call (generateDailyGuidance): returns the summary text, or null when there is nothing usable. */
  callAi: (facts: { headlines: string[]; evidence: string[] }) => Promise<NarrationCallResult>;
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
  const today = cached?.day === input.today ? cached : null;
  const attemptsSoFar = today ? (today.attempts ?? 1) : 0;
  // A transient failure (network / provider error / truncation) earlier today may be retried once; anything else is final for the day.
  const retryable = !!today && today.source === "deterministic" && isTransientAiFailure(today.failure) && attemptsSoFar < NARRATION_MAX_ATTEMPTS_PER_DAY;
  if (today && !retryable) {
    if (today.hash === hash) return { text: today.text, source: today.source, ...(today.failure ? { failure: today.failure } : {}) }; // same facts today: no call
    return { text: base, source: "deterministic", ...(today.failure ? { failure: today.failure } : {}) }; // today's budget of calls is used and the facts moved on: deterministic text, still no call
  }
  let result: NarrationResult = { text: base, source: "deterministic" };
  try {
    const out = await input.callAi({ headlines: input.cards.map((c) => c.headline), evidence: input.cards.flatMap((c) => c.why.map((w) => w.content)) });
    const text = typeof out === "string" || out === null ? out : out.text;
    if (text && text.trim()) result = { text: text.trim(), source: "ai" };
    else if (out && typeof out === "object" && out.reason) result = { text: base, source: "deterministic", failure: out.reason, ...(out.httpStatus !== undefined ? { httpStatus: out.httpStatus } : {}) };
  } catch {
    result = { text: base, source: "deterministic", failure: "network" }; // capped, failed or malformed -> deterministic
  }
  try {
    input.storage.set(NARRATION_STORAGE_KEY, JSON.stringify({ day: input.today, hash, text: result.text, source: result.source, attempts: attemptsSoFar + 1, ...(result.failure ? { failure: result.failure } : {}) } satisfies Cached));
  } catch {
    // storage unavailable: still at most one call per page session by the caller
  }
  return result;
}
