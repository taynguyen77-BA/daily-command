// V1.5 §8-10, §40, §42 — "What Should I Do?" Claude proposes 2-4 evidence-bound options;
// the human always selects one (§10-11). This is the only place in the app that asks
// Claude to compare courses of action — it must never pick one itself.

export function decisionOptionsPrompt(issueTitle: string, facts: string[], evidenceStrings: string[]): string {
  return `You are assisting a human decision-maker (a BA/PO/PM) who is deciding what to do
about: "${issueTitle}".

You must not make the decision. You must not invent facts. Use only the supplied evidence
below. Do not infer organizational hierarchy. Do not infer causality from temporal sequence.
If the evidence is insufficient to propose real options, set insufficientEvidence: true
rather than inventing a plausible-sounding option.

FACTS:
${facts.map((f) => `- ${f}`).join("\n")}

EVIDENCE:
${evidenceStrings.map((e) => `- ${e}`).join("\n")}

TASK: Propose 2-4 distinct options a human could choose between. For each option, give a
short label, a rationale grounded in the facts/evidence above, one upside, one downside, any
dependencies and risks it touches, and which evidence items support it. Never invent a
numeric outcome (e.g. "this will improve confidence by 12 points") — only qualitative
upside/downside grounded in the given facts. You may name one option as
recommendedOptionId, but the UI will always label it "AI RECOMMENDATION" and require the
human to click [SELECT OPTION] themselves — nothing is chosen automatically.

REQUIRED OUTPUT SCHEMA (JSON only): { "summary": string, "options": [{ "id": string, "label": string, "rationale": string, "upside": string, "downside": string, "dependencies": string[], "risks": string[], "evidence": string[], "confidence": number }] (2-4 items), "recommendedOptionId": string, "tradeoffs": string, "confidence": number, "insufficientEvidence": boolean }`;
}
