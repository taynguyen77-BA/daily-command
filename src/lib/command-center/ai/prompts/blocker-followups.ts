// V2.38 J2 — AI version of "Ask": one follow-up message per person for their blocked tickets.
// Ticket comment text only for allow-listed projects. Copy or send via the existing channels,
// always after a confirmation.

import { untrustedBlock } from "../untrusted";
import type { TaskInput } from "../task-registry";

const CHANNEL = {
  slack: "a Slack message: friendly, short, no greeting line longer than two words, bullets for several tickets.",
  jira: "a Jira comment: neutral and specific, mention what is needed to unblock, no chit-chat.",
  email: "an email: a subject line plus a polite, complete body; no signature.",
};

export function blockerFollowUpsPrompt(i: TaskInput<"draftBlockerFollowUps">): string {
  const people = i.people
    .map(
      (p) =>
        `PERSON: ${p.person}\n` +
        p.tickets
          .map(
            (t) =>
              `- ${t.key}: blocked ${t.ageBusinessDays} business day(s)${t.overSla ? ` (over the ${i.slaBusinessDays}-day SLA)` : ""}\n  ${untrustedBlock(`TITLE_${t.key.replace(/-/g, "_")}`, t.title)}${t.reason ? `\n  ${untrustedBlock(`BLOCK_REASON_${t.key.replace(/-/g, "_")}`, t.reason)}` : ""}${t.lastComment !== undefined ? `\n  ${untrustedBlock(`LAST_COMMENT_${t.key.replace(/-/g, "_")}`, t.lastComment)}` : ""}`
          )
          .join("\n")
    )
    .join("\n\n");
  return `You are drafting follow-up messages, on behalf of an IT Business Analyst / Product Owner, to people
whose work is blocking tickets. Today is ${i.today}. Write ${CHANNEL[i.channel]}

${people}

CONSTRAINTS:
- Exactly one message per PERSON above, addressed to that person, covering all of their tickets.
- Reference only the ticket keys listed for that person. Never invent a reason, date, number or commitment.
- suggestedDeadline: pick ONE of ${i.deadlineOptions.join(", ")} (sooner when a ticket is over the SLA) and ask for an answer by then in the text.
- "Unknown" as a person means nobody is recorded: write the message to "team".

REQUIRED OUTPUT SCHEMA (JSON only):
{ "messages": [{ "person": string, "subject"?: string, "text": string, "suggestedDeadline": string }] }`;
}
