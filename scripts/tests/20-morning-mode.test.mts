// F1 — Morning Mode (toggle, default on) and Command Center compact mode.
// Run through scripts/tests/run.mts (npm test).

import fs from "node:fs";
import path from "node:path";
import { CommandCenterStore, getTodayIso, parseStoredState } from "../../src/lib/command-center/store";
import { createMemoryStateStorage } from "../../src/lib/command-center/state-persistence";
import { addDays } from "../../src/lib/command-center/date-utils";
import { DEFAULT_FEATURE_TOGGLES, type TicketWorkState } from "../../src/lib/command-center/types";
import {
  applyMorningTriage,
  applyRecheck,
  dueRechecks,
  MORNING_MODE_LANDING,
  MORNING_STEPS,
  morningKeyCommand,
  nextMorningStep,
  planAgainstBudget,
  reorderIds,
  shouldOpenMorningMode,
  triageDoneLabel,
} from "../../src/lib/command-center/morning-mode";
import { myWorkViewOf } from "../../src/lib/command-center/my-work";
import { ok } from "./harness.mts";
import { v226Actionable, v226ConfiguredStore, v226Tick } from "./helpers.mts";

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");

// ----- The flow and the keys -----
{
  const group = "F1 Morning Mode flow";
  ok(group, MORNING_STEPS.map((s) => s.id).join() === "sync,triage,rechecks,plan,start", "five steps: sync → triage New → due re-checks → today's plan → start");
  ok(group, nextMorningStep("sync") === "triage" && nextMorningStep("start") === null, "steps advance in order and end at Start");
  const rows = ["A-1", "A-2", "A-3"];
  const k = (key: string, sel = 1, mod = {}) => morningKeyCommand(key, rows, sel, mod);
  ok(group, JSON.stringify([k("d"), k("D"), k("b"), k("s"), k("f"), k("Enter")].map((c) => c.kind)) === JSON.stringify(["done", "done", "block", "skip", "defer", "keep"]), "one key per action: D done, B block, S skip, F defer, Enter keep for today");
  ok(group, (k("d") as { ticketKey: string }).ticketKey === "A-2", "the action applies to the selected row");
  ok(group, (k("j") as { index: number }).index === 2 && (k("ArrowUp") as { index: number }).index === 0 && (k("j", 2) as { index: number }).index === 2, "J/K and ↓/↑ move, clamped to the list");
  ok(group, k("d", 1, { inTextField: true }).kind === "none" && k("d", 1, { meta: true }).kind === "none" && morningKeyCommand("d", [], 0).kind === "none", "never fires while typing, with a modifier, or with nothing to triage");
  ok(group, k("x").kind === "none", "other keys do nothing");
}

// ----- Keys drive the real store actions (same as TaskRow) and each row leaves New -----
{
  const group = "F1 Morning Mode triage";
  const today = getTodayIso();
  const { store, setJira } = v226ConfiguredStore({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [] });
  setJira(["MM-1", "MM-2", "MM-3", "MM-4", "MM-5"].map((key) => v226Actionable(key)));
  await store.syncJira();
  const newBefore = store.computeMyWork().views.new.map((r) => r.ticketKey).sort();
  ok(group, newBefore.join() === "MM-1,MM-2,MM-3,MM-4,MM-5", `sanity: the synced tickets are in New (${newBefore.join()})`);
  (["done", "block", "skip", "defer", "keep"] as const).forEach((a, i) => applyMorningTriage(store, a, `MM-${i + 1}`, today));
  await v226Tick();
  const st = store.getSnapshot().ticketWorkStates;
  ok(group, st["MM-1"].status === "DONE" && st["MM-2"].status === "BLOCKED" && st["MM-3"].status === "SKIPPED" && st["MM-4"].status === "DEFERRED", "D/B/S/F set DONE / BLOCKED / SKIPPED / DEFERRED on the ticket");
  ok(group, st["MM-4"].until === addDays(today, 1), "F defers to tomorrow");
  ok(group, !st["MM-5"] || st["MM-5"].status === "TODO", "Enter keeps the ticket as it is (TODO)");
  const work = store.computeMyWork();
  ok(group, work.views.new.length === 0, "every handled row has left New");
  ok(group, myWorkViewOf(work, "MM-5") === "today" && myWorkViewOf(work, "MM-1") === "done" && myWorkViewOf(work, "MM-2") === "blocked" && myWorkViewOf(work, "MM-4") === "skipped", "…and sits in the matching My Work view (kept → Today)");
  ok(group, ["MM-1", "MM-2", "MM-3", "MM-4"].every((key) => st[key].history.at(-1)?.surface === "my-work"), "recorded from My Work in each ticket's history");
}

