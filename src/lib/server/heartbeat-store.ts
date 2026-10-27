// P2.2 — the cron heartbeat in KV (global key with sign-in off, per member with it on). KV not
// configured -> get() is null and set() a no-op, never an error. The store lives in
// ../command-center/kv/kv-stores.ts (tested offline); this binds it to the real KV client.

import "server-only";
import { isNotifyStoreConfigured } from "../command-center/notify-state";
import { createKvHeartbeatStore } from "../command-center/kv/kv-stores";
import type { HeartbeatStore } from "../command-center/health";
import { vercelKv } from "./kv-client";

const inert: HeartbeatStore = { get: async () => null, set: async () => undefined };

export function createHeartbeatStore(uid?: string): HeartbeatStore {
  return isNotifyStoreConfigured() ? createKvHeartbeatStore(vercelKv, uid) : inert;
}
