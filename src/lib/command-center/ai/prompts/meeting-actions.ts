// V2.38 J4 — meeting notes / transcript → decisions, action items, ticket status changes, open
// questions. Everything is reviewed and confirmed by the user before anything is created;
// ticket keys that don't exist in the app are dropped, never created.

import { untrustedBlock } from "../untrusted";
import type { TaskInput } from "../task-registry";

export function meetingActionsPrompt(i: TaskInput<"extractMeetingActions">): string {
  return `Extract what was agreed in these meeting notes for an IT Business Analyst / Product Owner. Today is ${i.today}.

${untrustedBlock("MEETING_NOTES", i.notes)}

PRODUCE:
- decisions: what was decided (title + optional detail).
- actions: action items — title, owner only if a person is named for it, due only as written in the notes (e.g. "Friday", "next week", or a date that appears in the notes), relatedTicketKey only if a Jira key in the notes is clearly about it.
- statusChanges: only when the notes explicitly say a ticket is done / blocked / deferred / skipped / started — ticketKey as written, status, reason, and "when" for a deferral as written.
- openQuestions: questions raised and not answered.

CONSTRAINTS:
- Use only the notes. Never invent people, ticket keys, numbers or dates. Leave a field out rather than guess.

REQUIRED OUTPUT SCHEMA (JSON only):
{ "decisions": [{ "title": string, "detail"?: string }], "actions": [{ "title": string, "owner"?: string, "due"?: string, "relatedTicketKey"?: string }], "statusChanges": [{ "ticketKey": string, "status": "TODO" | "IN_PROGRESS" | "BLOCKED" | "SKIPPED" | "DEFERRED" | "DONE", "reason"?: string, "when"?: string }], "openQuestions": string[] }`;
}
