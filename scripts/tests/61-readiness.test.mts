// W2 — Sprint Readiness Radar: the Definition-of-Ready checklist, scope, summary, Markdown / CSV (offline, pure).
import fs from "node:fs";
import { ok } from "./harness.mts";
import { DEFAULT_READY_STATUSES, READINESS_SCOPE_CAP, evaluateTicket, gapSentence, hasAcceptanceCriteria, readinessNote, readinessToCsv, readinessToMarkdown, selectReadinessScope, summarizeReadiness, type ReadinessTicketInput } from "../../src/lib/command-center/readiness-radar";

const GOOD_DESC = "As a billing admin I want a reminder email 7 days before a subscription expires so that customers renew on time. See the design: https://www.figma.com/file/abc/reminder";
const full = (over: Partial<ReadinessTicketInput> = {}): ReadinessTicketInput => ({ key: "R-1", title: "Reminder email", status: "Ready for Dev", owner: "Linh", labels: ["billing"], estimate: 5, content: { description: GOOD_DESC + "\n\nAcceptance Criteria\n- [ ] Email sent 7 days before expiry\n- [ ] Plan name shown", links: [] }, ...over });
const row = (t: ReadinessTicketInput) => evaluateTicket(t);
const verdict = (r: ReturnType<typeof row>, id: string) => r.items.find((i) => i.id === id)!.verdict;

{
  const group = "W2 checklist";
  const r = row(full());
  ok(group, r.score === 100 && r.missing.length === 0 && r.unknown.length === 0, "a ticket with description, AC checklist, estimate, owner, design link and labels scores 100%");
  const noEstimate = row(full({ estimate: null }));
  ok(group, noEstimate.score! < 100 && noEstimate.missing.join() === "estimate", "each missing item lowers the score and is named");
  const several = row(full({ owner: undefined, estimate: null, labels: [], content: { description: "short", links: [] } }));
  ok(group, several.missing.includes("owner") && several.missing.includes("estimate") && several.missing.includes("description") && several.missing.includes("acceptance-criteria") && several.missing.includes("design-link") && several.score! < 50, "several gaps are all named");
  ok(group, verdict(row(full({ estimate: undefined })), "estimate") === "UNKNOWN" && /Setup|field id/i.test(row(full({ estimate: undefined })).items.find((i) => i.id === "estimate")!.hint ?? "") && row(full({ estimate: undefined })).score === 100, "an unknown estimate field -> UNKNOWN (not FAIL) with a Setup hint, and it does not lower the score");
  ok(group, verdict(row(full({ content: { description: "", links: [] } })), "description") === "FAIL", "an empty description FAILs");
  ok(group, verdict(row(full({ content: { description: GOOD_DESC + "\n\nTiêu chí chấp nhận:\n- Gửi email trước 7 ngày", links: [] } })), "acceptance-criteria") === "PASS", "a Vietnamese 'Tiêu chí chấp nhận' heading counts as acceptance criteria");
  ok(group, verdict(row(full({ content: { description: GOOD_DESC + "\n☐ Email sent\n☐ Plan shown", links: [] } })), "acceptance-criteria") === "PASS" && verdict(row(full({ content: { description: GOOD_DESC, acceptanceCriteria: "- Email is sent 7 days before expiry", links: [] } })), "acceptance-criteria") === "PASS", "a checkbox block, or the dedicated AC field, counts too");
  ok(group, verdict(row(full({ content: { description: GOOD_DESC.replace(/ See the design.*/, ""), links: [] } })), "design-link") === "FAIL" && verdict(row(full({ content: { description: GOOD_DESC + " https://acme.atlassian.net/wiki/spaces/X/pages/1", links: [] } })), "design-link") === "PASS", "design link: Figma / Confluence URLs are recognised; none -> FAIL");
  const blocked = row(full({ content: { description: GOOD_DESC + "\nAcceptance Criteria\n- x", links: [{ relation: "is blocked by", status: "In Progress", key: "B-9" }, { relation: "blocks", status: "To Do", key: "C-1" }, { relation: "is blocked by", status: "Done", key: "B-1" }] } }));
  ok(group, verdict(blocked, "no-blockers") === "FAIL" && /B-9/.test(blocked.items.find((i) => i.id === "no-blockers")!.evidence) && !/B-1\b/.test(blocked.items.find((i) => i.id === "no-blockers")!.evidence), "only unresolved 'is blocked by' links count as blockers");
  ok(group, verdict(row(full({ content: { description: GOOD_DESC + "\nAcceptance Criteria\n- x\nTBD: billing contact?", links: [] } })), "no-open-questions") === "FAIL" && verdict(row(full({ content: { description: GOOD_DESC + "\nAcceptance Criteria\n- x\nCần xác nhận với khách hàng", links: [] } })), "no-open-questions") === "FAIL", "open-question markers (TBD, 'to be confirmed', Vietnamese) FAIL");
  const late = row(full({ content: { description: GOOD_DESC + "\nAcceptance Criteria\n- x\n" + "x".repeat(2100) + " TBD", links: [] } }));
  ok(group, verdict(late, "no-open-questions") === "PASS", "markers beyond the first 2,000 characters are ignored");
  ok(group, row(full({ owner: undefined })).missing.includes("owner") && row(full({ labels: [] })).missing.includes("labels"), "owner and labels are checked");
  ok(group, hasAcceptanceCriteria({ description: "no section here", links: [] }) === false && hasAcceptanceCriteria({ description: "AC: user can log in", links: [] }), "the 'AC:' shorthand counts; plain text does not");
}

