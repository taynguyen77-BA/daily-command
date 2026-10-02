// G1 — Action Plan: no second status vocabulary, nothing disappears.
// Run through scripts/tests/run.mts (npm test).

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import { getTodayIso, parseStoredState } from "../../src/lib/command-center/store";
import { createMemoryStateStorage } from "../../src/lib/command-center/state-persistence";
import { addDays } from "../../src/lib/command-center/date-utils";
import { actionsNotInTodaysPlan, buildCandidates, buildPlan, isActionActive } from "../../src/lib/command-center/action-plan";
import { MIGRATED_BLOCK_REASON } from "../../src/lib/command-center/action-migration";
import { ticketExclusionSets } from "../../src/lib/command-center/ticket-work-state";
import { myWorkViewOf } from "../../src/lib/command-center/my-work";
import { PlanCandidateRow } from "../../src/components/command-center/PlanCandidateRow";
import { storeActionsFor } from "../../src/components/command-center/TaskReferenceRow";
import { buildProjectOverrideView } from "../../src/components/command-center/use-command-center";
import { emptyData, type Action } from "../../src/lib/command-center/types";
import { ok } from "./harness.mts";
import { makeItem, v226Actionable, v226ConfiguredStore, v226Tick } from "./helpers.mts";

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const today = getTodayIso();
const tomorrow = addDays(today, 1);

/** Is `key` in Action Plan (full-day budget) and which My Work view is it in, as of `date`? */
function surfacesOn(store: ReturnType<typeof v226ConfiguredStore>["store"], key: string, date: string) {
  const st = store.getSnapshot();
  const view = buildProjectOverrideView(st, date, "V226");
  const sets = ticketExclusionSets(st.ticketWorkStates, view.filteredData.workItems, date);
  const inPlan = buildPlan(view.filteredData, date, 480, view.workRelevanceIndex, sets.doneIds, sets.pausedIds).some((p) => p.item?.key === key);
  return { inPlan, myWork: myWorkViewOf(store.computeMyWork(new Date(`${date}T12:00:00`)), key) };
}

// ----- AC: no row ever shows two Block buttons -----
{
  const group = "G1 One status vocabulary";
  const ticket = { ...makeItem({ id: "jira-ONE-1", key: "ONE-1", title: "Checkout" }), sourceType: "jira" as const, sourceId: "ONE-1", sourceUrl: "https://jira.example.com/browse/ONE-1" };
  const buttons = (html: string) => Array.from(html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)).map((m) => m[1]);
  const backed = buttons(renderToStaticMarkup(React.createElement(PlanCandidateRow, { candidate: { id: "plan-x", title: "ONE-1 — Checkout", estimateMinutes: 15, priorityScore: 70, reason: "Overdue", item: ticket } })));
  const ticketless = buttons(renderToStaticMarkup(React.createElement(PlanCandidateRow, { candidate: { id: "a-1", title: "Send recap", estimateMinutes: 15, priorityScore: 55, reason: "Weekly", action: { id: "a-1", title: "Send recap", why: "Weekly", status: "open", estimateMinutes: 15, createdAt: today } } })));
  for (const [label, list] of [["ticket-backed", backed], ["ticketless", ticketless]] as const) {
    ok(group, list.filter((b) => /block/i.test(b)).length === 1, `${label} row: exactly one Block control (${list.filter((b) => /block/i.test(b)).join(" | ")})`);
    ok(group, list.filter((b) => /defer/i.test(b)).length <= 1 && list.filter((b) => /snooze/i.test(b)).length <= 1, `${label} row: at most one Defer and one Snooze`);
  }
  ok(group, backed.includes("Block ticket…") && !backed.some((b) => /Snooze|Defer action|Mark action blocked|Blocked…/.test(b)), "ticket-backed: the ticket buttons are the only status controls");
  ok(group, ["Defer…", "Snooze…", "Blocked…", "Complete action"].every((b) => ticketless.includes(b)), "ticketless: its own Defer (+date) / Snooze (+until) / Blocked (+reason)");
}

