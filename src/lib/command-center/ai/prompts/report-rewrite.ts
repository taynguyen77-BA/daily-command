// V2.37 I4 — audience-aware rewrite of a deterministic report. The report is the ONLY input and
// its facts are locked: every ticket key and number in the answer must exist in it (checked
// server-side and again in the browser, else the deterministic report is shown with a notice).

import { untrustedBlock } from "../untrusted";
import type { TaskInput } from "../task-registry";

const AUDIENCE = {
  standup: "the team's standup: short, plain, grouped by Done / Doing / Blocked, one line per ticket.",
  pm: "a project manager: lead with status and blockers, then progress; concise sentences, no chit-chat.",
  client: "the client: professional, outcome-focused, no internal process words; never mention skipped work, internal notes or teammates.",
  vi: "the same team, in Vietnamese (tiếng Việt): translate faithfully, keep the same structure.",
};

export function reportRewritePrompt(i: TaskInput<"rewriteReport">): string {
  return `Rewrite the report below for ${AUDIENCE[i.audience]}

${untrustedBlock("REPORT", i.report)}

LOCKED FACTS — you may only rephrase and summarize:
- Keep every ticket key exactly as written (e.g. ABC-123) and never add one.
- Never add or change a number or a date. You may leave out numbers, never invent them.
- A ticket stays in the section it is in (Done stays done, Blocked stays blocked); never move it.
- Do not add facts, owners, causes, estimates or recommendations.
- Plain text with simple headings and "-" bullets. No tables.

REQUIRED OUTPUT SCHEMA (JSON only): { "text": string }`;
}
