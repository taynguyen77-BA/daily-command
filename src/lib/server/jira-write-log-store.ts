// G2 — append-only server log of Jira write attempts, in Vercel KV (a list; newest kept, capped).
// Same best-effort contract as the other KV stores: unconfigured/unreachable → no-op / empty.

import "server-only";
import { kv } from "@vercel/kv";
import { isAppStateStoreConfigured } from "../command-center/app-state";
import type { JiraWriteLogStore, JiraWriteServerLogEntry } from "../command-center/jira/write-gate";

const LOG_KEY = "daily-command:jira-write-log:v1";
const MAX_ENTRIES = 1000;

export function createJiraWriteLogStore(): JiraWriteLogStore {
  return {
    async append(entry: JiraWriteServerLogEntry) {
      if (!isAppStateStoreConfigured()) return;
      try {
        await kv.rpush(LOG_KEY, JSON.stringify(entry));
        await kv.ltrim(LOG_KEY, -MAX_ENTRIES, -1);
      } catch {
        // best-effort — a log failure never fails or blocks the write's response
      }
    },
    async list(limit: number) {
      if (!isAppStateStoreConfigured()) return [];
      try {
        const raw = await kv.lrange<string | JiraWriteServerLogEntry>(LOG_KEY, -limit, -1);
        return raw.map((r) => (typeof r === "string" ? (JSON.parse(r) as JiraWriteServerLogEntry) : r)).reverse();
      } catch {
        return [];
      }
    },
  };
}
