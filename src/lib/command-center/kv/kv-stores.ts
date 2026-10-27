// L4 — the server-side KV stores, each optionally scoped to one user: the key is
// scopedKey(base, uid), so with sign-in off (no uid) every key is exactly the single-user one it
// always was, and with sign-in on user A's keys and user B's never overlap. Same best-effort
// contract as before: a KV failure reads as "nothing stored" and a write failure never throws.
// src/lib/server/*-store.ts bind these to the real Vercel KV client.

import type { AppStateStore, SyncedAppState } from "../app-state";
import type { NotifyStateStore, PersonalNotifyState } from "../notify-state";
import type { ServerReportState, ServerReportStore } from "../server-daily-report";
import type { JiraWriteLogStore, JiraWriteServerLogEntry } from "../jira/write-gate";
import type { CronHeartbeat, HeartbeatStore } from "../health";
import type { CronProgressStore } from "../cron-progress";
import { notifyPrefsSchema, type NotifyPrefs, type NotifyPrefsStore } from "../notify-prefs";
import type { DigestState, DigestStore } from "../notify-digest";
import { scopedKey } from "../auth/auth-config";
import type { KvLike } from "./kv";

export const APP_STATE_KEY = "daily-command:app-state:v1";
export const NOTIFY_STATE_KEY = "daily-command:personal-notify-state:v1";
export const SERVER_REPORTS_KEY = "daily-command:server-reports:v1";
export const NOTIFY_PREFS_KEY = "daily-command:notify-prefs:v1";
export const NOTIFY_DIGEST_KEY = "daily-command:notify-digest:v1";
export const CRON_PROGRESS_KEY = "daily-command:cron-progress:v1";
export const CRON_HEARTBEAT_KEY = "daily-command:cron-heartbeat:v1";
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
  return Array.isArray(s.assignedIssueKeys) && s.assignedIssueKeys.every((k) => typeof k === "string") && Array.isArray(s.notifiedCommentIds) && s.notifiedCommentIds.every((k) => typeof k === "string") && typeof s.lastCheckedAtIso === "string" && (s.retryIssueKeys === undefined || (Array.isArray(s.retryIssueKeys) && s.retryIssueKeys.every((k) => typeof k === "string"))) && (s.escalatedCommentIds === undefined || (Array.isArray(s.escalatedCommentIds) && s.escalatedCommentIds.every((k) => typeof k === "string"))) && (s.pendingMentions === undefined || (Array.isArray(s.pendingMentions) && s.pendingMentions.every((p) => typeof p === "object" && p !== null && typeof p.commentId === "string" && typeof p.issueKey === "string" && typeof p.mentionedAt === "string" && typeof p.excerpt === "string")));
}

function isValidHeartbeat(v: unknown): v is CronHeartbeat {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Partial<CronHeartbeat>;
  return typeof s.lastRunAt === "string" && typeof s.durationMs === "number" && typeof s.notified === "number" && Array.isArray(s.warnings) && s.warnings.every((w) => typeof w === "string") && (s.lastOkAt === undefined || typeof s.lastOkAt === "string") && (s.lastError === undefined || typeof s.lastError === "string");
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
export const createKvHeartbeatStore = (kv: KvLike, uid?: string): HeartbeatStore => blobStore(kv, scopedKey(CRON_HEARTBEAT_KEY, uid), isValidHeartbeat);
/** P2.3 — a member's last-processed time ({ at }), one small blob per member. */
export function createKvCronProgressStore(kv: KvLike, uid?: string): CronProgressStore {
  const inner = blobStore<{ at: string }>(kv, scopedKey(CRON_PROGRESS_KEY, uid), (v): v is { at: string } => typeof v === "object" && v !== null && typeof (v as { at?: unknown }).at === "string");
  return { get: async () => (await inner.get())?.at ?? null, set: (at) => inner.set({ at }) };
}
export const createKvNotifyPrefsStore = (kv: KvLike, uid?: string): NotifyPrefsStore => blobStore(kv, scopedKey(NOTIFY_PREFS_KEY, uid), (v): v is NotifyPrefs => notifyPrefsSchema.safeParse(v).success);
function isValidDigestState(v: unknown): v is DigestState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Partial<DigestState>;
  return Array.isArray(s.items) && s.items.every((i) => typeof i === "object" && i !== null && typeof i.id === "string" && typeof i.issueKey === "string" && typeof i.summary === "string" && typeof i.at === "string") && (s.lastFlushAt === undefined || typeof s.lastFlushAt === "string");
}
const digestBlob = (kv: KvLike, uid?: string) => blobStore<DigestState>(kv, scopedKey(NOTIFY_DIGEST_KEY, uid), isValidDigestState);
export function createKvDigestStore(kv: KvLike, uid?: string): DigestStore {
  const inner = digestBlob(kv, uid);
  return { get: async () => (await inner.get()) ?? { items: [] }, set: (s) => inner.set(s) };
}
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
