import type { DecisionConflictCandidate } from "../../types";

export function decisionConflictPrompt(candidate: DecisionConflictCandidate): string {
  const { decision, reasons, evidence } = candidate;
  return `You are assessing whether a previously made decision may need review, for an IT
Business Analyst / Product Owner / Project Manager. Deterministic preconditions have already
been checked — you may only use the reasons and evidence below.

DECISION: ${decision.title}${decision.decision ? ` — ${decision.decision}` : ""}
Status: ${decision.status}${decision.date ? ` | Decided: ${decision.date}` : ""}${decision.dueDate ? ` | Target: ${decision.dueDate}` : ""}

DETERMINISTIC REASONS THE CURRENT STATE MAY CONFLICT WITH THIS DECISION:
${reasons.map((r) => `- ${r}`).join("\n")}

EVIDENCE:
${evidence.map((e) => `- ${e.content}`).join("\n")}

CONSTRAINTS:
- Never state that the decision is "invalid" or "wrong". Use calibrated language: "potential
  conflict" or "decision may need review".
- Use only the reasons/evidence above. If they are too thin to say anything useful, set
  insufficientEvidence: true instead of guessing.

REQUIRED OUTPUT SCHEMA (JSON only): { "assessment": string, "confidence": number, "insufficientEvidence": boolean }`;
}
