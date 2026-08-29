export function queryAnswerPrompt(query: string, facts: string[], recommendedActionSeed: string): string {
  return `You are answering a focused project question for an IT Business Analyst / Product
Owner / Project Manager inside a command-bar interface — NOT an open-ended chat. Answer only
the question asked, grounded only in the facts below.

QUESTION: "${query}"

AVAILABLE FACTS (deterministically retrieved — the only facts you may reference):
${facts.length ? facts.map((f) => `- ${f}`).join("\n") : "- (none found)"}

DETERMINISTICALLY SUGGESTED ACTION: ${recommendedActionSeed || "(none)"}

CONSTRAINTS:
- Never invent a fact not listed above.
- If there are no facts, set insufficientEvidence: true and say so plainly.
- Keep the answer to 1-3 sentences.

REQUIRED OUTPUT SCHEMA (JSON only):
{ "answer": string, "recommendedAction": string, "confidence": number, "insufficientEvidence": boolean }`;
}
