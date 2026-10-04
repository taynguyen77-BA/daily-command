// V2.38 J6 — Weekly Insights over deterministic facts about the week (ticket history, blockers
// by person, skip reasons, triage acceptance). Numbers are locked to the facts.

import type { TaskInput } from "../task-registry";

export function weeklyInsightsPrompt(i: TaskInput<"weeklyInsights">): string {
  return `You are reviewing the week ${i.weekStart} to ${i.weekEnd} with an IT Business Analyst / Product Owner.

FACTS (deterministic — the only ones you may use):
${i.facts.length ? i.facts.map((f) => `- ${f}`).join("\n") : "- (none)"}

PRODUCE:
- observations: 3 to 5 patterns worth noticing, each with evidence = the fact line(s) above it rests on (copied verbatim).
- suggestions: exactly 3 concrete things to try next week.

CONSTRAINTS:
- Never add or change a number, ticket key, person or date. No causal claims ("caused", "led to"); describe what happened.
- No judgements about people's performance.

REQUIRED OUTPUT SCHEMA (JSON only): { "observations": [{ "text": string, "evidence": string[] }], "suggestions": string[] }`;
}
