// G2 — append-only server log of Jira write attempts, in Vercel KV (a list; newest kept, capped).
// Unconfigured/unreachable → no-op / empty. The store (rpush + ltrim, never edited) lives in
// ../command-center/kv/kv-stores.ts (tested offline). L4 — `uid` gives each member their log.

import "server-only";
import { isAppStateStoreConfigured } from "../command-center/app-state";
import type { JiraWriteLogStore } from "../command-center/jira/write-gate";
import { createKvJiraWriteLogStore } from "../command-center/kv/kv-stores";
import { vercelKv } from "./kv-client";

const inert: JiraWriteLogStore = { append: async () => undefined, list: async () => [] };

export function createJiraWriteLogStore(uid?: string): JiraWriteLogStore {
  return isAppStateStoreConfigured() ? createKvJiraWriteLogStore(vercelKv, uid) : inert;
}
