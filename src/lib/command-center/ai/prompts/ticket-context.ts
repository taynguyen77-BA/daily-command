// V2.37 — the shared ticket section for every task-level prompt over one ticket's content: the
// free text (summary, description, criteria, comments) only ever inside untrusted-data blocks.

import { untrustedBlock } from "../untrusted";
import type { TicketContextInput } from "../task-registry";

export function ticketContextSection(t: TicketContextInput): string {
  const comments = t.comments.length
    ? t.comments.map((c, i) => untrustedBlock(`COMMENT_${i + 1}`, `${c.author} (${c.created.slice(0, 10)}): ${c.body}`)).join("\n")
    : "(no comments)";
  const links = t.links.length ? t.links.map((l) => `- ${l.relation} ${l.key} — ${l.summary} [${l.status || "status unknown"}]`).join("\n") : "- (none)";
  const history = t.statusHistory.length ? t.statusHistory.map((h) => `- ${h.at.slice(0, 10)}: ${h.from} → ${h.to}`).join("\n") : "- (not available)";
  return `TICKET: ${t.key} (project ${t.projectKey}) — current Jira status: ${t.status || "unknown"}

${untrustedBlock("SUMMARY", t.summary)}

${untrustedBlock("DESCRIPTION", t.description)}

${t.acceptanceCriteria !== undefined ? untrustedBlock("ACCEPTANCE_CRITERIA", t.acceptanceCriteria) : "ACCEPTANCE CRITERIA FIELD: not configured."}

COMMENTS (oldest first):
${comments}

LINKED ISSUES (facts):
${links}

STATUS HISTORY (facts):
${history}`;
}