// ----- Step 3: due re-checks -----
{
  const group = "F1 Morning Mode re-checks";
  const today = "2026-10-07";
  const r = (ticketKey: string, status: TicketWorkState["status"], until?: string): TicketWorkState => ({ ticketKey, status, updatedAt: "2026-10-01T09:00:00.000Z", history: [], ...(until ? { until } : {}) });
  const states = {
    S1: r("S1", "SKIPPED", "2026-10-07"),
    S2: r("S2", "SKIPPED", "2026-10-09"),
    B1: r("B1", "BLOCKED", "2026-10-05"),
    D1: r("D1", "DEFERRED", "2026-10-07"),
    D2: r("D2", "DEFERRED", "2026-10-08"),
    T1: r("T1", "TODO", "2026-10-01"),
    N1: r("N1", "SKIPPED"),
  };
  const due = dueRechecks(states, today);
  ok(group, due.map((d) => d.ticketKey).join() === "B1,D1,S1", `skipped/blocked with a re-check date that has come, and deferrals whose date arrived — oldest first (${due.map((d) => d.ticketKey).join()})`);
  const calls: string[] = [];
  const fake = { reactivateSkippedTicket: (k: string) => calls.push(`reactivate:${k}`), unblockTicketInDailyCommand: (k: string) => calls.push(`unblock:${k}`) };
  applyRecheck(fake as never, due[0], "unblock");
  applyRecheck(fake as never, due[1], "reactivate");
  applyRecheck(fake as never, due[2], "keep");
  applyRecheck(fake as never, due[0], "reactivate");
  ok(group, calls.join() === "unblock:B1,reactivate:D1", "Unblock / Back to Today call the store; Keep changes nothing; a mismatched choice is ignored");
}

