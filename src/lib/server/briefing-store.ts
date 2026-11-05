// W1 — the member's briefing record in KV (global key with sign-in off, per member with it on). KV not configured -> inert.

import "server-only";
import { isNotifyStoreConfigured } from "../command-center/notify-state";
import { createKvBriefingStore } from "../command-center/kv/kv-stores";
import type { BriefingStore } from "../command-center/briefing";
import { vercelKv } from "./kv-client";

const inert: BriefingStore = { get: async () => null, set: async () => undefined };
export const createBriefingStore = (uid?: string): BriefingStore => (isNotifyStoreConfigured() ? createKvBriefingStore(vercelKv, uid) : inert);
