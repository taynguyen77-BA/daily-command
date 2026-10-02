// E1 — data durability: Export / Import backup, Reset safeguards, persistent storage, backup
// reminder, Setup Health "no backup" row.
// Run through scripts/tests/run.mts (npm test).

import fs from "node:fs";
import path from "node:path";
import { CommandCenterStore, getTodayIso, parseStoredState, type StoreState } from "../../src/lib/command-center/store";
import { createMemoryStateStorage } from "../../src/lib/command-center/state-persistence";
import { slug } from "../../src/lib/command-center/attention-queue";
import { addDays } from "../../src/lib/command-center/date-utils";
import {
  BACKUP_FORMAT,
  backupCounts,
  buildBackup,
  isBackupReminderDue,
  mergeImportedState,
  parseBackup,
  replaceWithImportedState,
  serializeBackup,
} from "../../src/lib/command-center/backup";
import { requestPersistentStorage, storagePersistenceLabel } from "../../src/lib/command-center/storage-persistence";
import { computeSetupHealthRows } from "../../src/components/command-center/SetupHealthBanner";
import { buildWorkRelevanceIndex } from "../../src/lib/command-center/jira/work-relevance";
import { DATA_SCHEMA_VERSION, DEFAULT_FEATURE_TOGGLES, emptyData } from "../../src/lib/command-center/types";
import { ok } from "./harness.mts";
import { v226Actionable, v226ConfiguredStore, v226Tick } from "./helpers.mts";

/** A store with real history: Jira data, every ticket status, a Focus Session, reports, sync log. */
async function seededStore() {
  const storage = createMemoryStateStorage();
  const deps = { stateStorage: storage, stateChannel: null, stateFocusTargets: [] };
  const { store, setJira } = v226ConfiguredStore(deps);
  setJira(["BK-1", "BK-2", "BK-3", "BK-4", "BK-5"].map((k) => v226Actionable(k)));
  await store.syncJira();
  const today = getTodayIso();
  store.startTicket("BK-1", "my-work");
  store.blockTicketInDailyCommand("BK-2", "Waiting on Anna", undefined, undefined, "my-work");
  store.skipTicketInDailyCommand("BK-3", "Not my action", undefined, "my-work");
  store.deferTicket("BK-4", addDays(today, 2), undefined, "my-work");
  const planId = store.addPersonalPlanItem({ sourceType: "attention", sourceId: `ASSIGNMENT:${slug("jira-BK-5")}`, estimatedMinutes: 15, plannedDate: today, priority: 0 });
  store.startFocusItem(planId, today);
  store.completeFocusItem(planId, today);
  store.generateDailyReport(today, true);
  await v226Tick();
  return { store, storage, deps, today };
}

const comparable = (s: StoreState) =>
  JSON.stringify({
    ticketWorkStates: s.ticketWorkStates,
    dailyReports: s.dailyReports,
    memoryEvents: s.memoryEvents,
    syncLog: s.syncLog,
    personalPlan: s.personalPlan,
    actions: s.data.actions,
    attentionState: s.attentionState,
    workItems: s.data.workItems.map((w) => w.key),
  });

