// P3.4 — delivery forecast: lead time, aging, slip risk, release forecast, the risk rule, UI strings, performance.
import fs from "node:fs";
import path from "node:path";
import { LEAD_TIME_MIN_SAMPLES, buildLeadTimeIndex, leadTimeSamples, percentile, type LeadTimeEstimate, type LeadTimeSample } from "../../src/lib/command-center/forecast/lead-time";
import { agingFor } from "../../src/lib/command-center/forecast/aging";
import { slipRiskFor } from "../../src/lib/command-center/forecast/slip-risk";
import { forecastRelease, hashSeed, seededRandom, weeklyThroughput } from "../../src/lib/command-center/forecast/release-forecast";
import { computeForecast, forecastFlags } from "../../src/lib/command-center/forecast";
import { detectRisks, riskFingerprint } from "../../src/lib/command-center/risk-detection";
import { dedupeRisks } from "../../src/lib/command-center/selectors";
import { describeReleaseForecast, weeklyForecastLine } from "../../src/components/command-center/ForecastCard";
import { addDays } from "../../src/lib/command-center/date-utils";
import { parseStoredState } from "../../src/lib/command-center/store";
import { emptyData, type CommandCenterData, type WorkItem } from "../../src/lib/command-center/types";
import { ok, perfBudget } from "./harness.mts";

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const today = "2026-10-27";
const wi = (key: string, over: Partial<WorkItem> = {}): WorkItem => ({ id: `jira-${key}`, key, title: "t", projectId: "p-1", clientId: "c", type: "task", status: "In Progress", priority: "P3", createdDate: "2026-10-01", lastUpdated: today, blocked: false, dependencyIds: [], riskIds: [], scopeChangeCount: 0, owner: "Tay", ownerId: "acc-me", ...over }) as WorkItem;
/** A resolved ticket that took `days` to finish, resolved `agoDays` days ago. */
const done = (key: string, days: number, agoDays: number, over: Partial<WorkItem> = {}): WorkItem => {
  const resolved = addDays(today, -agoDays);
  return wi(key, { status: "Done", createdDate: addDays(resolved, -days), resolvedAt: `${resolved}T12:00:00.000Z`, ...over });
};
const sample = (projectId: string, type: string, days: number): LeadTimeSample => ({ projectId, type, days });
const ok_ = (e: LeadTimeEstimate) => (e.status === "OK" ? e : (() => { throw new Error("expected OK"); })());

{
  const group = "P3.4 Lead time";
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  ok(group, percentile(sorted, 0.5) === 5 && percentile(sorted, 0.85) === 9 && percentile(sorted, 0.95) === 10 && percentile([7], 0.85) === 7 && Number.isNaN(percentile([], 0.5)), "percentiles on known samples (nearest rank): [1..10] -> P50 5, P85 9, P95 10");
  const items = [done("A-1", 5, 3), done("A-2", 5, 100), done("A-3", 9, 91), wi("A-4"), wi("A-5", { status: "Done", resolvedAt: undefined }), done("A-6", 4, 0), { ...done("A-7", 3, 5), createdDate: "2026-12-01" }];
  const s = leadTimeSamples(items, today);
  ok(group, s.length === 2 && s.map((x) => x.days).sort().join() === "4,5", `only items resolved in the last 90 days with both dates and a non-negative duration are used (${s.length})`);
  ok(group, leadTimeSamples([done("B-1", 2, 90)], today).length === 1 && leadTimeSamples([done("B-1", 2, 91)], today).length === 0, "the window includes day 90, not 91");

  const mk = (n: number, proj = "p-1", type = "task", base = 3) => Array.from({ length: n }, (_, i) => sample(proj, type, base + i));
  const eight = buildLeadTimeIndex(mk(8)).estimateFor("p-1", "task");
  ok(group, eight.status === "OK" && eight.scope === "project-type" && eight.n === 8 && eight.p50 === 6 && eight.p85 === 9, `8 samples is enough (n=${eight.status === "OK" ? eight.n : "?"}, P50 ${eight.status === "OK" ? eight.p50 : "?"}, P85 ${eight.status === "OK" ? eight.p85 : "?"})`);
  const seven = buildLeadTimeIndex(mk(7)).estimateFor("p-1", "task");
  ok(group, seven.status === "UNKNOWN" && seven.n === 7 && seven.reason === "insufficient history" && LEAD_TIME_MIN_SAMPLES === 8, "7 samples is UNKNOWN (insufficient history), never a number");
  const projectWide = buildLeadTimeIndex([...mk(5, "p-1", "task"), ...mk(5, "p-1", "bug", 20)]).estimateFor("p-1", "task");
  ok(group, projectWide.status === "OK" && projectWide.scope === "project" && projectWide.n === 10, "fewer than 8 for (project, type) falls back to the whole project");
  const global = buildLeadTimeIndex([...mk(5, "p-1", "task"), ...mk(5, "p-2", "bug", 20)]).estimateFor("p-1", "task");
  ok(group, global.status === "OK" && global.scope === "global" && global.n === 10, "…then to everything");
  ok(group, buildLeadTimeIndex([]).estimateFor("p-1", "task").status === "UNKNOWN", "…else UNKNOWN");
  ok(group, ok_(eight).olderThanPct(6) === 38 && ok_(eight).olderThanPct(3) === 0 && ok_(eight).olderThanPct(99) === 100, "olderThanPct = share of comparable tickets that took less time");
}

