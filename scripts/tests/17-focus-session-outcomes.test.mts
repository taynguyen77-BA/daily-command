// E2 — Focus Session never shows an outcome the store rejected.
// E3 — one reason vocabulary: Focus Session and TaskRow offer the same Block/Skip reasons;
//      Focus Session gains Defer (+date) and Skip (+reason).
// Run through scripts/tests/run.mts (npm test).

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandCenterStore, getTodayIso, parseStoredState } from "../../src/lib/command-center/store";
import { createMemoryStateStorage } from "../../src/lib/command-center/state-persistence";
import { slug } from "../../src/lib/command-center/attention-queue";
import { addDays } from "../../src/lib/command-center/date-utils";
import { ticketBucket } from "../../src/lib/command-center/ticket-work-state";
import { formatExecutionRecord, resolveTicketExecutionState } from "../../src/lib/command-center/task-execution";
import { BLOCK_REASON_SUGGESTIONS, SKIP_REASONS, type FocusSessionState } from "../../src/lib/command-center/types";
import { focusSessionHandlers, type FocusRejection, type FocusSessionUi } from "../../src/components/command-center/focus-session-handlers";
import { FocusBlockPanel, FocusDeferPanel, FocusRejectionNotice, FocusSkipPanel } from "../../src/components/command-center/FocusSession";
import { TaskReferenceRowView, storeActionsFor } from "../../src/components/command-center/TaskReferenceRow";
import { ok } from "./harness.mts";
import { v226Actionable, v226ConfiguredStore, v226Tick } from "./helpers.mts";

/** Records every UI setter call the Focus Session handlers make. */
function recordingUi() {
  const calls = { sessionStates: [] as FocusSessionState[], rejections: [] as (FocusRejection | null)[], outcomeCapture: [] as boolean[], decisionAssistant: [] as boolean[] };
  const ui: FocusSessionUi = {
    setSessionState: (s) => calls.sessionStates.push(s),
    setRejection: (r) => calls.rejections.push(r),
    setShowOutcomeCapture: (v) => calls.outcomeCapture.push(v),
    setShowDecisionAssistant: (v) => calls.decisionAssistant.push(v),
  };
  return { ui, calls, lastRejection: () => calls.rejections[calls.rejections.length - 1] ?? null };
}

/** Two "tabs" on one storage, no BroadcastChannel and no focus events — tab B only learns about
 *  tab A's writes when it re-reads storage itself. */
async function twoTabs(keys: string[]) {
  const storage = createMemoryStateStorage();
  const deps = { stateStorage: storage, stateChannel: null, stateFocusTargets: [] };
  const { store: tabA, setJira } = v226ConfiguredStore(deps);
  setJira(keys.map((k) => v226Actionable(k)));
  await tabA.syncJira();
  await v226Tick();
  const tabB = new CommandCenterStore({ jiraSyncLockManager: null, ...deps });
  tabB.getSnapshot();
  return { tabA, tabB, storage };
}

function planFor(store: CommandCenterStore, key: string, today: string): string {
  return store.addPersonalPlanItem({ sourceType: "attention", sourceId: `ASSIGNMENT:${slug(`jira-${key}`)}`, estimatedMinutes: 15, plannedDate: today, priority: 0, ticketKey: key });
}

const candidate = (title: string) => ({ title, actionId: undefined, decisionId: undefined, attentionItemId: undefined });

