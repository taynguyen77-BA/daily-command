// F5 — report summaries: a deterministic one-paragraph opening (counts + top blocker + biggest
// risk), "Blocked aging" and "Needs decision from" sections; optional "Polish with AI" that may
// never change numbers or ticket keys.
// Run through scripts/tests/run.mts (npm test).

import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { biggestRisk, blockedAging, checkPolishPreservesFacts, dailySummary, needsDecisionFrom, weeklySummary } from "../../src/lib/command-center/report-summary";
import { buildDailyReportView, buildWeeklyReportView, renderDailyReport, renderWeeklyReport, type ReportTicket, type StandupState } from "../../src/lib/command-center/reports";
import { ReportSummaryParagraph } from "../../src/components/command-center/ReportSummary";
import { aiTaskSchema } from "../../src/lib/command-center/ai/schemas";
import { getUsagePolicy } from "../../src/lib/command-center/ai/usage-policy";
import { resolveAiModel } from "../../src/lib/command-center/ai/model-config";
import { MockAIProvider } from "../../src/lib/command-center/ai/provider";
import { DEFAULT_FEATURE_TOGGLES, type Decision, type Risk } from "../../src/lib/command-center/types";
import { ok } from "./harness.mts";

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const risk = (title: string, level: Risk["level"], status: Risk["status"] = "open") => ({ title, level, status });
const decision = (title: string, status: Decision["status"], owner?: string) => ({ title, status, ...(owner ? { owner } : {}) });
const blockedTickets: ReportTicket[] = [
  { key: "PAY-9", title: "Docs", ageBusinessDays: 1 },
  { key: "PAY-3", title: "Card vault", ageBusinessDays: 6, notes: ["Waiting on Anna"] },
  { key: "OPS-4", title: "Infra", notes: ["Waiting on client decision"], waitsOn: ["Bob: sign-off on hosting"] },
];

// ----- The pieces -----
{
  const group = "F5 Summary pieces";
  ok(group, biggestRisk([risk("Low thing", "LOW"), risk("Big thing", "HIGH"), risk("Closed huge", "HIGH", "closed"), risk("Other high", "HIGH")])?.title === "Big thing", "biggest risk = the first open HIGH (closed ones ignored)");
  ok(group, biggestRisk([risk("x", "LOW", "closed")]) === undefined && biggestRisk(undefined) === undefined, "no open risk → none");
  ok(group, blockedAging(blockedTickets).map((t) => t.key).join() === "PAY-3,PAY-9,OPS-4", "Blocked aging: oldest first, unknown age last");
  const needs = needsDecisionFrom([decision("Pick vendor", "PROPOSED", "Carol"), decision("Old one", "DECIDED", "Carol"), decision("Scope cut", "pending"), decision("API style", "UNDER_REVIEW", "Carol")], blockedTickets);
  ok(group, JSON.stringify(needs) === JSON.stringify([{ person: "Carol", items: ["Pick vendor", "API style"] }, { person: "Bob", items: ["OPS-4 Infra"] }, { person: "Unassigned", items: ["Scope cut"] }]), `Needs decision from: open decisions by owner + decision-blocked tickets by who they wait on; Unassigned last (${JSON.stringify(needs)})`);
  const text = dailySummary({ doneMine: 3, inProgress: 2, blocked: blockedTickets, newToday: 4, mentionsAwaitingReply: 1, overdueBlockers: 1, risk: { title: "Release 2026.4 at risk", level: "HIGH" } });
  ok(group, text === "3 done, 2 in progress, 3 blocked (1 over SLA), 4 new, 1 mention awaiting reply. Top blocker: PAY-3 Card vault — blocked 6 business days (Waiting on Anna). Biggest risk: Release 2026.4 at risk (HIGH).", `daily: counts + top blocker + biggest risk, one paragraph ("${text}")`);
  ok(group, dailySummary({ doneMine: 0, inProgress: 0, blocked: [], newToday: 0, mentionsAwaitingReply: 2 }) === "0 done, 0 in progress, 0 blocked, 0 new, 2 mentions awaiting reply. No blockers. No open risks recorded.", "says so plainly when there is no blocker or risk");
  const weekly = weeklySummary({ doneMine: 12, newReceived: 7, blockers: blockedTickets, skipped: 2, decisions: 1, reportedDays: 5 });
  ok(group, weekly === "This week: 12 done, 7 new received, 3 blocked, 2 skipped, 1 decision (5 days reported). Top blocker: PAY-3 Card vault — blocked 6 business days (Waiting on Anna). No open risks recorded.", `weekly paragraph ("${weekly}")`);
}

