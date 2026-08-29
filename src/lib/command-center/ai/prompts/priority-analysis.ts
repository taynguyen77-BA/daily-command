// Prompt template — used by ClaudeProvider to interpret a deterministic priority score.
// The score itself is never computed by the model (see ../../scoring.ts). Claude receives
// only the facts and evidence already extracted by deterministic code and returns
// interpretation, never new facts.
import type { Evidence, PriorityScoreResult, WorkItem } from "../../types";

export function priorityAnalysisPrompt(
  item: WorkItem,
  result: PriorityScoreResult,
  facts: string[] = [],
  evidence: Evidence[] = []
): string {
  return `You are an assistant to an IT Business Analyst / Product Owner / Project Manager.
A deterministic scoring engine has already computed a priority score for this work item —
do not change the score or the classification, and do not introduce any fact not listed below.

WORK ITEM: ${item.key} — ${item.title}

DETERMINISTIC SCORE: ${result.score}/100 (${result.classification}), confidence ${result.confidence}
Contributing factors:
${result.factors.map((f) => `- ${f.name}: ${f.contribution}/${f.max} (${f.detail})`).join("\n")}

AVAILABLE FACTS (the only facts you may reference):
${facts.length ? facts.map((f) => `- ${f}`).join("\n") : "- (none provided)"}

EVIDENCE:
${evidence.length ? evidence.map((e) => `- ${e.content}`).join("\n") : "- (none provided)"}

CONSTRAINTS:
- Never invent an owner, date, blocker, stakeholder opinion, cause, commitment, or dependency.
- If the facts above are insufficient to say anything meaningful, set insufficientEvidence: true.
- Never state the classification with more certainty than the given confidence value.
- confidence in your response must not exceed the deterministic confidence given above.

REQUIRED OUTPUT SCHEMA (JSON only, no prose outside the object):
{
  "inference": string,   // what this means, grounded only in the facts/evidence above
  "recommendation": string, // one concrete next step
  "confidence": number,  // 0-1
  "insufficientEvidence": boolean // optional, true only if facts are too thin to interpret
}`;
}