// ----- AC: ticket DONE in tab A; Block from Focus Session in tab B → rejection, nothing written -----
{
  const group = "E2 Focus Session rejected outcome";
  const today = getTodayIso();
  const { tabA, tabB, storage } = await twoTabs(["FS-1"]);
  const planId = planFor(tabB, "FS-1", today);
  const b = recordingUi();
  const handlers = focusSessionHandlers({ store: tabB, planItemId: planId, today, candidate: candidate("FS-1 work"), hasDecisionAttentionItem: false }, b.ui);
  ok(group, (await handlers.start()) && b.calls.sessionStates.at(-1) === "IN_PROGRESS", "tab B opens a Focus Session on FS-1 (IN_PROGRESS)");
  await v226Tick();

  await tabA.checkForNewerState();
  tabA.completeTicketInDailyCommand("FS-1", "my-work");
  await v226Tick();
  ok(group, tabB.getSnapshot().ticketWorkStates["FS-1"].status === "IN_PROGRESS", "sanity: tab B has not seen tab A's Done yet (stale in memory)");

  const storedAfterA = parseStoredState(storage.raw()!);
  const planBefore = JSON.stringify(storedAfterA.personalPlan.find((p) => p.id === planId));
  const actionsBefore = storedAfterA.data.actions.length;
  const eventsBefore = storedAfterA.memoryEvents.length;
  const statesBefore = b.calls.sessionStates.length;

  const accepted = await handlers.block("Waiting for a reply", "asked Anna", true);
  await v226Tick();
  const rejection = b.lastRejection();
  const s = tabB.getSnapshot();
  ok(group, accepted === false, "the real blockFocus handler reports the block as not accepted");
  ok(group, rejection?.reason === "transition-rejected" && rejection.current === "DONE" && rejection.ticketKey === "FS-1" && rejection.surface === "my-work", "the UI receives the rejection: current Done, changed on My Work");
  ok(group, b.calls.sessionStates.length === statesBefore && !b.calls.sessionStates.includes("BLOCKED"), "the session never shows BLOCKED");
  ok(group, s.ticketWorkStates["FS-1"].status === "DONE" && parseStoredState(storage.raw()!).ticketWorkStates["FS-1"].status === "DONE", "store unchanged: the ticket stays DONE, in memory and in storage");
  ok(group, JSON.stringify(s.personalPlan.find((p) => p.id === planId)) === planBefore, "plan item unchanged (no blocked status, no blockedReason/blockedNote written)");
  ok(group, s.data.actions.length === actionsBefore, "no follow-up action is created for a rejected block, even when ticked");
  ok(group, s.memoryEvents.length === eventsBefore && !s.memoryEvents.some((e) => e.kind === "FOCUS_BLOCKED" || (e.kind === "TICKET_BLOCKED" && e.ticketKey === "FS-1")), "no FOCUS_BLOCKED / TICKET_BLOCKED event is recorded");

  const html = renderToStaticMarkup(React.createElement(FocusRejectionNotice, { rejection: rejection!, onReopen: () => undefined }));
  ok(group, /This ticket is already Done \(changed [^)]+ on My Work\)\. Reopen it first\?/.test(html) && /<button[^>]*>Reopen<\/button>/.test(html), `the dialog shows "This ticket is already Done (changed <since> on <surface>). Reopen it first?" with a Reopen button`);

  ok(group, (await handlers.reopen("FS-1")) && b.lastRejection() === null && b.calls.sessionStates.at(-1) === "IN_PROGRESS", "Reopen clears the notice and resumes the session");
  ok(group, tabB.getSnapshot().ticketWorkStates["FS-1"].status === "IN_PROGRESS" && tabB.getSnapshot().ticketWorkStates["FS-1"].history.slice(-2).map((h) => h.to).join(",") === "TODO,IN_PROGRESS", "the ticket went DONE → TODO (Reopen) → IN_PROGRESS, both recorded from the Focus Session");
}

// ----- Every Focus Session action: rejected → no outcome; accepted → outcome -----
{
  const group = "E2 Focus Session handlers";
  const today = getTodayIso();
  const { tabB: store } = await twoTabs(["FH-1", "FH-2", "FH-3", "FH-4", "FH-5"]);
  for (const k of ["FH-1", "FH-2", "FH-3", "FH-4"]) store.completeTicketInDailyCommand(k, "command-center");
  const run = async (key: string, act: (h: ReturnType<typeof focusSessionHandlers>) => Promise<boolean>) => {
    const planId = planFor(store, key, today);
    const r = recordingUi();
    const h = focusSessionHandlers({ store, planItemId: planId, today, candidate: candidate(key), hasDecisionAttentionItem: false }, r.ui);
    const accepted = await act(h);
    return { accepted, r, plan: store.getSnapshot().personalPlan.find((p) => p.id === planId) };
  };
  // DONE → DONE is allowed by the transition rules (a no-op): "Completed" is then the truth.
  const doneEventsBefore = store.getSnapshot().memoryEvents.filter((e) => e.kind === "TICKET_COMPLETED" && e.ticketKey === "FH-1").length;
  const complete = await run("FH-1", (h) => h.complete());
  ok(group, complete.accepted && complete.r.calls.sessionStates.at(-1) === "COMPLETED" && store.getSnapshot().ticketWorkStates["FH-1"].status === "DONE", "Complete on an already-Done ticket is a truthful no-op: the session says Completed and the ticket is Done");
  ok(group, store.getSnapshot().memoryEvents.filter((e) => e.kind === "TICKET_COMPLETED" && e.ticketKey === "FH-1").length === doneEventsBefore, "…and records no second TICKET_COMPLETED");
  const skip = await run("FH-2", (h) => h.skip("Not my action"));
  ok(group, !skip.accepted && !skip.r.calls.sessionStates.includes("SKIPPED") && store.getSnapshot().ticketWorkStates["FH-2"].status === "DONE", "Skip on a Done ticket: rejection, ticket stays Done");
  const defer = await run("FH-3", (h) => h.defer(addDays(today, 3)));
  ok(group, !defer.accepted && !defer.r.calls.sessionStates.includes("DEFERRED") && store.getSnapshot().ticketWorkStates["FH-3"].status === "DONE", "Defer on a Done ticket: rejection, ticket stays Done");
  const start = await run("FH-4", (h) => h.start());
  ok(group, !start.accepted && !start.r.calls.sessionStates.includes("IN_PROGRESS") && start.r.lastRejection()?.reason === "transition-rejected", "Opening a session on a Done ticket shows the rejection instead of IN_PROGRESS");
  const fine = await run("FH-5", async (h) => (await h.start()) && (await h.block("Waiting for a reply", undefined, false)));
  ok(group, fine.accepted && fine.r.calls.sessionStates.at(-1) === "BLOCKED" && store.getSnapshot().ticketWorkStates["FH-5"].status === "BLOCKED" && fine.plan?.blockedReason === "Waiting for a reply", "an allowed block still works: BLOCKED shown, ticket BLOCKED, reason recorded");

  // Store-level contract (E2): the result shape, and blockFocusItem writes nothing when rejected.
  const planId = planFor(store, "FH-1", today);
  const res = store.blockFocusItem(planId, today, "Waiting for a reply", "note");
  ok(group, !res.ok && res.reason === "transition-rejected" && res.current === "DONE", "blockFocusItem returns { ok: false, reason: 'transition-rejected', current: 'DONE' }");
  const p = store.getSnapshot().personalPlan.find((x) => x.id === planId)!;
  ok(group, p.blockedReason === undefined && p.blockedNote === undefined, "…and writes no blockedReason / blockedNote");
  ok(group, store.skipFocusItem(planId, today, "Other").ok === false && store.deferFocusItem(planId, addDays(today, 1)).ok === false && store.getSnapshot().personalPlan.find((x) => x.id === planId)!.status === "planned", "skipFocusItem / deferFocusItem rejected → plan item untouched");
  ok(group, store.startFocusItem("no-such-plan", today).ok === false, "an unknown plan item → { ok: false } (never a silent success)");
}

