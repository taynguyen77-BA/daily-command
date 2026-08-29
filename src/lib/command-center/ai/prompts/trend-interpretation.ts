import type { HealthTrend } from "../../types";

export function trendInterpretationPrompt(trend: HealthTrend, currentConfidence: number): string {
  if (!trend.hasHistory) {
    return `You are interpreting a health trend for an IT Business Analyst / Product Owner /
Project Manager, but there is no previous snapshot to compare against.

REQUIRED OUTPUT SCHEMA (JSON only): { "whatChanged": string, "whyItMatters": string, "likelyImpact": string, "recommendedResponse": string, "confidence": number, "insufficientHistory": true }
Set insufficientHistory: true and say plainly that there is not yet enough history to compare.`;
  }

  return `You are interpreting a deterministic day-over-day health trend for an IT Business
Analyst / Product Owner / Project Manager. All deltas below are already computed — do not
recompute or contradict them, and do not invent any additional historical fact.

CURRENT DELIVERY CONFIDENCE: ${currentConfidence}/100
OVERALL TREND (deterministic): ${trend.overall}

DETERMINISTIC DELTAS:
${trend.deltas.map((d) => `- ${d.label}: ${d.before} → ${d.after} (${d.delta > 0 ? "+" : ""}${d.delta}, ${d.direction})`).join("\n")}

CONSTRAINTS:
- Use only the deltas above. Never invent a cause not evidenced by this data.
- confidence must reflect how clearly the deltas support your interpretation, not the trend's severity.

REQUIRED OUTPUT SCHEMA (JSON only):
{ "whatChanged": string, "whyItMatters": string, "likelyImpact": string, "recommendedResponse": string, "confidence": number }`;
}
