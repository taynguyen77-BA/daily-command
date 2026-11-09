// V2.50 R2 — the narrative in exports, Close My Day, and the honest Polish / Rewrite messages.
import fs from "node:fs";
import { ok } from "./harness.mts";
import { renderDailyReport, renderWeeklyReport, type DailyReportView, type ReportFormat, type WeeklyReportView } from "../../src/lib/command-center/reports";
import { rewriteReportFlow } from "../../src/lib/command-center/ai/report-rewrite";
import { explainAiFailure } from "../../src/lib/command-center/ai/outcome";
import type { AIProvider } from "../../src/lib/command-center/ai/provider";

const read = (p: string) => fs.readFileSync(p, "utf8");
const day: DailyReportView = {
  date: "2026-11-09", doneMine: [{ key: "ABC-1", title: "Fix login", project: "Alpha", url: "https://j/ABC-1" }], inProgress: [], blocked: [], skipped: [], newToday: [], mentionsAwaitingReply: [], teamDone: [], removedFromScope: [], decisions: [], standupAvailable: true, identityConfigured: true, summary: "1 done.",
};
const week: WeeklyReportView = {
  weekStart: "2026-11-09", weekEnd: "2026-11-13", mode: "workweek", reportedDays: ["2026-11-09"], missingDays: [], totals: { doneMine: 1, teamDone: 0, blocked: 0, skipped: 0, newReceived: 0, decisions: 0 }, groupBy: "project",
  doneGroups: [{ name: "Alpha", tickets: [{ key: "ABC-1", title: "Fix login", project: "Alpha" }] }], teamDone: [], carriedOver: [], blockers: [], skipped: [], newReceived: [], decisions: [], nextWeek: [], summary: "Week summary.",
};
const FORMATS: ReportFormat[] = ["markdown", "slack", "text"];
const N = "Today I completed 1 ticket, including ABC-1. Nothing is recorded as in progress. No blockers are recorded.";

{
  const group = "V2.50 R2 exports";
  for (const f of FORMATS) {
    const withN = renderDailyReport(day, f, { narrative: N });
    const lines = withN.split("\n");
    ok(group, /daily report/i.test(lines[0]) && lines[1] === "" && lines[2] === N, `${f}: the narrative is the first paragraph under the title`);
    ok(group, withN.indexOf(N) < withN.indexOf("1 done.") && withN.indexOf("1 done.") < withN.indexOf("ABC-1", withN.indexOf("1 done.")), `${f}: narrative, then the existing summary line, then the sections`);
    ok(group, renderDailyReport(day, f) === renderDailyReport(day, f, { narrative: undefined }) && renderDailyReport(day, f) === renderDailyReport(day, f, { narrative: "  " }), `${f}: no narrative -> output is byte-identical to before`);
    const w = renderWeeklyReport(week, f, { narrative: N });
    ok(group, w.split("\n")[2] === N && w.indexOf(N) < w.indexOf("Week summary."), `${f}: weekly report starts with the narrative too`);
    ok(group, renderWeeklyReport(week, f) === renderWeeklyReport(week, f, { narrative: undefined }), `${f}: weekly output unchanged without a narrative`);
  }
  const tricky = "Done *bold* and _it_ <b> & [x] ABC-1";
  ok(group, renderDailyReport(day, "slack", { narrative: tricky }).includes("Done *bold* and _it_ &lt;b&gt; &amp; [x] ABC-1"), "slack: < > & are escaped; keys stay plain");
  ok(group, renderDailyReport(day, "markdown", { narrative: tricky }).includes("Done \\*bold\\* and \\_it\\_ <b> & \\[x\\] ABC-1"), "markdown: * _ [ ] are escaped; keys stay plain");
  ok(group, renderDailyReport(day, "text", { narrative: tricky }).includes(tricky), "plain text is left as is");
  const noData = renderDailyReport({ ...day, noData: true }, "text", { narrative: N });
  ok(group, !noData.includes(N), "a day with no data prints no narrative");
}

{
  const group = "V2.50 R2 pages and flows";
  const page = read("src/app/reports/page.tsx");
  ok(group, /narrative: dailyNarrative/.test(page) && /narrative: weeklyNarrative/.test(page), "Copy and Share on the Reports page pass the visible narrative");
  ok(group, /Copy summary only/.test(page) && /summary=\{dailyNarrative\}/.test(page) && /summary=\{weeklyNarrative\}/.test(page), "'Copy summary only' sits next to the full copy (daily and weekly)");
  const render = page.indexOf("renderWeeklyReport(w, format, { includeTeam, narrative: weeklyNarrative })");
  ok(group, render > 0 && page.indexOf("weeklyInsightsText", render) > render, "weekly copy keeps the order narrative, summary, … then insights");
  ok(group, /<ReportNarrative[^>]*kind: "daily"/.test(page) && /<ReportNarrative[^>]*kind: "weekly"/.test(page), "both panels render the narrative above the summary paragraph");
  ok(group, /TodayReportNarrative/.test(read("src/components/command-center/CloseDayModal.tsx")), "Close My Day shows today's narrative (same component)");
  const comp = read("src/components/command-center/ReportNarrative.tsx");
  ok(group, /export function TodayReportNarrative/.test(comp) && /clipboard\.writeText\(shown\)/.test(comp), "Copy puts exactly the visible text on the clipboard");
}

{
  const group = "V2.50 R2 honest AI messages";
  const sum = read("src/components/command-center/ReportSummary.tsx");
  ok(group, !/Mock AI never rewrites/.test(sum) && /explainAiFailure/.test(sum) && /found nothing to improve/.test(sum), "Polish no longer says 'Mock AI never rewrites'; it shows the real reason");
  const fake = (o: Awaited<ReturnType<NonNullable<AIProvider["runTask"]>>>): Pick<AIProvider, "rewriteReport" | "mode" | "runTask"> => ({ mode: "mock", runTask: (async () => o) as AIProvider["runTask"],
    // like ClaudeProvider: the method goes through this.runTask and falls back to its input
    rewriteReport: async function (this: { runTask: NonNullable<AIProvider["runTask"]> }, a, r) {
      const x = await this.runTask("rewriteReport", { audience: a, report: r });
      return x.ok ? x.data.text : r;
    },
  });
  const base = { source: "Daily Report — 2026-11-09\n- ABC-1 Fix login", audience: "standup" as const, customTerms: [] };
  const budget = await rewriteReportFlow({ ...base, provider: fake({ ok: false, reason: "budget" }) });
  ok(group, !budget.usedAi && budget.text === base.source && budget.notice!.includes(explainAiFailure("budget").title), "Rewrite: a budget stop shows the budget reason and the deterministic report");
  const trunc = await rewriteReportFlow({ ...base, provider: fake({ ok: false, reason: "truncated" }) });
  ok(group, trunc.notice!.includes(explainAiFailure("truncated").title), "Rewrite: truncation says so");
  const good = await rewriteReportFlow({ ...base, provider: fake({ ok: true, data: { text: "Standup: ABC-1 Fix login is done." } }) });
  ok(group, good.usedAi && good.text.includes("ABC-1"), "Rewrite: success is decided by the call's own outcome (mode stays 'mock' here and it is still AI)");
  const legacy = await rewriteReportFlow({ ...base, provider: { mode: "claude", rewriteReport: async () => "Rewritten ABC-1." } });
  ok(group, legacy.usedAi, "a provider without runTask keeps the old behaviour");
}
