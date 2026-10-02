// TicketWorkState — one canonical per-ticket status
// Run through scripts/tests/run.mts (npm test).

import { buildPlan } from "../../src/lib/command-center/action-plan";
import { emptyData } from "../../src/lib/command-center/types";
import { parseStoredState, getTodayIso, type StoreState } from "../../src/lib/command-center/store";
import { slug } from "../../src/lib/command-center/attention-queue";
import type { Risk } from "../../src/lib/command-center/types";
import { computePersonalFocus } from "../../src/lib/command-center/personal-focus";
import type { PersonalPlanItem } from "../../src/lib/command-center/types";
import { buildProjectOverrideView } from "../../src/components/command-center/use-command-center";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { extractSyncedAppState, mergeSyncedAppState } from "../../src/lib/command-center/app-state-sync";
import { TaskReferenceRowView } from "../../src/components/command-center/TaskReferenceRow";
import { resolveTaskExecutionState } from "../../src/lib/command-center/task-execution";
import { createMemoryStateStorage } from "../../src/lib/command-center/state-persistence";
import { buildDailyReportView } from "../../src/lib/command-center/reports";
import { storeActionsFor } from "../../src/components/command-center/TaskReferenceRow";
import { CommandCenterStore } from "../../src/lib/command-center/store";
import { addDays } from "../../src/lib/command-center/date-utils";
import { applyTicketStatus, getTicketView, mergeTicketWorkStates, migrateLegacyIntoTicketStates, ticketBucket, ticketExclusionSets, ticketStateMaps, TICKET_WORK_STATUSES, type TicketBucket } from "../../src/lib/command-center/ticket-work-state";
import { resolveTicketExecutionState } from "../../src/lib/command-center/task-execution";
import { buildMyWork, myWorkViewOf, type MyWorkView } from "../../src/lib/command-center/my-work";
import { dedupeCandidatesByTicket } from "../../src/lib/command-center/personal-focus";
import { effectivePlanStatus } from "../../src/components/command-center/MyDayAgenda";
import { actionsNotInTodaysPlan } from "../../src/lib/command-center/action-plan";
import { selectDailyCommandMaps } from "../../src/lib/command-center/store";
import type { TicketStatusSurface, TicketWorkState, TicketWorkStatus } from "../../src/lib/command-center/types";
import { ok, skip } from "./harness.mts";
import { TODAY, fakeProactive, jiraItem, makeAttentionItem, makeStoreState, v226Actionable, v226ConfiguredStore, v226JiraItem, v226Tick } from "./helpers.mts";

// ===== TicketWorkState — one canonical per-ticket status (AUDIT_TASK_STATE.md) =====
{
  const group = "TicketWorkState transitions";
  const at = "2026-09-01T10:00:00.000Z";
  // Every pair of the transition table.
  for (const from of TICKET_WORK_STATUSES) {
    for (const to of TICKET_WORK_STATUSES) {
      const start: Record<string, TicketWorkState> = from === "TODO" ? {} : { K: { ticketKey: "K", status: from, updatedAt: "2026-08-01T00:00:00.000Z", history: [] } };
      const r = applyTicketStatus(start, "K", to, { surface: "other", reason: "why" }, at);
      const expected = from === "DONE" ? (to === "TODO" ? "changed" : to === "DONE" ? "noop" : "rejected") : from === "TODO" && to === "TODO" ? "noop" : "changed";
      const got = r.rejected ? "rejected" : r.changed ? "changed" : "noop";
      const last = r.changed ? r.states.K.history[r.states.K.history.length - 1] : undefined;
      ok(group, got === expected && (got !== "changed" || (r.states.K.status === to && last?.from === from && last?.to === to && last?.at === r.states.K.updatedAt)) && (got === "changed" || r.states === start), `${from} → ${to}: ${expected}${got !== expected ? ` (got ${got})` : ""}`);
    }
  }
  let capped: Record<string, TicketWorkState> = {};
  for (let i = 0; i < 60; i++) capped = applyTicketStatus(capped, "H", i % 2 ? "BLOCKED" : "SKIPPED", { surface: "other" }, new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString()).states;
  ok(group, capped.H.history.length === 50 && capped.H.history[49].to === "BLOCKED", "history is capped at the last 50 transitions");
  const same = applyTicketStatus({ X: { ticketKey: "X", status: "BLOCKED", updatedAt: at, history: [] } }, "X", "BLOCKED", { surface: "other" }, at);
  ok(group, same.states.X.updatedAt > at, "the LWW clock always moves forward, even for two writes in the same millisecond");
  ok(group, getTicketView("NONE", { ticketWorkStates: {}, today: "2026-09-01" }).status === "TODO" && getTicketView("NONE", { ticketWorkStates: {}, today: "2026-09-01" }).since === undefined, "no record = implicit TODO");
  ok(group, ticketBucket("DEFERRED", "2026-09-05", "2026-09-04") === "SKIPPED_DEFERRED" && ticketBucket("DEFERRED", "2026-09-05", "2026-09-05") === "TODAY", "a deferred ticket comes back to Today on its date");
}


