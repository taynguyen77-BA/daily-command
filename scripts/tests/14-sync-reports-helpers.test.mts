// A1–A4, B, C, D — cross-device/cross-tab state, reports, smoke tests, daily helpers
// Run through scripts/tests/run.mts (npm test).

import { emptyData, type WorkItem } from "../../src/lib/command-center/types";
import { parseStoredState, commandCenterStore, getTodayIso, type StoreState } from "../../src/lib/command-center/store";
import { normalizeIssue } from "../../src/lib/command-center/jira/normalize";
import { jiraIssueSchema } from "../../src/lib/command-center/jira/types";
import { computeReleaseHealth } from "../../src/lib/command-center/release-health";
import { answerFromRoute } from "../../src/lib/command-center/query-router";
import { deriveData } from "../../src/lib/command-center/selectors";
import fs from "node:fs";
import path from "node:path";
import { computeDeliveryDrift } from "../../src/lib/command-center/delivery-drift";
import { ineffectiveActions } from "../../src/lib/command-center/action-effectiveness";
import { computeReleaseDrift } from "../../src/lib/command-center/release-drift";
import { buildAttentionQueue } from "../../src/lib/command-center/attention-queue";
import { buildReleaseUpdateDraft, rebuildDraftFromSourceRef, renderNeedsFromOthersText } from "../../src/lib/command-center/communicate";
import { buildProjectOverrideView } from "../../src/components/command-center/use-command-center";
import { buildWorkRelevanceIndex } from "../../src/lib/command-center/jira/work-relevance";
import type { MemoryEvent, DailyReportSnapshot } from "../../src/lib/command-center/types";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { syncedAppStateSchema, type SyncedAppState } from "../../src/lib/command-center/app-state";
import { decideInitialSync, extractSyncedAppState, looksUnused, mergeSyncedAppState } from "../../src/lib/command-center/app-state-sync";
import { TaskReferenceRowView } from "../../src/components/command-center/TaskReferenceRow";
import { closePausedTicketsFinishedInJira, formatExecutionRecord, formatPausedAge, resolveTaskExecutionState, type TaskExecutionState } from "../../src/lib/command-center/task-execution";
import { buildDailyReview, newReasonLabel } from "../../src/lib/command-center/daily-review";
import { createMemoryStateStorage, createStateChannelHub, readRevFromRaw, rebaseState, serializeWithRev } from "../../src/lib/command-center/state-persistence";
import { buildDailyReportView, buildWeeklyReportView, renderDailyReport, renderWeeklyReport, type DailyReportView, type StandupState } from "../../src/lib/command-center/reports";
import { selectAllReleaseHealth, selectReleaseHealth, renderReleaseUpdate } from "../../src/lib/command-center/release-health";
import { ReleaseHealthPanel } from "../../src/components/command-center/ReleaseHealthPanel";
import { parseSprintFieldValue } from "../../src/lib/command-center/jira/normalize";
import { DEFAULT_WORK_RELEVANCE_POLICY_MAP } from "../../src/lib/command-center/jira/work-relevance";
import type { ArtifactDraft } from "../../src/lib/command-center/types";
import { isValidCustomFieldId } from "../../src/lib/command-center/jira/http";
import { needsFromOthersForBlockedTicket, needsFromOthersForDependency, needsFromOthersForWaitingFor } from "../../src/lib/command-center/communicate";
import { NAV_GROUPS } from "../../src/components/command-center/Nav";
import { LANDING_PAGES } from "../../src/lib/command-center/store";
import { DEFAULT_AI_MODEL, DEFAULT_AI_MODEL_FAST, resolveAiModel } from "../../src/lib/command-center/ai/model-config";
import { buildMorningBrief, morningBriefSentence, morningBriefSince, morningBriefSinceLabel, shouldRunMorningBrief } from "../../src/lib/command-center/morning-brief";
import { triageCommand } from "../../src/lib/command-center/triage-keys";
import { listDailySyncSummaries, rollDailySyncSummary } from "../../src/lib/command-center/sync-history";
import { isMentionReplied } from "../../src/lib/command-center/mention-replies";
import { latestOwnCommentAt } from "../../src/lib/command-center/jira/mentions";
import { dueFollowUps } from "../../src/lib/command-center/follow-up-reminders";
import { runFollowUpRemindersOnce } from "../../src/lib/command-center/follow-up-runner";
import { emailDraftUrl, slackReportText } from "../../src/lib/command-center/report-export";
import { renderSlackText, slackSignalSchema } from "../../src/lib/server/slack-notify";
import { DEFAULT_FEATURE_TOGGLES } from "../../src/lib/command-center/types";
import type { StaleAssignedTicket } from "../../src/lib/command-center/personal-staleness";
import { applyDailyCommandChange, emptyTombstones, mergeDailyCommandState, TOMBSTONE_RETENTION_DAYS, type DailyCommandState } from "../../src/lib/command-center/execution-state-merge";
import { ChangeItem } from "../../src/components/command-center/ChangeItem";
import { DependencyRadarCard } from "../../src/components/command-center/DependencyRadarCard";
import { DeliveryLoopCard } from "../../src/components/command-center/DeliveryLoopCard";
import { storeActionsFor } from "../../src/components/command-center/TaskReferenceRow";
import { CommandCenterStore } from "../../src/lib/command-center/store";
import type { DataSourceSyncResult } from "../../src/lib/command-center/datasource/types";
import { addDays } from "../../src/lib/command-center/date-utils";
import { computeStaleAssignedTickets } from "../../src/lib/command-center/personal-staleness";
import { computeSetupHealthRows } from "../../src/components/command-center/SetupHealthBanner";
import { ok } from "./harness.mts";
import { TODAY, makeItem, v226Actionable, v226ActiveSurfaces, v226ConfiguredStore, v226JiraItem, v226Tick } from "./helpers.mts";

