// V2.13 §1 — the ONLY server-side state in this entire app: a single small JSON blob
// tracking "what did the last cron-driven check already know about" so an unattended sync
// can detect a genuinely NEW assignment/mention and Slack it, without a browser open. This is
// a deliberate, narrow, explicit exception to types.ts's own "Local-only V1: no auth, no
// multi-tenant, no backend" — see the dev prompt this pass implements for the full reasoning.
// Nothing else moves server-side: no work items, no risks, no decisions, no snapshot history.
//
// `import "server-only"` — same contract as jira-client.ts — makes it a build error for any
// client component to import this file. The shared `PersonalNotifyState`/`NotifyStateStore`
// contract and the offline-test fake live in ../command-center/notify-state.ts instead (no env
// access there), so the test suite can depend on that contract directly without ever importing
// this file — same reasoning as jira/http.ts (pure, testable) vs. this file's own jira-client.ts
// counterpart (server-only, real credentials, never imported by the test suite).

import "server-only";
import { kv } from "@vercel/kv";
import { isNotifyStoreConfigured, type NotifyStateStore, type PersonalNotifyState } from "../command-center/notify-state";

export { isNotifyStoreConfigured };

// Single fixed key, e.g. "daily-command:personal-notify-state:v1" — this is a single-user
// personal tool, no need to namespace by account/tenant.
const NOTIFY_STATE_KEY = "daily-command:personal-notify-state:v1";

function isValidState(v: unknown): v is PersonalNotifyState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Partial<PersonalNotifyState>;
  return (
    Array.isArray(s.assignedIssueKeys) &&
    s.assignedIssueKeys.every((k) => typeof k === "string") &&
    Array.isArray(s.notifiedCommentIds) &&
    s.notifiedCommentIds.every((k) => typeof k === "string") &&
    typeof s.lastCheckedAtIso === "string"
  );
}

class VercelKvNotifyStore implements NotifyStateStore {
  async get(): Promise<PersonalNotifyState | null> {
    if (!isNotifyStoreConfigured()) return null;
    try {
      const raw = await kv.get(NOTIFY_STATE_KEY);
      return isValidState(raw) ? raw : null;
    } catch {
      // Best-effort — a KV read failure is treated the same as "no baseline yet", never a
      // thrown error surfaced past this module.
      return null;
    }
  }

  async set(state: PersonalNotifyState): Promise<void> {
    if (!isNotifyStoreConfigured()) return;
    try {
      await kv.set(NOTIFY_STATE_KEY, state);
    } catch {
      // Best-effort — a KV write failure never throws past this module (matches every other
      // optional integration's "safe when unconfigured/unreachable" contract in this app).
    }
  }
}

export function createNotifyStore(): NotifyStateStore {
  return new VercelKvNotifyStore();
}
