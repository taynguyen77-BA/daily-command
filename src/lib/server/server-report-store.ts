// E4 — Vercel KV home for the cron-written daily standup snapshots (server-daily-report.ts).
// Same single-key/single-blob, best-effort contract as app-state-store.ts and notify-store.ts:
// KV not configured or unreachable → get() returns null and set() is a no-op.

import "server-only";
import { kv } from "@vercel/kv";
import { isAppStateStoreConfigured } from "../command-center/app-state";
import type { ServerReportState, ServerReportStore } from "../command-center/server-daily-report";

const SERVER_REPORTS_KEY = "daily-command:server-reports:v1";

function isValidState(v: unknown): v is ServerReportState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Partial<ServerReportState>;
  return typeof s.reports === "object" && s.reports !== null && (s.baseline === null || (typeof s.baseline === "object" && s.baseline !== undefined));
}

class VercelKvServerReportStore implements ServerReportStore {
  async get(): Promise<ServerReportState | null> {
    if (!isAppStateStoreConfigured()) return null;
    try {
      const raw = await kv.get(SERVER_REPORTS_KEY);
      return isValidState(raw) ? raw : null;
    } catch {
      return null;
    }
  }

  async set(state: ServerReportState): Promise<void> {
    if (!isAppStateStoreConfigured()) return;
    try {
      await kv.set(SERVER_REPORTS_KEY, state);
    } catch {
      // best-effort, same as every other KV write in this app
    }
  }
}

export function createServerReportStore(): ServerReportStore {
  return new VercelKvServerReportStore();
}