// ----- Step 4: plan against the Action Plan time budget -----
{
  const group = "F1 Morning Mode plan";
  const b = planAgainstBudget([{ id: "a", estimatedMinutes: 15 }, { id: "b", estimatedMinutes: 30 }, { id: "c", estimatedMinutes: 20 }], 60);
  ok(group, b.totalMinutes === 65 && b.overByMinutes === 5 && b.fitIds.join() === "a,b", "totals the plan, shows what fits and by how much it's over");
  ok(group, reorderIds(["a", "b", "c"], "c", 0).join() === "c,a,b" && reorderIds(["a", "b", "c"], "a", 9).join() === "b,c,a" && reorderIds(["a"], "z", 0).join() === "a", "drag/up-down reorder");
  const store = new CommandCenterStore({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [], jiraSyncLockManager: null });
  store.getSnapshot();
  store.setTimeBudget(120);
  store.setTimeBudget(77 as never);
  ok(group, store.getSnapshot().timeBudgetMinutes === 120 && parseStoredState(JSON.stringify(store.getSnapshot())).timeBudgetMinutes === 120, "the Action Plan budget is persisted (an invalid value is ignored) and shared");
  const actionPlan = read("src/app/action-plan/page.tsx");
  const mm = read("src/components/command-center/MorningMode.tsx");
  ok(group, /state\.timeBudgetMinutes \?\? 30/.test(actionPlan) && /store\.setTimeBudget\(b\)/.test(actionPlan) && /state\.timeBudgetMinutes \?\? DEFAULT_BUDGET/.test(mm), "Action Plan and Morning Mode read and write the same budget");
  ok(group, /store\.reorderPersonalPlan\(today, reorderIds\(/.test(mm) && /draggable/.test(mm), "the plan step reorders today's plan (drag, or ↑/↓)");
}

// ----- Finish, "Triage done in Xm", and the landing -----
{
  const group = "F1 Morning Mode finish & landing";
  ok(group, triageDoneLabel({ startedAt: "2026-10-07T08:00:00.000Z", finishedAt: "2026-10-07T08:04:20.000Z" }) === "Triage done in 4m", "Triage done in 4m");
  ok(group, triageDoneLabel({ startedAt: "2026-10-07T08:00:00.000Z", finishedAt: "2026-10-07T08:00:10.000Z" }) === "Triage done in 1m", "under a minute rounds up to 1m");
  const store = new CommandCenterStore({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [], jiraSyncLockManager: null });
  store.getSnapshot();
  const day = "2026-10-07";
  store.recordMorningTriage({ day, startedAt: `${day}T08:00:00.000Z`, finishedAt: `${day}T08:06:00.000Z`, handled: 7 });
  store.recordMorningTriage({ day, startedAt: `${day}T10:00:00.000Z`, finishedAt: `${day}T10:01:00.000Z`, handled: 1 });
  ok(group, store.getSnapshot().morningTriage[day].handled === 7, "remembered per day — the first finish of the day is kept");
  ok(group, parseStoredState(JSON.stringify(store.getSnapshot())).morningTriage[day]?.finishedAt === `${day}T08:06:00.000Z`, "…and survives a reload");
  ok(group, DEFAULT_FEATURE_TOGGLES.morningMode === true, "the toggle defaults on");
  ok(group, shouldOpenMorningMode({ enabled: true, loaded: true, today: day, morningTriage: {} }) && !shouldOpenMorningMode({ enabled: true, loaded: true, today: day, morningTriage: store.getSnapshot().morningTriage }), "lands on Morning Mode until today's triage is done");
  ok(group, !shouldOpenMorningMode({ enabled: false, loaded: true, today: day, morningTriage: {} }) && !shouldOpenMorningMode({ enabled: true, loaded: false, today: day, morningTriage: {} }), "never when switched off or before data loads");
  const nav = read("src/components/command-center/Nav.tsx");
  ok(group, MORNING_MODE_LANDING === "/my-work?mode=morning" && /shouldOpenMorningMode\(\{ enabled: state\.features\.morningMode/.test(nav) && /router\.replace\(MORNING_MODE_LANDING\)/.test(nav), "the first open of the day (at /) lands on Morning Mode");
  const page = read("src/app/my-work/page.tsx");
  ok(group, /if \(morning && state\.features\.morningMode\)/.test(page) && /triageDoneLabel\(triageToday\)/.test(page), "My Work renders Morning Mode for ?mode=morning, and shows 'Triage done in Xm' once finished");
  const mm = read("src/components/command-center/MorningMode.tsx");
  ok(group, /store\.syncJira\(\{ trigger: "auto" \}\)/.test(mm) && /Syncing Jira… \{syncSeconds\}s/.test(mm), "step 1 syncs with visible progress");
  ok(group, /store\.startFocusItem\(first\.id, today\)/.test(mm) && /store\.recordMorningTriage\(record\)/.test(mm), "step 5 starts the first task and records the triage");
}

// ----- Command Center compact mode -----
{
  const group = "F1 Command Center compact";
  const store = new CommandCenterStore({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [], jiraSyncLockManager: null });
  store.getSnapshot();
  ok(group, store.getSnapshot().commandCenterCompact === false, "off by default");
  store.setCommandCenterCompact(true);
  ok(group, parseStoredState(JSON.stringify(store.getSnapshot())).commandCenterCompact === true, "the choice is remembered");
  const page = read("src/app/page.tsx");
  const compact = page.slice(page.indexOf("if (state.commandCenterCompact) {"), page.indexOf("return (\n    <div className=\"space-y-8 pb-16\">"));
  ok(group, /<KpiStrip/.test(compact) && /<MyWorkSummary/.test(compact) && /<ReleaseHealthPanel/.test(compact) && !/<AttentionQueuePanel|<MorningBrief |<ExecutiveView/.test(compact), "compact = KPI strip + My Work summary + Release, nothing else");
  ok(group, (page.match(/action=\{compactToggle\}/g) ?? []).length === 2, "toggled from the page header in both modes");
}

// ----- Plan step lists only what is still to do today -----
{
  const group = "F1 Morning Mode plan contents";
  const mm = fs.readFileSync(path.join(process.cwd(), "src/components/command-center/MorningMode.tsx"), "utf8");
  ok(group, /p\.plannedDate === today && \(p\.status === "planned" \|\| p\.status === "in-progress"\)/.test(mm), "deferred / blocked / skipped / done plan items are not offered as today's plan");
}
