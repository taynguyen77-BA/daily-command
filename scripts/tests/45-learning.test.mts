// P3.3 — personal learning loop: appearances/outcomes, deltas, decay, hard rules, shadow/on modes, reset, state.
import fs from "node:fs";
import path from "node:path";
import { collectAppearances, computeLearnedAdjustments, groupKeyOf, learnedDeltaFor, learningMoves, shouldProposeLearningOn, signalKindForTicket, signalKindOfPlanItem, LEARN_MAX_DELTA, LEARN_MIN_SAMPLES, type Appearance, type LearnedAdjustment } from "../../src/lib/command-center/learned-adjustments";
import { buildScoringOptions } from "../../src/lib/command-center/scoring-context";
import { scoreAllWorkItems, scoreWorkItem, type ScoringOptions } from "../../src/lib/command-center/scoring";
import { parseStoredState } from "../../src/lib/command-center/store";
import { emptyData, type PersonalPlanItem, type TicketWorkState, type WorkItem } from "../../src/lib/command-center/types";
import { buildPerfData } from "./perf-fixture.mts";
import { ok } from "./harness.mts";
import { v226Store } from "./helpers.mts";

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const today = "2026-10-27"; // Tuesday
const wi = (key: string, over: Partial<WorkItem> = {}): WorkItem => ({ id: `jira-${key}`, key, title: "t", projectId: "p-1", clientId: "c", type: "task", status: "In Progress", priority: "P2", createdDate: "2026-09-01", lastUpdated: today, blocked: false, dependencyIds: [], riskIds: [], scopeChangeCount: 0, owner: "Tay", ownerId: "acc-me", ...over }) as WorkItem;
const plan = (key: string, plannedDate: string, sourceId = "STALE:x"): Pick<PersonalPlanItem, "ticketKey" | "plannedDate" | "sourceType" | "sourceId"> => ({ ticketKey: key, plannedDate, sourceType: "attention", sourceId });
const hist = (...t: { to: TicketWorkState["status"]; at: string; reason?: string }[]): Pick<TicketWorkState, "history"> => ({ history: t.map((x) => ({ from: "TODO" as const, to: x.to, at: x.at, ...(x.reason ? { reason: x.reason } : {}), surface: "my-work" as const })) });

{
  const group = "P3.3 Appearances and outcomes";
  const items = [wi("A-1"), wi("A-2"), wi("A-3"), wi("A-4"), wi("A-5"), wi("A-6"), wi("A-7")];
  const date = "2026-10-20"; // Tuesday; the 2-business-day window ends Thursday 10-22
  const states: Record<string, Pick<TicketWorkState, "history">> = {
    "A-1": hist({ to: "DONE", at: "2026-10-21T10:00:00.000Z" }),
    "A-2": hist({ to: "IN_PROGRESS", at: "2026-10-22T10:00:00.000Z" }),
    "A-3": hist({ to: "BLOCKED", at: "2026-10-21T10:00:00.000Z", reason: "waiting on API" }),
    "A-4": hist({ to: "BLOCKED", at: "2026-10-21T10:00:00.000Z" }),
    "A-5": hist({ to: "SKIPPED", at: "2026-10-21T10:00:00.000Z", reason: "later" }),
    "A-6": hist({ to: "DONE", at: "2026-10-23T10:00:00.000Z" }), // a day too late
  };
  const a = collectAppearances({ today, planItems: items.map((i) => plan(i.key, date)), ticketWorkStates: states, workItems: items });
  const out = (k: string) => a.find((x) => x.ticketKey === k)?.outcome;
  ok(group, out("A-1") === "acted" && out("A-2") === "acted" && out("A-3") === "acted", "DONE, IN_PROGRESS and BLOCKED with a real reason within 2 business days = acted on");
  ok(group, out("A-4") === "ignored" && out("A-5") === "ignored" && out("A-6") === "ignored" && out("A-7") === "ignored", "BLOCKED without a reason, skipped, acted too late, or nothing after the window = ignored");
  const recent = collectAppearances({ today, planItems: [plan("A-7", "2026-10-26")], ticketWorkStates: {}, workItems: items });
  ok(group, recent[0].outcome === "pending", "planned yesterday and nothing yet: still pending (not counted either way)");
  ok(group, collectAppearances({ today, planItems: [plan("A-1", "2026-08-01")], ticketWorkStates: {}, workItems: items }).length === 0 && collectAppearances({ today, planItems: [plan("A-1", "2026-11-05")], ticketWorkStates: {}, workItems: items }).length === 0, "only the last 45 days; nothing from the future");
  ok(group, collectAppearances({ today, planItems: [plan("A-1", "2026-10-10")], ticketWorkStates: {}, workItems: items, resetAt: "2026-10-15" }).length === 0, "history before a reset is ignored");
  ok(group, collectAppearances({ today, planItems: [plan("A-1", date), plan("A-1", date), plan("NOPE-1", date)], ticketWorkStates: {}, workItems: items }).length === 1, "a ticket planned twice for one day counts once; an unknown ticket is skipped");
  ok(group, a[0].projectLabel === "A" && a[0].kind === "OTHER" && signalKindOfPlanItem({ sourceType: "attention", sourceId: "MENTION:jpmc-1:c1" }) === "MENTION" && signalKindOfPlanItem({ sourceType: "loop", sourceId: "x" }) === "OTHER", "group dimensions: project label from the key, kind MENTION/OTHER");
}

