// P3.2 — the persisted side of conversation states: parsing a stored blob defensively, building the
// request cache, and merging a sync's fresh states in. Pure.

import type { ConversationState } from "./conversation-state";
export type { ConversationState };

const AWAITING = new Set(["ME", "THEM", "NONE"]);
const MAX_STORED_STATES = 1000;

function isState(v: unknown): v is ConversationState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Partial<ConversationState>;
  return typeof s.lastIsMe === "boolean" && typeof s.awaiting === "string" && AWAITING.has(s.awaiting) && (s.sinceAt === undefined || typeof s.sinceAt === "string") && (s.issueUpdatedAt === undefined || typeof s.issueUpdatedAt === "string");
}

/** A malformed or absent blob (including every state saved before this field existed) reads as "nothing known". */
export function asConversationStates(v: unknown): Record<string, ConversationState> {
  const out: Record<string, ConversationState> = {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) if (isState(value)) out[key] = value;
  return out;
}

/** key -> issueUpdatedAt of every cached state that has one (what the sync request carries — never content). */
export function conversationCacheOf(states: Readonly<Record<string, ConversationState>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, s] of Object.entries(states ?? {})) if (s.issueUpdatedAt) out[key] = s.issueUpdatedAt;
  return out;
}

/** Fresh states override cached ones; everything not an open ticket in the merged data is dropped (derived data
 *  must not outlive its ticket). `fresh` undefined (no accountId, or an older server) leaves the cache as it was,
 *  still pruned. */
export function mergeConversationStates(
  current: Readonly<Record<string, ConversationState>> | undefined,
  fresh: Readonly<Record<string, ConversationState>> | undefined,
  workItems: readonly { key: string; status: string }[]
): Record<string, ConversationState> {
  const open = new Set(workItems.filter((w) => w.status !== "Done").map((w) => w.key));
  const out: Record<string, ConversationState> = {};
  for (const [key, s] of Object.entries({ ...(current ?? {}), ...(fresh ?? {}) })) if (open.has(key)) out[key] = s;
  const keys = Object.keys(out);
  if (keys.length > MAX_STORED_STATES) for (const k of keys.slice(0, keys.length - MAX_STORED_STATES)) delete out[k];
  return out;
}