{
  const group = "P3.4 Aging";
  const est = buildLeadTimeIndex(Array.from({ length: 20 }, (_, i) => sample("p-1", "task", i + 1))).estimateFor("p-1", "task"); // P85 = 17
  const at = (daysOpen: number) => agingFor({ createdDate: addDays(today, -daysOpen), lastUpdated: addDays(today, -2), statusCategoryChangedAt: `${addDays(today, -4)}T09:00:00.000Z` }, today, est)!;
  ok(group, at(17).olderThanP85 === false && at(18).olderThanP85 === true && at(18).p85 === 17, "flagged only when strictly older than P85 (17 -> no, 18 -> yes)");
  ok(group, at(18).olderThanPct === 85 && at(18).inStatusDays === 4 && at(18).n === 20, "olderThanPct and days-in-status use the real numbers");
  ok(group, /older than 85% of similar tickets/.test(at(18).explanation) && /n = 20/.test(at(18).explanation), "the explanation names the percentage and n");
  ok(group, agingFor({ createdDate: "2026-10-01", lastUpdated: today }, today, { status: "UNKNOWN", n: 3, reason: "insufficient history" }) === null, "no estimate -> no aging claim");
}

{
  const group = "P3.4 Slip risk";
  const est = buildLeadTimeIndex(Array.from({ length: 20 }, (_, i) => sample("p-1", "task", i + 1))).estimateFor("p-1", "task"); // P50 10, P85 17
  const risk = (age: number, dueIn: number | null) => slipRiskFor({ createdDate: addDays(today, -age), dueDate: dueIn === null ? undefined : addDays(today, dueIn) }, today, est);
  ok(group, risk(5, null) === null, "no dueDate -> not computed");
  ok(group, slipRiskFor({ createdDate: "2026-10-20", dueDate: "2026-10-30" }, today, { status: "UNKNOWN", n: 2, reason: "insufficient history" }) === null, "no estimate -> not computed");
  ok(group, risk(2, 3)!.level === "HIGH" && risk(2, 3)!.expectedRemainingP50 === 8, "age 2, due in 3: typical remaining 8 days > 3 left -> HIGH");
  ok(group, risk(2, 8)!.level === "LOW" || risk(2, 8)!.level === "MEDIUM", "age 2, due in 8: typical exactly fits");
  ok(group, risk(2, 8)!.level === "MEDIUM" && risk(2, 15)!.level === "LOW" && risk(2, 14)!.level === "MEDIUM", "P50 fits but P85 (15 more days) does not -> MEDIUM; fits both -> LOW (boundary at 15 days left)");
  ok(group, risk(2, 0)!.level === "HIGH" && risk(20, 0)!.level === "LOW", "due today: HIGH when work typically remains, LOW when the ticket is already past P85");
  ok(group, risk(5, -1)!.level === "HIGH" && risk(30, -3)!.level === "HIGH" && risk(30, -3)!.explanation.includes("overdue by 3 day"), "overdue is always HIGH");
  ok(group, /n = 20/.test(risk(2, 3)!.explanation) && /P50/.test(risk(2, 3)!.explanation) && risk(2, 3)!.n === 20, "the explanation carries the numbers and n");
}

