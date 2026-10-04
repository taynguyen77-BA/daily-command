// V2.37 I1 — Ticket Brief. "Brief" on every TaskRow (and in a Focus Session) → one ticket's
// content (allow-listed + redacted, ai/data-protection.ts) → { whatIsAsked, currentState,
// waitingOn, openQuestions, suggestedNextStep, suggestedStatus? }.
//
// Cached per (issue key, Jira `updated`) in StoreState.aiBriefs: re-opening a ticket shows the
// stored brief with ZERO model calls (and no Jira fetch). When the synced ticket is newer than
// the brief, the brief is still shown, marked "updated since brief", with Regenerate.
//
// suggestedStatus is only ever a button: clicking it goes through the normal setTicketStatus
// (surface "ai-brief", reason "AI-suggested: …"). Nothing changes without that click.

import type { IssueContext } from "../jira/issue-context";
import type { TicketStatusSurface, TicketWorkStatus } from "../types";
import { addDays } from "../date-utils";
import { AI_DISABLED_FOR_PROJECT, gateTicketAi, isProjectAiAllowed, projectKeyOf, type AiDataProtectionSettings, type TicketAiGate } from "./data-protection";
import type { AIProvider } from "./provider";
import type { TicketBriefResponse } from "./schemas";

export interface StoredTicketBrief {
  key: string;
  /** Jira `updated` of the content the brief was made from — half of the cache key. */
  updated: string;
  createdAt: string;
  mode: "mock" | "claude";
  brief: TicketBriefResponse;
}
export type AiBriefCache = Record<string, StoredTicketBrief>;
export const MAX_STORED_BRIEFS = 200;

/** The synced ticket changed on a later day than the content the brief was made from. */
export function isBriefStale(b: StoredTicketBrief, workItemLastUpdated?: string): boolean {
  return !!workItemLastUpdated && workItemLastUpdated.slice(0, 10) > b.updated.slice(0, 10);
}

export function putBrief(cache: AiBriefCache, b: StoredTicketBrief): AiBriefCache {
  const next = { ...cache, [b.key]: b };
  const keys = Object.keys(next).sort((a, c) => next[a].createdAt.localeCompare(next[c].createdAt));
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_STORED_BRIEFS))) delete next[k];
  return next;
}

export type BriefOpen =
  | { kind: "cached"; stored: StoredTicketBrief; stale: boolean }
  | { kind: "generated"; stored: StoredTicketBrief }
  | Exclude<TicketAiGate, { kind: "ready" }>
  | { kind: "error"; message: string };

/** Opens the brief for one ticket. With a stored brief and no `regenerate`, returns it without
 *  touching Jira or the model. Otherwise loads the content, gates it and asks the provider. */
export async function openTicketBrief(args: {
  key: string;
  workItemLastUpdated?: string;
  cache: AiBriefCache;
  settings: AiDataProtectionSettings;
  regenerate?: boolean;
  previewConfirmed?: boolean;
  today: string;
  nowIso?: string;
  loadContext: (force: boolean) => Promise<{ ok: true; context: IssueContext } | { ok: false; error: string }>;
  provider: Pick<AIProvider, "generateTicketBrief" | "mode">;
}): Promise<BriefOpen> {
  const stored = args.cache[args.key];
  if (stored && !args.regenerate) return { kind: "cached", stored, stale: isBriefStale(stored, args.workItemLastUpdated) };
  // Not allow-listed: don't even fetch the content.
  if (!isProjectAiAllowed(args.settings, projectKeyOf(args.key))) return { kind: "disabled", reason: AI_DISABLED_FOR_PROJECT };
  const loaded = await args.loadContext(!!stored && isBriefStale(stored, args.workItemLastUpdated));
  if (!loaded.ok) return { kind: "error", message: loaded.error };
  const gate = gateTicketAi(loaded.context, args.settings, { previewConfirmed: args.previewConfirmed });
  if (gate.kind !== "ready") return gate;
  const raw = await args.provider.generateTicketBrief(gate.input, args.today);
  const brief = gate.session.restoreDeep(raw);
  return { kind: "generated", stored: { key: args.key, updated: loaded.context.updated, createdAt: args.nowIso ?? new Date().toISOString(), mode: args.provider.mode, brief } };
}

const STATUS_LABEL: Record<NonNullable<TicketBriefResponse["suggestedStatus"]>["status"], string> = {
  IN_PROGRESS: "Start",
  BLOCKED: "Block",
  DONE: "Mark done",
  DEFERRED: "Defer to tomorrow",
  SKIPPED: "Skip",
};
export const suggestionLabel = (s: NonNullable<TicketBriefResponse["suggestedStatus"]>) => STATUS_LABEL[s.status];

export const AI_SUGGESTED_PREFIX = "AI-suggested: ";

/** The user clicked the suggestion: the ordinary setTicketStatus, marked as AI-suggested. */
export function applyBriefSuggestion(
  store: { setTicketStatus(key: string, status: TicketWorkStatus, opts: { surface: TicketStatusSurface; reason?: string; until?: string }): boolean },
  key: string,
  s: NonNullable<TicketBriefResponse["suggestedStatus"]>,
  today: string
): boolean {
  return store.setTicketStatus(key, s.status, {
    surface: "ai-brief",
    reason: `${AI_SUGGESTED_PREFIX}${s.reason}`,
    ...(s.status === "DEFERRED" ? { until: addDays(today, 1) } : {}),
  });
}

export function asAiBriefCache(raw: unknown): AiBriefCache {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: AiBriefCache = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const b = v as Partial<StoredTicketBrief> | null;
    if (b && b.key === k && typeof b.updated === "string" && typeof b.createdAt === "string" && (b.mode === "mock" || b.mode === "claude") && b.brief && typeof b.brief === "object") out[k] = b as StoredTicketBrief;
  }
  return out;
}