{
  const group = "TicketWorkState cross-surface";
  const { store, setJira } = v226ConfiguredStore({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [] });
  const today = getTodayIso();
  const future = addDays(today, 3);
  type Step = "start" | "block" | "unblock" | "skip" | "defer" | "done" | "reopen";
  const SURFACES = ["command-center", "focus-session", "my-day", "daily-review", "priorities", "action-plan", "attention"] as const;
  const keyOf = (surface: string) => `CS-${surface.toUpperCase().replace(/[^A-Z]/g, "")}`;
  const keys = SURFACES.map(keyOf);
  const items = keys.map((k) => v226Actionable(k));
  const mentionAt = new Date(Date.now() - 60_000).toISOString();
  setJira(items, keys.map((k) => ({ issueKey: k, commentId: `c-${k}`, commentAuthor: "Anna", excerpt: "can you look?", mentionedAt: mentionAt })));
  await store.syncJira();
  // What the hook does on every render: persist the computed attention lifecycle.
  const firstView = buildProjectOverrideView(store.getSnapshot(), today, "V226");
  store.commitAttentionState(firstView.proactive!.nextAttentionState, firstView.proactive!.attentionQueue);
  // One My Day plan item per ticket (Focus Session / My Day act on it).
  const planId = new Map(keys.map((k) => [k, store.addPersonalPlanItem({ sourceType: "attention", sourceId: `MENTION:${slug(k)}:${slug(`c-${k}`)}`, estimatedMinutes: 15, plannedDate: today, priority: 0 })]));
  ok(group, keys.every((k) => store.getSnapshot().personalPlan.find((p) => p.id === planId.get(k))?.ticketKey === k), "plan items created from a ticket's attention item are linked to the ticket (ticketKey)");
  ok(group, keys.every((k) => (firstView.personalFocus?.candidates.filter((c) => c.ticketKey === k).length ?? 0) === 1), "sanity: every ticket is ONE row in Your Delivery Focus before any change");

  const EXPECT: Record<Step, TicketBucket> = { start: "IN_PROGRESS", block: "BLOCKED", unblock: "TODAY", skip: "SKIPPED_DEFERRED", defer: "SKIPPED_DEFERRED", done: "DONE", reopen: "TODAY" };
  const ORDER: Step[] = ["start", "block", "unblock", "skip", "defer", "done", "reopen"];
  const ticketActions = (key: string, surface: TicketStatusSurface) => {
    const a = storeActionsFor(key, surface, store);
    return { start: a.onStart!, block: () => a.onBlock("Waiting for a reply"), unblock: a.onUnblock, skip: () => a.onSkip("Not my action"), defer: () => a.onDefer!(future), done: a.onComplete, reopen: a.onReopen };
  };
  const handlerFor = (surface: (typeof SURFACES)[number], key: string): Record<Step, () => void> => {
    const pid = planId.get(key)!;
    switch (surface) {
      case "focus-session": {
        // The session's own buttons; what it doesn't offer comes from the My Day row it was opened from.
        const myDay = ticketActions(key, "my-day");
        return { ...myDay, start: () => store.startFocusItem(pid, today), block: () => store.blockFocusItem(pid, today, "Waiting on someone else"), skip: () => store.skipFocusItem(pid, today), done: () => store.completeFocusItem(pid, today), defer: () => store.deferPersonalPlanItem(pid, future) };
      }
      case "my-day":
        return { ...ticketActions(key, "my-day"), defer: () => store.deferPersonalPlanItem(pid, future) };
      case "action-plan": {
        const t = ticketActions(key, "action-plan");
        // PlanCandidateRow's "Complete action" on a ticket-backed candidate.
        return { ...t, done: () => { const id = store.addAction({ title: `Plan ${key}`, why: "x", relatedWorkItemId: `jira-${key}`, estimateMinutes: 15 }); store.completeAction(id); store.setTicketStatus(key, "DONE", { surface: "action-plan" }); } };
      }
      case "daily-review":
        return ticketActions(key, "my-work");
      default:
        return ticketActions(key, surface);
    }
  };
  const bucketOfView: Record<MyWorkView, TicketBucket> = { today: "TODAY", new: "TODAY", "in-progress": "IN_PROGRESS", blocked: "BLOCKED", skipped: "SKIPPED_DEFERRED", done: "DONE" };
  const kindToBucket: Record<string, TicketBucket> = { active: "TODAY", "in-progress": "IN_PROGRESS", blocked: "BLOCKED", skipped: "SKIPPED_DEFERRED", deferred: "SKIPPED_DEFERRED", completed: "DONE", "done-in-jira": "DONE" };
  const planToBucket: Record<string, TicketBucket> = { planned: "TODAY", "in-progress": "IN_PROGRESS", blocked: "BLOCKED", skipped: "SKIPPED_DEFERRED", deferred: "SKIPPED_DEFERRED", completed: "DONE" };
  const active = (b: TicketBucket) => b === "TODAY" || b === "IN_PROGRESS";

  /** Every surface's verdict for `key`, as a bucket (or active/paused where that's all it can say). */
  function observe(key: string): Record<string, string> {
    const st = store.getSnapshot();
    const item = st.data.workItems.find((w) => w.key === key)!;
    const view = buildProjectOverrideView(st, today, "V226");
    const sets = ticketExclusionSets(st.ticketWorkStates, st.data.workItems, today);
    const maps = selectDailyCommandMaps(st, today);
    const work = store.computeMyWork();
    const review = store.computeDailyReview();
    const plan = st.personalPlan.find((p) => p.id === planId.get(key))!;
    const views = (["today", "new", "in-progress", "blocked", "skipped", "done"] as MyWorkView[]).filter((v) => work.views[v].some((r) => r.ticketKey === key));
    const reviewBucket = review.completedRecently.some((r) => r.ticketKey === key) ? "DONE" : [...review.blocked, ...review.dueForRecheck.filter((r) => r.kind === "blocked")].some((r) => r.ticketKey === key) ? "BLOCKED" : [...review.skipped, ...review.dueForRecheck.filter((r) => r.kind === "skipped")].some((r) => r.ticketKey === key) ? "SKIPPED_DEFERRED" : "active";
    const legacy = key in maps.dailyCommandCompletions ? "DONE" : key in maps.dailyCommandBlocks ? "BLOCKED" : key in maps.dailyCommandSkips ? "SKIPPED_DEFERRED" : "active";
    const exclusion = sets.doneIds.has(item.id) ? "DONE" : sets.blockedIds.has(item.id) ? "BLOCKED" : sets.skippedIds.has(item.id) ? "SKIPPED_DEFERRED" : sets.inProgressIds.has(item.id) ? "IN_PROGRESS" : "TODAY";
    const priorities = sets.blockedIds.has(item.id) ? "BLOCKED" : sets.skippedIds.has(item.id) ? "SKIPPED_DEFERRED" : "active-or-done";
    return {
      selector: getTicketView(key, { ticketWorkStates: st.ticketWorkStates, today }).bucket,
      taskRow: kindToBucket[resolveTicketExecutionState(key, st.ticketWorkStates).kind],
      exclusionSets: exclusion,
      legacyMaps: legacy,
      myWork: views.length === 1 ? bucketOfView[views[0]] : `in ${views.length} views`,
      myDayRow: planToBucket[effectivePlanStatus(plan, st.ticketWorkStates, today)],
      focusSessionPlanItem: planToBucket[plan.status],
      dailyReview: reviewBucket,
      priorities,
      yourDeliveryFocus: view.personalFocus!.candidates.some((c) => c.ticketKey === key) ? "active" : "not-listed",
      actionPlan: buildPlan(view.filteredData, today, 480, view.workRelevanceIndex, view.dailyCommandCompletedWorkItemIds, view.dailyCommandPausedWorkItemIds).some((p) => p.item?.key === key) ? "active" : "not-listed",
      // G1 — an open action planned for this ticket follows the TICKET's state on Action Plan,
      // the same buckets as My Work (a synthetic action, so no other surface is affected).
      actionPlanAction: buildPlan({ ...view.filteredData, actions: [...view.filteredData.actions, { id: `syn-${key}`, title: `Planned ${key}`, why: "x", relatedWorkItemId: item.id, status: "open", estimateMinutes: 15, createdAt: today }] }, today, 480, view.workRelevanceIndex, view.dailyCommandCompletedWorkItemIds, view.dailyCommandPausedWorkItemIds).some((p) => p.id === `syn-${key}`) ? "active" : "not-listed",
      // …and a ticket-backed action is never parked in "Not in today's plan" (that's ticketless only).
      actionPlanNotInPlan: actionsNotInTodaysPlan(st.data.actions, today).some((n) => n.action.relatedWorkItemId === item.id) ? "listed" : "not-listed",
      attentionResolved: Object.entries(st.attentionState).filter(([id]) => id.startsWith(`MENTION:${slug(key)}:`)).every(([, s]) => s.lifecycle === "RESOLVED") ? "resolved" : "open",
    };
  }
  function agrees(obs: Record<string, string>, expected: TicketBucket): string[] {
    const wrong: string[] = [];
    for (const [surface, got] of Object.entries(obs)) {
      if (surface === "legacyMaps" || surface === "dailyReview") {
        if (got !== (active(expected) ? "active" : expected)) wrong.push(`${surface}=${got}`);
      } else if (surface === "priorities") {
        if (got !== (expected === "BLOCKED" || expected === "SKIPPED_DEFERRED" ? expected : "active-or-done")) wrong.push(`${surface}=${got}`);
      } else if (surface === "actionPlanNotInPlan") {
        if (got !== "not-listed") wrong.push(`${surface}=${got}`);
      } else if (surface === "yourDeliveryFocus" || surface === "actionPlan" || surface === "actionPlanAction") {
        if (got !== (active(expected) ? "active" : "not-listed")) wrong.push(`${surface}=${got}`);
      } else if (surface === "attentionResolved") {
        if (expected === "DONE" && got !== "resolved") wrong.push(`${surface}=${got}`);
      } else if (got !== expected) wrong.push(`${surface}=${got}`);
    }
    return wrong;
  }

  for (const surface of SURFACES) {
    const key = keyOf(surface);
    const handler = handlerFor(surface, key);
    for (const step of ORDER) {
      handler[step]();
      const wrong = agrees(observe(key), EXPECT[step]);
      ok(group, wrong.length === 0, `${step} from ${surface}: every surface shows ${EXPECT[step]} and the ticket is in exactly one My Work view${wrong.length ? ` — disagreeing: ${wrong.join(", ")}` : ""}`);
    }
    const history = store.getSnapshot().ticketWorkStates[key].history;
    ok(group, history.length === ORDER.length && history.every((h, i) => i === 0 || h.from === history[i - 1].to), `${surface}: one history entry per change, each starting where the last one ended`);
  }
  // The Focus Session block keeps its reason on the ticket, and never creates a Follow-up Action on its own.
  const fsKey = keyOf("focus-session");
  const actionsBefore = store.getSnapshot().data.actions.length;
  store.startFocusItem(planId.get(fsKey)!, today);
  store.blockFocusItem(planId.get(fsKey)!, today, "Missing information");
  ok(group, store.getSnapshot().ticketWorkStates[fsKey].reason === "Missing information" && store.getSnapshot().data.actions.length === actionsBefore, "Focus Session Blocked records its reason on the ticket and adds no Follow-up Action unless asked");
  // DONE from one surface completes the linked open Action too.
  const apKey = keyOf("priorities");
  const linkedAction = store.addAction({ title: "Linked", why: "x", relatedWorkItemId: `jira-${apKey}`, estimateMinutes: 15 });
  storeActionsFor(apKey, "priorities", store).onComplete();
  ok(group, store.getSnapshot().data.actions.find((a) => a.id === linkedAction)?.status === "completed", "DONE completes the ticket's linked open actions in the same change");
}


