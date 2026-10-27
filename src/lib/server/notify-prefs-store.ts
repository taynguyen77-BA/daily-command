// P3.5 — notification preferences + the digest queue in KV (global key with sign-in off, per member with it on).
// KV not configured -> inert (reads as "never saved"/empty, writes are no-ops), like every other store here.

import "server-only";
import { isNotifyStoreConfigured } from "../command-center/notify-state";
import { createKvDigestStore, createKvNotifyPrefsStore } from "../command-center/kv/kv-stores";
import type { NotifyPrefsStore } from "../command-center/notify-prefs";
import type { DigestStore } from "../command-center/notify-digest";
import { vercelKv } from "./kv-client";

const inertPrefs: NotifyPrefsStore = { get: async () => null, set: async () => undefined };
const inertDigest: DigestStore = { get: async () => ({ items: [] }), set: async () => undefined };

export function createNotifyPrefsStore(uid?: string): NotifyPrefsStore {
  return isNotifyStoreConfigured() ? createKvNotifyPrefsStore(vercelKv, uid) : inertPrefs;
}
export function createDigestStore(uid?: string): DigestStore {
  return isNotifyStoreConfigured() ? createKvDigestStore(vercelKv, uid) : inertDigest;
}
