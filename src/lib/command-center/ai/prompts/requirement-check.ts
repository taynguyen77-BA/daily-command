// V2.36 H — requirement check over ONE ticket's content. Deep tier. The ticket text arrives
// already allow-listed and redacted (ai/data-protection.ts) and is wrapped as untrusted data
// here: a description or comment can contain anything, including instructions to the model.

import { untrustedBlock } from "../untrusted";
import type { TicketContextInput } from "../task-registry";

export function requirementCheckPrompt(t: TicketContextInput): string {
  const comments = t.comments.length
    ? t.comments.map((c, i) => untrustedBlock(`COMMENT_${i + 1}`, `${c.author} (${c.created.slice(0, 10)}): ${c.body}`)).join("\n")
    : "(no comments)";
  const links = t.links.length ? t.links.map((l) => `- ${l.relation} ${l.key} — ${l.summary} [${l.status || "status unknown"}]`).join("\n") : "- (none)";
  const history = t.statusHistory.length ? t.statusHistory.map((h) => `- ${h.at.slice(0, 10)}: ${h.from} → ${h.to}`).join("\n") : "- (not available)";
  return `You are reviewing ONE ticket's requirements for an IT Business Analyst / Product Owner.
Find what a developer or tester would still need to ask before building or testing it. You
are not deciding anything and you are not changing the ticket.

TICKET: ${t.key} (project ${t.projectKey}) — current status: ${t.status || "unknown"}

${untrustedBlock("SUMMARY", t.summary)}

${untrustedBlock("DESCRIPTION", t.description)}

${t.acceptanceCriteria !== undefined ? untrustedBlock("ACCEPTANCE_CRITERIA", t.acceptanceCriteria) : "ACCEPTANCE CRITERIA FIELD: not configured — look for criteria inside the description."}

COMMENTS (oldest first):
${comments}

LINKED ISSUES (facts):
${links}

STATUS HISTORY (facts):
${history}

CONSTRAINTS:
- Ground every gap, question and risk in the text above. Quote or paraphrase it; never invent a requirement, number, date, person or ticket key that is not in it.
- Placeholders such as [EMAIL_1] or CLIENT_1 stand for redacted values — keep them exactly as written, never guess what they hide.
- gaps: missing or ambiguous behaviour, missing acceptance criteria, untestable statements.
- questions: concrete questions to ask the reporter, one per item.
- risks: contradictions between description, criteria and comments, or open linked issues.
- If the ticket has too little text to review, set insufficientEvidence: true and keep the lists short.

REQUIRED OUTPUT SCHEMA (JSON only):
{ "summary": string, "gaps": string[], "questions": string[], "risks": string[], "confidence": number (0-1), "insufficientEvidence"?: boolean }`;
}
