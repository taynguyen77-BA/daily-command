// E4 — Vercel KV home for the cron-written daily standup snapshots (server-daily-report.ts).
// KV not configured or unreachable → get() returns null and set() is a no-op. The store lives
// in ../command-center/kv/kv-stores.ts (tested offline). L4 — `uid` scopes it to one member.

import "server-only";
import { isAppStateStoreConfigured } from "../command-center/app-state";
import type { ServerReportStore } from "../command-center/server-daily-report";
import { createKvServerReportStore } from "../command-center/kv/kv-stores";
import { vercelKv } from "./kv-client";

const inert: ServerReportStore = { get: async () => null, set: async () => undefined };

export function createServerReportStore(uid?: string): ServerReportStore {
  return isAppStateStoreConfigured() ? createKvServerReportStore(vercelKv, uid) : inert;
}
