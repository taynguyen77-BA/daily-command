// P2.3 — per-member "last processed" in KV for the fair team cron. KV not configured -> inert.

import "server-only";
import { isNotifyStoreConfigured } from "../command-center/notify-state";
import { createKvCronProgressStore } from "../command-center/kv/kv-stores";
import type { CronProgressStore } from "../command-center/cron-progress";
import { vercelKv } from "./kv-client";

const inert: CronProgressStore = { get: async () => null, set: async () => undefined };

export function createCronProgressStore(uid: string): CronProgressStore {
  return isNotifyStoreConfigured() ? createKvCronProgressStore(vercelKv, uid) : inert;
}