// ----- AC: Export → Reset → Import restores identical ticket statuses, reports, history -----
{
  const group = "E1 Backup round trip";
  const { store } = await seededStore();
  const before = store.getSnapshot();
  ok(group, Object.keys(before.ticketWorkStates).length === 5 && Object.keys(before.dailyReports).length === 1 && before.syncLog.length > 0, "sanity: the seeded store has 5 ticket states, a daily report and a sync log");

  const file = serializeBackup(buildBackup(before, "2026-10-02T09:00:00.000Z"));
  const json = JSON.parse(file);
  ok(group, json.format === BACKUP_FORMAT && json.schemaVersion === DATA_SCHEMA_VERSION && json.exportedAt === "2026-10-02T09:00:00.000Z", "the file carries format, schemaVersion and exportedAt");
  ok(
    group,
    ["ticketWorkStates", "personalPlan", "attentionState", "memoryEvents", "dailyReports", "syncLog", "features", "data"].every((k) => k in json.state) && Array.isArray(json.state.data.actions),
    "the file holds the full state: ticketWorkStates, personalPlan, actions, attentionState, memoryEvents, dailyReports, syncLog, settings"
  );

  store.resetAll();
  ok(group, Object.keys(store.getSnapshot().ticketWorkStates).length === 0 && store.getSnapshot().memoryEvents.length === 0, "Reset clears everything");

  const parsed = parseBackup(file);
  ok(group, parsed.ok, "the exported file parses back");
  if (parsed.ok) {
    ok(group, parsed.counts.ticketStates === 5 && parsed.counts.dailyReports === 1 && parsed.counts.memoryEvents === before.memoryEvents.length, "the import preview counts what the backup holds");
    store.adoptImportedState(mergeImportedState(store.getSnapshot(), parsed.state, new Date().toISOString()));
    const after = store.getSnapshot();
    ok(group, comparable(after) === comparable(before), "Merge into the reset device restores identical ticket statuses, reports, history, plan, actions and data");
    ok(group, JSON.stringify(after.ticketWorkStates["BK-2"].history) === JSON.stringify(before.ticketWorkStates["BK-2"].history), "per-ticket history (who/when/where/why) comes back byte-identical");
    ok(group, after.features.backupReminder === before.features.backupReminder && JSON.stringify(after.staleAssignedTicketThresholds) === JSON.stringify(before.staleAssignedTicketThresholds), "settings come back too");
    const replaced = replaceWithImportedState(initialLike(), parsed.state);
    ok(group, comparable(replaced) === comparable(before), "Replace restores the same state");
  }
}

function initialLike(): StoreState {
  return parseStoredState("{}");
}

// ----- Merge never blind-replaces: per-record LWW, local-only records survive -----
{
  const group = "E1 Backup merge";
  const { store } = await seededStore();
  const file = serializeBackup(buildBackup(store.getSnapshot(), new Date().toISOString()));
  await v226Tick();
  // After the backup: a newer local change to BK-1, and a brand-new local ticket state.
  store.completeTicketInDailyCommand("BK-1", "my-work");
  store.skipTicketInDailyCommand("BK-9", "Other", undefined, "my-work");
  const parsed = parseBackup(file);
  if (!parsed.ok) throw new Error(parsed.error);
  const merged = mergeImportedState(store.getSnapshot(), parsed.state, new Date().toISOString());
  ok(group, merged.ticketWorkStates["BK-1"].status === "DONE", "a ticket changed locally AFTER the backup keeps the newer local status (newest updatedAt wins)");
  ok(group, merged.ticketWorkStates["BK-9"]?.status === "SKIPPED", "a ticket state that exists only locally survives the import");
  ok(group, merged.ticketWorkStates["BK-2"].status === "BLOCKED" && merged.ticketWorkStates["BK-3"].status === "SKIPPED", "untouched tickets keep their status");
  ok(group, new Set(merged.memoryEvents.map((e) => e.id)).size === merged.memoryEvents.length, "memory events are unioned by id, never duplicated");

  // Backup newer than local for one ticket → the backup's record wins for that ticket.
  const older = parseStoredState(JSON.stringify(store.getSnapshot()));
  const backupState = parseStoredState(JSON.stringify(store.getSnapshot()));
  backupState.ticketWorkStates["BK-2"] = { ...backupState.ticketWorkStates["BK-2"], status: "TODO", updatedAt: "2999-01-01T00:00:00.000Z", history: [...backupState.ticketWorkStates["BK-2"].history, { from: "BLOCKED", to: "TODO", at: "2999-01-01T00:00:00.000Z", surface: "my-work" }] };
  const merged2 = mergeImportedState(older, backupState, new Date().toISOString());
  ok(group, merged2.ticketWorkStates["BK-2"].status === "TODO", "a record that is newer in the backup wins for that ticket only");
  ok(group, merged2.ticketWorkStates["BK-1"].status === "DONE", "…while the other tickets keep their own newest record");
}

