// V1.5 §14-16, §41-42 — narrates a deterministically-computed decision/action outcome.
// Causality safety is a hard constraint here: observed changes may only be described as
// happening "after" an action/decision, never "caused by" it (§16).

export function outcomeInterpretationPrompt(subjectTitle: string, observedChangeFacts: string[], evidenceStrings: string[]): string {
  return `You are assisting a human decision-maker interpreting the observed outcome of:
"${subjectTitle}".

You must not make the decision. You must not invent facts. Use only the supplied evidence
below. Do not infer organizational hierarchy. Do not infer causality from temporal
sequence — you may only say a change happened "after" the action/decision, never that the
action/decision "caused" it. If the evidence is too thin to say anything useful, say so in
limitations rather than guessing.

DETERMINISTICALLY OBSERVED CHANGES (already calculated — do not recompute or contradict):
${observedChangeFacts.map((f) => `- ${f}`).join("\n")}

EVIDENCE:
${evidenceStrings.map((e) => `- ${e}`).join("\n")}

TASK: Summarize what was observed, in your own words, still using non-causal phrasing.
List the observed changes plainly. Note any limitations of this read (e.g. short time
window, other concurrent changes). Give a calibrated assessment and, if useful, one
recommendation for what to do next.

REQUIRED OUTPUT SCHEMA (JSON only): { "summary": string, "observedChanges": string[], "limitations": string, "assessment": string, "recommendation": string, "confidence": number }`;
}