// ----- E3 — FocusSession and TaskRow render the same reason options (snapshot) -----
{
  const group = "E3 One reason vocabulary";
  const options = (html: string, attr: "block" | "skip") => {
    const block = html.match(new RegExp(`<(?:datalist|select)[^>]*data-reason-options="${attr}"[^>]*>([\\s\\S]*?)</(?:datalist|select)>`));
    return block ? Array.from(block[1].matchAll(/<option[^>]*value="([^"]*)"/g)).map((m) => m[1]) : [];
  };
  const actions = storeActionsFor("RV-1", "my-work", new CommandCenterStore({ stateStorage: null, jiraSyncLockManager: null }));
  const row = (picker: "block" | "skip") => renderToStaticMarkup(React.createElement(TaskReferenceRowView, { ticketKey: "RV-1", execution: { kind: "active" }, actions, initialPicker: picker }));
  const noop = () => undefined;
  const focusBlock = renderToStaticMarkup(React.createElement(FocusBlockPanel, { reason: "", onReason: noop, note: "", onNote: noop, createFollowUp: false, onCreateFollowUp: noop, onConfirm: noop, onCancel: noop }));
  const focusSkip = renderToStaticMarkup(React.createElement(FocusSkipPanel, { reason: "", onReason: noop, onConfirm: noop, onCancel: noop }));

  const snapshot = {
    block: { taskRow: options(row("block"), "block"), focusSession: options(focusBlock, "block") },
    skip: { taskRow: options(row("skip"), "skip"), focusSession: options(focusSkip, "skip") },
  };
  const EXPECTED_SNAPSHOT = JSON.stringify({
    block: ["Waiting for a reply", "Depends on another ticket", "Waiting on environment/access", "Waiting on client decision"],
    skip: ["", "Team is handling it", "Not my action", "Waiting on another team", "Not relevant right now", "Other"],
  });
  ok(group, JSON.stringify(snapshot.block.taskRow) === JSON.stringify(snapshot.block.focusSession) && snapshot.block.taskRow.length === BLOCK_REASON_SUGGESTIONS.length, `Block: TaskRow and Focus Session render the same options (${snapshot.block.taskRow.join(" | ")})`);
  ok(group, JSON.stringify(snapshot.skip.taskRow) === JSON.stringify(snapshot.skip.focusSession) && snapshot.skip.taskRow.length === SKIP_REASONS.length + 1, `Skip: TaskRow and Focus Session render the same options (${snapshot.skip.taskRow.join(" | ")})`);
  ok(group, JSON.stringify({ block: snapshot.block.focusSession, skip: snapshot.skip.focusSession }) === EXPECTED_SNAPSHOT, "the rendered options match the stored snapshot");
  ok(group, !snapshot.block.focusSession.includes("Not enough time today") && !snapshot.block.taskRow.includes("Not enough time today"), "'Not enough time today' is no longer a Block reason anywhere");
  const deferHtml = renderToStaticMarkup(React.createElement(FocusDeferPanel, { until: "2026-10-03", onUntil: noop, onConfirm: noop, onCancel: noop }));
  ok(group, /type="date"[^>]*value="2026-10-03"/.test(deferHtml) && />Defer<\/button>/.test(deferHtml), "Focus Session has a Defer picker with a date");
}

