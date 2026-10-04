// V2.37 I2 — Smart Triage: ONE batched, fast-tier call over the New items of Morning Mode step 2.
// Items from projects outside the AI allow-list arrive with metadata only (no comment excerpt).
// The model only SUGGESTS; nothing is applied without the user ticking and clicking Apply.

import { untrustedBlock } from "../untrusted";
import type { TaskInput } from "../task-registry";

export function triagePrompt(i: TaskInput<"triageNewItems">): string {
  const rows = i.items
    .map((it) =>
      [
        `- ${it.key} | type: ${it.type} | Jira status: ${it.status} | why it is new: ${it.signal} | my role: ${it.role}`,
        `  ${untrustedBlock(`TITLE_${it.key.replace(/-/g, "_")}`, it.title)}`,
        it.lastCommentExcerpt !== undefined ? `  ${untrustedBlock(`LAST_COMMENT_${it.key.replace(/-/g, "_")}`, it.lastCommentExcerpt)}` : "  (metadata only — no comment text available)",
      ].join("\n")
    )
    .join("\n");
  return `You are triaging the NEW Jira items on an IT Business Analyst / Product Owner's list at the
start of their day (${i.today}). Suggest, for EVERY item below, exactly once:
- category: "Reply needed" (someone is waiting for my answer), "Review needed" (I must review/approve something), "Do" (work for me), or "FYI".
- action: keep (keep for today), done, defer (with "until" chosen ONLY from: ${i.deferDates.join(", ")}), block (with a short "reason"), or skip (with a short "reason").
- confidence 0-1 (low when the metadata is thin), and a one-line rationale grounded in the item's own data.

ITEMS:
${rows}

CONSTRAINTS:
- Return one entry per item key above — no other keys, no duplicates.
- Never invent people, numbers or dates; "until" must be one of the listed dates.
- An item with metadata only gets a cautious suggestion and confidence ≤ 0.6.

REQUIRED OUTPUT SCHEMA (JSON only):
{ "items": [{ "key": string, "category": "Reply needed" | "Review needed" | "Do" | "FYI", "action": { "kind": "keep" | "done" | "defer" | "block" | "skip", "until"?: string, "reason"?: string }, "confidence": number, "rationale": string }] }`;
}