{
  const group = "P3.4 Release forecast";
  // 12 tickets resolved over the last 8 weeks (1.5/week), 6 still open in version R1.
  const resolved = Array.from({ length: 12 }, (_, i) => done(`R-${i}`, 5, 2 + i * 4, { fixVersion: "R1" }));
  const open = Array.from({ length: 6 }, (_, i) => wi(`O-${i}`, { fixVersion: "R1", dueDate: i === 0 ? addDays(today, 30) : undefined }));
  const data = { ...emptyData(), workItems: [...resolved, ...open] } as CommandCenterData;
  const rel = [...resolved, ...open];
  const f1 = forecastRelease(data, "R1", rel, today);
  const f2 = forecastRelease(data, "R1", rel, today);
  ok(group, JSON.stringify(f1) === JSON.stringify(f2) && f1.status === "OK", "deterministic: the same inputs give the same forecast (seeded PRNG)");
  if (f1.status === "OK") {
    ok(group, f1.remaining === 6 && f1.n === 12 && f1.weeklyThroughput === 1.5 && f1.p50Date <= f1.p85Date && f1.p50Date > today, `P50 ${f1.p50Date} <= P85 ${f1.p85Date}, remaining 6, n 12, 1.5/week`);
    ok(group, f1.targetDate === addDays(today, 30) && f1.targetSource === "latest-due-date" && f1.probabilityByTarget !== undefined && f1.probabilityByTarget >= 0 && f1.probabilityByTarget <= 1, `target = latest due date; probability by target ${f1.probabilityByTarget}`);
    const withRelease = forecastRelease({ ...data, projects: [{ id: "p-1", name: "P", clientId: "c", status: "on-track", releaseDate: addDays(today, 90) }] }, "R1", rel, today);
    ok(group, withRelease.status === "OK" && withRelease.targetSource === "release-date" && withRelease.targetDate === addDays(today, 90) && (withRelease.probabilityByTarget ?? 0) >= (f1.probabilityByTarget ?? 1), "a user-entered release date wins over the latest due date, and a later target is at least as likely");
    const tight = forecastRelease({ ...data, projects: [{ id: "p-1", name: "P", clientId: "c", status: "on-track", releaseDate: addDays(today, 1) }] }, "R1", rel, today);
    ok(group, tight.status === "OK" && (tight.probabilityByTarget ?? 1) < 0.1, "a target tomorrow for six remaining tickets is very unlikely");
  }
  ok(group, forecastRelease(data, "R1", resolved, today).status === "DONE", "nothing open -> DONE");
  const sparse = { ...emptyData(), workItems: [...resolved.slice(0, 5), ...open] } as CommandCenterData;
  const u = forecastRelease(sparse, "R1", [...resolved.slice(0, 5), ...open], today);
  ok(group, u.status === "UNKNOWN" && u.n === 5 && u.remaining === 6 && u.reason === "insufficient history", "fewer than 8 resolved tickets in the 8 weeks -> UNKNOWN, not a guess");
  const weeks = weeklyThroughput([done("W-1", 1, 0), done("W-2", 1, 6), done("W-3", 1, 7), done("W-4", 1, 55), done("W-5", 1, 56)], new Set(["p-1"]), today);
  ok(group, weeks.length === 8 && weeks[7] === 2 && weeks[6] === 1 && weeks[0] === 1 && weeks.reduce((a, b) => a + b, 0) === 4, `weekly buckets: this week 2, last week 1, oldest 1, nothing older than 8 weeks (${weeks.join(",")})`);
  const r1 = seededRandom(hashSeed("x")), r2 = seededRandom(hashSeed("x")), r3 = seededRandom(hashSeed("y"));
  ok(group, r1() === r2() && r1() === r2() && r3() !== seededRandom(hashSeed("x"))(), "the seeded PRNG is reproducible and seed-dependent");
}

