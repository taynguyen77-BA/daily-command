// V1.4 §43 — Project Story. Narrates the Project Memory timeline into one short, evidence-
// bound paragraph. Never produces a narrative arc when history is insufficient.

export function projectStoryPrompt(timelineFacts: string[], evidenceStrings: string[], hasEnoughHistory: boolean): string {
  return `You are writing a short "Project Story" for an IT Business Analyst / Product Owner /
Project Manager — a compact narrative connecting the meaningful events below into a coherent
account of how the project has been trending. This is prose, not a bullet list.

MEANINGFUL EVENTS (chronological, oldest first — every sentence you write must trace back to
one of these):
${timelineFacts.map((f) => `- ${f}`).join("\n")}

EVIDENCE:
${evidenceStrings.map((e) => `- ${e}`).join("\n")}

HISTORY AVAILABLE: ${hasEnoughHistory ? "Sufficient (3+ meaningful days of memory events)." : "Insufficient — fewer than 3 meaningful days of memory events exist yet."}

CONSTRAINTS:
- Every sentence must be supported by one of the events above. Never invent a cause, owner, or
  date not present in the events/evidence.
- Keep it to 2-4 sentences — a narrative, not a report.
- If history is insufficient, set insufficientHistory: true and keep the narrative to a single
  sentence acknowledging that the story is still forming, rather than inventing an arc.

REQUIRED OUTPUT SCHEMA (JSON only): { "narrative": string, "confidence": number, "insufficientHistory": boolean }`;
}