// ----- AC: importing a backup from an older schema migrates without loss -----
{
  const group = "E1 Backup older schema";
  const legacy = {
    format: BACKUP_FORMAT,
    schemaVersion: 3,
    exportedAt: "2026-05-01T08:00:00.000Z",
    state: {
      schemaVersion: 3,
      loaded: true,
      dataSource: "jira",
      data: { ...emptyData(), workItems: [] },
      // pre-V2.18: one previous snapshot instead of a history
      previousSnapshot: { date: "2026-04-30", workItems: [], risks: [], requirements: [], dependencies: [], projects: [] },
      // pre-TicketWorkState: legacy Daily Command maps only
      dailyCommandCompletions: { "OLD-1": { ticketKey: "OLD-1", completedAt: "2026-04-30T10:00:00.000Z" } },
      dailyCommandSkips: { "OLD-2": { ticketKey: "OLD-2", skippedAt: "2026-04-30T11:00:00.000Z", reason: "Not my action" } },
      dailyCommandBlocks: { "OLD-3": { ticketKey: "OLD-3", blockedAt: "2026-04-30T12:00:00.000Z", reason: "Not enough time today" } },
      memoryEvents: [{ id: "ev-old-1", date: "2026-04-30", kind: "DECISION_MADE", title: "Old decision", impact: "", evidence: [] }],
      dailyReports: { "2026-04-30": { date: "2026-04-30", generatedAt: "2026-04-30T18:00:00.000Z", events: [] } },
      personalPlan: [],
    },
  };
  const parsed = parseBackup(JSON.stringify(legacy));
  ok(group, parsed.ok && parsed.migratedFrom === 3, "a schema-3 backup is accepted and reported as migrated");
  if (parsed.ok) {
    const s = parsed.state;
    ok(group, s.schemaVersion === DATA_SCHEMA_VERSION, "it comes in at the current schema version");
    ok(group, s.ticketWorkStates["OLD-1"]?.status === "DONE" && s.ticketWorkStates["OLD-2"]?.status === "SKIPPED" && s.ticketWorkStates["OLD-3"]?.status === "BLOCKED", "legacy completions/skips/blocks become canonical ticket states");
    ok(group, s.ticketWorkStates["OLD-2"]?.reason === "Not my action" && s.ticketWorkStates["OLD-3"]?.reason === "Not enough time today", "reasons are carried over as-is (E3: the retired 'Not enough time today' is kept, not rewritten)");
    ok(group, s.snapshotHistory.length === 1 && s.snapshotHistory[0].date === "2026-04-30", "the old single previousSnapshot becomes snapshotHistory");
    ok(group, s.memoryEvents.length === 1 && Object.keys(s.dailyReports).length === 1, "events and reports survive");
    ok(group, s.features.backupReminder === true, "settings missing from an old backup get today's defaults");
    const store = new CommandCenterStore({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [], jiraSyncLockManager: null });
    store.getSnapshot();
    store.adoptImportedState(mergeImportedState(store.getSnapshot(), s, new Date().toISOString()));
    ok(group, store.getSnapshot().ticketWorkStates["OLD-3"]?.status === "BLOCKED" && store.getSnapshot().dailyReports["2026-04-30"] !== undefined, "and it imports into a store intact");
  }
  const newer = parseBackup(JSON.stringify({ ...legacy, schemaVersion: DATA_SCHEMA_VERSION + 1 }));
  ok(group, !newer.ok && /newer version/.test(newer.error), "a backup from a NEWER schema is refused with a clear message");
}

