// V2.38 J1 — BA Requirement Check on Story/Task tickets (deep tier, allow-listed projects only):
// acceptance criteria as CHECKLIST items (happy path / validation / error / edge case), each
// traceable to a sentence of the ticket or flagged "assumption"; clarification questions by
// stakeholder; missing information; risks. Copy as Markdown, export as Excel-compatible CSV,
// or post as a Jira comment through the gated write-back flow.

import type { IssueContext } from "../jira/issue-context";
import { gateTicketAi, type AiDataProtectionSettings, type TicketAiGate } from "./data-protection";
import type { AIProvider } from "./provider";
import type { BaRequirementCheckResponse } from "./schemas";
import { isGherkin, quoteFound, type TicketContextInput } from "./task-registry";

export const BA_CHECK_TYPES = new Set(["story", "task"]);

/** Rewrites Gherkin keywords out of a statement (deterministic fallback / last-resort guard). */
export function deGherkin(text: string): string {
  return text
    .replace(/^\s*(given|and|but)\s+/i, "")
    .replace(/^\s*when\s+/i, "If ")
    .replace(/^\s*then\s+/i, "")
    .replace(/,?\s*\bwhen\b\s+/gi, " — on ")
    .replace(/,?\s*\bthen\b\s+/gi, " → ")
    .replace(/\bgiven\b\s+/gi, "with ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

/** The source text the quotes must come from. */
export function ticketSourceText(t: TicketContextInput): string {
  return [t.summary, t.description, t.acceptanceCriteria ?? "", ...t.comments.map((c) => c.body)].join("\n");
}

/** Guarantees the AC contract whatever the provider returned: no Gherkin phrasing, and an item
 *  whose quote isn't in the ticket becomes an "assumption" (flagged, never silently trusted). */
export function normalizeBaCheck(r: BaRequirementCheckResponse, source: string): BaRequirementCheckResponse {
  return {
    ...r,
    acceptanceCriteria: r.acceptanceCriteria.map((ac) => {
      const text = isGherkin(ac.text) ? deGherkin(ac.text) : ac.text;
      const traceable = ac.source.kind !== "assumption" && quoteFound(ac.source.quote, source);
      return { ...ac, text, source: traceable ? ac.source : { kind: "assumption" as const } };
    }),
  };
}

export type BaCheckFlow = Exclude<TicketAiGate, { kind: "ready" }> | { kind: "done"; result: BaRequirementCheckResponse; mode: "mock" | "claude" };

export async function runBaRequirementCheck(context: IssueContext, settings: AiDataProtectionSettings, provider: Pick<AIProvider, "baRequirementCheck" | "mode">, opts: { previewConfirmed?: boolean } = {}): Promise<BaCheckFlow> {
  const gate = gateTicketAi(context, settings, opts);
  if (gate.kind !== "ready") return gate;
  const raw = await provider.baRequirementCheck(gate.input);
  // Traceability is checked against the redacted text the model saw, then aliases restored.
  const normalized = normalizeBaCheck(raw, ticketSourceText(gate.input));
  return { kind: "done", result: gate.session.restoreDeep(normalized), mode: provider.mode };
}

const CATEGORY_LABEL: Record<BaRequirementCheckResponse["acceptanceCriteria"][number]["category"], string> = {
  "happy-path": "Happy path",
  validation: "Validation",
  error: "Error handling",
  "edge-case": "Edge cases",
};

function sourceLabel(ac: BaRequirementCheckResponse["acceptanceCriteria"][number]): string {
  return ac.source.kind === "assumption" ? "assumption" : `${ac.source.kind}: "${ac.source.quote ?? ""}"`;
}

export function baCheckToMarkdown(key: string, r: BaRequirementCheckResponse): string {
  const lines = [`## Requirement check — ${key}`, "", "### Acceptance criteria"];
  for (const cat of Object.keys(CATEGORY_LABEL) as (keyof typeof CATEGORY_LABEL)[]) {
    const items = r.acceptanceCriteria.filter((a) => a.category === cat);
    if (!items.length) continue;
    lines.push(`**${CATEGORY_LABEL[cat]}**`);
    for (const a of items) lines.push(`- [ ] ${a.text}${a.source.kind === "assumption" ? " _(assumption)_" : ""}`);
  }
  if (r.questionsByStakeholder.length) {
    lines.push("", "### Clarification questions");
    for (const g of r.questionsByStakeholder) {
      lines.push(`**${g.stakeholder}**`, ...g.questions.map((q) => `- ${q}`));
    }
  }
  if (r.missingInformation.length) lines.push("", "### Missing information", ...r.missingInformation.map((m) => `- ${m}`));
  if (r.risks.length) lines.push("", "### Risks", ...r.risks.map((m) => `- ${m}`));
  return lines.join("\n");
}

/** Excel-compatible CSV: UTF-8 BOM, CRLF, every cell quoted, formula injection neutralized. */
export function baCheckToCsv(key: string, r: BaRequirementCheckResponse): string {
  const cell = (v: string) => {
    const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const rows: string[][] = [["Ticket", "Type", "Category / Stakeholder", "Item", "Source"]];
  r.acceptanceCriteria.forEach((a) => rows.push([key, "Acceptance criterion", CATEGORY_LABEL[a.category], a.text, sourceLabel(a)]));
  r.questionsByStakeholder.forEach((g) => g.questions.forEach((q) => rows.push([key, "Question", g.stakeholder, q, ""])));
  r.missingInformation.forEach((m) => rows.push([key, "Missing information", "", m, ""]));
  r.risks.forEach((m) => rows.push([key, "Risk", "", m, ""]));
  return "﻿" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