{
  const group = "P3.4 Risk rule forecast-slip";
  const history = Array.from({ length: 12 }, (_, i) => done(`H-${i}`, 10, 3 + i * 2));
  const slipper = wi("S-1", { createdDate: addDays(today, -2), dueDate: addDays(today, 3) }); // needs ~8 more days, has 3
  const fine = wi("S-2", { createdDate: addDays(today, -2), dueDate: addDays(today, 30) });
  const data1 = { ...emptyData(), workItems: [...history, slipper, fine] } as CommandCenterData;
  const risks1 = detectRisks(data1, today).filter((r) => r.ruleId === "forecast-slip");
  ok(group, risks1.length === 1 && risks1[0].sourceWorkItemIds[0] === "jira-S-1" && risks1[0].identityKey === "jira-S-1" && risks1[0].reason.startsWith("Forecast:") && /n = 12/.test(risks1[0].reason), "one forecast-slip risk for the ticket that cannot make its date, with n in the reason");
  const data2 = { ...emptyData(), workItems: [...history, { ...slipper }, fine] } as CommandCenterData; // a fresh sync: new objects, same ticket
  const risks2 = detectRisks(data2, today).filter((r) => r.ruleId === "forecast-slip");
  ok(group, riskFingerprint(risks1[0]) === riskFingerprint(risks2[0]) && dedupeRisks(risks1, risks2).filter((r) => r.ruleId === "forecast-slip").length === 1, "same fingerprint across syncs -> deduped to one risk");
  const resolvedData = { ...emptyData(), workItems: [...history, { ...slipper, status: "Done" as const, resolvedAt: `${today}T08:00:00.000Z` }, fine] } as CommandCenterData;
  ok(group, detectRisks(resolvedData, today).filter((r) => r.ruleId === "forecast-slip").length === 0, "the risk is gone once the ticket is Done");
  const noHistory = { ...emptyData(), workItems: [slipper] } as CommandCenterData;
  ok(group, detectRisks(noHistory, today).filter((r) => r.ruleId === "forecast-slip").length === 0, "no history -> no forecast risk (nothing is guessed)");
  ok(group, detectRisks({ ...emptyData(), workItems: [...history, wi("S-3", { createdDate: addDays(today, -2) })] } as CommandCenterData, today).every((r) => r.ruleId !== "forecast-slip"), "no due date -> no forecast risk");
  const overdue = detectRisks({ ...emptyData(), workItems: [...history, wi("S-4", { createdDate: addDays(today, -2), dueDate: addDays(today, -2) })] } as CommandCenterData, today).find((r) => r.ruleId === "forecast-slip");
  ok(group, overdue?.level === "HIGH", "an already overdue ticket gets a HIGH forecast risk");
}

