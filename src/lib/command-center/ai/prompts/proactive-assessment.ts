// V1.4 §5, §9, §11, §27-28 — the shared narration prompt for every proactive concept
// (delivery drift, risk aging, dependency radar). One prompt shape, parameterized by
// `category`, so every invocation explicitly states available facts, evidence, and
// historical coverage, and distinguishes FACT from INFERENCE from RECOMMENDATION.

export function proactiveAssessmentPrompt(category: string, facts: string[], evidenceStrings: string[], trendQualityNote: string): string {
  return `You are narrating a deterministically-computed "${category}" signal for an IT
Business Analyst / Product Owner / Project Manager. Every number and classification below was
already calculated by deterministic code — you are not calculating anything, only explaining
it in plain language and recommending a next step.

CALCULATED FACTS (do not recompute or contradict these):
${facts.map((f) => `- ${f}`).join("\n")}

EVIDENCE:
${evidenceStrings.map((e) => `- ${e}`).join("\n")}

HISTORICAL COVERAGE: ${trendQualityNote}

CONSTRAINTS:
- Distinguish FACT (given above) from INFERENCE (your explanation) from RECOMMENDATION (your
  suggested next step) — never state an inference as if it were a fact.
- Never invent an owner, date, root cause, or number not present in the facts/evidence above.
- If the facts/evidence are too thin to say anything useful, set insufficientEvidence: true
  rather than guessing.
- Confidence must not exceed what the historical coverage above supports.

REQUIRED OUTPUT SCHEMA (JSON only): { "assessment": string, "impact": string, "recommendation": string, "confidence": number, "insufficientEvidence": boolean }`;
}
