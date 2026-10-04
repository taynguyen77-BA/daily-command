// V2.37 I3 — Mention Reply Drafter over the ticket's comment thread. A DRAFT for the user to
// edit: it is only ever copied, or posted through the write-back confirmation dialog.

import { untrustedBlock } from "../untrusted";
import type { TaskInput } from "../task-registry";
import { ticketContextSection } from "./ticket-context";

const TONE = {
  client: "Client-facing: polite, professional, no internal jargon, no internal names or team gossip.",
  internal: "Internal: direct and friendly, team shorthand is fine.",
};
const LANGUAGE = { en: "English", vi: "Vietnamese (tiếng Việt)" };
const LENGTH = { short: "2-3 sentences.", normal: "One short paragraph, at most 6 sentences." };

export function mentionReplyPrompt(i: TaskInput<"draftMentionReply">): string {
  return `You are drafting a reply, on behalf of an IT Business Analyst / Product Owner, to a Jira comment
that mentioned them. The user will review and edit it before anything is posted.

${ticketContextSection(i.ticket)}

THE COMMENT TO ANSWER:
${untrustedBlock("MENTION", `${i.mention.author} (${i.mention.created.slice(0, 10)}): ${i.mention.body}`)}

TONE: ${TONE[i.tone]}
LANGUAGE: write the reply in ${LANGUAGE[i.language]}.
LENGTH: ${LENGTH[i.length]}

CONSTRAINTS:
- Answer only what the thread above lets you answer. Never promise a date, number or commitment that is not in the thread.
- Every point of the comment you cannot answer from the thread goes into unansweredPoints (in English), not into the reply.
- Address people only by names that appear in the thread. Keep placeholders like [EMAIL_1] or CLIENT_1 as written.
- Do not sign the message.

REQUIRED OUTPUT SCHEMA (JSON only): { "reply": string, "unansweredPoints": string[] }`;
}
