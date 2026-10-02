// G5 — performance headroom and duplicate events:
//   - Focus Session complete(): ACTION_COMPLETED exactly once (the ticket's DONE completes the
//     linked action; complete() doesn't complete it again).
//   - Attention queue (proactive) under 100 ms at 3,000 items, caches cold.
//   - Interaction budget: one ticket status change → full recompute of every selector < 250 ms.
// Run through scripts/tests/run.mts (npm test).

import { CommandCenterStore, getTodayIso, previousSnapshotOf } from "../../src/lib/command-center/store";
import { createMemoryStateStorage } from "../../src/lib/command-center/state-persistence";
import { slug } from "../../src/lib/command-center/attention-queue";
import { deriveData } from "../../src/lib/command-center/selectors";
import { computeProactiveIntelligence } from "../../src/lib/command-center/proactive";
import { computePersonalFocus, dedupeCandidatesByTicket } from "../../src/lib/command-center/personal-focus";
import { buildWorkRelevanceIndex } from "../../src/lib/command-center/jira/work-relevance";
import { ticketExclusionSets } from "../../src/lib/command-center/ticket-work-state";
import { buildMyWork } from "../../src/lib/command-center/my-work";
import { buildPlan } from "../../src/lib/command-center/action-plan";
import { buildDailyReportView, buildWeeklyReportView, mondayOf } from "../../src/lib/command-center/reports";
import { focusSessionHandlers } from "../../src/components/command-center/focus-session-handlers";
import { ok } from "./harness.mts";
import { v226Actionable, v226ConfiguredStore, v226Tick } from "./helpers.mts";
import { buildPerfFixture, timeSelectors } from "./perf-fixture.mts";

export const ATTENTION_QUEUE_BUDGET_MS = 100;
export const INTERACTION_BUDGET_MS = 250;

// ----- Focus Session complete(): ACTION_COMPLETED once -----
{
  const group = "G5 One ACTION_COMPLETED";
  const today = getTodayIso();
  const { store, setJira } = v226ConfiguredStore({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [] });
  setJira([v226Actionable("EV-1"), v226Actionable("EV-2")]);
  await store.syncJira();
  const events = (actionId: string) => store.getSnapshot().memoryEvents.filter((e) => e.kind === "ACTION_COMPLETED" && e.title.includes(actionId === a1 ? "Chase EV-1" : "Chase EV-2")).length;
  const a1 = store.addAction({ title: "Chase EV-1", why: "x", relatedWorkItemId: "jira-EV-1", estimateMinutes: 15 });
  const plan = store.addPersonalPlanItem({ sourceType: "action", sourceId: a1, estimatedMinutes: 15, plannedDate: today, priority: 0, ticketKey: "EV-1" });
  const ui = { setSessionState() {}, setRejection() {}, setShowOutcomeCapture() {}, setShowDecisionAssistant() {} };
  const h = focusSessionHandlers({ store, planItemId: plan, today, candidate: { title: "Chase EV-1", actionId: a1, decisionId: undefined, attentionItemId: undefined }, hasDecisionAttentionItem: false }, ui);
  await h.start();
  ok(group, await h.complete(), "Focus Session completes the action-backed ticket");
  ok(group, store.getSnapshot().data.actions.find((a) => a.id === a1)?.status === "completed" && store.getSnapshot().ticketWorkStates["EV-1"].status === "DONE", "ticket DONE, action completed");
  ok(group, events(a1) === 1, `ACTION_COMPLETED recorded exactly once (${events(a1)})`);
  // Direct paths: ticket Done from any TaskRow, or Complete action twice.
  const a2 = store.addAction({ title: "Chase EV-2", why: "x", relatedWorkItemId: "jira-EV-2", estimateMinutes: 15 });
  store.completeTicketInDailyCommand("EV-2", "my-work");
  ok(group, events(a2) === 1 && store.getSnapshot().data.actions.find((a) => a.id === a2)?.status === "completed", "marking the ticket Done completes its open action and records it once");
  store.completeAction(a2);
  ok(group, events(a2) === 1, "completing an already-completed action records nothing new");
  const ids = store.getSnapshot().memoryEvents.map((e) => e.id);
  ok(group, new Set(ids).size === ids.length, "every memory event has a distinct id (same-millisecond events no longer collide)");
  await v226Tick();
}

