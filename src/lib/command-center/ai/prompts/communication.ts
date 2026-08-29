import type { WorkItem } from "../../types";

export function communicationPrompt(item: WorkItem, audience: string, why: string): string {
  return `You are drafting a short, professional message on behalf of an IT Business Analyst /
Product Owner / Project Manager. This message will be reviewed by the user before sending —
never claim it has been sent.

AVAILABLE FACTS:
- Recipient: ${audience}
- Reason a message is needed: ${why}
- Work item: ${item.key} — ${item.title} (status: ${item.status})

CONSTRAINTS:
- Use only the facts above. Never invent a deadline, commitment, or additional detail.
- 2-3 sentences max. Start with "Hi team," and do not sign the message.

REQUIRED OUTPUT SCHEMA (JSON only): { "text": string }`;
}