// ----- AC: a ticket deferred from Action Plan reappears in Action Plan and My Work on its date -----
{
  const group = "G1 Deferred ticket comes back";
  const { store, setJira } = v226ConfiguredStore({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [] });
  setJira([v226Actionable("DF-10")]);
  await store.syncJira();
  store.markDailyReviewSeen(["DF-10"]);
  const on = addDays(today, 2);
  ok(group, surfacesOn(store, "DF-10", today).inPlan, "sanity: in Action Plan before");
  storeActionsFor("DF-10", "action-plan", store).onDefer!(on);
  await v226Tick();
  const before = surfacesOn(store, "DF-10", today);
  ok(group, !before.inPlan && before.myWork === "skipped", "deferred: out of Action Plan, in My Work → Skipped/Deferred");
  const dayBefore = surfacesOn(store, "DF-10", addDays(on, -1));
  ok(group, !dayBefore.inPlan && dayBefore.myWork === "skipped", "still out the day before its date");
  const onDate = surfacesOn(store, "DF-10", on);
  ok(group, onDate.inPlan && onDate.myWork === "today", "on its date it is back in Action Plan AND My Work → Today, with no action needed");
}

// ----- AC: a ticketless action snoozed until tomorrow is open again tomorrow -----
{
  const group = "G1 Ticketless wake-up";
  const { store } = v226ConfiguredStore({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [] });
  const snoozed = store.addAction({ title: "Send recap", why: "weekly", estimateMinutes: 15 });
  const deferred = store.addAction({ title: "Book room", why: "x", estimateMinutes: 15 });
  const blocked = store.addAction({ title: "Order laptop", why: "x", estimateMinutes: 15 });
  store.snoozeAction(snoozed, tomorrow);
  store.deferAction(deferred);
  store.markActionBlocked(blocked, "Waiting on IT budget");
  const data = () => store.getSnapshot().data;
  const ids = (date: string) => buildCandidates(data(), date).map((c) => c.id);
  ok(group, ![snoozed, deferred, blocked].some((id) => ids(today).includes(id)), "today: snoozed, deferred and blocked actions are out of the plan");
  ok(group, data().actions.find((a) => a.id === deferred)?.deferredUntil === tomorrow, "Defer without a date = tomorrow");
  ok(group, new Set([snoozed, deferred, blocked]).size === 3, "actions created in the same millisecond get distinct ids (they used to collide)");
  const parked = actionsNotInTodaysPlan(data().actions, today);
  ok(group, parked.map((p) => `${p.status}:${p.until ?? p.reason}`).join() === `deferred:${tomorrow},snoozed:${tomorrow},blocked:Waiting on IT budget`, `"Not in today's plan" lists them with date / reason (${parked.map((p) => `${p.status}:${p.until ?? p.reason}`).join()})`);
  ok(group, ids(tomorrow).includes(snoozed) && ids(tomorrow).includes(deferred), "tomorrow: the snoozed and deferred actions are open again — on their own");
  ok(group, !ids(tomorrow).includes(blocked) && actionsNotInTodaysPlan(data().actions, tomorrow).map((p) => p.action.id).join() === blocked, "blocked stays out until reopened");
  store.reopenAction(blocked);
  const reopened = data().actions.find((a) => a.id === blocked)!;
  ok(group, ids(today).includes(blocked) && reopened.status === "open" && reopened.blockedReason === undefined, "Reopen puts it straight back (and clears the reason)");
  ok(group, isActionActive({ status: "snoozed", snoozedUntil: `${tomorrow}T09:00:00.000Z` }, tomorrow) && !isActionActive({ status: "snoozed" }, tomorrow), "a datetime snooze wakes on its date; a snooze with no date stays parked");
  const page = read("src/app/action-plan/page.tsx");
  ok(group, /data-not-in-plan/.test(page) && /store\.reopenAction\(n\.action\.id\)/.test(page), "the Action Plan page shows 'Not in today's plan' with a Reopen button");
}

// ----- AC: a ticket reopened after its action was completed is suggested again -----
{
  const group = "G1 Reopened ticket returns";
  const { store, setJira } = v226ConfiguredStore({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [] });
  setJira([v226Actionable("RO-1")]);
  await store.syncJira();
  store.markDailyReviewSeen(["RO-1"]);
  // PlanCandidateRow's "Complete action" on a ticket-backed candidate.
  const id = store.addAction({ title: "Fix RO-1", why: "x", relatedWorkItemId: "jira-RO-1", estimateMinutes: 15 });
  store.completeAction(id);
  store.setTicketStatus("RO-1", "DONE", { surface: "action-plan" });
  ok(group, !surfacesOn(store, "RO-1", today).inPlan, "done: not suggested");
  store.reopenTicketInDailyCommand("RO-1", "my-work");
  const back = surfacesOn(store, "RO-1", today);
  ok(group, back.inPlan && back.myWork === "today", "reopened (TODO): suggested again in Action Plan, and in My Work → Today");
  ok(group, store.getSnapshot().data.actions.filter((a) => a.relatedWorkItemId === "jira-RO-1").every((a) => a.status === "open"), "…its planned action is open again with it");
  // The pure rule, without the store: a completed action only covers a ticket that is still DONE.
  const item = makeItem({ id: "w-9", key: "W-9", businessImpact: 5, priority: "P1", blocked: true, dueDate: today });
  const done: Action = { id: "a-9", title: "x", why: "x", relatedWorkItemId: "w-9", status: "completed", estimateMinutes: 15, createdAt: today, completedAt: today };
  const data = { ...emptyData(), workItems: [item], actions: [done] };
  ok(group, !buildCandidates(data, today, undefined, new Set(["w-9"])).some((c) => c.item?.id === "w-9") && buildCandidates(data, today).some((c) => c.id === "plan-w-9"), "a completed action covers its ticket only while the ticket is DONE");
}

