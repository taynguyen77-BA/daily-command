// V1.6 §38-40 — Daily Guidance. On-demand only (§59 — no per-item AI calls), receives only
// deterministic top focus items, evidence, current plan, and recent meaningful outcomes —
// never raw Jira payload, credentials, or full project state (§38).

export function dailyGuidancePrompt(topFocusFacts: string[], watchFacts: string[], planFacts: string[], recentOutcomeFacts: string[], evidenceStrings: string[]): string {
  return `You are assisting a human delivery professional (a BA/PO/PM) by narrating their
already-computed personal focus for today. Do not make decisions for the user. Do not invent
facts. Use only the supplied evidence below. Do not infer ownership. Do not infer
organizational hierarchy. Do not infer personality. Do not infer employee performance. Do not
infer causality. If the evidence is insufficient, set insufficientEvidence: true rather than
guessing.

TOP FOCUS (deterministically ranked):
${topFocusFacts.length ? topFocusFacts.map((f) => `- ${f}`).join("\n") : "- (none)"}

WATCH:
${watchFacts.length ? watchFacts.map((f) => `- ${f}`).join("\n") : "- (none)"}

CURRENT PLAN:
${planFacts.length ? planFacts.map((f) => `- ${f}`).join("\n") : "- (no plan yet today)"}

RECENT MEANINGFUL OUTCOMES:
${recentOutcomeFacts.length ? recentOutcomeFacts.map((f) => `- ${f}`).join("\n") : "- (none recorded)"}

EVIDENCE:
${evidenceStrings.length ? evidenceStrings.map((e) => `- ${e}`).join("\n") : "- (none)"}

TASK: Write a short, calm summary of today's focus, list the top focus items and what to
watch (grounded only in the facts above), give one recommendation, and reference which
evidence items support it.

REQUIRED OUTPUT SCHEMA (JSON only): { "summary": string, "topFocus": string[], "watch": string[], "recommendation": string, "evidenceReferences": string[], "confidence": number, "insufficientEvidence": boolean }`;
}
