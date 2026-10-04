// E1 — Export / Import backup. Everything this app knows lives in ONE browser's IndexedDB (or
// localStorage) unless cross-device sync is set up; a cleared site-data, a new laptop or a
// different *.vercel.app URL is otherwise a total loss. A backup is the full StoreState as a
// JSON file the user keeps.
//
// Pure (no DOM, no store instance) so every rule is tested offline:
//   - buildBackup / serializeBackup — the file: { format, schemaVersion, exportedAt, state }.
//   - parseBackup — validates the shape and REJECTS anything malformed with a message (never a
//     partial import), then runs the same migrations every load runs (parseStoredState), so a
//     backup from an older schema comes in upgraded, without loss.
//   - mergeImportedState — the default import: the synced slice goes through the existing
//     per-record LWW merge (mergeSyncedAppState: ticket states newest-updatedAt-wins with
//     tombstones, records unioned by id, events/sync log unioned), and the local-only fields
//     are unioned or kept — never a blind replace. "Replace" is a separate, explicit choice
//     (replaceWithImportedState).

import { applySyncedSlice, mergeById, parseStoredState, type StoreState } from "./store";
import { extractSyncedAppState, mergeSyncedAppState } from "./app-state-sync";
import { DATA_SCHEMA_VERSION } from "./types";
import type { CommandCenterData } from "./types";

export const BACKUP_FORMAT = "ba-po-pm-command-center/backup";
/** A backup older than this many days, with no cross-device sync, is flagged (Setup Health and
 *  the weekly reminder). */
export const BACKUP_STALE_DAYS = 7;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  /** DATA_SCHEMA_VERSION of the app that wrote it. */
  schemaVersion: number;
  exportedAt: string;
  state: StoreState;
}

export interface BackupCounts {
  ticketStates: number;
  planItems: number;
  actions: number;
  decisions: number;
  attentionStates: number;
  memoryEvents: number;
  dailyReports: number;
  syncLogEntries: number;
  workItems: number;
}

export type ParsedBackup = { ok: true; schemaVersion: number; exportedAt: string; state: StoreState; counts: BackupCounts; migratedFrom?: number } | { ok: false; error: string };

/** V2.36 H1 — the AI context cache (fetched ticket descriptions/comments) is left out of a
 *  backup unless the user ticked "include AI context cache" (aiDataProtection setting). */
export function buildBackup(state: StoreState, exportedAt: string): BackupFile {
  const includeCache = state.aiDataProtection?.includeContextCacheInBackup === true;
  return { format: BACKUP_FORMAT, schemaVersion: DATA_SCHEMA_VERSION, exportedAt, state: includeCache ? state : { ...state, aiContextCache: {}, aiBriefs: {} } };
}

export function serializeBackup(backup: BackupFile): string {
  return JSON.stringify(backup, null, 2);
}

/** `command-center-backup-2026-10-02.json` (`…-encrypted.json` with a passphrase). */
export function backupFileName(exportedAt: string, encrypted = false): string {
  return `command-center-backup-${exportedAt.slice(0, 10)}${encrypted ? "-encrypted" : ""}.json`;
}

