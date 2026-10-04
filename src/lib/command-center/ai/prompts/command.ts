// V2.38 J5 — one Command Bar sentence → a typed list of operations from an allow-listed set.
// The model never resolves targets: it names a ticket key from the command, or a selector
// (mentions / blocked / new / in-progress, optionally a project) that the app resolves
// against real data; anything ambiguous comes back as a clarification question.

import { untrustedBlock } from "../untrusted";
import type { TaskInput } from "../task-registry";

export function commandPrompt(i: TaskInput<"parseCommand">): string {
  return `Translate ONE command from an IT Business Analyst / Product Owner into operations for their work tracker.
Today is ${i.today}. Known projects: ${i.knownProjects.length ? i.knownProjects.map((p) => `${p.key}${p.name ? ` (${p.name})` : ""}`).join(", ") : "none"}.

${untrustedBlock("COMMAND", i.command)}

ALLOWED OPERATIONS (nothing else exists):
- setTicketStatus: target + status (TODO | IN_PROGRESS | BLOCKED | SKIPPED | DEFERRED | DONE), optional reason, and "when" for DEFERRED (a word from the command such as "monday", "tomorrow", "next week").
- addAction: title (+ optional target ticket, optional "when" as written).

TARGETS:
- { "kind": "ticket", "ticketKey": "<KEY as written in the command>" }
- { "kind": "mentions" | "blocked" | "new" | "in-progress", "project"?: "<project key or name as written>" } — "all WF mentions" = { "kind": "mentions", "project": "WF" }.

RULES:
- If the command is ambiguous, unclear, or not one of these operations, return no operations and a short "clarification" question instead of guessing.
- Copy ticket keys and project names exactly as written. Never invent a key, a date or a project.

REQUIRED OUTPUT SCHEMA (JSON only):
{ "operations": [{ "op": "setTicketStatus" | "addAction", "target"?: { "kind": string, "ticketKey"?: string, "project"?: string }, "status"?: string, "when"?: string, "reason"?: string, "title"?: string }], "clarification"?: string }`;
}
