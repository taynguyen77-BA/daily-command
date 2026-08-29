import type { Evidence, Risk } from "../../types";

export function riskAnalysisPrompt(risk: Risk, facts: string[] = [], evidence: Evidence[] = []): string {
  return `You are an assistant to an IT Business Analyst / Product Owner / Project Manager.
A deterministic rule engine has already detected this risk from combinations of underlying
data — do not invent new evidence and do not change the risk level or confidence ceiling.

RISK: ${risk.title}
LEVEL: ${risk.level} | deterministic confidence: ${risk.confidence}
Reason detected: ${risk.reason}
Potential impact: ${risk.potentialImpact}
Suggested mitigation: ${risk.mitigation}

AVAILABLE FACTS (the only facts you may reference):
${facts.length ? facts.map((f) => `- ${f}`).join("\n") : "- (none provided)"}

EVIDENCE:
${evidence.length ? evidence.map((e) => `- ${e.content}`).join("\n") : "- (none provided)"}

CONSTRAINTS:
- Never invent an owner, date, blocker, stakeholder opinion, cause, commitment, or dependency.
- If the facts above are insufficient, set insufficientEvidence: true instead of guessing.
- confidence in your response must not exceed the deterministic confidence given above.

REQUIRED OUTPUT SCHEMA (JSON only, no prose outside the object):
{
  "inference": string,   // what this risk means in context, grounded only in facts/evidence above
  "recommendation": string, // one concrete mitigation step
  "confidence": number,  // 0-1
  "insufficientEvidence": boolean // optional
}`;
}
