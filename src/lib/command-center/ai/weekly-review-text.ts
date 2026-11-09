// V2.51 A3 — the Weekly Review text. "Not enough history yet" is a deterministic fact, so it never costs a model call
// (the model might improvise around it); with enough history the AI provider answers and falls back to the calculated review.

import type { WeeklyReviewFacts } from "../weekly-review";
import type { AIProvider } from "./provider";
import { MockAIProvider } from "./provider";

export async function weeklyReviewText(facts: WeeklyReviewFacts, provider: Pick<AIProvider, "generateWeeklyReview">, language?: "en" | "vi"): Promise<string> {
  if (!facts.hasEnoughHistory) return new MockAIProvider().generateWeeklyReview(facts);
  return provider.generateWeeklyReview(facts, language);
}