// ----- Migration of old action-level statuses on ticket-backed actions -----
{
  const group = "G1 Action status migration";
  const item = (key: string) => ({ ...makeItem({ id: `jira-${key}`, key }), sourceType: "jira" as const, sourceId: key });
  const action = (id: string, key: string, status: Action["status"], extra: Partial<Action> = {}): Action => ({ id, title: id, why: "x", relatedWorkItemId: `jira-${key}`, status, estimateMinutes: 15, createdAt: "2026-09-01T09:00:00.000Z", ...extra });
  const raw = {
    loaded: true,
    data: {
      ...emptyData(),
      workItems: ["MG-1", "MG-2", "MG-3", "MG-4", "MG-5"].map(item),
      actions: [
        action("a-def", "MG-1", "deferred"),
        action("a-snz", "MG-2", "snoozed", { snoozedUntil: "2026-12-24T09:00:00.000Z" }),
        action("a-blk", "MG-3", "blocked"),
        action("a-newer", "MG-4", "deferred"),
        { id: "a-free", title: "Ticketless", why: "x", status: "deferred", deferredUntil: "2026-12-01", estimateMinutes: 15, createdAt: "2026-09-01T09:00:00.000Z" } as Action,
        action("a-open", "MG-5", "open"),
      ],
    },
    ticketWorkStates: {
      // Changed AFTER the action was deferred → the ticket's own state wins.
      "MG-4": { ticketKey: "MG-4", status: "IN_PROGRESS", updatedAt: "2026-09-20T09:00:00.000Z", history: [{ from: "TODO", to: "IN_PROGRESS", at: "2026-09-20T09:00:00.000Z", surface: "my-work" }] },
    },
  };
  const s = parseStoredState(JSON.stringify(raw));
  const ts = s.ticketWorkStates;
  ok(group, ts["MG-1"]?.status === "DEFERRED" && ts["MG-1"].until === tomorrow, "deferred action → ticket DEFERRED until tomorrow");
  ok(group, ts["MG-2"]?.status === "DEFERRED" && ts["MG-2"].until === "2026-12-24", "snoozed action → ticket DEFERRED until its snoozedUntil");
  ok(group, ts["MG-3"]?.status === "BLOCKED" && ts["MG-3"].reason === MIGRATED_BLOCK_REASON, `blocked action → ticket BLOCKED, reason "${MIGRATED_BLOCK_REASON}"`);
  ok(group, ["MG-1", "MG-2", "MG-3"].every((k) => ts[k].history.at(-1)?.surface === "migration"), "recorded in each ticket's history as a migration");
  ok(group, ts["MG-4"].status === "IN_PROGRESS" && ts["MG-4"].history.length === 1, "a ticket with a NEWER state is left as it is");
  const acts = new Map(s.data.actions.map((a) => [a.id, a]));
  ok(group, ["a-def", "a-snz", "a-blk", "a-newer"].every((id) => acts.get(id)?.status === "open" && acts.get(id)?.snoozedUntil === undefined), "the migrated actions are open again (the ticket now decides)");
  ok(group, acts.get("a-free")?.status === "deferred" && acts.get("a-free")?.deferredUntil === "2026-12-01" && acts.get("a-open")?.status === "open" && !ts["MG-5"], "ticketless and open actions are untouched");
  const again = parseStoredState(JSON.stringify(s));
  ok(group, JSON.stringify(again.ticketWorkStates) === JSON.stringify(s.ticketWorkStates) && JSON.stringify(again.data.actions) === JSON.stringify(s.data.actions), "idempotent: loading again changes nothing");
  ok(group, s.dailyCommandBlocks["MG-3"]?.reason === MIGRATED_BLOCK_REASON, "the derived legacy maps agree");
  ok(group, parseStoredState(JSON.stringify({ data: { actions: "x", workItems: 3 } })).data !== undefined, "corrupted data still loads (the migration never throws)");
}
