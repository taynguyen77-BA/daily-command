// V2.15 §1 — the second (and, per the dev prompt's own framing, still deliberately narrow)
// piece of server-side state in this app, alongside notify-store.ts's V2.13 assignment/mention
// baseline. Same store/credentials (Vercel KV), same single-fixed-key/single-blob simplicity,
// same graceful-degradation contract: KV not configured -> get() returns null, set() no-ops,
// the whole cross-device sync layer becomes inert and the app behaves exactly as it does today
// (local-only). `import "server-only"` makes it a build error for any client component to
// import this file directly — see notify-store.ts's own comment for the identical reasoning.
// The shared `SyncedAppState`/`AppStateStore` contract and offline-test fake live in
// ../command-center/app-state.ts instead (no env access there beyond the boolean-only
// isAppStateStoreConfigured check), so the test suite can depend on that contract directly
// without ever importing this file.

import "server-only";
import { kv } from "@vercel/kv";
import { isAppStateStoreConfigured, type AppStateStore, type SyncedAppState } from "../command-center/app-state";

export { isAppStateStoreConfigured };

// Single fixed key — this is a single-user personal tool, no need to namespace by account.
const APP_STATE_KEY = "daily-command:app-state:v1";

function isValidState(v: unknown): v is SyncedAppState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Partial<SyncedAppState>;
  return (
    typeof s.jiraWorkRelevancePolicy === "object" &&
    s.jiraWorkRelevancePolicy !== null &&
    typeof s.attentionState === "object" &&
    s.attentionState !== null &&
    Array.isArray(s.decisions) &&
    typeof s.actionPlanState === "object" &&
    s.actionPlanState !== null &&
    Array.isArray((s.actionPlanState as { actions?: unknown }).actions) &&
    Array.isArray((s.actionPlanState as { personalPlan?: unknown }).personalPlan) &&
    Array.isArray(s.memoryEvents) &&
    typeof s.uiPreferences === "object" &&
    s.uiPreferences !== null &&
    typeof s.updatedAtIso === "string"
  );
}

class VercelKvAppStateStore implements AppStateStore {
  async get(): Promise<SyncedAppState | null> {
    if (!isAppStateStoreConfigured()) return null;
    try {
      const raw = await kv.get(APP_STATE_KEY);
      return isValidState(raw) ? raw : null;
    } catch {
      // Best-effort — a KV read failure is treated the same as "no baseline yet", never a
      // thrown error surfaced past this module.
      return null;
    }
  }

  async set(state: SyncedAppState): Promise<void> {
    if (!isAppStateStoreConfigured()) return;
    try {
      await kv.set(APP_STATE_KEY, state);
    } catch {
      // Best-effort — a KV write failure never throws past this module (matches every other
      // optional integration's "safe when unconfigured/unreachable" contract in this app).
    }
  }
}

export function createAppStateStore(): AppStateStore {
  return new VercelKvAppStateStore();
}
