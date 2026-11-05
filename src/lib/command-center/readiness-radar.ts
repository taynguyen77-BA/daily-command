// W2 — Sprint Readiness Radar: for the tickets entering the next sprint, is each one READY to build, and what is missing?
// A deterministic Definition-of-Ready checklist per ticket — every item PASS / FAIL / UNKNOWN with evidence. UNKNOWN (a field that is
// not synced or a fetch that failed) is never counted as a failure and never as a pass. No AI here: the AI actions (Suggest AC,
// clarification questions) live on the existing baRequirementCheck task and only run on a click for an allow-listed project.

import type { WorkItem } from "./types";

export const READINESS_SCOPE_CAP = 100;
export const DEFAULT_READY_STATUSES = ["Ready for Dev", "Backlog Refinement"];
export const READY_THRESHOLD_PCT = 80;
export const MIN_DESCRIPTION_CHARS = 80;
const OPEN_QUESTION_WINDOW = 2000;

export type ReadinessItemId = "description" | "acceptance-criteria" | "estimate" | "owner" | "design-link" | "no-blockers" | "labels" | "no-open-questions";
export type ReadinessVerdict = "PASS" | "FAIL" | "UNKNOWN";
export interface ReadinessItem { id: ReadinessItemId; label: string; verdict: ReadinessVerdict; evidence: string; /** What the user can do about an UNKNOWN. */ hint?: string }

export interface ReadinessTicketInput {
  key: string;
  title: string;
  status: string;
  owner?: string;
  labels?: string[];
  sprint?: string;
  /** Story points. undefined = the estimate field is not configured / not synced (UNKNOWN); null = configured but empty (FAIL). */
  estimate?: number | null;
  /** The ticket's content. undefined = not fetched yet; null = the fetch failed (UNKNOWN, retry). */
  content?: { description: string; acceptanceCriteria?: string; links: { relation: string; status: string; key: string }[] } | null;
}

export interface ReadinessRow { key: string; title: string; status: string; owner?: string; items: ReadinessItem[]; score: number | null; missing: ReadinessItemId[]; unknown: ReadinessItemId[] }

const AC_HEADING = /(acceptance criteria|definition of done|\bAC\b\s*[:\-]|tiêu chí (chấp nhận|nghiệm thu|hoàn thành)|điều kiện (chấp nhận|nghiệm thu))/i;
const CHECKLIST = /^\s*(?:[-*•]\s*)?(?:\[[ xX]\]|☐|☑|✓)\s+\S/m;
const DESIGN_URL = /https?:\/\/[^\s)>\]]*(figma\.com|confluence|atlassian\.net\/wiki|miro\.com|lucid(?:chart|spark)?\.(?:com|app)|invisionapp\.com|zeplin\.io|sketch\.com|whimsical\.com|notion\.(?:so|site)|drive\.google\.com|docs\.google\.com)[^\s)>\]]*/i;
const OPEN_QUESTION = /\b(TBD|TBC|to be (confirmed|decided|defined)|open question|unclear|\?\?)\b|chưa rõ|cần xác nhận|chưa xác định|\bcần làm rõ\b/i;
export const ESTIMATE_HINT = "Story points are not synced: set the story-points field id in Data & Settings → Jira (the same place as the sprint field).";

export function hasAcceptanceCriteria(content: NonNullable<ReadinessTicketInput["content"]>): boolean {
  if (content.acceptanceCriteria && content.acceptanceCriteria.trim().length >= 10) return true;
  const d = content.description ?? "";
  return AC_HEADING.test(d) || CHECKLIST.test(d);
}