// ----- AC: Defer from Focus Session → ticket DEFERRED until date, back on Today on that date -----
{
  const group = "E3 Focus Session Defer / Skip";
  const today = getTodayIso();
  const { tabB: store } = await twoTabs(["DF-1", "DF-2", "DF-3"]);
  const until = addDays(today, 2);
  const planId = planFor(store, "DF-1", today);
  const r = recordingUi();
  const h = focusSessionHandlers({ store, planItemId: planId, today, candidate: candidate("DF-1"), hasDecisionAttentionItem: false }, r.ui);
  await h.start();
  ok(group, (await h.defer(until)) && r.calls.sessionStates.at(-1) === "DEFERRED", "Defer is accepted and the session shows DEFERRED");
  const state = store.getSnapshot().ticketWorkStates["DF-1"];
  ok(group, state.status === "DEFERRED" && state.until === until && state.history.at(-1)?.surface === "focus-session", "the ticket is DEFERRED until the chosen date, recorded from the Focus Session");
  ok(group, ticketBucket(state.status, state.until, today) !== "TODAY" && ticketBucket(state.status, state.until, addDays(until, -1)) !== "TODAY", "it is off Today before that date");
  ok(group, ticketBucket(state.status, state.until, until) === "TODAY", "and returns to Today on that date");
  ok(group, store.getSnapshot().memoryEvents.some((e) => e.kind === "TICKET_DEFERRED" && e.ticketKey === "DF-1"), "TICKET_DEFERRED is recorded for reports");

  const plan2 = planFor(store, "DF-2", today);
  const r2 = recordingUi();
  const h2 = focusSessionHandlers({ store, planItemId: plan2, today, candidate: candidate("DF-2"), hasDecisionAttentionItem: false }, r2.ui);
  await h2.defer();
  ok(group, store.getSnapshot().ticketWorkStates["DF-2"].until === addDays(today, 1), "Defer without a date defaults to tomorrow");

  const plan3 = planFor(store, "DF-3", today);
  const r3 = recordingUi();
  const h3 = focusSessionHandlers({ store, planItemId: plan3, today, candidate: candidate("DF-3"), hasDecisionAttentionItem: false }, r3.ui);
  ok(group, (await h3.skip("Not my action")) && r3.calls.sessionStates.at(-1) === "SKIPPED", "Skip with a reason is accepted");
  ok(group, store.getSnapshot().ticketWorkStates["DF-3"].status === "SKIPPED" && store.getSnapshot().ticketWorkStates["DF-3"].reason === "Not my action", "the ticket is SKIPPED with the same SkipReason TaskRow records");
}

// ----- E3 — records carrying the retired "Not enough time today" are kept and shown as-is -----
{
  const group = "E3 Legacy block reason";
  const at = "2026-09-01T10:00:00.000Z";
  const raw = JSON.stringify({
    personalPlan: [{ id: "plan-legacy", sourceType: "attention", sourceId: "x", priority: 0, position: 0, plannedDate: "2026-09-01", status: "blocked", estimatedMinutes: 15, addedAt: at, blockedReason: "Not enough time today", ticketKey: "LG-1" }],
    ticketWorkStates: {
      "LG-1": { ticketKey: "LG-1", status: "BLOCKED", reason: "Not enough time today", updatedAt: at, history: [{ from: "TODO", to: "BLOCKED", at, reason: "Not enough time today", surface: "focus-session" }] },
    },
  });
  const s = parseStoredState(raw);
  ok(group, s.personalPlan[0].blockedReason === "Not enough time today", "a plan item's old blockedReason is kept verbatim");
  ok(group, s.ticketWorkStates["LG-1"].reason === "Not enough time today" && s.ticketWorkStates["LG-1"].history[0].reason === "Not enough time today" && s.ticketWorkStates["LG-1"].history.length === 1, "the ticket state and its history are kept, not rewritten");
  const again = parseStoredState(JSON.stringify(s));
  ok(group, JSON.stringify(again.ticketWorkStates) === JSON.stringify(s.ticketWorkStates), "loading again changes nothing (no migration rewrites it later)");
  const record = formatExecutionRecord(resolveTicketExecutionState("LG-1", s.ticketWorkStates), new Date("2026-09-02T10:00:00.000Z"));
  ok(group, !!record && record.includes("Not enough time today"), `TaskRow shows the old reason as-is ("${record}")`);
}