// ===== A1 — cross-device sync carries personal execution state (LWW + tombstones) =====
{
  const group = "A1 Execution-state sync";
  const legacyBlob = (overrides: Partial<SyncedAppState> = {}): SyncedAppState => ({
    personalIdentity: undefined,
    jiraWorkRelevancePolicy: {},
    attentionState: {},
    decisions: [],
    actionPlanState: { actions: [], personalPlan: [] },
    memoryEvents: [],
    dailyReports: {},
    uiPreferences: { showAdvancedSettings: false, myActionItemsOnly: { attention: false, myDay: false, priorities: false }, jiraProjectScope: { mode: "ALL", projectKeys: [] } },
    updatedAtIso: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
  const emptyDc = (): DailyCommandState => ({ dailyCommandCompletions: {}, dailyCommandSkips: {}, dailyCommandBlocks: {}, dailyCommandTombstones: emptyTombstones() });
  const T = (min: number) => new Date(Date.UTC(2026, 5, 1, 9, min)).toISOString();
  const kindOf = (dc: DailyCommandState, key: string) => resolveTaskExecutionState(key, dc).kind;

  // --- Complete on device A → device B treats it as completed on every surface. ---
  const tay = { accountId: "acc-tay", displayName: "Tay" };
  const keys = ["A1-1", "A1-2", "A1-3"];
  // Two DEVICES: each with its own storage and no cross-tab channel, so the sync merge is the
  // only way anything travels between them.
  const isolated = () => ({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [] });
  const devA = v226ConfiguredStore(isolated());
  const devB = v226ConfiguredStore(isolated());
  for (const d of [devA, devB]) d.setJira(keys.map((k) => v226Actionable(k)));
  await devA.store.syncJira();
  await devB.store.syncJira();
  ok(group, v226ActiveSurfaces(devB.store, "A1-1", Date.now()).length > 0, "control: before any sync, A1-1 is active work on device B");
  devA.store.completeTicketInDailyCommand("A1-1");
  ok(group, !("A1-1" in devB.store.getSnapshot().dailyCommandCompletions), "control: before the merge, device B knows nothing of A's completion");
  const sliceA = extractSyncedAppState(devA.store.getSnapshot(), new Date().toISOString());
  ok(group, !!sliceA.dailyCommandCompletions?.["A1-1"] && typeof sliceA.dailyCommandCompletions["A1-1"].updatedAt === "string", "the synced slice carries dailyCommandCompletions, each record stamped with updatedAt");
  devB.store.applySyncedAppState(mergeSyncedAppState(extractSyncedAppState(devB.store.getSnapshot(), T(0)), sliceA));
  const stB = devB.store.getSnapshot();
  ok(group, resolveTaskExecutionState("A1-1", stB).kind === "completed", "after the merge, device B resolves A1-1 as completed");
  ok(group, v226ActiveSurfaces(devB.store, "A1-1", Date.now()).length === 0, `device B shows A1-1 as active on no surface (My Assigned Work, Attention, Focus, Action Plan, Priorities) — got: ${v226ActiveSurfaces(devB.store, "A1-1", Date.now()).join(", ") || "none"}`);
  const viewB = buildProjectOverrideView(stB, getTodayIso(), "V226");
  const reviewB = buildDailyReview({ workItems: viewB.filteredData.workItems, identity: tay, workRelevanceIndex: viewB.workRelevanceIndex, dailyCommandCompletions: stB.dailyCommandCompletions, dailyCommandSkips: stB.dailyCommandSkips, dailyCommandBlocks: stB.dailyCommandBlocks, memoryEvents: stB.memoryEvents, mentionEvents: stB.mentionEvents, syncLog: stB.syncLog, now: new Date() });
  ok(group, !reviewB.newSinceLastVisit.some((w) => w.key === "A1-1") && reviewB.completedRecently.some((r) => r.ticketKey === "A1-1"), "Daily Review on device B: A1-1 is not New, and is listed under Completed recently");
  ok(group, v226ActiveSurfaces(devB.store, "A1-2", Date.now()).length > 0, "control: an untouched ticket is still active on device B");

  // --- Reactivate on A after B already has the skip → merged result has no active skip. ---
  let a = applyDailyCommandChange(emptyDc(), "X", { kind: "skip", record: { ticketKey: "X", skippedAt: T(1) } }, T(1));
  let b = mergeDailyCommandState(emptyDc(), a); // B received the skip
  a = applyDailyCommandChange(a, "X", null, T(2)); // A reactivates
  ok(group, !("X" in a.dailyCommandSkips) && a.dailyCommandTombstones.skips["X"]?.deletedAt === T(2), "reactivating writes a tombstone instead of just deleting the key");
  ok(group, kindOf(mergeDailyCommandState(b, a), "X") === "active" && kindOf(mergeDailyCommandState(a, b), "X") === "active", "merging B's stale skip with A's reactivation (either direction) leaves X active — the removal is never resurrected");
  b = mergeDailyCommandState(b, a);
  ok(group, !("X" in b.dailyCommandSkips) && !!b.dailyCommandTombstones.skips["X"], "B adopts the tombstone too, so a third device's stale copy can't bring it back either");
  const reSkipped = applyDailyCommandChange(b, "X", { kind: "skip", record: { ticketKey: "X", skippedAt: T(3) } }, T(3));
  ok(group, kindOf(mergeDailyCommandState(reSkipped, a), "X") === "skipped", "a skip made AFTER the tombstone wins over it (strictly newer live record)");
  // Same for un-complete and unblock.
  const comp = applyDailyCommandChange(emptyDc(), "Y", { kind: "completion", record: { ticketKey: "Y", completedAt: T(1) } }, T(1));
  const reopened = applyDailyCommandChange(comp, "Y", null, T(2));
  const blk = applyDailyCommandChange(emptyDc(), "Z", { kind: "block", record: { ticketKey: "Z", blockedAt: T(1) } }, T(1));
  const unblocked = applyDailyCommandChange(blk, "Z", null, T(2));
  ok(group, kindOf(mergeDailyCommandState(comp, reopened), "Y") === "active" && kindOf(mergeDailyCommandState(blk, unblocked), "Z") === "active", "reopen (un-complete) and unblock are tombstoned the same way");

  // --- Concurrent edits: newest updatedAt wins, deterministically. ---
  const aSkip = applyDailyCommandChange(emptyDc(), "C", { kind: "skip", record: { ticketKey: "C", skippedAt: T(5) } }, T(5));
  const bBlock = applyDailyCommandChange(emptyDc(), "C", { kind: "block", record: { ticketKey: "C", blockedAt: T(6), reason: "waiting" } }, T(6));
  const m1 = mergeDailyCommandState(aSkip, bBlock);
  const m2 = mergeDailyCommandState(bBlock, aSkip);
  ok(group, kindOf(m1, "C") === "blocked" && kindOf(m2, "C") === "blocked" && !("C" in m1.dailyCommandSkips), "skip at t5 vs block at t6 on different devices → block wins in both merge orders, and the losing skip is dropped (mutual exclusion holds)");
  ok(group, JSON.stringify(m1) === JSON.stringify(m2), "the merge is order-independent (byte-identical result)");
  const sameA = applyDailyCommandChange(emptyDc(), "S", { kind: "skip", record: { ticketKey: "S", skippedAt: T(7) } }, T(7));
  const sameB = applyDailyCommandChange(emptyDc(), "S", { kind: "completion", record: { ticketKey: "S", completedAt: T(7) } }, T(7));
  ok(group, kindOf(mergeDailyCommandState(sameA, sameB), "S") === "completed" && kindOf(mergeDailyCommandState(sameB, sameA), "S") === "completed", "identical timestamps tie-break deterministically (completion > blocked > skipped) in both orders");
  const r1 = applyDailyCommandChange(emptyDc(), "R", { kind: "block", record: { ticketKey: "R", blockedAt: T(8), reason: "older reason" } }, T(8));
  const r2 = applyDailyCommandChange(emptyDc(), "R", { kind: "block", record: { ticketKey: "R", blockedAt: T(9), reason: "newer reason" } }, T(9));
  ok(group, mergeDailyCommandState(r1, r2).dailyCommandBlocks["R"].reason === "newer reason" && mergeDailyCommandState(r2, r1).dailyCommandBlocks["R"].reason === "newer reason", "two edits of the same record: the newer one wins regardless of which side is 'server'");
  const legacyRec = { ...emptyDc(), dailyCommandCompletions: { L: { ticketKey: "L", completedAt: T(10) } } };
  const newerTomb = { ...emptyDc(), dailyCommandTombstones: { ...emptyTombstones(), completions: { L: { ticketKey: "L", deletedAt: T(11) } } } };
  ok(group, kindOf(mergeDailyCommandState(legacyRec, newerTomb), "L") === "active", "a pre-A1 record without updatedAt falls back to completedAt as its clock");

  // --- A KV blob from the previous version (no new fields) merges without throwing or wiping. ---
  const localWithState = applyDailyCommandChange(applyDailyCommandChange(emptyDc(), "K1", { kind: "completion", record: { ticketKey: "K1", completedAt: T(1) } }, T(1)), "K2", { kind: "block", record: { ticketKey: "K2", blockedAt: T(2) } }, T(2));
  const localSlice = legacyBlob({ ...localWithState, syncLog: [{ startedAt: T(0), completedAt: T(1), recordsCreated: 1, recordsUpdated: 0, newTicketKeys: ["K1"] }], dailyReviewLastVisitAt: T(3) });
  const oldServer = legacyBlob({ updatedAtIso: "2027-01-01T00:00:00.000Z" });
  let mergedLegacy: SyncedAppState | undefined;
  let threw = false;
  try {
    mergedLegacy = mergeSyncedAppState(localSlice, oldServer);
  } catch {
    threw = true;
  }
  ok(group, !threw && !!mergedLegacy?.dailyCommandCompletions?.["K1"] && !!mergedLegacy?.dailyCommandBlocks?.["K2"], "merging with a pre-A1 server blob does not throw and keeps every local record");
  ok(group, mergedLegacy?.syncLog?.length === 1 && mergedLegacy?.dailyReviewLastVisitAt === T(3), "syncLog and dailyReviewLastVisitAt survive the legacy merge too");
  ok(group, syncedAppStateSchema.safeParse(oldServer).success, "the route schema still accepts a pre-A1 blob");
  const parsedNew = syncedAppStateSchema.safeParse(JSON.parse(JSON.stringify(localSlice)));
  ok(group, parsedNew.success && !!(parsedNew.data as unknown as SyncedAppState).dailyCommandCompletions?.["K1"] && !!(parsedNew.data as unknown as SyncedAppState).dailyCommandTombstones, "the route schema keeps the new fields instead of silently stripping them");
  const devC = v226ConfiguredStore(isolated());
  devC.store.completeTicketInDailyCommand("K9");
  devC.store.applySyncedAppState(oldServer);
  ok(group, "K9" in devC.store.getSnapshot().dailyCommandCompletions, "applying a pre-A1 blob to a store never clears its local Daily Command records");
  const stC = devC.store.getSnapshot();
  ok(group, !looksUnused(stC), "a device whose only use is Complete/Skip/Block is not 'unused' (it is merged, never overwritten)");
  ok(group, decideInitialSync(extractSyncedAppState(stC, T(0)), stC, oldServer, undefined).kind === "merge", "so the on-load decision against a newer server blob is 'merge', not 'adopt-server'");

  // --- Tombstone pruning. ---
  const oldStone = { ...emptyDc(), dailyCommandTombstones: { ...emptyTombstones(), skips: { OLD: { ticketKey: "OLD", deletedAt: "2026-01-01T00:00:00.000Z" }, RECENT: { ticketKey: "RECENT", deletedAt: "2026-02-20T00:00:00.000Z" } } } };
  const pruned = applyDailyCommandChange(oldStone, "NEW", { kind: "skip", record: { ticketKey: "NEW", skippedAt: "2026-03-01T00:00:00.000Z" } }, "2026-03-01T00:00:00.000Z");
  ok(group, !pruned.dailyCommandTombstones.skips["OLD"] && !!pruned.dailyCommandTombstones.skips["RECENT"], `tombstones older than ${TOMBSTONE_RETENTION_DAYS} days are pruned on write; recent ones are kept`);

  // --- Store write path. ---
  const devD = v226ConfiguredStore(isolated());
  devD.store.skipTicketInDailyCommand("W1", "Not my action");
  devD.store.completeTicketInDailyCommand("W1");
  const stD = devD.store.getSnapshot();
  ok(group, "W1" in stD.dailyCommandCompletions && !("W1" in stD.dailyCommandSkips) && !!stD.dailyCommandTombstones.skips["W1"], "completing a skipped ticket tombstones the skip (mutual-exclusion clears are removals too)");
  ok(group, parseStoredState(JSON.stringify({ ...stD, dailyCommandTombstones: "garbage" })).dailyCommandTombstones.skips !== undefined, "a corrupted tombstone map parses to an empty one, never a crash");
  const legacyParsed = parseStoredState(JSON.stringify({ loaded: true, dailyCommandCompletions: { P: { ticketKey: "P", completedAt: T(1) } } }));
  ok(group, "P" in legacyParsed.dailyCommandCompletions && Object.keys(legacyParsed.dailyCommandTombstones.completions).length === 0 && Object.keys(legacyParsed.dailyReviewAcks).length === 0, "pre-A1 persisted state loads without migration: records kept, new fields default empty");
}



// ===== A2 — cross-tab stale-overwrite protection (stateRev + BroadcastChannel + rebase) =====
{
  const group = "A2 Cross-tab persistence";
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const tab = (storage: ReturnType<typeof createMemoryStateStorage>, extra: Partial<ConstructorParameters<typeof CommandCenterStore>[0]> = {}) => {
    const store = new CommandCenterStore({ jiraSyncLockManager: null, stateStorage: storage, ...extra });
    store.getSnapshot();
    return store;
  };
  const storedState = (storage: ReturnType<typeof createMemoryStateStorage>) => parseStoredState(storage.raw() ?? "{}");

  // Pure pieces.
  ok(group, readRevFromRaw(null) === 0 && readRevFromRaw(JSON.stringify({ loaded: true })) === 0 && readRevFromRaw(serializeWithRev({ loaded: true }, 42)) === 42, "stateRev is read from the blob's prefix; a pre-A2 blob (no stateRev) reads as rev 0");
  ok(group, serializeWithRev({ stateRev: 1, a: 1 } as object, 7).startsWith('{"stateRev":7,'), "serializeWithRev always puts the current rev first, replacing any stale one");
  const prev = { a: 1, m: { x: 1, y: 1 }, arr: [1] };
  const next = { ...prev, m: { ...prev.m, y: 2 } };
  const stored = { a: 9, m: { x: 5, y: 1, z: 3 }, arr: [7] };
  ok(group, JSON.stringify(rebaseState(prev, next, stored)) === JSON.stringify({ a: 9, m: { x: 5, y: 2, z: 3 }, arr: [7] }), "rebaseState re-applies only what this tab changed (m.y) on top of the newer stored state, keeping the other tab's a/m.x/m.z/arr");

  for (const mode of ["localStorage-like (sync)", "IndexedDB-like (async)"] as const) {
    const isAsync = mode.startsWith("IndexedDB");
    const label = (s: string) => `[${mode}] ${s}`;

    // --- Tab A idle, tab B completes X → A shows X completed without reload. ---
    {
      const storage = createMemoryStateStorage({ async: isAsync });
      const hub = createStateChannelHub();
      const seed = tab(storage, { stateChannel: hub });
      seed.loadDemoData();
      await settle();
      const tabA = tab(storage, { stateChannel: hub });
      const tabB = tab(storage, { stateChannel: hub });
      await settle();
      ok(group, tabA.getSnapshot().loaded && tabB.getSnapshot().loaded, label("both tabs hydrate the same stored state"));
      tabB.completeTicketInDailyCommand("X-1");
      await settle();
      ok(group, "X-1" in tabA.getSnapshot().dailyCommandCompletions, label("tab A (idle) shows X-1 completed right after tab B's write — via the channel, no reload"));
      ok(group, readRevFromRaw(storage.raw()) >= 2, label("every write bumps the persisted stateRev"));
    }

    // --- Tab A stale (never notified), then performs an unrelated action → X stays completed. ---
    {
      const storage = createMemoryStateStorage({ async: isAsync });
      const seed = tab(storage, { stateChannel: null, stateFocusTargets: [] });
      seed.loadDemoData();
      await settle();
      const tabA = tab(storage, { stateChannel: null, stateFocusTargets: [] });
      const tabB = tab(storage, { stateChannel: null, stateFocusTargets: [] });
      await settle();
      tabB.completeTicketInDailyCommand("X-1");
      tabB.skipTicketInDailyCommand("X-2", "Not my action");
      await settle();
      ok(group, !("X-1" in tabA.getSnapshot().dailyCommandCompletions), label("control: with no channel and no focus event, tab A is genuinely stale"));
      tabA.setShowAdvancedSettings(true); // unrelated field
      await settle();
      let st = storedState(storage);
      ok(group, "X-1" in st.dailyCommandCompletions && "X-2" in st.dailyCommandSkips && st.showAdvancedSettings === true, label("tab A's unrelated write is rebased: storage keeps B's completion/skip AND A's own change"));
      ok(group, "X-1" in tabA.getSnapshot().dailyCommandCompletions, label("…and tab A's in-memory state picks up B's records from that rebase"));
      // Same map, different key, and a removal: stale tab touching the Daily Command maps.
      tabB.completeTicketInDailyCommand("X-3");
      await settle();
      tabA.reactivateSkippedTicket("X-2"); // A already saw X-2 via the rebase above
      tabA.completeTicketInDailyCommand("Y-1");
      await settle();
      st = storedState(storage);
      ok(group, "X-1" in st.dailyCommandCompletions && "X-3" in st.dailyCommandCompletions && "Y-1" in st.dailyCommandCompletions, label("a stale tab completing a different ticket never drops the other tab's completions from the same map"));
      ok(group, !("X-2" in st.dailyCommandSkips) && !!st.dailyCommandTombstones.skips["X-2"], label("a stale tab's removal is kept (with its tombstone)"));
      // Never a blind overwrite of a newer rev.
      const revBefore = readRevFromRaw(storage.raw());
      tabB.setFilters({});
      await settle();
      ok(group, readRevFromRaw(storage.raw()) > revBefore, label("the rev only ever increases"));
    }

    // --- BroadcastChannel absent: fallback compares the stored rev on focus/visibilitychange. ---
    {
      const storage = createMemoryStateStorage({ async: isAsync });
      const focusA = new EventTarget();
      const seed = tab(storage, { stateChannel: null, stateFocusTargets: [] });
      seed.loadDemoData();
      await settle();
      const tabA = tab(storage, { stateChannel: null, stateFocusTargets: [focusA] });
      const tabB = tab(storage, { stateChannel: null, stateFocusTargets: [] });
      await settle();
      tabB.blockTicketInDailyCommand("F-1", "Waiting for a reply");
      await settle();
      ok(group, !("F-1" in tabA.getSnapshot().dailyCommandBlocks), label("fallback control: no update before the tab regains focus"));
      focusA.dispatchEvent(new Event("focus"));
      await settle();
      ok(group, "F-1" in tabA.getSnapshot().dailyCommandBlocks, label("fallback: on focus, tab A re-hydrates the newer rev"));
      tabB.unblockTicketInDailyCommand("F-1");
      await settle();
      focusA.dispatchEvent(new Event("visibilitychange"));
      await settle();
      ok(group, !("F-1" in tabA.getSnapshot().dailyCommandBlocks), label("fallback: visibilitychange works the same way"));
    }
  }

  // Legacy blob (pre-A2, no stateRev) loads and is written over safely.
  {
    const legacy = JSON.stringify({ loaded: true, isDemo: true, dailyCommandCompletions: { OLD: { ticketKey: "OLD", completedAt: "2026-01-01T00:00:00.000Z" } } });
    const storage = createMemoryStateStorage({ initial: legacy });
    const t = tab(storage, { stateChannel: null, stateFocusTargets: [] });
    ok(group, "OLD" in t.getSnapshot().dailyCommandCompletions, "a pre-A2 blob (no stateRev) hydrates normally");
    t.completeTicketInDailyCommand("NEW");
    const st = storedState(storage);
    ok(group, "OLD" in st.dailyCommandCompletions && "NEW" in st.dailyCommandCompletions && readRevFromRaw(storage.raw()) >= 1, "the first writes over it keep everything and start the rev counting up from 0");
  }

  // Wiring: the browser defaults.
  const storeSrc = fs.readFileSync(path.join(process.cwd(), "src/lib/command-center/store.ts"), "utf8");
  const persistSrc = fs.readFileSync(path.join(process.cwd(), "src/lib/command-center/state-persistence.ts"), "utf8");
  ok(group, /STATE_CHANNEL_NAME = "daily-command-state"/.test(persistSrc) && /new window\.BroadcastChannel\(STATE_CHANNEL_NAME\)/.test(persistSrc) && /typeof \(window as \{ BroadcastChannel\?: unknown \}\)\.BroadcastChannel !== "function"/.test(persistSrc), "the default channel is BroadcastChannel(\"daily-command-state\"), feature-detected");
  ok(group, /idbUpdate\(STORAGE_KEY, fn\)/.test(storeSrc) && /createLocalStorageStateStorage\(\(\) => window\.localStorage, STORAGE_KEY\)/.test(storeSrc), "both the IndexedDB and the localStorage path go through the same rev-checked update()");
}



// ===== A3 — Daily Review "New" correctness =====
{
  const group = "A3 Daily Review New";
  const tay = { accountId: "acc-tay", displayName: "Tay" };
  // Exactly the inputs daily-review/page.tsx passes.
  const pageReview = (store: CommandCenterStore) => {
    const st = store.getSnapshot();
    const view = buildProjectOverrideView(st, getTodayIso(), "V226");
    return buildDailyReview({
      workItems: view.filteredData.workItems,
      identity: tay,
      workRelevanceIndex: view.workRelevanceIndex,
      dailyCommandCompletions: st.dailyCommandCompletions,
      dailyCommandSkips: st.dailyCommandSkips,
      dailyCommandBlocks: st.dailyCommandBlocks,
      memoryEvents: st.memoryEvents,
      mentionEvents: st.mentionEvents,
      attentionState: st.attentionState,
      syncLog: st.syncLog,
      baselineAt: st.dailyReviewBaselineAt,
      lastVisitAt: st.dailyReviewLastVisitAt,
      reviewAcks: st.dailyReviewAcks,
      now: new Date(),
    });
  };
  const newKeys = (store: CommandCenterStore) => pageReview(store).newRows.map((r) => r.ticketKey).sort().join(",");
  const storage = createMemoryStateStorage();
  const deps = { stateStorage: storage, stateChannel: null, stateFocusTargets: [] };
  const { store, setJira } = v226ConfiguredStore(deps);
  const base = ["N-1", "N-2", "N-3"].map((k) => v226Actionable(k));
  const bobs = v226Actionable("N-BOB", { owner: "Bob", ownerId: "acc-bob" });

  setJira([...base, bobs]);
  await store.syncJira();
  await v226Tick();
  setJira([...base, bobs, v226Actionable("N-4")]);
  await store.syncJira();
  const st = store.getSnapshot();
  ok(group, st.dailyReviewBaselineAt === st.syncLog[0].completedAt, "the second sync pins the baseline at the previous sync (no legacy visit recorded)");
  ok(group, newKeys(store) === "N-4", "N-4 (first seen after the baseline) is New");
  ok(group, pageReview(store).newRows[0].reasons[0].kind === "new-ticket" && newReasonLabel(pageReview(store).newRows[0].reasons) === "New ticket", "…labeled 'New ticket'");

  // Refresh: rebuilding (same state) and a full reload (fresh store on the same storage).
  const reviewSrc = fs.readFileSync(path.join(process.cwd(), "src/app/my-work/page.tsx"), "utf8");
  ok(group, !/markDailyReviewVisited/.test(reviewSrc) && !/markDailyReviewSeen\([^)]*\)\s*;?\s*\n\s*\/\/ eslint/.test(reviewSrc), "the page records nothing on mount (no visit-on-mount)");
  ok(group, newKeys(store) === "N-4", "refreshing the page (rebuilding the review) keeps the unreviewed New row");
  const reloaded = new CommandCenterStore({ jiraSyncLockManager: null, ...deps });
  ok(group, newKeys(reloaded) === "N-4", "a full reload (fresh store hydrated from storage) still shows it");
  await v226Tick();
  setJira([...base, bobs, v226Actionable("N-4")]);
  await store.syncJira();
  ok(group, newKeys(store) === "N-4", "a later sync with nothing new does not move the baseline or clear the row");

  // Explicit acknowledgment.
  store.markDailyReviewSeen(["N-4"]);
  ok(group, newKeys(store) === "", "'Seen' hides the row");
  ok(group, /markDailyReviewSeen\(\[r\.ticketKey\]\)/.test(reviewSrc) && /markDailyReviewSeen\(review\.newRows\.map\(\(r\) => r\.ticketKey\)\)/.test(reviewSrc) && />\s*Seen\s*</.test(reviewSrc) && /Mark all reviewed/.test(reviewSrc), "the page offers per-row 'Seen' and 'Mark all reviewed', both persisting reviewedAt per ticketKey");

  // A new mention after the acknowledgment brings it back, labeled with the author.
  await v226Tick();
  const mentionAt = new Date(Date.now() + 1000).toISOString();
  setJira([...base, bobs, v226Actionable("N-4")], [{ issueKey: "N-4", commentId: "c-n4", commentAuthor: "Anna", excerpt: "please check", mentionedAt: mentionAt }]);
  await store.syncJira();
  const afterMention = pageReview(store);
  ok(group, afterMention.newRows.length === 1 && newReasonLabel(afterMention.newRows[0].reasons) === "Mentioned by Anna", "a new mention after 'Seen' makes the ticket New again, labeled 'Mentioned by Anna'");
  store.markDailyReviewSeen(afterMention.newRows.map((r) => r.ticketKey), new Date(Date.now() + 2000).toISOString());
  ok(group, newKeys(store) === "", "'Mark all reviewed' clears every listed row");

  // Reassignment of an EXISTING ticket to me.
  await v226Tick();
  setJira([...base, v226Actionable("N-BOB", { owner: "Tay", ownerId: "acc-tay" }), v226Actionable("N-4")], []);
  await store.syncJira();
  const reassigned = pageReview(store).newRows.find((r) => r.ticketKey === "N-BOB");
  ok(group, !!reassigned && reassigned.reasons.length === 1 && newReasonLabel(reassigned.reasons) === "Assigned to you", "reassigning an existing ticket to me → it appears in New as 'Assigned to you'");
  const bobItem = store.getSnapshot().data.workItems.find((w) => w.key === "N-BOB")!;
  ok(group, !!bobItem.assignedToMeAt && bobItem.firstSeenAt === st.syncLog[0].completedAt, "the ticket keeps its original firstSeenAt; only assignedToMeAt is stamped");
  await v226Tick();
  setJira([...base, v226Actionable("N-BOB", { owner: "Tay", ownerId: "acc-tay" }), v226Actionable("N-4")], []);
  await store.syncJira();
  ok(group, store.getSnapshot().data.workItems.find((w) => w.key === "N-BOB")!.assignedToMeAt === bobItem.assignedToMeAt, "assignedToMeAt is carried forward unchanged by later syncs");
  store.markDailyReviewSeen(["N-BOB"]);

  // Leaving and re-entering scope: no false New rows.
  await v226Tick();
  setJira([v226Actionable("N-1"), v226Actionable("N-4")], []); // a full sync without N-2/N-3/N-BOB
  await store.syncJira({ full: true });
  ok(group, !store.getSnapshot().data.workItems.some((w) => w.key === "N-2"), "control: the full sync dropped N-2 from the local store");
  await v226Tick();
  setJira([...base, v226Actionable("N-BOB", { owner: "Tay", ownerId: "acc-tay" }), v226Actionable("N-4")], []);
  await store.syncJira({ full: true });
  const back = store.getSnapshot();
  ok(group, newKeys(store) === "", `tickets re-entering the dataset produce no New rows — got: ${newKeys(store) || "none"}`);
  ok(group, back.data.workItems.find((w) => w.key === "N-2")?.firstSeenAt === st.syncLog[0].completedAt && back.syncLog[back.syncLog.length - 1].newTicketKeys.length === 0, "…they keep their original firstSeenAt and are not listed as newTicketKeys");
  // The Focus-scope variant: narrow scope to another project, sync, widen back, sync.
  store.setJiraProjectScope("FOCUSED", ["OTHER"]);
  await v226Tick();
  setJira([], []);
  await store.syncJira({ full: true });
  store.setJiraProjectScope("ALL");
  await v226Tick();
  setJira([...base, v226Actionable("N-BOB", { owner: "Tay", ownerId: "acc-tay" }), v226Actionable("N-4")], []);
  await store.syncJira({ full: true });
  ok(group, newKeys(store) === "", "removing the project from Focus scope and re-adding it → no false New rows");

  // Completed / skipped / blocked never appear in New — even when new for every reason, after a full sync.
  await v226Tick();
  const later = new Date(Date.now() + 5000).toISOString();
  const fresh = ["N-C", "N-S", "N-B"].map((k) => v226Actionable(k));
  setJira([...base, ...fresh, v226Actionable("N-BOB", { owner: "Tay", ownerId: "acc-tay" }), v226Actionable("N-4")], fresh.map((w) => ({ issueKey: w.key, commentId: `c-${w.key}`, commentAuthor: "Anna", excerpt: "x", mentionedAt: later })));
  await store.syncJira({ full: true });
  ok(group, newKeys(store) === "N-B,N-C,N-S", "control: three brand-new, mentioned tickets are New");
  store.completeTicketInDailyCommand("N-C");
  store.skipTicketInDailyCommand("N-S");
  store.blockTicketInDailyCommand("N-B");
  await v226Tick();
  await store.syncJira({ full: true });
  ok(group, newKeys(store) === "", "once completed/skipped/blocked they never appear in New, even after a full sync re-delivers them with their mentions");

  // Legacy install: only the pre-A3 dailyReviewLastVisitAt → the next sync pins the baseline from it.
  const legacy = v226ConfiguredStore({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [] });
  legacy.setJira(base);
  await legacy.store.syncJira();
  legacy.store.markDailyReviewVisited("2026-01-01T00:00:00.000Z");
  await v226Tick();
  await legacy.store.syncJira();
  ok(group, legacy.store.getSnapshot().dailyReviewBaselineAt === "2026-01-01T00:00:00.000Z", "a pre-A3 install's last visit becomes the pinned baseline (no migration step)");
}



// ===== A4 — Skip/Block lifecycle: re-check day, age, auto-move to Completed when Jira closes =====
{
  const group = "A4 Skip/Block lifecycle";
  const tay = { accountId: "acc-tay", displayName: "Tay" };
  const { store, setJira } = v226ConfiguredStore({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [] });
  const items = ["L-1", "L-2", "L-3", "L-4", "L-5"].map((k) => v226Actionable(k));
  setJira(items);
  await store.syncJira();
  const reviewAt = (now: Date) => {
    const st = store.getSnapshot();
    const view = buildProjectOverrideView(st, getTodayIso(), "V226");
    return buildDailyReview({ workItems: view.filteredData.workItems, identity: tay, workRelevanceIndex: view.workRelevanceIndex, dailyCommandCompletions: st.dailyCommandCompletions, dailyCommandSkips: st.dailyCommandSkips, dailyCommandBlocks: st.dailyCommandBlocks, memoryEvents: st.memoryEvents, mentionEvents: st.mentionEvents, attentionState: st.attentionState, syncLog: st.syncLog, baselineAt: st.dailyReviewBaselineAt, reviewAcks: st.dailyReviewAcks, now });
  };
  const today = getTodayIso();
  const tomorrow = addDays(today, 1);
  const tomorrowDate = new Date(tomorrow + "T09:00:00");

  // --- revisitOn = tomorrow ---
  store.skipTicketInDailyCommand("L-1", "Not my action", tomorrow);
  ok(group, store.getSnapshot().dailyCommandSkips["L-1"].revisitOn === tomorrow, "skip accepts an optional revisitOn");
  const todayReview = reviewAt(new Date());
  ok(group, !todayReview.dueForRecheck.some((r) => r.ticketKey === "L-1") && todayReview.skipped.some((r) => r.ticketKey === "L-1"), "today: not in 'Due for re-check' — still listed under Skipped");
  const tomorrowReview = reviewAt(tomorrowDate);
  ok(group, tomorrowReview.dueForRecheck.some((r) => r.ticketKey === "L-1" && r.kind === "skipped") && !tomorrowReview.skipped.some((r) => r.ticketKey === "L-1"), "tomorrow: listed under 'Due for re-check today' (and not duplicated under Skipped)");
  ok(group, "L-1" in store.getSnapshot().dailyCommandSkips && resolveTaskExecutionState("L-1", store.getSnapshot()).kind === "skipped", "reaching the re-check day changes nothing by itself — the ticket is still skipped");
  // A re-check day that has arrived: still excluded from Action Plan / Attention / every active surface.
  store.blockTicketInDailyCommand("L-2", "Waiting on Anna", today);
  ok(group, reviewAt(new Date()).dueForRecheck.some((r) => r.ticketKey === "L-2" && r.kind === "blocked"), "a block whose re-check day is today is due today");
  const leaks = ["L-1", "L-2"].flatMap((k) => v226ActiveSurfaces(store, k, Date.now()).map((s) => `${k}@${s}`));
  ok(group, leaks.length === 0, `due-for-re-check tickets stay excluded from Action Plan, Attention and every other active surface until I act${leaks.length ? ` — leaked: ${leaks.join(", ")}` : ""}`);
  ok(group, v226ActiveSurfaces(store, "L-5", Date.now()).length > 0, "control: an untouched ticket is active");
  store.skipTicketInDailyCommand("L-3", undefined, "not-a-date");
  ok(group, store.getSnapshot().dailyCommandSkips["L-3"].revisitOn === undefined, "an invalid revisitOn is ignored, never stored");
  const dueRow = renderToStaticMarkup(React.createElement(TaskReferenceRowView, { ticketKey: "L-2", execution: resolveTaskExecutionState("L-2", store.getSnapshot()) }));
  ok(group, dueRow.includes("re-check due"), "a due row says so in its label");
  const trSrc = fs.readFileSync(path.join(process.cwd(), "src/components/command-center/TaskReferenceRow.tsx"), "utf8");
  const drSrc = fs.readFileSync(path.join(process.cwd(), "src/app/my-work/page.tsx"), "utf8");
  ok(group, /type="date"/.test(trSrc) && /skipTicketInDailyCommand\(ticketKey, reason, revisitOn(, surface)?\)/.test(trSrc) && /blockTicketInDailyCommand\(ticketKey, reason, revisitOn(, pingOn)?(, surface)?\)/.test(trSrc), "the Skip/Block pickers offer an optional re-check date, wired through to the store");
  ok(group, /Due for re-check today/.test(drSrc) && /review\.dueForRecheck\.map/.test(drSrc) && /recheckDue/.test(drSrc), "My Work's New view lists what is due for a re-check today (pointing at the Blocked / Skipped view each ticket lives in, where due rows sort first)");

  // --- Age on every Skipped/Blocked row ---
  const monday = new Date(2026, 8, 28, 10, 0);
  const sixDays: TaskExecutionState = { kind: "blocked", at: new Date(2026, 8, 18, 11, 0).toISOString(), reason: "Waiting on Anna" };
  ok(group, formatExecutionRecord(sixDays, monday)!.startsWith("Blocked 6 business days — Waiting on Anna"), `a block from Fri Sep 18 read on Mon Sep 28 shows "Blocked 6 business days — Waiting on Anna" (got: ${formatExecutionRecord(sixDays, monday)})`);
  ok(group, formatPausedAge(new Date(2026, 8, 28, 8, 0).toISOString(), monday) === "today" && formatPausedAge(new Date(2026, 8, 25, 8, 0).toISOString(), monday) === "1 business day" && formatPausedAge("garbage", monday) === undefined, "age reads 'today' / '1 business day' and is omitted for an unparseable time");
  ok(group, formatExecutionRecord({ kind: "skipped", at: new Date(2026, 8, 24, 9, 0).toISOString() }, monday)!.startsWith("Skipped 2 business days"), "a skip with no reason still shows its age");
  const blockedRow = renderToStaticMarkup(React.createElement(TaskReferenceRowView, { ticketKey: "L-2", execution: sixDays, now: monday }));
  ok(group, blockedRow.includes("Blocked 6 business days — Waiting on Anna"), "the shared row (used by every Skipped/Blocked list) renders the age");

  // --- Jira closes a blocked/skipped ticket → it moves to Completed, record kept ---
  await v226Tick();
  setJira(items.map((w) => (w.key === "L-2" ? { ...w, status: "Done" as const, jiraStatusName: "Done" } : w.key === "L-1" ? { ...w, status: "Done" as const, jiraStatusName: "Done" } : w)));
  await store.syncJira();
  const st = store.getSnapshot();
  ok(group, !("L-2" in st.dailyCommandBlocks) && !("L-1" in st.dailyCommandSkips), "closed in Jira → it leaves the Blocked / Skipped lists");
  const c2 = st.dailyCommandCompletions["L-2"];
  ok(group, c2?.source === "jira" && c2.closedInJiraOn === today && c2.previousState?.kind === "blocked" && c2.previousState.reason === "Waiting on Anna", "…and is recorded as completed with source 'jira', the close day, and the block it replaced (kept, not lost)");
  ok(group, !!st.dailyCommandTombstones.blocks["L-2"], "the removed block is tombstoned, so another device's stale copy can't resurrect it");
  const afterClose = reviewAt(new Date());
  const closedRow = afterClose.completedRecently.find((r) => r.ticketKey === "L-2");
  ok(group, !afterClose.blocked.some((r) => r.ticketKey === "L-2") && !afterClose.dueForRecheck.some((r) => r.ticketKey === "L-2") && !!closedRow && closedRow.sources.join(",") === "jira", "Daily Review: gone from Blocked/Due, present in Completed recently with source Jira");
  const closedLabel = formatExecutionRecord(resolveTaskExecutionState("L-2", st));
  ok(group, /^Closed in Jira on [A-Z][a-z]{2} \d{1,2} — was Blocked: Waiting on Anna$/.test(closedLabel ?? ""), `the row reads "Closed in Jira on <date> — was Blocked: …" (got: ${closedLabel})`);
  // EXCLUDED is not "closed".
  store.setJiraStatusRelevance("Parked", "EXCLUDED");
  store.blockTicketInDailyCommand("L-4");
  await v226Tick();
  setJira(items.map((w) => (w.key === "L-4" ? { ...w, jiraStatusName: "Parked" } : w)));
  await store.syncJira();
  ok(group, "L-4" in store.getSnapshot().dailyCommandBlocks, "a ticket moved to an EXCLUDED status is not treated as closed — the block stays");
  // Pure function, directly.
  const pure = closePausedTicketsFinishedInJira(
    { P: { ticketKey: "P", status: "SKIPPED", updatedAt: "2026-09-01T00:00:00.000Z", history: [] } },
    [{ key: "P", status: "In Progress", sourceType: "jira", projectId: "jira-project-X", jiraStatusName: "In Progress" }],
    undefined,
    "2026-09-02T00:00:00.000Z",
    "2026-09-02"
  );
  ok(group, pure.closedKeys.length === 0 && pure.states.P.status === "SKIPPED", "an open ticket is never moved");
}



// ===== B1–B5 — reports that are usable as-is, and one release number everywhere =====
{
  const group = "B Reports & release truth";
  const noUndefined = (s: string) => !/undefined|null|NaN|\[object Object\]/.test(s);
  const tay = { accountId: "acc-tay", displayName: "Tay" };
  const iso = () => ({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [] });

  // ---------- B1: ticket-level actions reach the report ----------
  {
    const { store, setJira } = v226ConfiguredStore(iso());
    setJira(["R-X", "R-Y", "R-Z", "R-W"].map((k) => v226Actionable(k)));
    await store.syncJira();
    store.completeTicketInDailyCommand("R-X");
    store.skipTicketInDailyCommand("R-Y", "Not my action");
    store.blockTicketInDailyCommand("R-Z", "Waiting on Anna's API answer");
    const st = store.getSnapshot();
    const kinds = st.memoryEvents.filter((e) => e.kind.startsWith("TICKET_")).map((e) => `${e.kind}:${e.ticketKey}`);
    ok(group, kinds.join(",") === "TICKET_COMPLETED:R-X,TICKET_SKIPPED:R-Y,TICKET_BLOCKED:R-Z", `complete/skip/block each emit a MemoryEvent (got ${kinds.join(",")})`);
    const skipEv = st.memoryEvents.find((e) => e.kind === "TICKET_SKIPPED")!;
    ok(group, skipEv.reason === "Not my action" && skipEv.ticketTitle === "Ticket R-Y" && skipEv.projectName === "V226 Project" && skipEv.ticketUrl === "https://jira.example.com/browse/R-Y" && skipEv.assigneeId === "acc-tay", "events capture reason, title, project, link and assignee at that moment");
    store.unblockTicketInDailyCommand("R-Z");
    store.blockTicketInDailyCommand("R-Z", "Waiting on Anna's API answer");
    store.skipTicketInDailyCommand("R-W");
    store.reactivateSkippedTicket("R-W");
    ok(group, ["TICKET_UNBLOCKED", "TICKET_REACTIVATED"].every((k) => store.getSnapshot().memoryEvents.some((e) => e.kind === k)), "unblock and reactivate are recorded too");

    const snap = store.generateDailyReport(getTodayIso(), true);
    ok(group, !!snap.standup && snap.events.some((e) => e.kind === "TICKET_COMPLETED"), "today's generated report freezes both the ticket events and the standup state");
    const view = buildDailyReportView(snap, getTodayIso(), tay);
    ok(group, view.doneMine.some((t) => t.key === "R-X" && (t.notes ?? []).includes("via Daily Command")), "Mark completed (button) → listed in that day's Done (mine), labelled 'via Daily Command'");
    ok(group, view.skipped.some((t) => t.key === "R-Y" && t.notes?.[0] === "Not my action") && view.blocked.some((t) => t.key === "R-Z" && t.notes?.[0] === "Waiting on Anna's API answer" && t.ageBusinessDays === 0), "skipped / blocked tickets are listed with their reasons (and age)");
    ok(group, !view.inProgress.some((t) => ["R-X", "R-Y", "R-Z"].includes(t.key ?? "")) && view.inProgress.some((t) => t.key === "R-W"), "In progress lists only still-active assigned work");
    const fromEventsOnly = buildDailyReportView({ ...snap, standup: undefined }, getTodayIso(), tay);
    ok(group, !fromEventsOnly.standupAvailable && fromEventsOnly.skipped.some((t) => t.key === "R-Y" && t.notes?.[0] === "Not my action") && fromEventsOnly.blocked.some((t) => t.key === "R-Z") && !fromEventsOnly.skipped.some((t) => t.key === "R-W"), "a day without a standup snapshot still lists that day's skips/blocks from events (a reactivated skip is not listed)");
    // Reopen the same day → no longer Done.
    store.reopenTicketInDailyCommand("R-X");
    const reopened = buildDailyReportView(store.generateDailyReport(getTodayIso(), true), getTodayIso(), tay);
    ok(group, !reopened.doneMine.some((t) => t.key === "R-X"), "completed then reopened the same day → not listed as Done");
  }
  // De-duplication: Action completion + ticket button, same day, same ticket.
  {
    const ev = (kind: MemoryEvent["kind"], extra: Partial<MemoryEvent> = {}): MemoryEvent => ({ id: `${kind}-${Math.random()}`, date: "2026-10-01", kind, title: kind, impact: "", evidence: [], ...extra });
    const snap: DailyReportSnapshot = { date: "2026-10-01", generatedAt: "2026-10-01T18:00:00.000Z", events: [ev("ACTION_COMPLETED", { title: "Action completed: chase API", ticketKey: "D-1", projectName: "Pay" }), ev("TICKET_COMPLETED", { ticketKey: "D-1", ticketTitle: "Login fix", ticketUrl: "https://j/D-1", projectName: "Pay" }), ev("ACTION_COMPLETED", { title: "Action completed: send recap" })] };
    const v = buildDailyReportView(snap, "2026-10-01", tay);
    ok(group, v.doneMine.filter((t) => t.key === "D-1").length === 1 && v.doneMine.find((t) => t.key === "D-1")?.title === "Login fix", "a ticket completed via an Action AND via the ticket button the same day is listed once (with the ticket's title)");
    ok(group, v.doneMine.some((t) => !t.key && t.title === "Action completed: send recap"), "an Action with no ticket is still listed");
  }

  // ---------- B2: Jira completion accuracy ----------
  {
    const { store, setJira } = v226ConfiguredStore(iso());
    store.setJiraStatusRelevance("Parked", "EXCLUDED");
    const base = [v226Actionable("J-MINE"), v226Actionable("J-TEAM", { owner: "Bob", ownerId: "acc-bob" }), v226Actionable("J-EXCL"), v226Actionable("J-SAT"), v226Actionable("J-NORES")];
    setJira(base);
    await store.syncJira();
    await v226Tick();
    const saturday = new Date(2026, 8, 26, 15, 30).toISOString(); // Sat Sep 26 2026, local
    setJira([
      v226Actionable("J-MINE", { status: "Done", jiraStatusName: "Done", resolvedAt: new Date().toISOString() }),
      v226Actionable("J-TEAM", { owner: "Bob", ownerId: "acc-bob", status: "Done", jiraStatusName: "Done", resolvedAt: new Date().toISOString() }),
      v226Actionable("J-EXCL", { jiraStatusName: "Parked" }),
      v226Actionable("J-SAT", { status: "Done", jiraStatusName: "Done", resolvedAt: saturday }),
      v226Actionable("J-NORES", { status: "Done", jiraStatusName: "Done" }),
    ]);
    await store.syncJira();
    const st = store.getSnapshot();
    const evOf = (key: string) => st.memoryEvents.filter((e) => e.ticketKey === key && e.kind.startsWith("JIRA_"));
    ok(group, evOf("J-EXCL").length === 1 && evOf("J-EXCL")[0].kind === "JIRA_REMOVED_FROM_SCOPE", "a ticket moved to an EXCLUDED status → a 'Removed from scope' event, never JIRA_STATUS_COMPLETED");
    ok(group, evOf("J-SAT")[0]?.date === "2026-09-26" && evOf("J-SAT")[0].datedBy === "resolution" && !!st.dailyReports["2026-09-26"]?.events.some((e) => e.ticketKey === "J-SAT"), "resolved Saturday, synced today → the event is dated Saturday and lands in Saturday's report");
    ok(group, evOf("J-NORES")[0]?.date === getTodayIso() && evOf("J-NORES")[0].datedBy === "detection", "no resolutiondate → dated by the detection day, marked as detected");
    ok(group, evOf("J-TEAM")[0]?.assigneeId === "acc-bob" && evOf("J-MINE")[0]?.assigneeId === "acc-tay", "the assignee is stored on the event");
    const view = buildDailyReportView(store.generateDailyReport(getTodayIso(), true), getTodayIso(), tay);
    ok(group, view.doneMine.some((t) => t.key === "J-MINE" && t.notes?.[0] === "in Jira") && !view.teamDone.some((t) => t.key === "J-MINE"), "my ticket closed in Jira → Done (mine), labelled 'in Jira'");
    ok(group, view.teamDone.some((t) => t.key === "J-TEAM" && t.assignee === "Bob") && !view.doneMine.some((t) => t.key === "J-TEAM"), "a teammate's ticket closed in Jira → only in the Team section");
    ok(group, !view.doneMine.some((t) => t.key === "J-EXCL") && !view.teamDone.some((t) => t.key === "J-EXCL") && view.removedFromScope.some((t) => t.key === "J-EXCL"), "the EXCLUDED ticket is not Done anywhere — it is listed under 'Removed from scope'");
    ok(group, view.doneMine.find((t) => t.key === "J-NORES")?.notes?.[0] === `in Jira (detected ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][new Date().getMonth()]} ${new Date().getDate()})`, "a detection-dated completion says 'detected <date>'");
    const md = renderDailyReport(view, "markdown", { includeTeam: false });
    ok(group, !md.includes("J-TEAM") && renderDailyReport(view, "markdown").includes("J-TEAM"), "the Team section is optional in exports");
    // Jira fields.
    const httpSrc = fs.readFileSync(path.join(process.cwd(), "src/lib/command-center/jira/http.ts"), "utf8");
    ok(group, /resolutiondate,statuscategorychangedate/.test(httpSrc), "ISSUE_FIELDS requests resolutiondate and statuscategorychangedate");
    const issue = jiraIssueSchema.parse({ id: "1", key: "N-1", fields: { summary: "S", status: { name: "Done", statusCategory: { key: "done" } }, project: { key: "N" }, fixVersions: [{ name: "1.0" }, { name: "1.1" }], resolutiondate: "2026-09-26T10:00:00.000+0000", customfield_10020: [{ name: "Sprint 6", state: "closed" }, { name: "Sprint 7", state: "active" }] } });
    const n = normalizeIssue(issue, { today: "2026-10-01", sprintFieldId: "customfield_10020" }).workItem;
    ok(group, n.resolvedAt === "2026-09-26T10:00:00.000+0000" && JSON.stringify(n.fixVersions) === '["1.0","1.1"]' && n.fixVersion === "1.0" && n.sprint === "Sprint 7", "normalize keeps resolutiondate, every fix version (first still in fixVersion) and the ACTIVE sprint from the configured field");
    ok(group, parseSprintFieldValue(["com.atlassian.greenhopper.service.sprint.Sprint@1[id=3,rapidViewId=1,state=CLOSED,name=Sprint 2,startDate=x]"]) === "Sprint 2" && parseSprintFieldValue("junk") === undefined, "the older Server/DC string sprint format is parsed too; junk is ignored");
    ok(group, normalizeIssue(issue, { today: "2026-10-01" }).workItem.sprint === undefined, "no sprint field configured → no sprint (never guessed)");
    ok(group, isValidCustomFieldId("customfield_10020") && !isValidCustomFieldId("summary") && !isValidCustomFieldId("customfield_1; drop"), "only customfield_<digits> ids are ever sent to Jira");
    ok(group, store.setJiraSprintFieldId("customfield_10020") && store.getSnapshot().jiraSprintFieldId === "customfield_10020" && !store.setJiraSprintFieldId("Sprint") && store.getSnapshot().jiraSprintFieldId === "customfield_10020", "Data & Settings stores a valid sprint field id and refuses anything else");
  }

  // ---------- B3: export snapshots ----------
  const sampleDaily: DailyReportView = {
    date: "2026-10-01",
    doneMine: [{ key: "PAY-1", title: "Fix *login* <bug>", url: "https://jira.example.com/browse/PAY-1", project: "Payments", notes: ["via Daily Command", "in Jira"] }, { title: "Action completed: send recap", notes: ["via Daily Command"] }],
    inProgress: [{ key: "PAY-2", title: "Refund flow", url: "https://jira.example.com/browse/PAY-2", project: "Payments", notes: ["planned today"] }],
    blocked: [{ key: "PAY-3", title: "Card vault", project: "Payments", notes: ["Waiting on Anna"], ageBusinessDays: 6, waitsOn: ["Platform: API keys"], revisitOn: "2026-10-05" }],
    skipped: [{ key: "OPS-4", title: "Infra cleanup", url: "https://jira.example.com/browse/OPS-4", project: "Ops", notes: ["Team is handling it"], ageBusinessDays: 1 }],
    newToday: [{ key: "PAY-5", title: "New fraud rule", url: "https://jira.example.com/browse/PAY-5", project: "Payments", notes: ["Assigned to you"] }],
    mentionsAwaitingReply: [],
    teamDone: [{ key: "PAY-9", title: "Docs", url: "https://jira.example.com/browse/PAY-9", project: "Payments", assignee: "Bob", notes: ["in Jira"] }],
    removedFromScope: [],
    decisions: [],
    standupAvailable: true,
    identityConfigured: true,
  };
  const expectedMd = [
    "# Daily Report — 2026-10-01",
    "",
    "## Done (2)",
    "- [PAY-1](https://jira.example.com/browse/PAY-1) Fix \\*login\\* <bug> — Payments · via Daily Command · in Jira",
    "- Action completed: send recap · via Daily Command",
    "",
    "## In progress / planned today (1)",
    "- [PAY-2](https://jira.example.com/browse/PAY-2) Refund flow — Payments · planned today",
    "",
    "## Blocked (1)",
    "- **PAY-3** Card vault — Payments · 6 business days · Waiting on Anna · waits on Platform: API keys · re-check Oct 5",
    "",
    "## Skipped (1)",
    "- [OPS-4](https://jira.example.com/browse/OPS-4) Infra cleanup — Ops · 1 business day · Team is handling it",
    "",
    "## New today (1)",
    "- [PAY-5](https://jira.example.com/browse/PAY-5) New fraud rule — Payments · Assigned to you",
    "",
    "## Mentions awaiting my reply (0)",
    "- None.",
    "",
    "## Team: done (1)",
    "- [PAY-9](https://jira.example.com/browse/PAY-9) Docs — Payments · Bob · in Jira",
  ].join("\n");
  const md = renderDailyReport(sampleDaily, "markdown");
  ok(group, md === expectedMd, `daily Markdown export matches its snapshot${md === expectedMd ? "" : `\n--- got ---\n${md}`}`);
  const slack = renderDailyReport(sampleDaily, "slack");
  const expectedSlackStart = ["*Daily Report — 2026-10-01*", "", "*Done (2)*", "• <https://jira.example.com/browse/PAY-1|PAY-1> Fix *login* &lt;bug&gt; — Payments · via Daily Command · in Jira", "• Action completed: send recap · via Daily Command", ""].join("\n");
  ok(group, slack.startsWith(expectedSlackStart) && slack.includes("• *PAY-3* Card vault — Payments · 6 business days") && !/^#/m.test(slack) && !/\]\(/.test(slack), `daily Slack export uses mrkdwn (*bold*, <url|KEY>, •, &lt;/&gt; escaping), never Markdown headings/links${slack.startsWith(expectedSlackStart) ? "" : `\n--- got ---\n${slack}`}`);
  const text = renderDailyReport(sampleDaily, "text", { includeTeam: false });
  ok(group, text.startsWith("DAILY REPORT — 2026-10-01\n\nDone (2)\n- PAY-1 Fix *login* <bug> — Payments · via Daily Command · in Jira (https://jira.example.com/browse/PAY-1)") && !text.includes("PAY-9"), `daily plain-text export snapshot (links in parentheses; team omitted when asked)${text.startsWith("DAILY REPORT") ? "" : `\n${text}`}`);
  ok(group, [md, slack, text].every(noUndefined), "no 'undefined'/'null'/'NaN' in any daily export");
  const sparse = renderDailyReport({ ...sampleDaily, doneMine: [{ key: "X-1" }, {}], standupAvailable: false }, "markdown");
  ok(group, noUndefined(sparse) && sparse.includes("- **X-1**") && sparse.includes("No standup snapshot"), "tickets with missing title/link/project still render cleanly");

  // ---------- B4: weekly ----------
  {
    const day = (date: string, events: MemoryEvent[], standup?: StandupState): DailyReportSnapshot => ({ date, generatedAt: `${date}T18:00:00.000Z`, events, ...(standup ? { standup } : {}) });
    const ev = (date: string, kind: MemoryEvent["kind"], extra: Partial<MemoryEvent>): MemoryEvent => ({ id: `${date}-${kind}-${extra.ticketKey}`, date, kind, title: kind, impact: "", evidence: [], ...extra });
    const standup = (extra: Partial<StandupState> = {}): StandupState => ({ asOf: "x", inProgress: [], blocked: [], skipped: [], newToday: [], mentionsAwaitingReply: [], openAssigned: [], ...extra });
    const reports: Record<string, DailyReportSnapshot> = {
      "2026-09-28": day("2026-09-28", [ev("2026-09-28", "TICKET_COMPLETED", { ticketKey: "W-1", ticketTitle: "One", projectName: "Pay", sprint: "S7" }), ev("2026-09-28", "DECISION_MADE", { title: "Go with vendor A" })], standup({ newToday: [{ key: "W-9", title: "Fresh", notes: ["New ticket"] }] })),
      "2026-09-30": day("2026-09-30", [ev("2026-09-30", "JIRA_STATUS_COMPLETED", { ticketKey: "W-2", ticketTitle: "Two", projectName: "Ops", assigneeId: "acc-tay", sprint: "S7" }), ev("2026-09-30", "JIRA_STATUS_COMPLETED", { ticketKey: "W-3", ticketTitle: "Three", projectName: "Ops", assigneeId: "acc-bob", assigneeName: "Bob" })]),
      "2026-10-02": day(
        "2026-10-02",
        [ev("2026-10-02", "TICKET_COMPLETED", { ticketKey: "W-4", ticketTitle: "Four", projectName: "Pay", sprint: "S8" })],
        standup({
          inProgress: [{ key: "OLD-1", title: "Old one", since: "2026-09-10T09:00:00.000Z" }, { key: "NEW-1", title: "New one", since: "2026-09-29T09:00:00.000Z" }],
          blocked: [{ key: "BL-1", title: "Blocked", notes: ["Waiting on Anna"], ageBusinessDays: 4, since: "2026-09-01T09:00:00.000Z", revisitOn: "2026-10-06" }],
          skipped: [{ key: "SK-1", title: "Skipped", notes: ["Not my action"] }],
          openAssigned: [{ key: "OLD-1", title: "Old one" }, { key: "NEW-1", title: "New one" }],
        })
      ),
      "2026-10-03": day("2026-10-03", []), // Saturday report — fine, never required
    };
    const w = buildWeeklyReportView({ weekStart: "2026-09-30", dailyReports: reports, identity: tay, today: "2026-10-04" });
    ok(group, JSON.stringify(buildWeeklyReportView({ weekStart: "2026-09-28", dailyReports: {}, identity: tay, today: "2026-09-29" }).missingDays) === '["2026-09-28","2026-09-29"]', "days that haven't happened yet are never reported as missing");
    ok(group, w.weekStart === "2026-09-28" && w.weekEnd === "2026-10-02" && JSON.stringify(w.missingDays) === '["2026-09-29","2026-10-01"]', "Mon–Fri week from any day in it; only missing WEEKDAYS are gaps");
    const cal = buildWeeklyReportView({ weekStart: "2026-09-28", mode: "calendar", dailyReports: reports, identity: tay, today: "2026-10-04" });
    ok(group, cal.weekEnd === "2026-10-04" && !cal.missingDays.includes("2026-10-04") && !cal.missingDays.includes("2026-10-03"), "calendar mode covers 7 days, and a weekend day without a report is never a gap");
    ok(group, JSON.stringify(w.doneGroups.map((g) => [g.name, g.tickets.map((t) => t.key)])) === '[["Pay",["W-1","W-4"]],["Ops",["W-2"]]]', "done work is grouped per project as ticket lists, not just counts");
    ok(group, w.teamDone.map((t) => t.key).join(",") === "W-3" && w.totals.doneMine === 3 && w.totals.teamDone === 1, "team work stays in its own list");
    ok(group, w.carriedOver.map((t) => t.key).join(",") === "OLD-1,BL-1", "carried over = still open at week end and first seen before the week");
    ok(group, w.blockers[0]?.ageBusinessDays === 4 && w.skipped[0]?.notes?.[0] === "Not my action" && w.stateAsOf === "2026-10-02", "blockers with age and skipped with reason, as of the latest day with standup state");
    ok(group, w.newReceived.map((t) => t.key).join(",") === "W-9" && w.decisions.join() === "Go with vendor A", "new received this week, and decisions");
    ok(group, w.nextWeek.map((t) => t.key).join(",") === "OLD-1,NEW-1,BL-1", "next week = open assigned + tickets whose re-check falls next week");
    const bySprint = buildWeeklyReportView({ weekStart: "2026-09-28", groupBy: "sprint", dailyReports: reports, identity: tay, today: "2026-10-04" });
    ok(group, JSON.stringify(bySprint.doneGroups.map((g) => [g.name, g.tickets.length])) === '[["S7",2],["S8",1]]', "group by sprint");
    for (const format of ["markdown", "slack", "text"] as const) {
      const out = renderWeeklyReport(w, format);
      ok(group, noUndefined(out) && out.includes("W-1") && out.includes("Waiting on Anna") && out.includes("missing: 2026-09-29, 2026-10-01"), `weekly ${format} export lists tickets, reasons and gaps, with no 'undefined'`);
    }
    ok(group, renderWeeklyReport(w, "markdown").split("\n").slice(0, 4).join("\n") === "# Weekly Report — 2026-09-28 to 2026-10-02\n\n## Totals\n- Done (mine): 3", "weekly Markdown header snapshot");
    ok(group, !renderWeeklyReport(w, "slack", { includeTeam: false }).includes("W-3"), "team section optional in the weekly export too");
  }

  // ---------- B5: one release number everywhere ----------
  {
    const items: WorkItem[] = [
      makeItem({ id: "rel-1", key: "REL-1", fixVersion: "2.0", status: "Done", jiraStatusName: "Done", sourceType: "jira", projectId: "jira-project-REL" }),
      makeItem({ id: "rel-2", key: "REL-2", fixVersion: "2.0", status: "In Progress", jiraStatusName: "Ready for UAT", sourceType: "jira", projectId: "jira-project-REL" }),
      makeItem({ id: "rel-3", key: "REL-3", fixVersion: "2.0", status: "In Progress", jiraStatusName: "In Progress", sourceType: "jira", projectId: "jira-project-REL", owner: "Tay", blocked: true, blockerReason: "Flagged in Jira" }),
      makeItem({ id: "rel-4", key: "REL-4", fixVersion: "2.0", status: "In Progress", jiraStatusName: "Parked", sourceType: "jira", projectId: "jira-project-REL" }),
      makeItem({ id: "rel-5", key: "REL-5", fixVersion: "2.0", fixVersions: ["2.0", "2.1"], status: "To Do", jiraStatusName: "To Do", sourceType: "jira", projectId: "jira-project-REL" }),
    ];
    const relData = { ...emptyData(), workItems: items };
    const index = buildWorkRelevanceIndex({ ...DEFAULT_WORK_RELEVANCE_POLICY_MAP, "Ready for UAT": "COMPLETED", Parked: "EXCLUDED" });
    const truth = selectReleaseHealth(relData, "2.0", TODAY, index);
    ok(group, truth.totalItems === 4 && truth.completedItems === 2 && truth.completionPct === 50 && truth.excludedItems === 1, "release truth = Done + COMPLETED (2 of 4); the EXCLUDED item leaves the denominator");
    const dcIds = new Set(["rel-3"]);
    ok(group, computeReleaseHealth(relData, "2.0", TODAY, index, dcIds).completionPct === truth.completionPct && selectAllReleaseHealth(relData, TODAY, index).find((r) => r.fixVersion === "2.0")!.completionPct === 50, "personally 'completing' an open release ticket does not change the release %");
    ok(group, selectReleaseHealth(relData, "2.1", TODAY, index).totalItems === 1 && selectAllReleaseHealth(relData, TODAY, index).some((r) => r.fixVersion === "2.1"), "an item with several fix versions counts in each of them");
    ok(group, JSON.stringify(truth.remainingByStatus?.map((g) => [g.status, g.items.map((i) => i.key)])) === '[["In Progress",["REL-3"]],["To Do",["REL-5"]]]' && truth.blockers?.[0]?.key === "REL-3" && truth.blockers[0].assignee === "Tay", "remaining open items are grouped by status with assignee; blockers listed");
    // Every surface, same %.
    const panel = renderToStaticMarkup(React.createElement(ReleaseHealthPanel, { data: relData, today: TODAY, workRelevanceIndex: index, dailyCommandCompletedWorkItemIds: dcIds }));
    const askFacts = answerFromRoute({ intent: "release-risk", target: "2.0" }, relData, deriveData(relData, null, TODAY), TODAY, "jira", undefined, undefined, undefined, index, {}, dcIds).facts;
    const pctOf = (draft: ArtifactDraft | null) => draft?.sections.find((s) => s.heading === "Completion")?.segments[0]?.text;
    const commandBarDraft = buildReleaseUpdateDraft(selectReleaseHealth(relData, "2.0", TODAY, index), relData);
    const rebuilt = rebuildDraftFromSourceRef({ type: "release", fixVersion: "2.0" }, "Release Health", relData, deriveData(relData, null, TODAY), {} as never, null, TODAY, index);
    const exported = renderReleaseUpdate(truth, "markdown");
    const seen = [panel.includes("Completion: 50%"), askFacts.includes("Completion: 50%"), pctOf(commandBarDraft)?.startsWith("50%"), pctOf(rebuilt)?.startsWith("50%"), exported.includes("Completion: 50%")];
    ok(group, seen.every(Boolean), `Panel, Ask, CommandBar draft, rebuilt release update draft and the release export all show 50% for 2.0 (${seen.join(",")})`);
    const sources = ["src/components/command-center/CommandBar.tsx", "src/components/command-center/ReleaseHealthPanel.tsx", "src/lib/command-center/communicate.ts", "src/lib/command-center/query-router.ts", "src/lib/command-center/proactive.ts", "src/lib/command-center/release-drift.ts", "src/lib/command-center/store.ts"].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8"));
    ok(group, sources.every((s) => !/computeReleaseHealth\(|computeAllReleaseHealth\(/.test(s)) && /<ReleaseHealthPanel data=\{filteredData\} today=\{today\} workRelevanceIndex=\{workRelevanceIndex\} \/>/.test(fs.readFileSync(path.join(process.cwd(), "src/app/page.tsx"), "utf8")), "every caller goes through selectReleaseHealth / selectAllReleaseHealth, and the dashboard panel gets the Work Relevance index");
    // Drift scope added/removed.
    const prevSnap = { date: "2026-09-30", workItems: items.filter((w) => w.key !== "REL-5").concat([makeItem({ id: "rel-6", key: "REL-6", fixVersion: "2.0" })]), risks: [], requirements: [], dependencies: [], projects: [] };
    const drift = computeReleaseDrift([truth], prevSnap, TODAY, index, items).find((d) => d.fixVersion === "2.0");
    ok(group, JSON.stringify(drift?.scopeAdded) === '["REL-5"]' && JSON.stringify(drift?.scopeRemoved) === '["REL-6"]', "release drift lists tickets added to / removed from the release since the last snapshot");
    const slackRel = renderReleaseUpdate(truth, "slack", drift);
    const expectedRelSlack = [
      "*Release update — 2.0*",
      "",
      "• Completion: 50% (2/4 done in Jira) · 1 excluded from scope",
    ].join("\n");
    ok(group, slackRel.startsWith(expectedRelSlack) && slackRel.includes("*Blockers (1)*") && slackRel.includes("• *REL-3*") && slackRel.includes("• Added: REL-5") && !/^#/m.test(slackRel), `release Slack export snapshot${slackRel.startsWith(expectedRelSlack) ? "" : `\n${slackRel}`}`);
    ok(group, exported.startsWith("# Release update — 2.0\n\n- Completion: 50% (2/4 done in Jira) · 1 excluded from scope") && exported.includes("## Remaining (2)") && exported.includes("**In Progress (1)**"), "release Markdown export snapshot");
    ok(group, [slackRel, exported, panel].every(noUndefined), "no 'undefined' in release outputs");
  }

  const reportsPage = fs.readFileSync(path.join(process.cwd(), "src/app/reports/page.tsx"), "utf8");
  const nav = fs.readFileSync(path.join(process.cwd(), "src/components/command-center/Nav.tsx"), "utf8");
  ok(group, /href: "\/reports"/.test(nav) && /type="date"/.test(reportsPage) && /Week of/.test(reportsPage) && /renderDailyReport/.test(reportsPage) && /renderWeeklyReport/.test(reportsPage), "the /reports page is in the nav, with a day picker for daily and a week picker for weekly");
  const closeDay = fs.readFileSync(path.join(process.cwd(), "src/components/command-center/CloseDayModal.tsx"), "utf8");
  const weeklyPage = fs.readFileSync(path.join(process.cwd(), "src/app/weekly-review/page.tsx"), "utf8");
  ok(group, /dailyReportToMarkdown/.test(closeDay) && /weeklyReportToMarkdown/.test(weeklyPage), "Close Day and Weekly Review keep their existing copy buttons");
}



// ===== C3 — functional smoke test of every page (demo data + a seeded Jira-like dataset) =====
// Every route is rendered with react-dom/server against the REAL app store (live state, see
// store.renderLiveStateOnServerForTests). Asserted per page: renders without a runtime error,
// no "undefined"/"NaN" leaks, and every ticket row links to Jira when the ticket has a Jira URL
// (never an empty/"undefined" href). Then every ticket action the rows expose (complete,
// reopen, skip, reactivate, block, unblock, Daily Review "Seen") is run through the exact
// functions the buttons call, and each result is checked again after a reload.
{
  const group = "C3 Page smoke";
  // A browser-like origin for this block: one localStorage that the app store and a "reloaded"
  // store share (so reload checks hit real persistence), and React as a global for the pages'
  // JSX (Next compiles it away; tsx's classic transform needs it in scope).
  const smokeStorage = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => smokeStorage.get(k) ?? null,
      setItem: (k: string, v: string) => void smokeStorage.set(k, v),
      removeItem: (k: string) => void smokeStorage.delete(k),
    },
  };
  (globalThis as unknown as { React: typeof React }).React = React;
  const routes: [string, string][] = [
    ["/", "../../src/app/page.tsx"],
    ...["my-work", "priorities", "action-plan", "attention", "risks", "dependencies", "changes", "loops", "decisions", "meeting", "reports", "weekly-review", "memory", "data-settings"].map((r): [string, string] => [`/${r}`, `../../src/app/${r}/page.tsx`]),
  ];
  const pages = await Promise.all(routes.map(async ([route, mod]) => [route, (await import(mod)).default as React.ComponentType] as const));
  const failures: string[] = [];

  const jiraPayloadItems = ["SMK-1", "SMK-2", "SMK-3", "SMK-4"].map((k, i) =>
    v226JiraItem(k, { projectId: "jira-project-SMK", jiraStatusName: "In Progress", priority: "P1", dueDate: "2026-01-05", businessImpact: 5, fixVersion: "SMK 1.0", blocked: i === 3, blockerReason: i === 3 ? "Flagged in Jira" : undefined })
  );
  const realFetch = globalThis.fetch;
  const seedJira = async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/api/command-center/jira/sync")) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: { ...emptyData(), projects: [{ id: "jira-project-SMK", name: "Smoke Project", clientId: "c-1", status: "on-track", sourceType: "jira", sourceId: "SMK" }], workItems: jiraPayloadItems, dependencies: [{ id: "jira-dep-1", workItemId: "jira-SMK-4", description: "API keys", dependsOnTeam: "Platform", status: "unresolved", raisedDate: "2026-01-01" }] },
            recordsFetched: jiraPayloadItems.length,
            syncedAt: new Date().toISOString(),
            mentionEvents: [{ issueKey: "SMK-2", commentId: "c-smk", commentAuthor: "Anna", excerpt: "can you check?", mentionedAt: new Date().toISOString() }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ ok: false }), { status: 503 });
    }) as typeof fetch;
    commandCenterStore.setPersonalIdentity({ displayName: "Tay", accountId: "acc-tay" });
    commandCenterStore.setJiraStatusRelevance("In Progress", "ACTIONABLE");
    const r = await commandCenterStore.syncJira({ full: true });
    globalThis.fetch = realFetch;
    return r.ok;
  };

  for (const dataset of ["demo", "jira"] as const) {
    commandCenterStore.resetAll();
    if (dataset === "demo") commandCenterStore.loadDemoData();
    else ok(group, await seedJira(), "the Jira-like dataset syncs into the real store");
    if (dataset === "jira") {
      commandCenterStore.blockTicketInDailyCommand("SMK-4", "Waiting on Platform");
      commandCenterStore.skipTicketInDailyCommand("SMK-3", "Not my action");
    }
    commandCenterStore.renderLiveStateOnServerForTests(true);
    let rowsChecked = 0;
    for (const [route, Page] of pages) {
      let html = "";
      try {
        html = renderToStaticMarkup(React.createElement(Page));
      } catch (err) {
        failures.push(`${dataset} ${route}: runtime error — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const text = html.replace(/<[^>]+>/g, " ");
      if (/\bundefined\b|\bNaN\b|\[object Object\]/.test(text)) failures.push(`${dataset} ${route}: renders "undefined"/"NaN" text`);
      if (/href="(undefined|null|)"/.test(html)) failures.push(`${dataset} ${route}: empty/undefined href`);
      // Every ticket row: if its ticket has a Jira URL, the row links to it.
      for (const m of html.matchAll(/data-task-row="([^"]+)"([\s\S]*?)(?=data-task-row="|$)/g)) {
        const key = m[1];
        const item = commandCenterStore.getSnapshot().data.workItems.find((w) => w.key === key);
        rowsChecked++;
        if (item?.sourceUrl && !m[2].includes(`href="${item.sourceUrl}"`)) failures.push(`${dataset} ${route}: ticket ${key} row has no working Jira link`);
      }
    }
    commandCenterStore.renderLiveStateOnServerForTests(false);
    ok(group, rowsChecked > 0, `[${dataset}] ticket rows were actually rendered and checked (${rowsChecked})`);
  }
  ok(group, failures.length === 0, `every page renders cleanly with demo data and with Jira data${failures.length ? `:\n   - ${failures.join("\n   - ")}` : ""}`);
  // /daily-review and /focus keep working: each is a server redirect to its My Work view.
  for (const [route, target] of [["daily-review", "/my-work?view=new"], ["focus", "/my-work?view=today"]] as const) {
    const Redirect = (await import(`../../src/app/${route}/page.tsx`)).default as () => never;
    let digest = "";
    try {
      Redirect();
    } catch (err) {
      digest = String((err as { digest?: string }).digest ?? "");
    }
    ok(group, digest.startsWith("NEXT_REDIRECT;") && digest.includes(`;${target};`), `/${route} redirects to ${target} (got: ${digest})`);
  }

  // Jira dataset is loaded now — exercise every row action, each surviving a reload.
  const reload = () => new CommandCenterStore().getSnapshot();
  const steps: [string, () => void, (s: StoreState) => boolean][] = [
    ["Mark completed", () => storeActionsFor("SMK-1").onComplete(), (s) => "SMK-1" in s.dailyCommandCompletions],
    ["Reopen", () => storeActionsFor("SMK-1").onReopen(), (s) => !("SMK-1" in s.dailyCommandCompletions)],
    ["Skip (reason + re-check)", () => storeActionsFor("SMK-1").onSkip("Team is handling it", "2026-12-01"), (s) => s.dailyCommandSkips["SMK-1"]?.reason === "Team is handling it" && s.dailyCommandSkips["SMK-1"]?.revisitOn === "2026-12-01"],
    ["Reactivate", () => storeActionsFor("SMK-1").onReactivateSkip(), (s) => !("SMK-1" in s.dailyCommandSkips)],
    ["Block (reason)", () => storeActionsFor("SMK-1").onBlock("Waiting for a reply"), (s) => s.dailyCommandBlocks["SMK-1"]?.reason === "Waiting for a reply"],
    ["Unblock", () => storeActionsFor("SMK-1").onUnblock(), (s) => !("SMK-1" in s.dailyCommandBlocks)],
    ["Seen (Daily Review)", () => commandCenterStore.markDailyReviewSeen(["SMK-2"]), (s) => !!s.dailyReviewAcks["SMK-2"]],
  ];
  for (const [label, act, check] of steps) {
    act();
    const live = check(commandCenterStore.getSnapshot());
    const reloaded = check(reload());
    ok(group, live && reloaded, `"${label}" changes state and the change survives a reload (live ${live}, reloaded ${reloaded})`);
  }
  delete (globalThis as unknown as { window?: unknown }).window;
  const reportsSrc = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8");
  ok(group, /## Page smoke test/.test(reportsSrc), "README lists the page smoke-test results");
}



// ===== C1 / C2 / C4 — surfaced modules, navigation, setup health + AI model config =====
{
  const group = "C Surfacing, nav & setup";
  (globalThis as unknown as { React: typeof React }).React = React;
  // C1 — follow-ups grouped per recipient.
  const twoForPlatform = [
    needsFromOthersForDependency({ dependsOnTeam: "Platform", description: "API keys", blockedItemCount: 2, ageDays: 4, releaseProximity: { fixVersion: "2.0", daysToRelease: 5 } as never }),
    ...needsFromOthersForBlockedTicket({ key: "PAY-3", title: "Card vault", dueDate: "2026-10-09" }, "Waiting on keys", [{ dependsOnTeam: "Platform", description: "Sandbox access" }]),
    needsFromOthersForWaitingFor({ who: "Legal", what: "Contract sign-off", since: "2026-09-20", ageDays: 11, expectedBy: undefined, blockedItemCount: 1, projectNames: ["Pay"] }),
  ];
  const text = renderNeedsFromOthersText(twoForPlatform);
  ok(group, (text.match(/Person\/Team: Platform/g) ?? []).length === 1 && text.includes("What I need: API keys") && text.includes("What I need: Sandbox access") && text.includes("By when: before 2.0 (in 5 day(s))") && text.includes("By when: 2026-10-09"), "Draft follow-up groups every ask to the same recipient into one message");
  ok(group, text.includes("Person/Team: Legal") && /Legal[\s\S]*By when: UNKNOWN — No owner\/deadline/.test(text), "a missing deadline reads UNKNOWN, never guessed");
  const noDeps = needsFromOthersForBlockedTicket({ key: "X-1" }, "Waiting for a reply", []);
  ok(group, noDeps.length === 1 && noDeps[0].person === "UNKNOWN" && noDeps[0].what === "Unblock X-1" && noDeps[0].why === "X-1 is blocked: Waiting for a reply.", "a blocked ticket with no known dependency still gets a follow-up, recipient UNKNOWN");
  const blockedView = renderToStaticMarkup(React.createElement(TaskReferenceRowView, { ticketKey: "X-1", execution: { kind: "blocked", reason: "Waiting for a reply" }, followUpRows: noDeps }));
  const activeView = renderToStaticMarkup(React.createElement(TaskReferenceRowView, { ticketKey: "X-1", execution: { kind: "active" }, followUpRows: noDeps }));
  ok(group, blockedView.includes("Draft follow-up") && !activeView.includes("Draft follow-up"), "Blocked rows carry a 'Draft follow-up' button (only when blocked)");
  const depCard = renderToStaticMarkup(React.createElement(DependencyRadarCard, { item: { dependencyId: "d1", description: "API keys", dependsOnTeam: "Platform", ageDays: 3, blockedItemCount: 1, blockedHighPriorityCount: 0, heat: "WARM", recommended: "Chase it" } as never }));
  ok(group, depCard.includes("Draft follow-up"), "Dependency cards carry 'Draft follow-up'");
  ok(group, /needsFromOthersForWaitingFor/.test(fs.readFileSync(path.join(process.cwd(), "src/components/command-center/WaitingFor.tsx"), "utf8")), "Waiting For rows (and the whole list, one message per person) carry 'Draft follow-up'");
  // C1 — "If nothing changes" on loops and action plan rows; evidence on changes.
  const loopCard = renderToStaticMarkup(React.createElement(DeliveryLoopCard, { loop: { id: "l1", issue: "Vendor delay", health: "STALLED", why: "No action for 5 days", nowWhat: "Escalate" } as never }));
  ok(group, loopCard.includes("If nothing changes"), "Loop cards show the 'If nothing changes' block");
  const planSrc = fs.readFileSync(path.join(process.cwd(), "src/components/command-center/PlanCandidateRow.tsx"), "utf8");
  ok(group, /projectActionImpact\(/.test(planSrc) && /triggerLabel="If nothing changes"/.test(planSrc) && /repeatedlyIneffective\(/.test(planSrc) && /Repeated without effect/.test(planSrc), "Action Plan rows show 'If nothing changes' and a 'Repeated without effect' badge");
  ok(group, /buildActionStrategyFacts\(/.test(fs.readFileSync(path.join(process.cwd(), "src/app/weekly-review/page.tsx"), "utf8")), "Weekly Review has an 'Actions repeated without effect' section built from buildActionStrategyFacts");
  const changeCard = renderToStaticMarkup(React.createElement(ChangeItem, { change: { id: "c1", entityType: "WorkItem", entityId: "w1", entityLabel: "PAY-1", field: "Status", before: "To Do", after: "Blocked", impact: "Blocked now", date: "2026-10-01" } as never }));
  ok(group, changeCard.includes("Evidence (1)") && changeCard.includes("Status: &quot;To Do&quot; → &quot;Blocked&quot;"), "ChangeItem has an evidence drawer (evidenceForChange)");

  // C2 — grouped navigation, nothing removed.
  const flat = NAV_GROUPS.flatMap((g) => g.links.map((l) => l.href));
  const expectedRoutes = ["/", "/my-work", "/meeting", "/attention", "/loops", "/priorities", "/changes", "/risks", "/dependencies", "/action-plan", "/decisions", "/weekly-review", "/reports", "/data-settings"];
  ok(group, expectedRoutes.every((r) => flat.includes(r)) && flat.length === expectedRoutes.length, "every previous nav destination is still there, exactly once");
  ok(group, JSON.stringify(NAV_GROUPS.map((g) => g.label)) === '["Today","Work queues","Project insight","Reports","Settings"]' && JSON.stringify(NAV_GROUPS[0].links.map((l) => l.href)) === '["/my-work","/"]' && JSON.stringify(NAV_GROUPS[1].links.map((l) => l.href)) === '["/priorities","/action-plan","/attention"]' && JSON.stringify(NAV_GROUPS[3].links.map((l) => l.href)) === '["/reports","/weekly-review"]', "groups follow the morning workflow: Today (My Work → Command Center), Work queues, Project insight, Reports, Settings");
  const navStore = new CommandCenterStore({ jiraSyncLockManager: null, stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [] });
  navStore.getSnapshot();
  navStore.setDefaultLandingPage("/daily-review");
  navStore.setDefaultLandingPage("/not-a-page");
  ok(group, navStore.getSnapshot().defaultLandingPage === "/daily-review" && LANDING_PAGES.includes("/reports") && parseStoredState(JSON.stringify({ defaultLandingPage: "/evil" })).defaultLandingPage === undefined, "the landing page is configurable, limited to real routes");
  const navSrc = fs.readFileSync(path.join(process.cwd(), "src/components/command-center/Nav.tsx"), "utf8");
  ok(group, /computeMyWorkBadge\(\)/.test(navSrc) && /data-nav-badge/.test(navSrc) && /router\.replace\(landing\)/.test(navSrc), "My Work shows a badge (unreviewed New + due re-checks); the app opens on the configured page");
  const { store: badgeStore, setJira: badgeJira } = v226ConfiguredStore({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [] });
  badgeJira([v226Actionable("BG-1")]);
  await badgeStore.syncJira();
  await v226Tick();
  badgeJira([v226Actionable("BG-1"), v226Actionable("BG-2")]);
  await badgeStore.syncJira();
  badgeStore.blockTicketInDailyCommand("BG-1", "x", getTodayIso());
  const rv = badgeStore.computeDailyReview();
  ok(group, rv.newRows.length + rv.dueForRecheck.length === 2, "badge count = 1 unreviewed New (BG-2) + 1 re-check due today (BG-1)");

  // C4 — setup health.
  const idx = buildWorkRelevanceIndex(DEFAULT_WORK_RELEVANCE_POLICY_MAP);
  const fine = { configured: true, serverSideNotifyActive: true } as never;
  const rowsFor = (extras: Parameters<typeof computeSetupHealthRows>[5], source: "jira" | "demo" = "jira") => computeSetupHealthRows({ id: "i", displayName: "T", accountId: "a" }, source, emptyData(), idx, fine, extras).map((r) => r.id);
  ok(group, !rowsFor({ crossDevice: { enabledOrEverPaired: false, status: { configured: false, paired: false } } }).includes("cross-device"), "cross-device row never shows for someone who never turned sync on");
  ok(group, rowsFor({ crossDevice: { enabledOrEverPaired: true, status: { configured: false, paired: false } } }).includes("cross-device") && rowsFor({ crossDevice: { enabledOrEverPaired: true, status: { configured: true, paired: false } } }).includes("cross-device") && !rowsFor({ crossDevice: { enabledOrEverPaired: true, status: { configured: true, paired: true } } }).includes("cross-device") && !rowsFor({ crossDevice: { enabledOrEverPaired: true, status: null } }).includes("cross-device"), "cross-device row: shown when enabled/ever paired but not configured or not paired; hidden while loading or when fine");
  ok(group, rowsFor({ sprintFieldMapped: false }).includes("sprint-field") && !rowsFor({ sprintFieldMapped: false }, "demo").includes("sprint-field") && !rowsFor({ sprintFieldMapped: true }).includes("sprint-field"), "sprint-field row only on a Jira install without a mapped field");
  ok(group, rowsFor({ ai: { available: true, modelFromEnv: false, fastModelFromEnv: true, model: "claude-opus-5-5" } }).includes("ai-model") && !rowsFor({ ai: { available: true, modelFromEnv: true, fastModelFromEnv: true } }).includes("ai-model") && !rowsFor({ ai: { available: false } }).includes("ai-model") && !rowsFor({ ai: null }).includes("ai-model"), "AI model row when a key is set but the model env isn't; never when AI is off or still loading");
  ok(group, !computeSetupHealthRows(undefined, "demo", emptyData(), idx, fine).some((r) => r.id === "identity") && computeSetupHealthRows(undefined, "jira", emptyData(), idx, fine).some((r) => r.id === "identity"), "identity row is gated to dataSource === 'jira'");
  // C4 — AI model from env.
  ok(group, resolveAiModel("analyzePriorities", {}).model === DEFAULT_AI_MODEL && resolveAiModel("interpretTrend", {}).model === DEFAULT_AI_MODEL_FAST && DEFAULT_AI_MODEL === "claude-sonnet-5-5" && DEFAULT_AI_MODEL_FAST === "claude-haiku-4-5", "defaults (V2.36 H4): a mid-cost model for the default tier, a cheaper one for short tasks");
  ok(group, resolveAiModel("analyzePriorities", { ANTHROPIC_MODEL: "claude-sonnet-5-5" }).model === "claude-sonnet-5-5" && resolveAiModel("interpretTrend", { ANTHROPIC_MODEL_FAST: "claude-sonnet-5-5" }).model === "claude-sonnet-5-5" && resolveAiModel("analyzePriorities", { ANTHROPIC_MODEL: "bad model; rm" }).model === DEFAULT_AI_MODEL, "ANTHROPIC_MODEL / ANTHROPIC_MODEL_FAST override the defaults; a malformed value is ignored");
  const routeSrc = fs.readFileSync(path.join(process.cwd(), "src/app/api/command-center/ai/route.ts"), "utf8");
  const runnerSrc = fs.readFileSync(path.join(process.cwd(), "src/lib/command-center/ai/server-runner.ts"), "utf8");
  ok(group, !/"claude-[a-z0-9.-]+"/.test(routeSrc) && !/"claude-[a-z0-9.-]+"/.test(runnerSrc) && /resolveAiModel\(task/.test(runnerSrc), "the AI route (and its server runner) never hardcodes a model id");
}



// ===== V2.30 (Prompt D) — seven toggleable helpers =====
{
  const group = "D Toggleable helpers";
  const src = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
  const iso = () => ({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [] });
  const tay = { accountId: "acc-tay", displayName: "Tay" };

  // ---- toggles ----
  // F4 (V2.34) — Jira write-back is OFF by default by design (it writes to Jira).
  // V2.36 H — Ticket AI is OFF by default too (it sends ticket content to the model).
  ok(group, Object.entries(DEFAULT_FEATURE_TOGGLES).every(([k, v]) => v === (k !== "staleUseMyActivity" && k !== "jiraWriteBack" && k !== "ticketAi")), "every feature defaults ON except 'staleness from my own activity' (and Jira write-back, Ticket AI)");
  const parsedToggles = parseStoredState(JSON.stringify({ features: { morningBrief: false, keyboardTriage: "yes", bogus: true } })).features;
  ok(group, parsedToggles.morningBrief === false && parsedToggles.keyboardTriage === true && !("bogus" in parsedToggles) && parseStoredState("{}").features.reportExport === true, "stored toggles parse defensively; pre-D state gets the defaults");
  const settingsSrc = src("src/app/data-settings/page.tsx");
  ok(group, Object.keys(DEFAULT_FEATURE_TOGGLES).every((k) => settingsSrc.includes(`key: "${k}"`)) && /store\.setFeatureToggle\(key, e\.target\.checked\)/.test(settingsSrc), "each of the 7 features has a toggle in Data & Settings");
  const readme = src("README.md");
  ok(group, ["Morning Brief", "Keyboard triage", "Sync history", "Mention reply tracking", "Follow-up reminders", "No ticket activity", "Send reports to Slack"].every((t) => readme.includes(t)), "each feature has a README entry");

  // ---- D1 Morning Brief ----
  const tue = new Date(2026, 8, 29, 8, 30); // Tue Sep 29
  const mon = new Date(2026, 8, 28, 8, 30); // Mon Sep 28
  ok(group, morningBriefSince(tue).getDate() === 28 && morningBriefSince(tue).getHours() === 18 && morningBriefSinceLabel(morningBriefSince(tue), tue) === "Since yesterday 18:00", "Tuesday morning: since yesterday (Monday) 18:00");
  ok(group, morningBriefSince(mon).getDate() === 25 && morningBriefSinceLabel(morningBriefSince(mon), mon) === "Since Fri 18:00", "Monday morning: since Friday 18:00 — the weekend isn't 'yesterday'");
  const at = (d: number, h: number) => new Date(2026, 8, d, h, 0).toISOString();
  const briefItems = [
    v226Actionable("MB-NEW", { firstSeenAt: at(28, 20) }),
    v226Actionable("MB-OLD", { firstSeenAt: at(28, 9) }),
    v226Actionable("MB-ASG", { firstSeenAt: at(1, 9), assignedToMeAt: at(29, 7) }),
    v226Actionable("MB-TEAM", { owner: "Bob", ownerId: "acc-bob", firstSeenAt: at(29, 7) }),
  ];
  const brief = buildMorningBrief({
    workItems: briefItems,
    identity: tay,
    mentionEvents: [{ issueKey: "MB-OLD", commentId: "m1", excerpt: "x", mentionedAt: at(28, 19) }, { issueKey: "MB-OLD", commentId: "m0", excerpt: "x", mentionedAt: at(28, 10) }],
    memoryEvents: [
      { id: "e1", date: "2026-09-29", kind: "JIRA_STATUS_COMPLETED", title: "", impact: "", evidence: [], ticketKey: "T-9", assigneeId: "acc-bob" },
      { id: "e2", date: "2026-09-29", kind: "JIRA_STATUS_COMPLETED", title: "", impact: "", evidence: [], ticketKey: "MB-MINE", assigneeId: "acc-tay" },
    ],
    dailyCommandSkips: { S: { ticketKey: "S", skippedAt: at(1, 9), revisitOn: "2026-09-29" } },
    dailyCommandBlocks: { B: { ticketKey: "B", blockedAt: at(1, 9), revisitOn: "2026-10-05" } },
    now: tue,
  });
  ok(group, morningBriefSentence(brief) === "Since yesterday 18:00: 1 new, 1 assigned, 1 mention, 1 due re-check, 1 closed by team", `the brief header counts only what happened since the boundary (got: ${morningBriefSentence(brief)})`);
  ok(group, brief.counts.find((c) => c.id === "new")!.href === "#review-new" && brief.counts.find((c) => c.id === "recheck")!.href === "#review-due" && brief.counts.find((c) => c.id === "team-closed")!.href === "/reports", "each count is a jump link");
  ok(group, shouldRunMorningBrief(true, "2026-09-28", "2026-09-29") && !shouldRunMorningBrief(true, "2026-09-29", "2026-09-29") && !shouldRunMorningBrief(false, undefined, "2026-09-29"), "the one-click flow runs once per day, only when on");
  const navSrc = src("src/components/command-center/Nav.tsx");
  const reviewSrc = src("src/app/my-work/page.tsx");
  ok(group, /shouldRunMorningBrief\(state\.features\.morningBrief/.test(navSrc) && /syncJira\(\{ trigger: "auto" \}\)/.test(navSrc) && /MORNING_BRIEF_LANDING = "\/my-work\?view=new"/.test(navSrc) && /router\.replace\(MORNING_BRIEF_LANDING\)/.test(navSrc) && /data-morning-brief/.test(reviewSrc) && /id="review-new"/.test(reviewSrc) && /id="review-due"/.test(reviewSrc), "opening the app syncs and lands on My Work → New, whose header carries the brief");

  // ---- D2 Keyboard triage ----
  const rows = [{ ticketKey: "A", url: "https://j/A", reviewable: true, actionable: true }, { ticketKey: "B", reviewable: false, actionable: true }];
  ok(group, JSON.stringify(triageCommand("j", rows, 0)) === '{"kind":"move","index":1}' && JSON.stringify(triageCommand("J", rows, 1)) === '{"kind":"move","index":1}' && JSON.stringify(triageCommand("k", rows, 0)) === '{"kind":"move","index":0}', "J/K move and clamp at the ends");
  ok(group, triageCommand("c", rows, 0).kind === "complete" && triageCommand("s", rows, 1).kind === "skip" && triageCommand("b", rows, 1).kind === "block" && triageCommand("r", rows, 0).kind === "reviewed" && JSON.stringify(triageCommand("o", rows, 0)) === '{"kind":"open","url":"https://j/A"}', "C/S/B/R/O map to complete / skip / block / reviewed / open in Jira");
  ok(group, triageCommand("r", rows, 1).kind === "none" && triageCommand("o", rows, 1).kind === "none" && triageCommand("c", rows, 0, { inTextField: true }).kind === "none" && triageCommand("c", rows, 0, { meta: true }).kind === "none" && triageCommand("x", rows, 0).kind === "none" && triageCommand("j", [], 0).kind === "none", "R only on New rows, O only with a link; typing in a field, modifier keys and other keys do nothing");
  ok(group, /useTriageKeys\(triageOn, triageRows, runTriage\)/.test(reviewSrc) && /state\.features\.keyboardTriage/.test(reviewSrc) && /markDailyReviewSeen\(\[cmd\.ticketKey\]\)/.test(reviewSrc), "Daily Review wires the keys to the store, behind the toggle");

  // ---- D3 Sync history ----
  let hist = rollDailySyncSummary({}, "2026-09-29", { at: "t1", newTickets: 2, assignedToMe: 1, closed: 0 });
  hist = rollDailySyncSummary(hist, "2026-09-29", { at: "t2", newTickets: 1, assignedToMe: 0, closed: 3 });
  hist = rollDailySyncSummary({ ...hist, "2026-06-01": { date: "2026-06-01", syncs: 1, newTickets: 0, assignedToMe: 0, closed: 0 } }, "2026-09-30", { at: "t3", newTickets: 0, assignedToMe: 0, closed: 0 });
  ok(group, JSON.stringify(hist["2026-09-29"]) === '{"date":"2026-09-29","syncs":2,"newTickets":3,"assignedToMe":1,"closed":3,"lastSyncAt":"t2"}' && !hist["2026-06-01"] && listDailySyncSummaries(hist)[0].date === "2026-09-30", "syncs roll into a per-day summary; days older than 90 are dropped");
  {
    const { store, setJira } = v226ConfiguredStore(iso());
    setJira([v226Actionable("SH-1")]);
    await store.syncJira();
    await v226Tick();
    setJira([v226Actionable("SH-1", { status: "Done", jiraStatusName: "Done" }), v226Actionable("SH-2")]);
    await store.syncJira();
    const day = store.getSnapshot().dailySyncSummary[getTodayIso()];
    ok(group, day?.syncs === 2 && day.newTickets === 2 && day.closed === 1, `each sync is recorded in today's summary (got ${JSON.stringify(day)})`);
    store.setFeatureToggle("syncHistory", false);
    await store.syncJira();
    ok(group, store.getSnapshot().dailySyncSummary[getTodayIso()].syncs === 2, "with the toggle off, nothing new is recorded");
    ok(group, /data-sync-history/.test(settingsSrc) && /listDailySyncSummaries\(state\.dailySyncSummary\)/.test(settingsSrc), "the history is visible in Data & Settings");
  }

  // ---- D4 Mention reply tracking ----
  const m = { issueKey: "MR-1", commentId: "c1", mentionedAt: "2026-09-29T10:00:00.000Z" };
  ok(group, isMentionReplied(m, { c1: { commentId: "c1", issueKey: "MR-1", repliedAt: "x", source: "manual" } }, {})?.source === "manual", "marked 'Replied' by hand");
  ok(group, isMentionReplied(m, {}, { "MR-1": { lastCommentAt: "2026-09-29T11:00:00.000Z" } })?.source === "jira" && !isMentionReplied(m, {}, { "MR-1": { lastCommentAt: "2026-09-29T09:00:00.000Z" } }), "auto-detected: my comment on the same issue AFTER the mention counts; an earlier one doesn't");
  ok(group, latestOwnCommentAt([{ author: { accountId: "acc-tay" }, created: "2026-09-29T08:00:00.000Z" }, { author: { accountId: "acc-bob" }, created: "2026-09-29T12:00:00.000Z" }, { author: { accountId: "acc-tay" }, created: "2026-09-29T11:00:00.000Z" }], "acc-tay") === "2026-09-29T11:00:00.000Z", "the sync finds my own latest comment among the comments it already fetched");
  {
    let payload: DataSourceSyncResult = { ok: true, data: emptyData(), recordsFetched: 0 };
    const store = new CommandCenterStore({ createJiraDataSource: () => ({ type: "jira", sync: async () => payload }), jiraSyncLockManager: null, ...iso() });
    store.getSnapshot();
    store.setPersonalIdentity({ displayName: "Tay", accountId: "acc-tay" });
    store.setJiraStatusRelevance("In Progress", "ACTIONABLE");
    const mentionAt = new Date(Date.now() - 3600_000).toISOString();
    payload = {
      ok: true,
      data: { ...emptyData(), projects: [{ id: "jira-project-V226", name: "V226 Project", clientId: "c-1", status: "on-track", sourceType: "jira", sourceId: "V226" } as never], workItems: [v226Actionable("MR-1"), v226Actionable("MR-2")] },
      recordsFetched: 2,
      syncedAt: new Date().toISOString(),
      mentionEvents: [{ issueKey: "MR-1", commentId: "c-mr1", commentAuthor: "Anna", excerpt: "?", mentionedAt: mentionAt }, { issueKey: "MR-2", commentId: "c-mr2", commentAuthor: "Bo", excerpt: "?", mentionedAt: mentionAt }],
      myActivity: { "MR-1": { lastCommentAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() } },
    };
    await store.syncJira();
    const awaiting = () => store.buildLiveStandup().mentionsAwaitingReply.map((t) => t.key).join(",");
    ok(group, awaiting() === "MR-2" && !!store.getSnapshot().myTicketActivity["MR-1"]?.lastCommentAt, "a mention I already answered in Jira leaves 'awaiting my reply' automatically");
    store.markMentionReplied("c-mr2", "MR-2");
    ok(group, awaiting() === "" && store.getSnapshot().mentionReplies["c-mr2"]?.source === "manual", "marking 'Replied' removes the other one");
    store.setFeatureToggle("mentionReplyTracking", false);
    ok(group, awaiting() === "MR-1,MR-2" || awaiting() === "MR-2,MR-1", "with the toggle off, reply tracking is not applied");
    const merged = mergeSyncedAppState(extractSyncedAppState(store.getSnapshot(), "t"), { ...extractSyncedAppState(store.getSnapshot(), "t"), mentionReplies: { other: { commentId: "other", issueKey: "X", repliedAt: "z", source: "manual" } } });
    ok(group, !!merged.mentionReplies?.["c-mr2"] && !!merged.mentionReplies?.["other"], "'Replied' marks sync across devices (grow-only merge)");
  }
  ok(group, /latestOwnCommentAt\(commentsResult\.data, accountId\)/.test(src("src/app/api/command-center/jira/sync/route.ts")) && /markMentionReplied\(m\.commentId, m\.issueKey\)/.test(src("src/components/command-center/RecentlyMentioned.tsx")), "the sync route reports my comments; Recently Mentioned offers 'Replied'");

  // ---- D5 Follow-up reminders ----
  {
    const { store, setJira } = v226ConfiguredStore(iso());
    setJira([v226Actionable("FU-1"), v226Actionable("FU-2")]);
    await store.syncJira();
    store.blockTicketInDailyCommand("FU-1", "Waiting on Anna", undefined, getTodayIso());
    store.blockTicketInDailyCommand("FU-2", "Waiting on Bo", undefined, addDays(getTodayIso(), 2));
    store.blockTicketInDailyCommand("FU-3", "x", undefined, "nope");
    const st = store.getSnapshot();
    ok(group, st.dailyCommandBlocks["FU-1"].pingOn === getTodayIso() && st.dailyCommandBlocks["FU-3"].pingOn === undefined, "Block accepts an optional 'ping on' date (invalid dates ignored)");
    const due = dueFollowUps(st.dailyCommandBlocks, getTodayIso(), st.data.workItems);
    ok(group, due.map((d) => d.ticketKey).join(",") === "FU-1" && due[0].url === "https://jira.example.com/browse/FU-1" && due[0].reason === "Waiting on Anna", "only follow-ups whose ping date has come are due");
    const sent: unknown[][] = [];
    const deps = { slackConfigured: async () => true, send: async (s: unknown[]) => (sent.push(s), { sent: true }) };
    const first = await runFollowUpRemindersOnce(store, deps as never);
    const second = await runFollowUpRemindersOnce(store, deps as never);
    ok(group, first === 1 && second === 0 && sent.length === 1 && (sent[0][0] as { kind: string }).kind === "FOLLOW_UP", "the Slack reminder goes out once per ticket per ping date");
    store.blockTicketInDailyCommand("FU-1", "Waiting on Anna", undefined, getTodayIso());
    ok(group, (await runFollowUpRemindersOnce(store, { slackConfigured: async () => false, send: deps.send } as never)) === 0, "nothing is sent when Slack isn't configured");
    store.setFeatureToggle("followUpReminders", false);
    ok(group, (await runFollowUpRemindersOnce(store, deps as never)) === 0, "nothing is sent with the toggle off");
    ok(group, renderSlackText({ issueKey: "FU-1", summary: "Card vault", kind: "FOLLOW_UP", detail: "blocked: Waiting on Anna", url: "https://j/FU-1" }) === "⏰ Follow-up due: FU-1 — Card vault — blocked: Waiting on Anna (https://j/FU-1)" && slackSignalSchema.safeParse({ issueKey: "a", summary: "b", kind: "FOLLOW_UP", detail: "c" }).success, "the notify route renders FOLLOW_UP reminders");
    ok(group, /id="review-followups"/.test(reviewSrc) && /dueFollowUps\(dailyCommandMaps\.dailyCommandBlocks/.test(reviewSrc) && /aria-label="Ping on \(optional\)"/.test(src("src/components/command-center/TaskReferenceRow.tsx")), "due follow-ups show in Daily Review; the Block picker offers 'Ping on'");
  }

  // ---- D6 Staleness wording + my activity ----
  const staleItem = v226Actionable("ST-1", { lastUpdated: "2026-09-21" });
  const byTicket = computeStaleAssignedTickets([staleItem], "2026-09-29");
  const byMe = computeStaleAssignedTickets([v226Actionable("ST-1", { lastUpdated: "2026-09-29" })], "2026-09-29", undefined, { "ST-1": { lastActivityAt: new Date(2026, 8, 21, 10).toISOString() } });
  ok(group, byTicket[0]?.basis === "ticket" && byMe[0]?.basis === "me" && byMe[0].businessDaysSinceUpdate === 6, "without my activity, silence is measured from the ticket; with it, from my last comment/transition (even if others touched the ticket today)");
  const staleQueue = (s: StaleAssignedTicket[]) =>
    buildAttentionQueue(
      { drift: computeDeliveryDrift([], null as never), releaseDrift: [], riskEscalations: [], openRisks: [], dependencyRadar: [], decisionRadar: [], ineffectiveActions: [], stakeholderAttention: [], communicationPriority: [], staleAssignedTickets: s },
      {},
      "2026-09-29"
    ).items.find((i) => i.category === "STALE");
  ok(group, /^No ticket activity for 6 business day\(s\): /.test(staleQueue(byTicket)?.what ?? "") && /^No activity by you for 6 business day\(s\): /.test(staleQueue(byMe)?.what ?? ""), `the label reads "No ticket activity for N days" (or "No activity by you…" when measured from my activity) — got: ${staleQueue(byTicket)?.what}`);
  ok(group, /state\.features\?\.staleUseMyActivity \? state\.myTicketActivity : undefined/.test(src("src/components/command-center/use-command-center.ts")), "my-activity staleness is applied only when its toggle is on");
  ok(group, /author: jiraUserSchema/.test(src("src/lib/command-center/jira/types.ts")) && /h\.author\?\.accountId === requestAccountId/.test(src("src/app/api/command-center/jira/sync/route.ts")), "changelog entries carry their author, so my transitions count as my activity where the changelog was fetched");

  // ---- D7 Report export ----
  const draft = emailDraftUrl("Daily Report — 2026-09-29", "Done (1)\n- PAY-1 Fix & ship", "me@example.com");
  ok(group, draft.url === "mailto:me%40example.com?subject=Daily%20Report%20%E2%80%94%202026-09-29&body=Done%20(1)%0A-%20PAY-1%20Fix%20%26%20ship" && !draft.truncated, "email export is a mailto: DRAFT with encoded subject/body");
  ok(group, emailDraftUrl("s", "x".repeat(5000)).truncated && slackReportText("y".repeat(50000)).length <= 35000, "long reports are shortened for mailto/Slack, and say so");
  const reportsPageSrc = src("src/app/reports/page.tsx");
  ok(group, /window\.confirm\("Send this report to the Slack channel/.test(reportsPageSrc) && /sendReportToSlack\(slackReportText\(render\("slack"\)\)\)/.test(reportsPageSrc) && /state\.features\.reportExport && <ShareButtons/.test(reportsPageSrc), "Send to Slack needs an explicit click + confirmation, behind the toggle");
  ok(group, /report: z\.object\(\{ text: z\.string\(\)\.min\(1\)\.max\(40000\) \}\)/.test(src("src/app/api/command-center/notify/route.ts")), "reports go through the existing notify route (which holds the webhook)");
}