export function evaluateTicket(t: ReadinessTicketInput, opts: { minDescriptionChars?: number } = {}): ReadinessRow {
  const min = opts.minDescriptionChars ?? MIN_DESCRIPTION_CHARS;
  const c = t.content;
  const needsContent = "Open the ticket content (fetch pending or failed — press Retry).";
  const items: ReadinessItem[] = [];
  const push = (id: ReadinessItemId, label: string, verdict: ReadinessVerdict, evidence: string, hint?: string) => items.push({ id, label, verdict, evidence, ...(hint ? { hint } : {}) });

  if (c === undefined || c === null) {
    for (const [id, label] of [["description", "Description"], ["acceptance-criteria", "Acceptance criteria"], ["design-link", "Design / spec link"], ["no-blockers", "No open blocking links"], ["no-open-questions", "No open questions"]] as const)
      push(id, label, "UNKNOWN", c === null ? "The ticket could not be loaded" : "Not loaded yet", needsContent);
  } else {
    const desc = (c.description ?? "").trim();
    push("description", "Description", desc.length >= min ? "PASS" : "FAIL", desc.length === 0 ? "The description is empty" : `${desc.length} characters (needs ${min}+)`);
    push("acceptance-criteria", "Acceptance criteria", hasAcceptanceCriteria(c) ? "PASS" : "FAIL", hasAcceptanceCriteria(c) ? "Found an Acceptance Criteria section or checklist" : "No Acceptance Criteria section or checklist");
    const design = (desc + "\n" + (c.acceptanceCriteria ?? "")).match(DESIGN_URL);
    push("design-link", "Design / spec link", design ? "PASS" : "FAIL", design ? design[0].slice(0, 80) : "No Figma / Confluence / design link");
    const blockers = c.links.filter((l) => /blocked by/i.test(l.relation) && !/^(done|closed|resolved)$/i.test(l.status));
    push("no-blockers", "No open blocking links", blockers.length === 0 ? "PASS" : "FAIL", blockers.length === 0 ? "No unresolved “is blocked by” links" : `Blocked by ${blockers.map((b) => b.key).join(", ")}`);
    const window = desc.slice(0, OPEN_QUESTION_WINDOW);
    const q = window.match(OPEN_QUESTION);
    push("no-open-questions", "No open questions", q ? "FAIL" : "PASS", q ? `Contains “${q[0]}”` : "No TBD / “to be confirmed” markers in the first 2,000 characters");
  }
  if (t.estimate === undefined) push("estimate", "Estimate", "UNKNOWN", "The estimate field is not synced", ESTIMATE_HINT);
  else push("estimate", "Estimate", t.estimate === null || !(t.estimate > 0) ? "FAIL" : "PASS", t.estimate && t.estimate > 0 ? `${t.estimate} points` : "No estimate");
  push("owner", "Owner", t.owner ? "PASS" : "FAIL", t.owner ? `Assigned to ${t.owner}` : "No assignee");
  push("labels", "Labels", (t.labels?.length ?? 0) > 0 ? "PASS" : "FAIL", (t.labels?.length ?? 0) > 0 ? t.labels!.join(", ") : "No labels (components are not synced)");

  const known = items.filter((i) => i.verdict !== "UNKNOWN");
  const pass = known.filter((i) => i.verdict === "PASS").length;
  return {
    key: t.key,
    title: t.title,
    status: t.status,
    ...(t.owner ? { owner: t.owner } : {}),
    items,
    score: known.length === 0 ? null : Math.round((100 * pass) / known.length),
    missing: items.filter((i) => i.verdict === "FAIL").map((i) => i.id),
    unknown: items.filter((i) => i.verdict === "UNKNOWN").map((i) => i.id),
  };
}

/** Which tickets belong in the next sprint's readiness view: the configured next sprint, or a status from the editable list. Capped. */
export function selectReadinessScope(workItems: readonly Pick<WorkItem, "key" | "status" | "jiraStatusName" | "sprint">[], opts: { statuses?: readonly string[]; sprint?: string; cap?: number } = {}): { keys: string[]; truncated: boolean } {
  const statuses = new Set((opts.statuses ?? DEFAULT_READY_STATUSES).map((s) => s.trim().toLowerCase()).filter(Boolean));
  const sprint = opts.sprint?.trim().toLowerCase();
  const cap = opts.cap ?? READINESS_SCOPE_CAP;
  const all = workItems.filter((w) => w.status !== "Done" && ((sprint && w.sprint?.trim().toLowerCase() === sprint) || statuses.has((w.jiraStatusName ?? "").trim().toLowerCase()))).map((w) => w.key);
  return { keys: all.slice(0, cap), truncated: all.length > cap };
}

