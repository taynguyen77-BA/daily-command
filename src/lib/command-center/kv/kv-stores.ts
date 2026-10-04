// L4 — the server-side KV stores, each optionally scoped to one user: the key is
// scopedKey(base, uid), so with sign-in off (no uid) every key is exactly the single-user one it
// always was, and with sign-in on user A's keys and user B's never overlap. Same best-effort
// contract as before: a KV failure reads as "nothing stored" and a write failure never throws.
// src/lib/server/*-store.ts bind these to the real Vercel KV client.

import type { AppStateStore, SyncedAppState } from "../app-state";
import type { NotifyStateStore, PersonalNotifyState } from "../notify-state";
import type { ServerReportState, ServerReportStore } from "../server-daily-report";
import type { JiraWriteLogStore, JiraWriteServerLogEntry } from "../jira/write-gate";
import { scopedKey } from "../auth/auth-config";
import type { KvLike } from "./kv";

export const APP_STATE_KEY = "daily-command:app-state:v1";
export const NOTIFY_STATE_KEY = "daily-command:personal-notify-state:v1";
export const SERVER_REPORTS_KEY = "daily-command:server-reports:v1";
export const JIRA_WRITE_LOG_KEY = "daily-command:jira-write-log:v1";
export const JIRA_WRITE_LOG_MAX_ENTRIES = 1000;

function isValidAppState(v: unknown): v is SyncedAppState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Partial<SyncedAppState>;
  return (
    typeof s.jiraWorkRelevancePolicy === "object" &&
    s.jiraWorkRelevancePolicy !== null &&
    typeof s.attentionState === "object" &&
    s.attentionState !== null &&
    Array.isArray(s.decisions) &&
    typeof s.actionPlanState === "object" &&
    s.actionPlanState !== null &&
    Array.isArray((s.actionPlanState as { actions?: unknown }).actions) &&
    Array.isArray((s.actionPlanState as { personalPlan?: unknown }).personalPlan) &&
    Array.isArray(s.memoryEvents) &&
    typeof s.uiPreferences === "object" &&
    s.uiPreferences !== null &&
    typeof s.updatedAtIso === "string"
  );
}

function isValidNotifyState(v: unknown): v is PersonalNotifyState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Partial<PersonalNotifyState>;
  return Array.isArray(s.assignedIssueKeys) && s.assignedIssueKeys.every((k) => typeof k === "string") && Array.isArray(s.notifiedCommentIds) && s.notifiedCommentIds.every((k) => typeof k === "string") && typeof s.lastCheckedAtIso === "string";
}

function isValidReportState(v: unknown): v is ServerReportState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Partial<ServerReportState>;
  return typeof s.reports === "object" && s.reports !== null && (s.baseline === null || (typeof s.baseline === "object" && s.baseline !== undefined));
}

/** A get/set blob store under one (scoped) key. */
function blobStore<T>(kv: KvLike, key: string, isValid: (v: unknown) => v is T) {
  return {
    async get(): Promise<T | null> {
      try {
        const raw = await kv.get(key);
        return isValid(raw) ? raw : null;
      } catch {
        return null;
      }
    },
    async set(state: T): Promise<void> {
      try {
        await kv.set(key, state);
      } catch {
        // best-effort, same as every other KV write in this app
      }
    },
  };
}

export const createKvAppStateStore = (kv: KvLike, uid?: string): AppStateStore => blobStore(kv, scopedKey(APP_STATE_KEY, uid), isValidAppState);
export const createKvNotifyStore = (kv: KvLike, uid?: string): NotifyStateStore => blobStore(kv, scopedKey(NOTIFY_STATE_KEY, uid), isValidNotifyState);
export const createKvServerReportStore = (kv: KvLike, uid?: string): ServerReportStore => blobStore(kv, scopedKey(SERVER_REPORTS_KEY, uid), isValidReportState);

/** Append-only (rpush, trimmed to the newest entries, never edited). */
export function createKvJiraWriteLogStore(kv: KvLike, uid?: string): JiraWriteLogStore {
  const LOG_KEY = scopedKey(JIRA_WRITE_LOG_KEY, uid);
  return {
    async append(entry: JiraWriteServerLogEntry) {
      try {
        await kv.rpush(LOG_KEY, JSON.stringify(entry));
        await kv.ltrim(LOG_KEY, -JIRA_WRITE_LOG_MAX_ENTRIES, -1);
      } catch {
        // best-effort — a log failure never fails or blocks the write's response
      }
    },
    async list(limit: number) {
      try {
        const raw = await kv.lrange<string | JiraWriteServerLogEntry>(LOG_KEY, -limit, -1);
        return raw.map((r) => (typeof r === "string" ? (JSON.parse(r) as JiraWriteServerLogEntry) : r)).reverse();
      } catch {
        return [];
      }
    },
  };
}