{
  const group = "P3.4 Bundle, flags and wording";
  const history = Array.from({ length: 12 }, (_, i) => done(`H-${i}`, 10, 3 + i * 2, { fixVersion: "V9" }));
  const old = wi("OLD-1", { createdDate: addDays(today, -60), fixVersion: "V9", dueDate: addDays(today, 5) });
  const data = { ...emptyData(), workItems: [...history, old, wi("NEW-1", { createdDate: addDays(today, -1) })] } as CommandCenterData;
  const fc = computeForecast(data, today);
  ok(group, computeForecast(data, today) === fc && fc.resolvedSamples === 12, "the bundle is memoised per dataset and counts its resolved samples");
  const flags = forecastFlags(fc.byTicket.get("OLD-1"));
  ok(group, flags.agingFlag && !flags.slipHigh && !forecastFlags(fc.byTicket.get("NEW-1")).agingFlag && !forecastFlags(undefined).slipHigh, "a ticket older than P85 is aging-flagged (its expected remaining time is 0, so it is not a slip risk by the max(0, P50 - age) rule); a fresh one is not");
  const slipData = { ...emptyData(), workItems: [...history, wi("SLIP-1", { createdDate: addDays(today, -2), dueDate: addDays(today, 3) })] } as CommandCenterData;
  ok(group, forecastFlags(computeForecast(slipData, today).byTicket.get("SLIP-1")).slipHigh && !forecastFlags(computeForecast(slipData, today).byTicket.get("SLIP-1")).agingFlag, "a young ticket that cannot make its date is slip-flagged but not aging-flagged");
  const rel = fc.releases.find((r) => r.fixVersion === "V9")!;
  const text = describeReleaseForecast(rel);
  ok(group, /n = \d+/.test(text) && (rel.status === "OK" ? /P50/.test(text) && /P85/.test(text) : /insufficient history/.test(text)), `a release line always carries n: "${text.slice(0, 90)}…"`);
  ok(group, /insufficient history/.test(describeReleaseForecast({ status: "UNKNOWN", fixVersion: "X", remaining: 4, n: 3, reason: "insufficient history" })) && !/0%|NaN|undefined/.test(describeReleaseForecast({ status: "UNKNOWN", fixVersion: "X", remaining: 4, n: 3, reason: "insufficient history" })), "UNKNOWN reads 'insufficient history', never zero or a default");
  ok(group, /insufficient history/.test(weeklyForecastLine({ byTicket: new Map(), resolvedSamples: 3, leadTime: fc.leadTime })) && /1 open ticket\(s\) are older than 85%/.test(weeklyForecastLine(fc)) && /n = 12/.test(weeklyForecastLine(fc)), "the Weekly Review line: insufficient history, or the counts with n");
}

{
  const group = "P3.4 Integration and state";
  const ui = read("src/components/command-center/ForecastCard.tsx");
  ok(group, /TrustLabel kind="forecast"/.test(ui) && /FORECAST_CAVEAT/.test(ui) && /first sync is limited to the last 90 days/.test(ui), "labelled FORECAST, with the 'only synced issues exist' caveat");
  ok(group, /<ForecastCard \/>/.test(read("src/components/command-center/ExecutiveView.tsx")) && /<ReleaseForecastLine fixVersion=/.test(read("src/components/command-center/ReleaseHealthPanel.tsx")) && /<ForecastChip ticketKey=\{key\} \/>/.test(read("src/components/command-center/TaskReferenceRow.tsx")) && /<WeeklyForecastLine \/>/.test(read("src/app/weekly-review/page.tsx")), "mounted: Executive view, Release Health, ticket rows, Weekly Review (no new nav page)");
  ok(group, !/forecast/i.test(read("src/lib/command-center/store.ts").replace(/\/\/[^\n]*/g, "")), "no new persisted state: the store has no forecast field");
  const stored = parseStoredState(JSON.stringify({ schemaVersion: 1, data: emptyData(), snapshotHistory: [], dataSource: "jira" }));
  ok(group, stored.loaded !== undefined && !("forecast" in stored), "an old stored state loads unchanged");
}

{
  const group = "P3.4 Performance";
  const items: WorkItem[] = [];
  for (let i = 0; i < 3000; i++) {
    const p = `p-${i % 30}`;
    items.push(i % 3 === 0 ? done(`T-${i}`, 3 + (i % 25), i % 80, { projectId: p, type: (["task", "bug"] as const)[i % 2], fixVersion: `V${i % 10}` }) : wi(`T-${i}`, { projectId: p, type: (["task", "bug"] as const)[i % 2], fixVersion: `V${i % 10}`, createdDate: addDays(today, -(i % 70)), dueDate: i % 4 === 0 ? addDays(today, (i % 20) - 5) : undefined }));
  }
  const data = { ...emptyData(), workItems: items } as CommandCenterData;
  const t0 = performance.now();
  const fc = computeForecast(data, today);
  const ms = performance.now() - t0;
  ok(group, fc.resolvedSamples > 500 && fc.byTicket.size > 500 && ms <= perfBudget(100), `the whole forecast layer on 3,000 tickets: ${ms.toFixed(1)} ms (budget ${perfBudget(100)} ms, ${fc.resolvedSamples} resolved samples, ${fc.releases.length} releases)`);
  const t1 = performance.now();
  detectRisks({ ...data }, today);
  ok(group, performance.now() - t1 <= perfBudget(400), "the risk engine with the new rule stays within its budget");
}