export function backupCounts(state: StoreState): BackupCounts {
  return {
    ticketStates: Object.keys(state.ticketWorkStates).length,
    planItems: state.personalPlan.length,
    actions: state.data.actions.length,
    decisions: state.data.decisions.length,
    attentionStates: Object.keys(state.attentionState).length,
    memoryEvents: state.memoryEvents.length,
    dailyReports: Object.keys(state.dailyReports).length,
    syncLogEntries: state.syncLog.length,
    workItems: state.data.workItems.length,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// Container types of the fields a backup must not get wrong. A present field with the wrong
// type means the file is damaged or not ours: reject, never silently drop it.
const ARRAY_FIELDS = ["personalPlan", "memoryEvents", "syncLog", "snapshotHistory", "eodHistory", "artifacts", "mentionEvents", "pilotFeedback"] as const;
const OBJECT_FIELDS = ["data", "ticketWorkStates", "attentionState", "dailyReports", "features", "dailyCommandCompletions", "dailyCommandSkips", "dailyCommandBlocks", "dailyReviewAcks", "mentionReplies", "aiContextCache", "aiDataProtection", "aiBriefs", "aiTriageStats", "aiWeeklyInsights"] as const;
const DATA_ARRAY_FIELDS = ["workItems", "projects", "clients", "actions", "decisions", "risks", "dependencies"] as const;

export function parseBackup(raw: string): ParsedBackup {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "This file isn't valid JSON — it can't be a Command Center backup." };
  }
  if (!isObject(json) || json.format !== BACKUP_FORMAT) {
    return { ok: false, error: "This file isn't a Command Center backup (the format marker is missing). Nothing was imported." };
  }
  const { schemaVersion, exportedAt, state } = json;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    return { ok: false, error: "The backup has no valid schemaVersion. Nothing was imported." };
  }
  if (schemaVersion > DATA_SCHEMA_VERSION) {
    return { ok: false, error: `This backup was made by a newer version of the app (schema ${schemaVersion}; this one reads up to ${DATA_SCHEMA_VERSION}). Update the app first. Nothing was imported.` };
  }
  if (typeof exportedAt !== "string" || Number.isNaN(new Date(exportedAt).getTime())) {
    return { ok: false, error: "The backup has no valid exportedAt date. Nothing was imported." };
  }
  if (!isObject(state)) {
    return { ok: false, error: "The backup has no app state in it. Nothing was imported." };
  }
  for (const f of ARRAY_FIELDS) {
    if (f in state && !Array.isArray(state[f])) return { ok: false, error: `The backup is damaged: "${f}" should be a list. Nothing was imported.` };
  }
  for (const f of OBJECT_FIELDS) {
    if (f in state && !isObject(state[f])) return { ok: false, error: `The backup is damaged: "${f}" should be an object. Nothing was imported.` };
  }
  if (isObject(state.data)) {
    for (const f of DATA_ARRAY_FIELDS) {
      if (f in state.data && !Array.isArray(state.data[f])) return { ok: false, error: `The backup is damaged: "data.${f}" should be a list. Nothing was imported.` };
    }
  }
  if (!("data" in state) && !("ticketWorkStates" in state) && !("personalPlan" in state) && !("dailyCommandCompletions" in state)) {
    return { ok: false, error: "The backup contains no app data. Nothing was imported." };
  }
  // The same migration path every load takes (older schemas → current, losslessly).
  const migrated = parseStoredState(JSON.stringify(state));
  return {
    ok: true,
    schemaVersion,
    exportedAt,
    state: migrated,
    counts: backupCounts(migrated),
    ...(schemaVersion < DATA_SCHEMA_VERSION ? { migratedFrom: schemaVersion } : {}),
  };
}

// ===== Import ==========================================================================

function hasNoData(data: CommandCenterData): boolean {
  return data.workItems.length === 0 && data.projects.length === 0 && data.clients.length === 0;
}

/** Union by a key, local entries first (local wins on a shared key), newest-last by `order`. */
function unionBy<T>(local: T[], imported: T[], key: (t: T) => string, order: (t: T) => string, cap: number): T[] {
  const seen = new Set(local.map(key));
  return [...local, ...imported.filter((t) => !seen.has(key(t)))].sort((a, b) => order(a).localeCompare(order(b))).slice(-cap);
}

/** Records present only in the backup are added; a key present on both sides keeps local. */
function fillRecord<T>(local: Record<string, T>, imported: Record<string, T>): Record<string, T> {
  return { ...imported, ...local };
}

