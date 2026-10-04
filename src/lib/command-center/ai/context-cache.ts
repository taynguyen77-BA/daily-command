// V2.36 H1 — client-side cache of fetched ticket content (IssueContext), keyed per issue and
// valid only while Jira's `updated` for that issue is unchanged. Size-capped (bytes and
// entries), least-recently-fetched evicted first. Lives in StoreState like the rest of this
// device's data (same IndexedDB durability), is never part of cross-device sync, and is left
// out of backups unless the user ticks "include AI context cache".

import type { IssueContext } from "../jira/issue-context";

export interface AiContextCacheEntry {
  updated: string;
  fetchedAt: string;
  bytes: number;
  context: IssueContext;
}

export type AiContextCache = Record<string, AiContextCacheEntry>;

export const AI_CONTEXT_CACHE_MAX_BYTES = 2_000_000;
export const AI_CONTEXT_CACHE_MAX_ENTRIES = 200;

const sizeOf = (ctx: IssueContext) => JSON.stringify(ctx).length * 2; // UTF-16 upper bound

/** The cached context when its `updated` still matches (pass the synced ticket's `updated`;
 *  omit it to accept any cached copy). */
export function getCachedContext(cache: AiContextCache, key: string, updated?: string): IssueContext | undefined {
  const e = cache[key];
  if (!e) return undefined;
  if (updated !== undefined && updated !== "" && e.updated !== updated) return undefined;
  return e.context;
}

export function putCachedContext(cache: AiContextCache, ctx: IssueContext, limits = { maxBytes: AI_CONTEXT_CACHE_MAX_BYTES, maxEntries: AI_CONTEXT_CACHE_MAX_ENTRIES }): AiContextCache {
  const bytes = sizeOf(ctx);
  if (bytes > limits.maxBytes) return cache; // one oversized ticket is simply not cached
  const next: AiContextCache = { ...cache, [ctx.key]: { updated: ctx.updated, fetchedAt: ctx.fetchedAt, bytes, context: ctx } };
  const keys = Object.keys(next).sort((a, b) => next[a].fetchedAt.localeCompare(next[b].fetchedAt)); // oldest first
  let total = keys.reduce((s, k) => s + next[k].bytes, 0);
  let count = keys.length;
  for (const k of keys) {
    if (total <= limits.maxBytes && count <= limits.maxEntries) break;
    if (k === ctx.key) continue;
    total -= next[k].bytes;
    count--;
    delete next[k];
  }
  return next;
}

export function contextCacheStats(cache: AiContextCache): { entries: number; bytes: number } {
  const values = Object.values(cache);
  return { entries: values.length, bytes: values.reduce((s, e) => s + e.bytes, 0) };
}

/** Tolerant parse for stored state / backups. */
export function asAiContextCache(raw: unknown): AiContextCache {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: AiContextCache = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const e = v as Partial<AiContextCacheEntry> | null;
    if (e && typeof e === "object" && typeof e.updated === "string" && typeof e.fetchedAt === "string" && typeof e.bytes === "number" && e.context && typeof e.context === "object" && (e.context as IssueContext).key === k) {
      out[k] = e as AiContextCacheEntry;
    }
  }
  return out;
}