export interface SprintReadiness {
  total: number;
  ready: number;
  /** Share of tickets at or above the threshold (tickets with no known item are left out of the denominator). */
  readyPct: number | null;
  unscored: number;
  threshold: number;
  /** "12 tickets lack AC" — most frequent gaps first. */
  topGaps: { id: ReadinessItemId; label: string; count: number }[];
}

export function summarizeReadiness(rows: readonly ReadinessRow[], threshold: number = READY_THRESHOLD_PCT): SprintReadiness {
  const scored = rows.filter((r) => r.score !== null);
  const ready = scored.filter((r) => (r.score as number) >= threshold).length;
  const counts = new Map<ReadinessItemId, { label: string; count: number }>();
  for (const r of rows) for (const i of r.items) if (i.verdict === "FAIL") counts.set(i.id, { label: i.label, count: (counts.get(i.id)?.count ?? 0) + 1 });
  return {
    total: rows.length,
    ready,
    readyPct: scored.length ? Math.round((100 * ready) / scored.length) : null,
    unscored: rows.length - scored.length,
    threshold,
    topGaps: Array.from(counts, ([id, v]) => ({ id, label: v.label, count: v.count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  };
}

const GAP_PHRASE: Record<ReadinessItemId, string> = { description: "have no real description", "acceptance-criteria": "lack acceptance criteria", estimate: "have no estimate", owner: "have no owner", "design-link": "have no design link", "no-blockers": "are blocked", labels: "have no labels", "no-open-questions": "have open questions" };
export const gapSentence = (g: { id: ReadinessItemId; count: number }) => `${g.count} ticket${g.count === 1 ? "" : "s"} ${GAP_PHRASE[g.id].replace(/^have /, g.count === 1 ? "has " : "have ").replace(/^are /, g.count === 1 ? "is " : "are ").replace(/^lack /, g.count === 1 ? "lacks " : "lack ")}`;

/** One line for Next Best Action / Weekly Review: "5 tickets for planning are not ready". */
export function readinessNote(s: SprintReadiness): string | null {
  const notReady = s.total - s.unscored - s.ready;
  return notReady > 0 ? `${notReady} ticket${notReady === 1 ? "" : "s"} for the next sprint ${notReady === 1 ? "is" : "are"} not ready (${s.readyPct ?? 0}% ready)` : null;
}

export function readinessToMarkdown(rows: readonly ReadinessRow[], s: SprintReadiness, title = "Sprint readiness"): string {
  const lines = [`## ${title}`, "", `${s.readyPct === null ? "No ticket could be scored yet" : `${s.readyPct}% ready`} (${s.ready} of ${s.total - s.unscored} scored tickets at ${s.threshold}%+${s.unscored ? `, ${s.unscored} unscored` : ""})`, ""];
  if (s.topGaps.length) lines.push("### Top gaps", ...s.topGaps.map((g) => `- ${gapSentence(g)}`), "");
  lines.push("| Ticket | Score | Missing |", "| --- | --- | --- |");
  for (const r of rows) lines.push(`| ${r.key} ${r.title.replace(/\|/g, "/")} | ${r.score === null ? "—" : `${r.score}%`} | ${[...r.missing.map((m) => r.items.find((i) => i.id === m)!.label), ...r.unknown.map((m) => `${r.items.find((i) => i.id === m)!.label} (unknown)`)].join(", ") || "—"} |`);
  return lines.join("\n");
}

/** Excel-compatible CSV: UTF-8 BOM, CRLF, every cell quoted, formula injection neutralised (same rules as the BA-check export). */
export function readinessToCsv(rows: readonly ReadinessRow[]): string {
  const cell = (v: string) => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
  const head = ["Ticket", "Title", "Status", "Owner", "Score %", "Missing", "Unknown"];
  const body = rows.map((r) => [r.key, r.title, r.status, r.owner ?? "", r.score === null ? "" : String(r.score), r.missing.map((m) => r.items.find((i) => i.id === m)!.label).join("; "), r.unknown.map((m) => r.items.find((i) => i.id === m)!.label).join("; ")]);
  return "﻿" + [head, ...body].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
