import type { ChangeEvent } from "../../types";

export function changeAnalysisPrompt(change: ChangeEvent): string {
  return `You are an assistant to an IT Business Analyst / Product Owner / Project Manager.
A deterministic diff engine already detected this change — do not invent additional facts.

AVAILABLE FACTS:
- Entity: ${change.entityLabel} (${change.entityType})
- Field: ${change.field}
- Before: ${change.before}
- After: ${change.after}
- Detected impact: ${change.impact}

CONSTRAINTS:
- Use only the facts above. Never invent a cause, owner, or additional context.
- One or two sentences, plain professional language.

REQUIRED OUTPUT SCHEMA (JSON only): { "text": string }`;
}