// Seeded history: group X (P2 task, project X) is always skipped, group Y (project Y) is always acted on.
function seeded(nX: number, nY: number, newestDay = "2026-10-20", spread = 20) {
  const items: WorkItem[] = [];
  const planItems: ReturnType<typeof plan>[] = [];
  const states: Record<string, Pick<TicketWorkState, "history">> = {};
  const addDay = (n: number) => { const d = new Date(newestDay + "T00:00:00"); d.setDate(d.getDate() - n); while ([0, 6].includes(d.getDay())) d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  for (let i = 0; i < nX; i++) { const k = `XX-${i}`; items.push(wi(k, { projectId: "p-x" })); const day = addDay(i % spread); planItems.push(plan(k, day)); states[k] = hist({ to: "SKIPPED", at: `${day}T09:00:00.000Z` }); }
  for (let i = 0; i < nY; i++) { const k = `YY-${i}`; items.push(wi(k, { projectId: "p-y" })); const day = addDay(i % spread); planItems.push(plan(k, day)); states[k] = hist({ to: "DONE", at: `${day}T09:00:00.000Z` }); }
  return { items, planItems, states };
}

{
  const group = "P3.3 Deltas";
  const s = seeded(12, 12);
  const app = collectAppearances({ today, planItems: s.planItems, ticketWorkStates: s.states, workItems: s.items });
  const adj = computeLearnedAdjustments(app, today);
  const gx = adj.find((a) => a.projectId === "p-x")!, gy = adj.find((a) => a.projectId === "p-y")!;
  ok(group, adj.length === 2 && gx.n === 12 && gy.n === 12, `two groups with n=12 each (${adj.length})`);
  ok(group, gx.delta === -4 && gy.delta === 4 && gx.rate === 0 && gy.rate === 1 && Math.abs(gx.overallRate - 0.5) < 0.05, `skipped group lowered by round(8 x (0 - 0.5)) = -4, always-acted group raised by +4 (got ${gx.delta} / ${gy.delta})`);
  ok(group, adj.every((a) => Math.abs(a.delta) <= LEARN_MAX_DELTA), "|delta| <= 8");
  ok(group, gx.evidence.includes("n=12") && gx.evidence.includes("acted on 0 of 12") && gy.evidence.includes("acted on 12 of 12") && gy.evidence.includes("n=12"), "the evidence names the count and the sample size");
  ok(group, JSON.stringify(adj) === JSON.stringify(computeLearnedAdjustments(app, today)) && JSON.stringify(computeLearnedAdjustments([...app].reverse(), today).map((a) => a.groupKey).sort()) === JSON.stringify(adj.map((a) => a.groupKey).sort()), "deterministic: same inputs -> same deltas (no clock inside)");

  const few = seeded(5, 20);
  const fewAdj = computeLearnedAdjustments(collectAppearances({ today, planItems: few.planItems, ticketWorkStates: few.states, workItems: few.items }), today);
  ok(group, !fewAdj.some((a) => a.projectId === "p-x") && fewAdj.some((a) => a.projectId === "p-y") && LEARN_MIN_SAMPLES === 6, "n < 6 -> no adjustment for that group (n=5), n >= 6 still adjusts");
  const six = seeded(6, 20);
  ok(group, computeLearnedAdjustments(collectAppearances({ today, planItems: six.planItems, ticketWorkStates: six.states, workItems: six.items }), today).some((a) => a.projectId === "p-x"), "exactly n = 6 is enough");

  // decay: newest sample older than 30 days halves the effect
  const old = seeded(12, 12, "2026-09-18", 6);
  const oldAdj = computeLearnedAdjustments(collectAppearances({ today: "2026-10-22", planItems: old.planItems, ticketWorkStates: old.states, workItems: old.items }), "2026-10-22");
  const ox = oldAdj.find((a) => a.projectId === "p-x");
  ok(group, !!ox && ox.decayed && ox.rawDelta !== 0 && Math.abs(ox.delta) === Math.round(Math.abs(ox.rawDelta) / 2), `a delta whose newest sample is > 30 days old is halved (raw ${ox?.rawDelta} -> ${ox?.delta})`);
  ok(group, !gx.decayed && gx.delta === gx.rawDelta, "a recent group is not decayed");

  const moves = learningMoves(adj, 3);
  ok(group, moves.raised.length === 1 && moves.raised[0].projectId === "p-y" && moves.lowered.length === 1 && moves.lowered[0].projectId === "p-x", "the weekly list shows both what moved up and what moved down");
  ok(group, shouldProposeLearningOn("shadow", "2026-10-10", adj, today) && !shouldProposeLearningOn("shadow", "2026-10-20", adj, today) && !shouldProposeLearningOn("on", "2026-09-01", adj, today) && !shouldProposeLearningOn("shadow", "2026-09-01", [], today) && !shouldProposeLearningOn("shadow", undefined, adj, today), "the weekly proposal needs shadow mode, 14+ days of it, and something to show");
}

{
  const group = "P3.3 Hard rules win";
  const adj = (delta: number): LearnedAdjustment => ({ groupKey: groupKeyOf({ projectId: "p-1", issueType: "task", priority: "P2", kind: "OTHER" }), projectId: "p-1", projectLabel: "A", issueType: "task", priority: "P2", kind: "OTHER", n: 10, acted: 1, rate: 0.1, overallRate: 0.5, rawDelta: delta, delta, decayed: false, newestSample: today, evidence: "E n=10" });
  const base = wi("A-1");
  const look = (over: Partial<WorkItem>, delta = -4, awaitingMe?: { sinceIso: string; count: number }) => learnedDeltaFor({ ...base, ...over }, "OTHER", [adj(delta)], { today, awaitingMe });
  ok(group, look({}).delta === -4 && look({}).exemptBecause === undefined, "a plain ticket gets the negative delta");
  ok(group, look({ dueDate: "2026-10-26" }).delta === 0 && look({ dueDate: "2026-10-26" }).exemptBecause === "overdue", "overdue is never lowered");
  ok(group, look({ blocked: true }).delta === 0 && look({ blocked: true }).exemptBecause === "blocked", "blocked is never lowered");
  ok(group, look({ priority: "P1" }, -4).delta === 0, "a P1 ticket is never lowered (it simply is not in this group, and a P1 group's negative delta is refused)");
  const p1 = learnedDeltaFor({ ...base, priority: "P1" }, "OTHER", [{ ...adj(-4), priority: "P1", groupKey: groupKeyOf({ projectId: "p-1", issueType: "task", priority: "P1", kind: "OTHER" }) }], { today });
  ok(group, p1.delta === 0 && p1.exemptBecause === "P1", "…the exemption reason is P1");
  ok(group, look({}, -4, { sinceIso: "2026-10-15", count: 1 }).exemptBecause === "awaiting-you-past-SLA" && look({}, -4, { sinceIso: "2026-10-26", count: 1 }).delta === -4, "waiting on your reply past the SLA is never lowered; within the SLA it can be");
  ok(group, look({ dueDate: "2026-10-26", blocked: true, priority: "P2" }, +4).delta === 4, "a POSITIVE delta always applies, exemptions or not");
  ok(group, learnedDeltaFor(base, "OTHER", [], { today }).delta === 0 && learnedDeltaFor(base, "MENTION", [adj(-4)], { today }).delta === 0, "no adjustment for the group (or another kind) -> 0");
  ok(group, signalKindForTicket("A-1", { "A-1": { sinceIso: "2026-10-26", count: 1 } }) === "MENTION" && signalKindForTicket("A-2", {}) === "OTHER", "kind at scoring time: waiting on my reply = MENTION, else OTHER");
}

{
  const group = "P3.3 Shadow, on, off";
  const s = seeded(12, 12);
  const adjAll = computeLearnedAdjustments(collectAppearances({ today, planItems: s.planItems, ticketWorkStates: s.states, workItems: s.items }), today);
  const dataset = { ...emptyData(), workItems: s.items };
  const score = (learned?: ScoringOptions["learned"]) => scoreAllWorkItems(dataset, today, undefined, undefined, { model: "v2", ...(learned ? { learned } : {}) });
  const off = score();
  const offMode = score({ mode: "off", adjustments: adjAll });
  const shadow = score({ mode: "shadow", adjustments: adjAll });
  const on = score({ mode: "on", adjustments: adjAll });
  const brief = (r: typeof off) => r.map((x) => `${x.itemId}:${x.score}`).join(",");
  ok(group, brief(off) === brief(offMode), "mode off = no learning at all");
  ok(group, brief(off) === brief(shadow) && JSON.stringify(off.map((r) => r.factors)) === JSON.stringify(shadow.map((r) => r.factors)), "shadow: scores, order and factors are byte-identical to off");
  const sh = shadow.find((r) => r.itemId === "jira-XX-0")!;
  ok(group, sh.learnedShadow?.delta === -4 && sh.learnedShadow.detail.includes("n=12") && shadow.find((r) => r.itemId === "jira-YY-0")!.learnedShadow?.delta === 4 && off.every((r) => r.learnedShadow === undefined), "shadow exposes what learning WOULD do (with evidence and n) without changing anything");
  const onX = on.find((r) => r.itemId === "jira-XX-0")!, offX = off.find((r) => r.itemId === "jira-XX-0")!;
  const onY = on.find((r) => r.itemId === "jira-YY-0")!, offY = off.find((r) => r.itemId === "jira-YY-0")!;
  ok(group, onX.score === offX.score - 4 && onY.score === offY.score + 4, `on: the skipped group is lowered by the expected -4, the always-acted group raised by +4 (${offX.score}→${onX.score}, ${offY.score}→${onY.score})`);
  const lf = onX.factors.find((f) => f.name === "Learned (you)");
  ok(group, !!lf && lf.trust === "LEARNED" && lf.max === 8 && lf.contribution === -4 && lf.detail.includes("n=12"), "the factor is labelled LEARNED, max 8, with evidence and sample size");
  ok(group, !onX.reasoning.includes("acted on"), "the reasoning text names ordinary factors, not the learned one");
  const v1 = scoreWorkItem(s.items[0], dataset, today, { model: "v1", learned: { mode: "on", adjustments: adjAll } });
  ok(group, !v1.factors.some((f) => f.name === "Learned (you)"), "learning only applies to model v2");
  // hard rules inside the real scorer
  const overdue = wi("XX-0", { projectId: "p-x", dueDate: "2026-10-20" });
  const r = scoreWorkItem(overdue, { ...emptyData(), workItems: [overdue] }, today, { model: "v2", learned: { mode: "on", adjustments: adjAll } });
  ok(group, !r.factors.some((f) => f.name === "Learned (you)"), "an overdue ticket in a 'skipped' group is not lowered by the scorer");

  // through the real state -> options path, including Reset
  const st = { scoringModel: "v2" as const, learnedPriority: "on" as const, personalPlan: s.planItems.map((p, i) => ({ id: `pl-${i}`, ...p, priority: 1, position: i, status: "planned", estimatedMinutes: 30, addedAt: p.plannedDate })) as unknown as PersonalPlanItem[], ticketWorkStates: s.states as unknown as Record<string, TicketWorkState>, data: { workItems: s.items } };
  const o1 = buildScoringOptions(st, [], today);
  ok(group, o1.learned?.mode === "on" && o1.learned.adjustments.length === 2, "buildScoringOptions derives the adjustments from the plan + ticket history");
  const afterReset = buildScoringOptions({ ...st, learningResetAt: today }, [], today);
  ok(group, (afterReset.learned?.adjustments.length ?? 0) === 0, "after Reset learning there are no adjustments, so scores return to their un-learned values");
  const sameAsOff = scoreAllWorkItems(dataset, today, undefined, undefined, afterReset).map((x) => x.score).join() === scoreAllWorkItems(dataset, today, undefined, undefined, { model: "v2" }).map((x) => x.score).join();
  ok(group, sameAsOff, "…exactly the values without learning");
  ok(group, buildScoringOptions({ ...st, learnedPriority: "off" }, [], today).learned === undefined && buildScoringOptions({ ...st, scoringModel: "v1" }, [], today).learned === undefined, "off, or model v1: no learned options at all");
  const shadowByDefault = buildScoringOptions({ ...st, learnedPriority: undefined }, [], today);
  ok(group, shadowByDefault.learned?.mode === "shadow", "an absent setting means shadow");

  // 3,000-item fixture: shadow rankings identical to off
  const { data } = buildPerfData(today);
  const groups = new Map<string, WorkItem>();
  for (const w of data.workItems) groups.set(groupKeyOf({ projectId: w.projectId, issueType: w.type, priority: w.priority, kind: "OTHER" }), w);
  const fake: LearnedAdjustment[] = Array.from(groups.entries()).slice(0, 40).map(([k, w], i) => ({ groupKey: k, projectId: w.projectId, projectLabel: "P", issueType: w.type, priority: w.priority, kind: "OTHER" as const, n: 10, acted: 5, rate: 0.5, overallRate: 0.5, rawDelta: i % 2 ? 5 : -5, delta: i % 2 ? 5 : -5, decayed: false, newestSample: today, evidence: "fixture n=10" }));
  const big = (mode: "off" | "shadow") => scoreAllWorkItems(data, today, undefined, undefined, { model: "v2", learned: { mode, adjustments: fake } }).map((x) => `${x.itemId}:${x.score}`).join("|");
  ok(group, big("off") === big("shadow"), "3,000-item fixture: shadow-mode rankings are identical to off");
}

{
  const group = "P3.3 State, store and UI";
  const old = JSON.stringify({ schemaVersion: 1, data: emptyData(), snapshotHistory: [], dataSource: "jira" });
  const p = parseStoredState(old);
  ok(group, p.learnedPriority === "shadow" && !!p.learnedShadowSince && p.learningResetAt === undefined, "old state without the fields loads as shadow");
  ok(group, parseStoredState(JSON.stringify({ ...JSON.parse(old), learnedPriority: "on", learningResetAt: "2026-10-01" })).learnedPriority === "on" && parseStoredState(JSON.stringify({ ...JSON.parse(old), learnedPriority: "bogus" })).learnedPriority === "shadow", "the mode persists across reload; a bogus value falls back to shadow");
  const { store } = v226Store();
  store.setLearnedPriority("on");
  ok(group, store.getSnapshot().learnedPriority === "on", "setLearnedPriority(on)");
  store.setLearnedPriority("shadow");
  ok(group, store.getSnapshot().learnedPriority === "shadow" && !!store.getSnapshot().learnedShadowSince, "going back to shadow restarts the 14-day clock");
  store.setLearnedPriority("bogus" as never);
  ok(group, store.getSnapshot().learnedPriority === "shadow", "an invalid mode is ignored");
  store.resetLearning();
  const after = store.getSnapshot();
  ok(group, !!after.learningResetAt && after.memoryEvents.some((e) => e.kind === "LEARNING_RESET"), "Reset learning sets the reset day and records a memory event");

  // no AI, no network
  const files = ["learned-adjustments.ts", "scoring-context.ts"].map((f) => read(`src/lib/command-center/${f}`));
  ok(group, files.every((f) => !/\bfetch\(|from "\.\/ai|getAIProvider|ai\/route|anthropic/i.test(f)), "the learning modules never touch AI or the network");
  const ui = ["LearningPanel", "LearningChip", "LearningWeekly"].map((f) => read(`src/components/command-center/${f}.tsx`)).join("\n");
  ok(group, !/\bfetch\(|getAIProvider|AiProvider/.test(ui) && /store\.resetLearning/.test(ui) && /Export JSON/.test(ui) && /Reset learning/.test(ui), "the panel, chip and weekly cards make no AI/network call; the panel has Reset and Export");
  ok(group, /<LearningPanel \/>/.test(read("src/app/data-settings/page.tsx")) && /<LearningWeekly \/>/.test(read("src/app/weekly-review/page.tsx")) && /<LearningChip ticketKey=\{key\} \/>/.test(read("src/components/command-center/TaskReferenceRow.tsx")), "mounted: Data & Settings, Weekly Review, ticket rows");
  ok(group, /TrustLabel kind="learned"/.test(read("src/components/command-center/LearningPanel.tsx")) && /n=\{look\.adjustment\.n\}/.test(read("src/components/command-center/LearningChip.tsx")), "labelled LEARNED; the chip shows its sample size");
  ok(group, read("src/app/data-settings/page.tsx").split("\n").length < 2010, "data-settings/page.tsx only gained mount lines");
}