{
  const group = "W2 failures and unknowns";
  const failed = row(full({ content: null }));
  ok(group, failed.unknown.length >= 4 && failed.items.find((i) => i.id === "description")!.verdict === "UNKNOWN" && failed.score !== null && /could not be loaded/.test(failed.items[0].evidence), "a failed fetch -> that row's content items are UNKNOWN (with a reason), the rest still scored");
  const pending = row(full({ content: undefined }));
  ok(group, pending.unknown.length >= 4 && /Not loaded/.test(pending.items[0].evidence), "not loaded yet -> UNKNOWN, never a pass");
  const nothing = row({ key: "N-1", title: "t", status: "x", content: null, estimate: undefined });
  ok(group, nothing.score !== null, "owner and labels are always known, so the score exists");
}

{
  const group = "W2 scope and summary";
  const w = (key: string, status: string, over: Record<string, unknown> = {}) => ({ key, status: "In Progress", jiraStatusName: status, ...over });
  const scope = selectReadinessScope([w("A-1", "Ready for Dev"), w("A-2", "backlog refinement"), w("A-3", "In Progress"), w("A-4", "Ready for Dev", { status: "Done" }), w("A-5", "To Do", { sprint: "Sprint 24" })] as never, { sprint: "Sprint 24" });
  ok(group, scope.keys.join() === "A-1,A-2,A-5" && !scope.truncated, "scope: the configured statuses (case-insensitive) or the next sprint; Done is excluded");
  const many = Array.from({ length: 130 }, (_, i) => w(`M-${i}`, "Ready for Dev"));
  const capped = selectReadinessScope(many as never);
  ok(group, capped.keys.length === READINESS_SCOPE_CAP && capped.truncated && DEFAULT_READY_STATUSES.length === 2, "capped at 100 tickets, and says so");
  const rows = [row(full()), row(full({ key: "R-2", owner: undefined, estimate: null })), row(full({ key: "R-3", owner: undefined, estimate: null, content: { description: "x", links: [] } })), row(full({ key: "R-4", content: null, owner: undefined, labels: [], estimate: undefined }))];
  const s = summarizeReadiness(rows, 80);
  ok(group, s.total === 4 && s.ready === 1 && s.readyPct === 25 && s.topGaps[0].count >= 2, "readiness % = tickets at or above the threshold; gaps by frequency");
  ok(group, /lack/.test(gapSentence({ id: "acceptance-criteria", count: 12 })) && /^1 ticket has no owner$/.test(gapSentence({ id: "owner", count: 1 })), "gaps read as sentences ('12 tickets lack acceptance criteria')");
  ok(group, /not ready/.test(readinessNote(s) ?? "") && readinessNote(summarizeReadiness([row(full())])) === null, "a one-line note for Next Best Action / planning when tickets are not ready");
  ok(group, summarizeReadiness([]).readyPct === null, "no tickets -> no percentage (never 0% or 100%)");
}

{
  const group = "W2 exports";
  const rows = [row(full({ title: "=HYPERLINK(\"x\")" })), row(full({ key: "R-2", title: "Tiêu đề tiếng Việt, có dấu", owner: undefined }))];
  const csv = readinessToCsv(rows);
  ok(group, csv.startsWith("﻿") && csv.includes("\r\n") && !csv.slice(1).includes("﻿") && csv.endsWith("\r\n"), "CSV: UTF-8 BOM, CRLF");
  ok(group, csv.includes("\"'=HYPERLINK(\"\"x\"\")\"") && csv.includes("Tiêu đề tiếng Việt, có dấu"), "CSV: formulas neutralised, Vietnamese characters intact, commas quoted");
  const md = readinessToMarkdown(rows, summarizeReadiness(rows));
  ok(group, /## Sprint readiness/.test(md) && /\| R-2 /.test(md) && /Owner/.test(md), "Markdown for the planning meeting lists each ticket and what is missing");
}

{
  const group = "W2 wiring";
  const page = fs.readFileSync("src/app/readiness/page.tsx", "utf8");
  ok(group, /loadIssueContext/.test(page) && /BaRequirementCheck/.test(page) && /Promise\.all\(\[worker\(\), worker\(\), worker\(\), worker\(\)\]\)/.test(page) && !/getAIProvider|handleAiRequest/.test(page), "the page loads content through the cached issue-context path with bounded concurrency; AI only through the per-ticket click");
  ok(group, /\{ href: "\/readiness", label: "Sprint Readiness" \}/.test(fs.readFileSync("src/components/command-center/Nav.tsx", "utf8")), "the page is in the navigation");
}
