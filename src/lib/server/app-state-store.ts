// V2.15 §1 — the Cross-Device Sync blob in Vercel KV. Same graceful-degradation contract as
// ever: KV not configured -> get() returns null, set() no-ops, and the cross-device sync layer
// is inert. The store itself (validation, best-effort reads/writes) lives in
// ../command-center/kv/kv-stores.ts so it is tested offline; this file binds it to the real KV
// client. L4 — `uid` (sign-in on) scopes the key to one user; without it the key is the
// single-user one it always was.

import "server-only";
import { isAppStateStoreConfigured, type AppStateStore } from "../command-center/app-state";
import { createKvAppStateStore } from "../command-center/kv/kv-stores";
import { vercelKv } from "./kv-client";

export { isAppStateStoreConfigured };

const inert: AppStateStore = { get: async () => null, set: async () => undefined };

export function createAppStateStore(uid?: string): AppStateStore {
  return isAppStateStoreConfigured() ? createKvAppStateStore(vercelKv, uid) : inert;
}