// ----- In the reports -----
{
  const group = "F5 Summary in reports";
  const today = "2026-10-09";
  const standup: StandupState = { asOf: `${today}T09:00:00Z`, inProgress: [{ key: "PAY-1" }], blocked: blockedTickets, skipped: [], newToday: [{ key: "PAY-20" }], mentionsAwaitingReply: [], openAssigned: [] };
  const snapshot = { date: today, generatedAt: `${today}T18:00:00Z`, events: [{ id: "e1", date: today, kind: "TICKET_COMPLETED" as const, title: "x", impact: "", evidence: [], ticketKey: "PAY-2" }], standup };
  const summaries = { risks: [risk("Vendor slip", "MEDIUM")], decisions: [decision("Pick vendor", "PROPOSED", "Carol")] };
  const view = buildDailyReportView(snapshot, today, { accountId: "acc" }, undefined, { blockerSlaBusinessDays: 2, summaries });
  ok(group, view.summary?.startsWith("1 done, 1 in progress, 3 blocked (1 over SLA), 1 new, 0 mentions awaiting reply. Top blocker: PAY-3") && view.summary.endsWith("Biggest risk: Vendor slip (MEDIUM)."), "the daily view carries the summary built from its own sections");
  const md = renderDailyReport(view, "markdown").split("\n");
  ok(group, md[0].startsWith("# Daily Report") && md[2].startsWith("**⚠ 1 blocker over") && md[4] === view.summary, "the report opens with the summary (after the overdue callout)");
  const all = md.join("\n");
  ok(group, /## Blocked aging \(3\)\n- \*\*PAY-3\*\* Card vault · 6 business days/.test(all), "'Blocked aging' section, oldest first");
  ok(group, /## Needs decision from \(2\)\n- Bob: OPS-4 Infra\n- Carol: Pick vendor/.test(all), "'Needs decision from' section, one line per person (most items first, then by name)");
  const plain = buildDailyReportView(snapshot, today, { accountId: "acc" });
  ok(group, plain.summary === undefined && !/Blocked aging|Needs decision from/.test(renderDailyReport(plain, "markdown")), "feature off → the report is exactly as before");
  const week = buildWeeklyReportView({ weekStart: "2026-10-05", dailyReports: { [today]: snapshot }, identity: { accountId: "acc" }, today, summaries });
  ok(group, week.summary?.startsWith("This week: ") && /Biggest risk: Vendor slip/.test(week.summary) && !!week.blockedAging && !!week.needsDecisionFrom, "the weekly report gets the same treatment");
  const wmd = renderWeeklyReport(week, "markdown").split("\n");
  ok(group, wmd[2] === week.summary && wmd.some((l) => l.startsWith("## Blocked aging")) && wmd.some((l) => l.startsWith("## Needs decision from")), "…opening with its paragraph and including both sections");
  ok(group, renderDailyReport(view, "slack").includes("Card vault") && !renderDailyReport(view, "slack").includes("**"), "Slack format keeps mrkdwn (no Markdown bold)");
  ok(group, DEFAULT_FEATURE_TOGGLES.reportSummaries === true, "the feature defaults on");
  const page = read("src/app/reports/page.tsx");
  ok(group, /state\.features\.reportSummaries \? \{ summaries:/.test(page) && /<ReportSummaryParagraph summary=\{daily\.view\.summary\}/.test(page) && /<NeedsDecision groups=\{v\.needsDecisionFrom\}/.test(page), "the Reports page shows the paragraph and both sections when on");
}

// ----- "Polish with AI" never alters numbers or ticket keys -----
{
  const group = "F5 Polish with AI";
  const original = "3 done, 2 in progress, 1 blocked. Top blocker: PAY-3 Card vault — blocked 6 business days.";
  ok(group, checkPolishPreservesFacts(original, "Today: 3 tickets done and 2 in progress; 1 is blocked — PAY-3 (Card vault) has waited 6 business days.") === null, "rewording with the same numbers and keys is accepted");
  ok(group, /number/.test(checkPolishPreservesFacts(original, "3 done, 2 in progress, 1 blocked. Top blocker: PAY-3 Card vault — blocked 7 business days.") ?? ""), "a changed number is refused");
  ok(group, /number/.test(checkPolishPreservesFacts(original, "3 done, 2 in progress, 1 blocked. Top blocker: PAY-3 Card vault — blocked 6 business days, about 50% of the sprint.") ?? ""), "an added number is refused");
  ok(group, /ticket keys/.test(checkPolishPreservesFacts(original, "3 done, 2 in progress, 1 blocked. Top blocker: PAY-4 Card vault — blocked 6 business days.") ?? ""), "a changed ticket key is refused");
  ok(group, /ticket keys/.test(checkPolishPreservesFacts(original, "3 done, 2 in progress, 1 blocked; top blocker Card vault, 6 business days.") ?? ""), "a dropped ticket key is refused");
  ok(group, checkPolishPreservesFacts(original, "  ") !== null, "an empty answer is refused");
  ok(group, aiTaskSchema.options.includes("polishReportSummary") && getUsagePolicy("polishReportSummary").trigger === "on-demand" && resolveAiModel("polishReportSummary", {}).tier === "fast", "a registered, on-demand AI task on the fast model");
  ok(group, (await new MockAIProvider().polishReportSummary(original)) === original, "Mock AI never rewrites (the deterministic text is returned unchanged)");
  const html = renderToStaticMarkup(React.createElement(ReportSummaryParagraph, { summary: original, onPolished: () => undefined }));
  ok(group, html.includes(original) && />Polish with AI<\/button>/.test(html) && /Calculated from the report below/.test(html), "the paragraph shows with an optional 'Polish with AI'");
  const src = read("src/components/command-center/ReportSummary.tsx");
  ok(group, /checkPolishPreservesFacts\(summary, text\);\s*if \(refused\) setStatus\(refused\);\s*else \{\s*onPolished\(text\);/.test(src), "a polished text is used only after the facts check passes");
  const polished = renderToStaticMarkup(React.createElement(ReportSummaryParagraph, { summary: original, polished: "Reworded: 3 done, 2 in progress, 1 blocked; PAY-3 Card vault, 6 business days.", onPolished: () => undefined }));
  ok(group, /Reworded:/.test(polished) && /Polished with AI — same numbers and ticket keys/.test(polished) && />Show original<\/button>/.test(polished), "once accepted it is labelled, and the original is one click away");
}