// ----- AC: a malformed file is rejected with a clear message; state untouched -----
{
  const group = "E1 Backup malformed";
  const { store } = await seededStore();
  const before = store.getSnapshot();
  const cases: [string, string, RegExp][] = [
    ["not JSON", "{oops", /valid JSON/],
    ["a JSON array", "[]", /isn't a Command Center backup/],
    ["no format marker", JSON.stringify({ schemaVersion: 5, exportedAt: "2026-10-01T00:00:00Z", state: {} }), /format marker/],
    ["no schemaVersion", JSON.stringify({ format: BACKUP_FORMAT, exportedAt: "2026-10-01T00:00:00Z", state: { data: {} } }), /schemaVersion/],
    ["no exportedAt", JSON.stringify({ format: BACKUP_FORMAT, schemaVersion: 5, state: { data: {} } }), /exportedAt/],
    ["no state", JSON.stringify({ format: BACKUP_FORMAT, schemaVersion: 5, exportedAt: "2026-10-01T00:00:00Z" }), /no app state/],
    ["wrong type: personalPlan", JSON.stringify({ format: BACKUP_FORMAT, schemaVersion: 5, exportedAt: "2026-10-01T00:00:00Z", state: { personalPlan: "x" } }), /"personalPlan" should be a list/],
    ["wrong type: ticketWorkStates", JSON.stringify({ format: BACKUP_FORMAT, schemaVersion: 5, exportedAt: "2026-10-01T00:00:00Z", state: { ticketWorkStates: [] } }), /"ticketWorkStates" should be an object/],
    ["wrong type: data.actions", JSON.stringify({ format: BACKUP_FORMAT, schemaVersion: 5, exportedAt: "2026-10-01T00:00:00Z", state: { data: { actions: {} } } }), /"data.actions" should be a list/],
    ["no app data at all", JSON.stringify({ format: BACKUP_FORMAT, schemaVersion: 5, exportedAt: "2026-10-01T00:00:00Z", state: { foo: 1 } }), /no app data/],
  ];
  for (const [label, raw, message] of cases) {
    const r = parseBackup(raw);
    ok(group, !r.ok && message.test(r.error) && /Nothing was imported|can't be/.test(r.error), `${label}: rejected with a clear message`);
  }
  ok(group, store.getSnapshot() === before, "rejected files never touch the store (same state object)");
  const panel = fs.readFileSync(path.join(process.cwd(), "src/components/command-center/BackupPanel.tsx"), "utf8");
  ok(group, /const parsed = parseBackup\(text\);\s*if \(!parsed\.ok\) \{\s*setImportError\(parsed\.error\);\s*return;/.test(panel), "Data & Settings shows the parse error and returns before any import");
  ok(group, /data-import-preview/.test(panel) && /mode === "replace" \? replaceWithImportedState/.test(panel) && /useState<"merge" \| "replace">\("merge"\)/.test(panel), "a valid file shows a count preview and imports only on confirm — Merge by default, Replace only when picked");
  ok(group, /data-storage-persistence/.test(panel), "Backup & storage shows the storage persistence line");
}

// ----- Reset all data: offers "Export backup first" and requires typing RESET -----
{
  const group = "E1 Reset safeguards";
  const src = fs.readFileSync(path.join(process.cwd(), "src/app/data-settings/page.tsx"), "utf8");
  ok(group, /Export backup first/.test(src), "the Reset confirmation offers 'Export backup first'");
  ok(group, /resetConfirmText\s*===\s*"RESET"/.test(src) && /disabled=\{resetConfirmText !== "RESET"\}/.test(src), "Reset stays disabled until RESET is typed exactly");
  ok(group, !/onClick=\{\(\) => \{\s*store\.resetAll\(\);\s*setConfirmingReset\(false\);/.test(src), "the old one-click 'Yes, reset' is gone");
}

// ----- navigator.storage.persist() — feature-detected, result shown in Data & Settings -----
{
  const group = "E1 Persistent storage";
  ok(group, (await requestPersistentStorage(undefined)) === "unsupported", "no navigator.storage → 'unsupported', never a throw");
  let persistCalls = 0;
  const granted = await requestPersistentStorage({ storage: { persisted: async () => false, persist: async () => (persistCalls++, true) } });
  ok(group, granted === "persistent" && persistCalls === 1, "asks for persistence once when not yet persistent, and reports 'persistent' when granted");
  const already = await requestPersistentStorage({ storage: { persisted: async () => true, persist: async () => (persistCalls++, true) } });
  ok(group, already === "persistent" && persistCalls === 1, "already persistent → no second request");
  ok(group, (await requestPersistentStorage({ storage: { persisted: async () => false, persist: async () => false } })) === "best-effort", "denied → 'best-effort'");
  ok(group, (await requestPersistentStorage({ storage: { persist: async () => { throw new Error("x"); } } })) === "unsupported", "a throwing persist() → 'unsupported'");
  ok(group, storagePersistenceLabel("persistent") === "Storage: persistent" && storagePersistenceLabel("best-effort") === "Storage: may be cleared by the browser", "Data & Settings wording");
  const header = fs.readFileSync(path.join(process.cwd(), "src/components/command-center/Header.tsx"), "utf8");
  const ds = fs.readFileSync(path.join(process.cwd(), "src/components/command-center/BackupPanel.tsx"), "utf8");
  ok(group, /ensurePersistentStorage\(\)/.test(header) && /storagePersistenceLabel\(/.test(ds) && /<BackupPanel \/>/.test(fs.readFileSync(path.join(process.cwd(), "src/app/data-settings/page.tsx"), "utf8")), "requested on first load (app header) and shown in Data & Settings");
}

// ----- Weekly backup reminder (toggle, default on) — only without cross-device sync -----
{
  const group = "E1 Backup reminder";
  const now = new Date("2026-10-02T09:00:00.000Z");
  const base = { enabled: true, crossDeviceActive: false, loaded: true, isDemo: false, now };
  ok(group, DEFAULT_FEATURE_TOGGLES.backupReminder === true, "the toggle defaults on");
  ok(group, isBackupReminderDue(base), "never backed up, no cross-device sync → due");
  ok(group, !isBackupReminderDue({ ...base, lastBackupAt: "2026-09-30T09:00:00.000Z" }), "a backup 2 days ago → not due");
  ok(group, isBackupReminderDue({ ...base, lastBackupAt: "2026-09-20T09:00:00.000Z" }), "a backup 12 days ago → due");
  ok(group, !isBackupReminderDue({ ...base, crossDeviceActive: true }), "cross-device sync active → never due");
  ok(group, !isBackupReminderDue({ ...base, crossDeviceActive: null }), "sync status still loading → not due (no flash)");
  ok(group, !isBackupReminderDue({ ...base, enabled: false }), "toggle off → never due");
  ok(group, !isBackupReminderDue({ ...base, isDemo: true }) && !isBackupReminderDue({ ...base, loaded: false }), "demo / empty state → not due");
  ok(group, !isBackupReminderDue({ ...base, snoozedAt: "2026-09-29T09:00:00.000Z" }), "'Remind me next week' snoozes it for 7 days");
  const store = new CommandCenterStore({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [], jiraSyncLockManager: null });
  store.getSnapshot();
  store.snoozeBackupReminder("2026-09-29T09:00:00.000Z");
  store.markBackupExported("2026-10-02T09:00:00.000Z");
  ok(group, store.getSnapshot().lastBackupAt === "2026-10-02T09:00:00.000Z" && store.getSnapshot().backupReminderSnoozedAt === undefined, "exporting records lastBackupAt and clears the snooze");
  ok(group, parseStoredState(JSON.stringify(store.getSnapshot())).lastBackupAt === "2026-10-02T09:00:00.000Z", "lastBackupAt survives a reload");
}

// ----- Setup Health: "No backup in the last 7 days and no cross-device sync" -----
{
  const group = "E1 Setup Health backup row";
  const idx = buildWorkRelevanceIndex({});
  const status = { configured: true, serverSideNotifyActive: true } as never;
  const now = new Date("2026-10-02T09:00:00.000Z");
  const rows = (backup: Parameters<typeof computeSetupHealthRows>[5] extends infer E ? E extends { backup?: infer B } ? B : never : never) =>
    computeSetupHealthRows({ displayName: "A", accountId: "x" } as never, "jira", emptyData(), idx, status, { backup }).filter((r) => r.id === "backup");
  ok(group, rows({ crossDeviceActive: false, isDemo: false, now }).length === 1, "never backed up and no cross-device sync → row shown");
  ok(group, rows({ crossDeviceActive: false, isDemo: false, now })[0]?.text.startsWith("No backup in the last 7 days and no cross-device sync"), "with the agreed wording");
  ok(group, rows({ crossDeviceActive: false, isDemo: false, now, lastBackupAt: "2026-09-29T09:00:00.000Z" }).length === 0, "a backup within 7 days → no row");
  ok(group, rows({ crossDeviceActive: true, isDemo: false, now }).length === 0, "cross-device sync active → no row");
  ok(group, rows({ crossDeviceActive: null, isDemo: false, now }).length === 0, "status still loading → no row");
  ok(group, rows({ crossDeviceActive: false, isDemo: true, now }).length === 0, "demo data → no row");
  ok(group, backupCounts(parseStoredState("{}")).ticketStates === 0, "counts of an empty state are all zero");
}
