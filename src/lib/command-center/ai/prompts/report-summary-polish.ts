// F5 — "Polish with AI" for a report summary. Wording only: the caller rejects any answer whose
// numbers or ticket keys differ from the original (report-summary.ts checkPolishPreservesFacts).

export function reportSummaryPolishPrompt(summary: string): string {
  return `Rewrite this standup report summary so it reads naturally as one short paragraph for a team update.

SUMMARY:
${summary}

CONSTRAINTS:
- Keep EVERY number exactly as written, each one exactly as many times, and add no new numbers (no dates, no percentages).
- Keep EVERY ticket key (like ABC-123) exactly as written; add none, drop none.
- Do not add facts, opinions, owners, causes or recommendations.
- Plain text, no markdown, no bullet points.

REQUIRED OUTPUT SCHEMA (JSON only): { "text": string }`;
}