{
  const group = "TicketWorkState migration";
  const plan = (id: string, status: PersonalPlanItem["status"], ticketKey: string | undefined, sourceId = `ASSIGNMENT:x-${id}`): PersonalPlanItem =>
    ({ id, sourceType: "attention", sourceId, priority: 0, position: 0, plannedDate: "2026-09-10", status, estimatedMinutes: 15, addedAt: "2026-09-10T08:00:00.000Z", ...(status === "completed" ? { completedAt: "2026-09-10" } : {}), ...(ticketKey ? { ticketKey } : {}) }) as PersonalPlanItem;
  const blob = {
    loaded: true,
    data: { ...emptyData(), workItems: [v226JiraItem("M-6"), v226JiraItem("M-7")] },
    dailyCommandCompletions: { "M-1": { ticketKey: "M-1", completedAt: "2026-09-10T09:00:00.000Z", completedBy: "Tay" } },
    dailyCommandSkips: { "M-2": { ticketKey: "M-2", skippedAt: "2026-09-10T09:01:00.000Z", reason: "Not my action", revisitOn: "2026-12-01" } },
    dailyCommandBlocks: { "M-3": { ticketKey: "M-3", blockedAt: "2026-09-10T09:02:00.000Z", reason: "Waiting on Anna", pingOn: "2026-09-12" } },
    dailyCommandTombstones: { completions: { "M-8": { ticketKey: "M-8", deletedAt: "2026-09-11T00:00:00.000Z" } }, skips: {}, blocks: {} },
    personalPlan: [
      plan("p1", "deferred", "M-4"),
      plan("p2", "in-progress", "M-5"),
      // No ticketKey yet: backfilled from its STALE attention id → work item M-6.
      plan("p3", "blocked", undefined, `STALE:${slug("jira-M-6")}`),
      // Older than the ticket's own record: the record wins.
      plan("p4", "completed", "M-3"),
      plan("p5", "planned", "M-7"),
    ],
  };
  const parsed = parseStoredState(JSON.stringify(blob));
  const status = (k: string) => getTicketView(k, { ticketWorkStates: parsed.ticketWorkStates, today: "2026-09-10" }).status;
  ok(group, status("M-1") === "DONE" && status("M-2") === "SKIPPED" && status("M-3") === "BLOCKED", "completions → DONE, skips → SKIPPED, blocks → BLOCKED");
  ok(group, parsed.ticketWorkStates["M-2"].reason === "Not my action" && parsed.ticketWorkStates["M-2"].until === "2026-12-01" && parsed.ticketWorkStates["M-3"].reason === "Waiting on Anna" && parsed.ticketWorkStates["M-3"].pingOn === "2026-09-12" && parsed.ticketWorkStates["M-1"].updatedBy === "Tay", "reasons, re-check / ping dates and who recorded it are carried over");
  ok(group, status("M-4") === "DEFERRED" && status("M-5") === "IN_PROGRESS" && status("M-6") === "BLOCKED" && status("M-7") === "TODO", "ticket-linked plan items migrate: deferred → DEFERRED, in-progress → IN_PROGRESS, a backfilled blocked item → BLOCKED, planned stays TODO");
  ok(group, parsed.personalPlan.find((p) => p.id === "p3")?.ticketKey === "M-6", "a plan item made before ticketKey existed is backfilled on load");
  ok(group, status("M-3") === "BLOCKED", "a plan item older than the ticket's own record never overrides it");
  ok(group, status("M-8") === "TODO" && !!parsed.dailyCommandTombstones.completions["M-8"], "a legacy tombstone with no live record stays TODO, and the tombstone is kept for older devices");
  const legacyBefore = { c: blob.dailyCommandCompletions, s: blob.dailyCommandSkips, b: blob.dailyCommandBlocks };
  const legacyAfter = ticketStateMaps(parsed.ticketWorkStates);
  ok(group, ["M-1"].every((k) => k in legacyAfter.dailyCommandCompletions) && legacyAfter.dailyCommandSkips["M-2"]?.reason === "Not my action" && legacyAfter.dailyCommandBlocks["M-3"]?.reason === "Waiting on Anna" && legacyAfter.dailyCommandCompletions["M-1"].completedAt === legacyBefore.c["M-1"].completedAt && legacyAfter.dailyCommandSkips["M-2"].skippedAt === legacyBefore.s["M-2"].skippedAt && legacyAfter.dailyCommandBlocks["M-3"].blockedAt === legacyBefore.b["M-3"].blockedAt, "the deprecated maps, derived back from the new state, keep every original record and timestamp (identical visible statuses)");
  ok(group, resolveTaskExecutionState("M-2", parsed).kind === resolveTicketExecutionState("M-2", parsed.ticketWorkStates).kind && resolveTaskExecutionState("M-3", parsed).kind === "blocked", "a reader still on the legacy maps sees the same status as the canonical one");
  const reparsed = parseStoredState(JSON.stringify(parsed));
  ok(group, JSON.stringify(reparsed.ticketWorkStates) === JSON.stringify(parsed.ticketWorkStates), "migration is idempotent: loading the migrated state again changes nothing");
  ok(group, Object.keys(parseStoredState(JSON.stringify({ loaded: true })).ticketWorkStates).length === 0 && parseStoredState("{not json").ticketWorkStates !== undefined, "a blob with no execution state (or a corrupt one) loads with an empty ticket state");
  // An older device (legacy maps only) syncing in.
  const local = { ...extractSyncedAppState({ ...makeStoreState(), ticketWorkStates: { "S-1": { ticketKey: "S-1", status: "DONE", updatedAt: "2026-09-10T09:00:00.000Z", history: [] } } }, "2026-09-10T09:00:00.000Z") };
  const olderServer = { ...local, ticketWorkStates: undefined, dailyCommandCompletions: {}, dailyCommandBlocks: { "S-2": { ticketKey: "S-2", blockedAt: "2026-09-11T00:00:00.000Z" } }, dailyCommandTombstones: { completions: { "S-1": { ticketKey: "S-1", deletedAt: "2026-09-11T00:00:00.000Z" } }, skips: {}, blocks: {} } };
  const merged = mergeSyncedAppState(local, olderServer as never);
  ok(group, merged.ticketWorkStates?.["S-2"]?.status === "BLOCKED" && merged.ticketWorkStates?.["S-1"]?.status === "TODO", "an older device's newer block is taken, and its newer Reopen (tombstone) is honoured");
  const a = { K: { ticketKey: "K", status: "BLOCKED" as TicketWorkStatus, updatedAt: "2026-09-10T00:00:00.000Z", history: [] } };
  const b = { K: { ticketKey: "K", status: "DONE" as TicketWorkStatus, updatedAt: "2026-09-11T00:00:00.000Z", history: [] } };
  ok(group, JSON.stringify(mergeTicketWorkStates(a, b)) === JSON.stringify(mergeTicketWorkStates(b, a)) && mergeTicketWorkStates(a, b).K.status === "DONE", "the per-ticket merge is symmetric, newest wins");
  ok(group, migrateLegacyIntoTicketStates(parsed.ticketWorkStates, { dailyCommandCompletions: legacyAfter.dailyCommandCompletions, dailyCommandSkips: legacyAfter.dailyCommandSkips, dailyCommandBlocks: legacyAfter.dailyCommandBlocks }) === parsed.ticketWorkStates, "the derived maps never re-apply themselves (same object back)");
}


