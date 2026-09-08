// V2.15 §1 — the cross-device "synced slice" contract. Deliberately pure/no server-only
// import (unlike src/lib/server/app-state-store.ts, which wraps this same contract around the
// real Vercel KV client and IS server-only) so the in-memory fake below — and app-state-sync.ts
// (the client merge/decision logic), which depends only on this file's types — can be imported
// directly by the offline test suite and the browser bundle, matching notify-state.ts's own
// split (pure contract vs. server-only KV wrapper) rather than duplicating that reasoning.
//
// Scope (see the V2.15 dev prompt's own "Scope decision" section, not repeated here): exactly
// the seven fields below sync across devices. Everything else (raw Jira-derived work items,
// risks, drift, dependencies, priorities, snapshotHistory, the AI response cache) stays local,
// per device, and is re-derived fresh from Jira on every sync — see store.ts's own
// CommandCenterData for that half of the model, which this file never touches.

import { z } from "zod";
import type {
  Action,
  AttentionItemState,
  Decision,
  JiraProjectScope,
  JiraWorkRelevancePolicyMap,
  MemoryEvent,
  MyActionItemsOnlyByPage,
  PersonalIdentity,
  PersonalPlanItem,
} from "./types";

export interface SyncedAppState {
  personalIdentity?: PersonalIdentity;
  jiraWorkRelevancePolicy: JiraWorkRelevancePolicyMap;
  attentionState: Record<string, AttentionItemState>;
  decisions: Decision[];
  // Action Plan / Close Day interaction state — user-authored, never recomputed from Jira.
  // `actions` is data.actions (Action Plan page: started/completed/deferred/blocked, notes,
  // outcomes); `personalPlan` is the Focus Session/Close Day planning list (My Day).
  actionPlanState: { actions: Action[]; personalPlan: PersonalPlanItem[] };
  memoryEvents: MemoryEvent[];
  // UI preferences added V2.11-V2.14.
  uiPreferences: {
    showAdvancedSettings: boolean;
    myActionItemsOnly: MyActionItemsOnlyByPage;
    jiraProjectScope: JiraProjectScope;
  };
  updatedAtIso: string;
}

export interface AppStateStore {
  get(): Promise<SyncedAppState | null>;
  set(state: SyncedAppState): Promise<void>;
}

/** V2.15 §3 — a boolean-only presence check (never a secret value), same reasoning as
 *  notify-state.ts's isNotifyStoreConfigured(): safe to live outside the server-only
 *  boundary and be shared by both app-state-store.ts's real KV-backed store and the
 *  /api/command-center/state route's own "is sync available at all" check. */
export function isAppStateStoreConfigured(): boolean {
  return !!process.env.KV_REST_API_URL && !!process.env.KV_REST_API_TOKEN;
}

/** Testability — the test suite must stay fully offline; this fake is what's actually
 *  exercised by app-state-sync.ts's tests. */
export function createInMemoryAppStateStore(initial: SyncedAppState | null = null): AppStateStore {
  let state: SyncedAppState | null = initial;
  return {
    async get() {
      return state;
    },
    async set(next: SyncedAppState) {
      state = next;
    },
  };
}

/** V2.15 §2 — pure auth decision for GET/POST /api/command-center/state, split out so it's
 *  directly testable (the route itself transitively imports "server-only" via
 *  app-state-store.ts, so it can never be imported into the offline test process — same
 *  reasoning as jira/sync/route.ts's own sync-auth.ts split). Deliberately NOT "open when
 *  unconfigured" like jira/sync's CRON_SECRET gate: this synced slice is genuinely private
 *  (decision content, personal identity, interaction history), so an unconfigured
 *  APP_STATE_SECRET means sync is treated as unavailable (503), never silently open. */
export function checkAppStateAuth(authorizationHeader: string | null, appStateSecret: string | undefined): { ok: true } | { ok: false; status: 401 | 503; error: string } {
  if (!appStateSecret) {
    return { ok: false, status: 503, error: "Cross-device sync is not configured on this server (APP_STATE_SECRET is unset)." };
  }
  if (authorizationHeader !== `Bearer ${appStateSecret}`) {
    return { ok: false, status: 401, error: "Missing or invalid Authorization header. Pair this device in Data & Settings." };
  }
  return { ok: true };
}

// V2.15 — a loose, structural request-body schema for POST /api/command-center/state: checks
// that each of the seven synced fields (plus updatedAtIso) is present with the right container
// shape (object/array/boolean), same "defensive against corruption, not exhaustive per-field
// validation" discipline store.ts's own parseStoredState already uses for these same record
// types (Decision/Action/PersonalPlanItem/MemoryEvent are complex, evolving shapes owned by
// types.ts — re-validating every field here would duplicate and drift from that source of
// truth). The route casts the parsed result back to SyncedAppState after this boundary check.
export const syncedAppStateSchema = z.object({
  personalIdentity: z
    .object({
      id: z.string(),
      displayName: z.string(),
      email: z.string().optional(),
      accountId: z.string().optional(),
    })
    .optional(),
  jiraWorkRelevancePolicy: z.record(z.string(), z.string()),
  attentionState: z.record(z.string(), z.record(z.string(), z.unknown())),
  decisions: z.array(z.record(z.string(), z.unknown())),
  actionPlanState: z.object({
    actions: z.array(z.record(z.string(), z.unknown())),
    personalPlan: z.array(z.record(z.string(), z.unknown())),
  }),
  memoryEvents: z.array(z.record(z.string(), z.unknown())),
  uiPreferences: z.object({
    showAdvancedSettings: z.boolean(),
    myActionItemsOnly: z.object({ attention: z.boolean(), myDay: z.boolean(), priorities: z.boolean() }),
    jiraProjectScope: z.object({
      mode: z.enum(["ALL", "FOCUSED"]),
      projectKeys: z.array(z.string()),
      updatedAt: z.string().optional(),
    }),
  }),
  updatedAtIso: z.string(),
});
