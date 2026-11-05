// D4 — the member's ReminderIndex in KV (global key with sign-in off, per member with it on). KV not configured -> inert.

import "server-only";
import { isNotifyStoreConfigured } from "../command-center/notify-state";
import { createKvReminderIndexStore } from "../command-center/kv/kv-stores";
import type { ReminderIndexStore } from "../command-center/reminder-index";
import { vercelKv } from "./kv-client";

const inert: ReminderIndexStore = { get: async () => null, set: async () => undefined };
export const createReminderIndexStore = (uid?: string): ReminderIndexStore => (isNotifyStoreConfigured() ? createKvReminderIndexStore(vercelKv, uid) : inert);