{
  const group = "TicketWorkState dedup";
  const w = jiraItem({ id: "wi-dd-1", key: "DD-1", jiraStatusName: "In Progress", owner: "Alice" });
  const risk = { id: "r-dd", projectId: w.projectId, title: "DD-1 risk", level: "HIGH", reason: "x", evidence: [], potentialImpact: "x", mitigation: "x", status: "open", confidence: 0.8, detectedAt: TODAY, sourceWorkItemIds: [w.id], auto: true } as Risk;
  const data: CommandCenterData = { ...emptyData(), workItems: [w], risks: [risk] };
  const items = [
    makeAttentionItem({ id: "MENTION:dd-1:c1", category: "MENTION", severity: "HIGH", sourceRef: { type: "workItem", id: w.id }, ownershipExplicit: true }),
    makeAttentionItem({ id: `ASSIGNMENT:${slug(w.id)}`, category: "ASSIGNMENT", severity: "MEDIUM", sourceRef: { type: "workItem", id: w.id } }),
    makeAttentionItem({ id: "RISK:dd-1-risk", category: "RISK", severity: "HIGH", sourceRef: { type: "risk", id: risk.title } }),
  ];
  const focus = computePersonalFocus(data, fakeProactive(items) as never, "Alice", TODAY, undefined, undefined, [risk]);
  const rows = focus.candidates.filter((c) => c.ticketKey === "DD-1");
  ok(group, (focus.allCandidates ?? []).filter((c) => c.ticketKey === "DD-1").length === 3, "sanity: three signals on one ticket");
  ok(group, rows.length === 1 && rows[0].signals?.length === 3 && new Set(rows[0].signals!.map((s) => s.kind)).size === 3 && ["MENTION", "ASSIGNMENT", "RISK"].every((k) => rows[0].signals!.some((s) => s.kind === k)), "Your Delivery Focus: one row with three chips (Mention, Assigned, Risk)");
  ok(group, rows[0].score === Math.max(...(focus.allCandidates ?? []).filter((c) => c.ticketKey === "DD-1").map((c) => c.score)) && rows[0].signals![0].score >= rows[0].signals![2].score, "ranked by its highest-priority signal, chips highest first");
  const html = renderToStaticMarkup(React.createElement(TaskReferenceRowView, { ticketKey: "DD-1", execution: { kind: "active" }, signals: rows[0].signals }));
  ok(group, (html.match(/data-signal="/g) ?? []).length === 3 && html.includes('data-signal-chips="3"'), "the row renders the three chips");
  ok(group, dedupeCandidatesByTicket([...focus.allCandidates!]).length === focus.candidates.length, "dedupe is stable (re-running it changes nothing)");
  // STALE is Attention-only by design (never a focus candidate), but My Work's row for the
  // ticket lists it with the others: MENTION + STALE + RISK → one row, three chips.
  const stale = makeAttentionItem({ id: `STALE:${slug(w.id)}`, category: "STALE", severity: "MEDIUM", sourceRef: { type: "workItem", id: w.id }, ticketKey: "DD-1" });
  const attn = [{ ...items[0], ticketKey: "DD-1" }, stale, { ...items[2], ticketKey: "DD-1" }];
  const mw = buildMyWork({ workItems: [w], identity: { displayName: "Alice" }, ticketWorkStates: {}, today: TODAY, attentionItems: attn });
  const mwRows = (Object.values(mw.views) as { ticketKey: string; view: { signals: { kind: string }[] } }[][]).flat().filter((r) => r.ticketKey === "DD-1");
  ok(group, mwRows.length === 1 && ["MENTION", "STALE", "RISK"].every((k) => mwRows[0].view.signals.some((s) => s.kind === k)) && mwRows[0].view.signals.length === 3, "My Work: one ticket with Mention + Stale + Risk signals is one row with three chips");
}


{
  const group = "TicketWorkState persistence & report";
  const storage = createMemoryStateStorage();
  const deps = { stateStorage: storage, stateChannel: null, stateFocusTargets: [] };
  const { store, setJira } = v226ConfiguredStore(deps);
  const items = ["PR-1", "PR-2", "PR-3", "PR-4", "PR-5"].map((k) => v226Actionable(k));
  setJira(items);
  await store.syncJira();
  const today = getTodayIso();
  store.startTicket("PR-1", "my-work");
  store.blockTicketInDailyCommand("PR-2", "Waiting on Anna", undefined, undefined, "my-work");
  store.skipTicketInDailyCommand("PR-3", "Not my action", undefined, "my-work");
  store.deferTicket("PR-4", addDays(today, 2), undefined, "my-work");
  const planId = store.addPersonalPlanItem({ sourceType: "attention", sourceId: `ASSIGNMENT:${slug("jira-PR-5")}`, estimatedMinutes: 15, plannedDate: today, priority: 0 });
  store.startFocusItem(planId, today);
  store.completeFocusItem(planId, today);
  await v226Tick();
  const statuses = (s: StoreState) => ["PR-1", "PR-2", "PR-3", "PR-4", "PR-5"].map((k) => s.ticketWorkStates[k]?.status).join(",");
  const expected = "IN_PROGRESS,BLOCKED,SKIPPED,DEFERRED,DONE";
  ok(group, statuses(store.getSnapshot()) === expected, `statuses are recorded (${statuses(store.getSnapshot())})`);
  const reloaded = new CommandCenterStore({ jiraSyncLockManager: null, ...deps });
  ok(group, statuses(reloaded.getSnapshot()) === expected, "they survive a reload (fresh store on the same storage)");
  await v226Tick();
  await store.syncJira();
  ok(group, statuses(store.getSnapshot()) === expected, "they survive a Jira sync with no changes");
  const work = store.computeMyWork();
  ok(group, ["PR-1", "PR-2", "PR-3", "PR-4", "PR-5"].map((k) => myWorkViewOf(work, k)).join(",") === "in-progress,blocked,skipped,skipped,done", "and land in the matching My Work views");
  // A DONE set from the Focus Session is in that day's Daily Report — once, under the ticket.
  const report = store.generateDailyReport(today, true);
  const view = buildDailyReportView(report, today, { accountId: "acc-tay", displayName: "Tay" }, store.buildLiveStandup());
  const pr5 = view.doneMine.filter((t) => t.key === "PR-5");
  ok(group, pr5.length === 1 && view.doneMine.every((t) => !!t.key), "a ticket completed from Focus Session appears in that day's Daily Report, exactly once and under its ticket key");
  ok(group, view.inProgress.some((t) => t.key === "PR-1"), "a started ticket is listed In progress in the standup");
  ok(group, store.getSnapshot().memoryEvents.some((e) => e.kind === "TICKET_STARTED" && e.ticketKey === "PR-1") && store.getSnapshot().memoryEvents.some((e) => e.kind === "TICKET_DEFERRED" && e.ticketKey === "PR-4"), "Start and Defer record TICKET_STARTED / TICKET_DEFERRED for reports");
}