// ----- Attention queue < 100 ms, cold caches -----
const env = await buildPerfFixture();
{
  const group = "G5 Attention queue budget";
  const times = await timeSelectors(env);
  const ms = times["Attention queue (proactive)"];
  ok(group, ms < ATTENTION_QUEUE_BUDGET_MS, `Attention queue (proactive): ${ms.toFixed(1)} ms < ${ATTENTION_QUEUE_BUDGET_MS} ms at 3,000 items / 1,500 mentions (caches cold)`);
}

// ----- Interaction budget: one status change → full recompute < 250 ms -----
{
  const group = "G5 Interaction budget";
  const { store, today, mentions } = env;
  const identity = { displayName: "Tay", accountId: "acc-tay" };
  /** Everything the pages compute, as the hook does it, over the store's current state. */
  const recomputeAll = () => {
    const st = store.getSnapshot();
    const idx = buildWorkRelevanceIndex(st.jiraWorkRelevancePolicy);
    const sets = ticketExclusionSets(st.ticketWorkStates, st.data.workItems, today);
    const prev = previousSnapshotOf(st);
    const derived = deriveData(st.data, prev, today, idx, sets.doneIds);
    const proactive = computeProactiveIntelligence(st.data, derived, st.snapshotHistory, prev, st.attentionState, "jira", today, idx, mentions, "acc-tay", "Tay", sets.doneIds, sets.pausedIds, st.staleAssignedTicketThresholds);
    const focus = computePersonalFocus(st.data, proactive, "Tay", today, "acc-tay", idx, derived.risks, mentions, sets.doneIds, sets.pausedIds);
    const review = store.computeDailyReview();
    const work = buildMyWork({ workItems: st.data.workItems, identity, workRelevanceIndex: idx, ticketWorkStates: st.ticketWorkStates, today, focusCandidates: dedupeCandidatesByTicket(focus.candidates), personalPlan: st.personalPlan, review, attentionItems: proactive.attentionQueue, blockerSlaBusinessDays: st.blockerSlaBusinessDays });
    const plan = buildPlan(st.data, today, 480, idx, sets.doneIds, sets.pausedIds);
    const standup = store.buildLiveStandup();
    const daily = buildDailyReportView(st.dailyReports[today], today, identity, standup, { blockerSlaBusinessDays: 2, summaries: { risks: derived.risks, decisions: st.data.decisions } });
    const weekly = buildWeeklyReportView({ weekStart: mondayOf(today), dailyReports: st.dailyReports, identity, today, summaries: { risks: derived.risks, decisions: st.data.decisions } });
    return [work.counts.today, plan.length, daily.summary, weekly.summary, proactive.attentionQueue.length];
  };
  recomputeAll(); // JIT warm-up, discarded
  // Nine real interactions — block, done and start, each on three different tickets. One
  // wall-clock sample is at the mercy of a garbage-collection pause (the fixture has just churned
  // through a 3,000-item state), so the budget applies to each kind's MEDIAN; every sample is
  // reported.
  const mine = env.store.getSnapshot().data.workItems.filter((w) => w.ownerId === "acc-tay" && w.status !== "Done").slice(200, 209).map((w) => w.key);
  const kinds: [string, (key: string) => void][] = [
    ["block", (k) => store.blockTicketInDailyCommand(k, "Waiting for a reply", undefined, undefined, "my-work")],
    ["done", (k) => store.completeTicketInDailyCommand(k, "my-work")],
    ["start", (k) => store.startTicket(k, "my-work")],
  ];
  ok(group, mine.length === 9, "sanity: nine real tickets assigned to me");
  const report: string[] = [];
  let worstMedian = 0;
  kinds.forEach(([label, change], k) => {
    const samples = mine.slice(k * 3, k * 3 + 3).map((key) => {
      const t0 = performance.now();
      change(key);
      recomputeAll();
      return performance.now() - t0;
    });
    const median = [...samples].sort((a, b) => a - b)[1];
    worstMedian = Math.max(worstMedian, median);
    report.push(`${label}: median ${median.toFixed(1)} ms (${samples.map((x) => x.toFixed(0)).join("/")})`);
  });
  ok(group, worstMedian < INTERACTION_BUDGET_MS, `one status change + full recompute of every selector stays under ${INTERACTION_BUDGET_MS} ms at 3,000 items — ${report.join("; ")}`);
}
void slug;
void CommandCenterStore;
