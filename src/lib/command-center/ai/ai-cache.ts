// Entity-level AI cache (V2.0 §3). Bounded, deterministic, localStorage-backed, and safe
// when localStorage is corrupted or unavailable — mirrors store.ts's parseStoredState
// pattern (try/catch around every read/write, per-field type guards, silent fallback to
// an empty cache, never a throw).
//
// Key = `${task}:${entityId}:${evidenceVersion}`. evidenceVersion is a short deterministic
// hash of the exact facts/evidence passed into the call, so changed evidence produces a
// different key and therefore a natural cache miss ("stale") — no explicit invalidation
// logic is needed anywhere. Same evidence + same AI task = reuse previous result (§3).
//
// This is a response cache, not a database: bounded to MAX_ENTRIES, oldest evicted first,
// no TTL persistence beyond what getUsagePolicy(task).cacheDurationMs allows.

import { getUsagePolicy } from "./usage-policy";
import type { AITask } from "./schemas";

const STORAGE_KEY = "command-center:ai-cache:v1";
const MAX_ENTRIES = 150;

interface CacheEntry {
  key: string;
  value: unknown;
  storedAt: string; // ISO
}

interface CacheShape {
  entries: CacheEntry[];
}

function emptyCache(): CacheShape {
  return { entries: [] };
}

function isCacheEntry(v: unknown): v is CacheEntry {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { key?: unknown }).key === "string" &&
    typeof (v as { storedAt?: unknown }).storedAt === "string" &&
    "value" in (v as object)
  );
}

/** Exported for tests only (mirrors store.ts's exported parseStoredState) — a pure,
 *  never-throwing parse of the raw stored cache string. */
export function parseCache(raw: string): CacheShape {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return emptyCache();
    const entries = (parsed as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return emptyCache();
    return { entries: entries.filter(isCacheEntry) };
  } catch {
    return emptyCache();
  }
}

function readCache(): CacheShape {
  if (typeof window === "undefined") return emptyCache();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyCache();
    return parseCache(raw);
  } catch {
    return emptyCache();
  }
}

function writeCache(cache: CacheShape): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Storage full, private-browsing restriction, or unavailable — the cache simply
    // stops persisting; callers keep working (every fetch is still valid, just uncached).
  }
}

/** Short, deterministic, non-cryptographic string hash (djb2 variant). This is a cache
 *  key, not a security boundary — good enough to detect "the evidence changed." */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

export function makeEvidenceVersion(facts: string[], evidence: { content: string }[]): string {
  return hashString(JSON.stringify({ facts, evidence: evidence.map((e) => e.content) }));
}

export function makeAICacheKey(task: AITask, entityId: string, evidenceVersion: string): string {
  return `${task}:${entityId}:${evidenceVersion}`;
}

export function getCachedAIResult<T>(key: string, maxAgeMs?: number): T | undefined {
  const cache = readCache();
  const entry = cache.entries.find((e) => e.key === key);
  if (!entry) return undefined;
  if (maxAgeMs !== undefined) {
    const storedAtMs = new Date(entry.storedAt).getTime();
    const age = Date.now() - storedAtMs;
    if (!Number.isFinite(storedAtMs) || age > maxAgeMs) return undefined;
  }
  return entry.value as T;
}

export function setCachedAIResult<T>(key: string, value: T): void {
  const cache = readCache();
  const next = cache.entries.filter((e) => e.key !== key);
  next.push({ key, value, storedAt: new Date().toISOString() });
  while (next.length > MAX_ENTRIES) next.shift();
  writeCache({ entries: next });
}

export type CacheState = "cached" | "refreshed";

/** The one call-site pattern every on-demand AI trigger should use (V2.0 §3): check the
 *  cache first — a hit renders immediately with zero network/model calls and is labeled
 *  "cached"; a miss calls the real fetcher, stores the result, and is labeled "refreshed".
 *  Never lets a cached result look like a freshly-computed fact — callers must still show
 *  the appropriate TrustLabel/AiProviderIndicator alongside it. */
export async function withAICache<T>(
  task: AITask,
  entityId: string,
  facts: string[],
  evidence: { content: string }[],
  fetcher: () => Promise<T>
): Promise<{ value: T; cacheState: CacheState }> {
  const policy = getUsagePolicy(task);
  const version = makeEvidenceVersion(facts, evidence);
  const key = makeAICacheKey(task, entityId, version);
  const cached = getCachedAIResult<T>(key, policy.cacheDurationMs);
  if (cached !== undefined) return { value: cached, cacheState: "cached" };
  const value = await fetcher();
  setCachedAIResult(key, value);
  return { value, cacheState: "refreshed" };
}

/** Test/debugging helper — clears the entire cache. */
export function clearAICache(): void {
  writeCache(emptyCache());
}

/** Test helper — exposes the raw entry count without touching internals elsewhere. */
export function aiCacheSize(): number {
  return readCache().entries.length;
}
