// V2.38 J1 — BA requirement check over ONE Story/Task (allow-listed, redacted). Deep tier.
// Acceptance criteria are CHECKLIST items, never Given/When/Then; each one quotes the sentence
// it comes from, or is marked an assumption (server-checked, and normalized again in the browser).

import type { TicketContextInput } from "../task-registry";
import { ticketContextSection } from "./ticket-context";

export function baRequirementCheckPrompt(t: TicketContextInput): string {
  return `You are a senior Business Analyst preparing ONE ticket for development and testing.

${ticketContextSection(t)}

PRODUCE:
1. acceptanceCriteria — a checklist covering the happy path, validation, error handling and edge cases.
   - Each item is one short, testable statement written as a checklist line (e.g. "Export button downloads a CSV of the selected month").
   - NEVER use Given/When/Then (Gherkin) phrasing, and never start an item with "Given", "When", "Then" or "And".
   - source.kind = where it comes from: "description", "acceptance-criteria" or "comment", with source.quote = the exact sentence (copied verbatim, ≤ 300 chars) it is based on.
   - If an item is your own inference (typical for validation/error/edge cases the ticket doesn't mention), set source.kind = "assumption" and leave quote empty.
2. questionsByStakeholder — clarification questions grouped by who should answer (e.g. "Product owner", "Client", "Tech lead", "QA", or a person named in the ticket).
3. missingInformation — what the ticket does not say but development/testing needs.
4. risks — contradictions, dependencies on open linked issues, scope ambiguity.

CONSTRAINTS:
- Never invent ticket keys, numbers, dates or people. Placeholders like [EMAIL_1] or CLIENT_1 stay as written.

REQUIRED OUTPUT SCHEMA (JSON only):
{ "acceptanceCriteria": [{ "text": string, "category": "happy-path" | "validation" | "error" | "edge-case", "source": { "kind": "description" | "acceptance-criteria" | "comment" | "assumption", "quote"?: string } }], "questionsByStakeholder": [{ "stakeholder": string, "questions": string[] }], "missingInformation": string[], "risks": string[] }`;
}