/** E1 — the default import ("Merge"). See the file header for the contract. */
export function mergeImportedState(local: StoreState, imported: StoreState, nowIso: string): StoreState {
  const merged = mergeSyncedAppState(extractSyncedAppState(local, nowIso), extractSyncedAppState(imported, nowIso));
  // Merge never overrides this device's preferences or identity with the backup's.
  const synced = {
    ...merged,
    personalIdentity: local.personalIdentity ?? imported.personalIdentity,
    uiPreferences: local.loaded || local.personalIdentity ? extractSyncedAppState(local, nowIso).uiPreferences : merged.uiPreferences,
  };
  // A device with no Jira/import data of its own (e.g. right after Reset) takes the backup's
  // dataset and settings; otherwise its own stay.
  const takeDataset = hasNoData(local.data) && !hasNoData(imported.data);
  const pristine = !local.loaded;
  const base: StoreState = {
    ...local,
    ...(takeDataset
      ? { data: imported.data, loaded: imported.loaded, isDemo: imported.isDemo, dataSource: imported.dataSource, jiraSync: imported.jiraSync, filters: imported.filters }
      : {}),
    ...(pristine
      ? {
          features: imported.features,
          staleAssignedTicketThresholds: imported.staleAssignedTicketThresholds,
          jiraSprintFieldId: imported.jiraSprintFieldId,
          weeklyReportMode: imported.weeklyReportMode,
          defaultLandingPage: imported.defaultLandingPage,
          aiDataProtection: imported.aiDataProtection,
          ownerName: local.ownerName ?? imported.ownerName,
        }
      : {}),
    snapshotHistory: unionBy(local.snapshotHistory, imported.snapshotHistory, (s) => s.date, (s) => s.date, 60),
    eodHistory: unionBy(local.eodHistory, imported.eodHistory, (e) => e.date, (e) => e.date, 400),
    artifacts: mergeById(imported.artifacts, local.artifacts).slice(-30),
    mentionEvents: unionBy(local.mentionEvents, imported.mentionEvents, (m) => m.commentId, (m) => m.mentionedAt, 500),
    pilotFeedback: unionBy(local.pilotFeedback, imported.pilotFeedback, (p) => p.id, (p) => p.submittedAt, 500),
    knownTicketFirstSeen: fillRecord(local.knownTicketFirstSeen, imported.knownTicketFirstSeen),
    workItemCalibrationHistory: fillRecord(local.workItemCalibrationHistory, imported.workItemCalibrationHistory),
    dailySyncSummary: fillRecord(local.dailySyncSummary, imported.dailySyncSummary),
    myTicketActivity: fillRecord(local.myTicketActivity, imported.myTicketActivity),
    followUpNotified: fillRecord(local.followUpNotified, imported.followUpNotified),
    usageCounters: fillRecord(local.usageCounters, imported.usageCounters),
    aiContextCache: fillRecord(local.aiContextCache, imported.aiContextCache),
    aiBriefs: fillRecord(local.aiBriefs, imported.aiBriefs),
    aiTriageStats: fillRecord(local.aiTriageStats, imported.aiTriageStats),
    aiWeeklyInsights: fillRecord(local.aiWeeklyInsights, imported.aiWeeklyInsights),
    lastBackupAt: local.lastBackupAt ?? imported.lastBackupAt,
  };
  return applySyncedSlice(base, synced);
}

/** E1 — "Replace": the backup becomes this device's state. Only this device's own sync
 *  bookkeeping (lastAppStateSyncIso) is kept, so cross-device sync still knows where it is. */
export function replaceWithImportedState(local: StoreState, imported: StoreState): StoreState {
  return { ...imported, lastAppStateSyncIso: local.lastAppStateSyncIso };
}

/** E1 — whether the weekly "download a backup" reminder is due. Never when cross-device sync
 *  is active (that already keeps a copy off this device), when switched off, on an empty/demo
 *  state, or within a week of the last backup / the last "remind me later". */
export function isBackupReminderDue(input: {
  enabled: boolean;
  crossDeviceActive: boolean | null;
  loaded: boolean;
  isDemo: boolean;
  lastBackupAt?: string;
  snoozedAt?: string;
  now: Date;
}): boolean {
  if (!input.enabled || input.crossDeviceActive !== false || !input.loaded || input.isDemo) return false;
  return isOlderThanDays(input.lastBackupAt, input.now) && isOlderThanDays(input.snoozedAt, input.now);
}

/** True when `iso` is missing or more than BACKUP_STALE_DAYS before `now`. */
export function isOlderThanDays(iso: string | undefined, now: Date, days: number = BACKUP_STALE_DAYS): boolean {
  if (!iso) return true;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return true;
  return now.getTime() - t > days * 24 * 60 * 60 * 1000;
}
