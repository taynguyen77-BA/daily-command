// V2.13 §1 — the cron notify check's baseline ("what did the last check already know about"),
// in Vercel KV, so an unattended run can Slack only genuinely NEW assignments/mentions. KV not
// configured → get() returns null, set() no-ops, never an error. The store lives in
// ../command-center/kv/kv-stores.ts (tested offline); this binds it to the real KV client.
// L4 — `uid` (sign-in on) gives each member their own baseline.

import "server-only";
import { isNotifyStoreConfigured, type NotifyStateStore } from "../command-center/notify-state";
import { createKvNotifyStore } from "../command-center/kv/kv-stores";
import { vercelKv } from "./kv-client";

export { isNotifyStoreConfigured };

const inert: NotifyStateStore = { get: async () => null, set: async () => undefined };

export function createNotifyStore(uid?: string): NotifyStateStore {
  return isNotifyStoreConfigured() ? createKvNotifyStore(vercelKv, uid) : inert;
}
