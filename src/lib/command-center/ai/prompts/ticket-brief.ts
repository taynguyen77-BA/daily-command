// V2.37 I1 — Ticket Brief over ONE ticket's (allow-listed, redacted) content. Every statement
// must come from the ticket text; the server's grounding guard and the brief's own check
// (waitingOn people must appear in the ticket) reject anything else.

import type { TicketContextInput } from "../task-registry";
import { ticketContextSection } from "./ticket-context";

export function ticketBriefPrompt(t: TicketContextInput, today: string): string {
  return `You are briefing an IT Business Analyst / Product Owner on ONE Jira ticket so they can act
on it in under a minute. Today is ${today}.

${ticketContextSection(t)}

CONSTRAINTS:
- Use only the ticket text above. Never invent a person, ticket key, number, date or requirement.
- waitingOn: only people named in the ticket text (as written there), each with what is awaited from them. Empty if nobody.
- openQuestions: questions raised in the description or comments that have no answer later in the thread.
- suggestedNextStep: one concrete action for the reader.
- suggestedStatus is optional — only when the thread clearly supports it (e.g. the work is waiting on someone → BLOCKED with that reason). The user decides; you are only suggesting.
- Placeholders such as [EMAIL_1] or CLIENT_1 stand for redacted values — keep them as written.

REQUIRED OUTPUT SCHEMA (JSON only):
{ "whatIsAsked": string, "currentState": string, "waitingOn": [{ "who": string, "what": string }], "openQuestions": string[], "suggestedNextStep": string, "suggestedStatus"?: { "status": "IN_PROGRESS" | "BLOCKED" | "DONE" | "DEFERRED" | "SKIPPED", "reason": string } }`;
}
