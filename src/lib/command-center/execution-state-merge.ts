// A1 — per-record last-writer-wins for the personal execution state (the three Daily Command
// maps + Daily Review acknowledgments), so cross-device sync carries it without the two
// failure modes a plain union-by-key merge has:
//   1. resurrection — a record removed on one device (Reopen/Reactivate/Unblock, or cleared
//      by mutual exclusion) comes back from the other device's still-live copy. Fixed by
//      tombstones: every removal records { ticketKey, deletedAt } per map, and a live record
//      survives a merge only if it is strictly newer than the newest tombstone for its key.
//   2. blob-level "server wins" — with a single updatedAtIso per blob, a newer edit to the
//      same ticket on the "older" device was silently overwritten. Fixed by comparing each
//      record's own clock (updatedAt, falling back to completedAt/skippedAt/blockedAt for
//      pre-A1 records).
// After the per-map merge, mutual exclusion is restored per ticketKey (the newest of the
// three states wins), since two devices can independently put the same ticket into
// different states.
//
// Deterministic tie-breaks (identical timestamps): a tombstone beats a live record (removal
// wins), completion > blocked > skipped across maps, and between two live records of the
// same map, the lexicographically greater JSON. Clock skew between devices is inherent to
// LWW and accepted.
//
// Pure — no store/window import — so it is tested directly and shared by store.ts (local
// writes) and app-state-sync.ts (cross-device merge).

import type { DailyCommandBlock, DailyCommandCompletion, DailyCommandSkip, DailyCommandTombstone, DailyCommandTombstones, DailyReviewAck } from "./types";

export const TOMBSTONE_RETENTION_DAYS = 30;

export interface DailyCommandState {
  dailyCommandCompletions: Record<string, DailyCommandCompletion>;
  dailyCommandSkips: Record<string, DailyCommandSkip>;
  dailyCommandBlocks: Record<string, DailyCommandBlock>;
  dailyCommandTombstones: DailyCommandTombstones;
}

export type DailyCommandKind = "completion" | "skip" | "block";

export function emptyTombstones(): DailyCommandTombstones {
  return { completions: {}, skips: {}, blocks: {} };
}

export function completionClock(c: DailyCommandCompletion): string {
  return c.updatedAt ?? c.completedAt;
}
export function skipClock(s: DailyCommandSkip): string {
  return s.updatedAt ?? s.skippedAt;
}
export function blockClock(b: DailyCommandBlock): string {
  return b.updatedAt ?? b.blockedAt;
}

function newerLive<T>(a: T | undefined, b: T | undefined, clock: (r: T) => string): T | undefined {
  if (!a) return b;
  if (!b) return a;
  const ca = clock(a);
  const cb = clock(b);
  if (ca !== cb) return ca > cb ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

function newerTomb(a: DailyCommandTombstone | undefined, b: DailyCommandTombstone | undefined): DailyCommandTombstone | undefined {
  if (!a) return b;
  if (!b) return a;
  return a.deletedAt >= b.deletedAt ? a : b;
}

function mergeMap<T>(
  localLive: Record<string, T>,
  serverLive: Record<string, T>,
  localTomb: Record<string, DailyCommandTombstone>,
  serverTomb: Record<string, DailyCommandTombstone>,
  clock: (r: T) => string
): { live: Record<string, T>; tomb: Record<string, DailyCommandTombstone> } {
  const keys = new Set([...Object.keys(localLive), ...Object.keys(serverLive), ...Object.keys(localTomb), ...Object.keys(serverTomb)]);
  const live: Record<string, T> = {};
  const tomb: Record<string, DailyCommandTombstone> = {};
  for (const key of Array.from(keys).sort()) {
    const bestLive = newerLive(localLive[key], serverLive[key], clock);
    const bestTomb = newerTomb(localTomb[key], serverTomb[key]);
    if (bestLive && (!bestTomb || clock(bestLive) > bestTomb.deletedAt)) live[key] = bestLive;
    else if (bestTomb) tomb[key] = bestTomb;
  }
  return { live, tomb };
}

/** Restores "a ticketKey is in at most one of the three maps" after a merge: the newest record
 *  wins; ties go completion > blocked > skipped (the most conservative "don't nag me" reading,
 *  same order task-execution.ts resolves corrupted data in). */
function enforceMutualExclusion(state: DailyCommandState): DailyCommandState {
  const completions = { ...state.dailyCommandCompletions };
  const skips = { ...state.dailyCommandSkips };
  const blocks = { ...state.dailyCommandBlocks };
  const keys = new Set([...Object.keys(completions), ...Object.keys(skips), ...Object.keys(blocks)]);
  for (const key of Array.from(keys)) {
    const candidates: { kind: DailyCommandKind; clock: string; rank: number }[] = [];
    if (completions[key]) candidates.push({ kind: "completion", clock: completionClock(completions[key]), rank: 3 });
    if (blocks[key]) candidates.push({ kind: "block", clock: blockClock(blocks[key]), rank: 2 });
    if (skips[key]) candidates.push({ kind: "skip", clock: skipClock(skips[key]), rank: 1 });
    if (candidates.length < 2) continue;
    candidates.sort((a, b) => (a.clock !== b.clock ? (a.clock > b.clock ? -1 : 1) : b.rank - a.rank));
    const winner = candidates[0].kind;
    if (winner !== "completion") delete completions[key];
    if (winner !== "skip") delete skips[key];
    if (winner !== "block") delete blocks[key];
  }
  return { ...state, dailyCommandCompletions: completions, dailyCommandSkips: skips, dailyCommandBlocks: blocks };
}

/** Symmetric (argument order never changes the result, up to the deterministic tie-breaks
 *  above) LWW merge of two devices' Daily Command state. */
export function mergeDailyCommandState(local: DailyCommandState, server: DailyCommandState): DailyCommandState {
  const lt = local.dailyCommandTombstones ?? emptyTombstones();
  const st = server.dailyCommandTombstones ?? emptyTombstones();
  const c = mergeMap(local.dailyCommandCompletions, server.dailyCommandCompletions, lt.completions, st.completions, completionClock);
  const s = mergeMap(local.dailyCommandSkips, server.dailyCommandSkips, lt.skips, st.skips, skipClock);
  const b = mergeMap(local.dailyCommandBlocks, server.dailyCommandBlocks, lt.blocks, st.blocks, blockClock);
  return enforceMutualExclusion({
    dailyCommandCompletions: c.live,
    dailyCommandSkips: s.live,
    dailyCommandBlocks: b.live,
    dailyCommandTombstones: { completions: c.tomb, skips: s.tomb, blocks: b.tomb },
  });
}

function cutoffIso(nowIso: string): string {
  const d = new Date(nowIso);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() - TOMBSTONE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/** Drops tombstones older than TOMBSTONE_RETENTION_DAYS. Called on local writes only. The
 *  accepted trade-off: a device offline for longer than that may resurrect a removed record. */
export function pruneTombstones(tombstones: DailyCommandTombstones, nowIso: string): DailyCommandTombstones {
  const cutoff = cutoffIso(nowIso);
  const prune = (m: Record<string, DailyCommandTombstone>) => Object.fromEntries(Object.entries(m).filter(([, t]) => t.deletedAt >= cutoff));
  return { completions: prune(tombstones.completions), skips: prune(tombstones.skips), blocks: prune(tombstones.blocks) };
}

export type DailyCommandRecord =
  | { kind: "completion"; record: DailyCommandCompletion }
  | { kind: "skip"; record: DailyCommandSkip }
  | { kind: "block"; record: DailyCommandBlock };

/** The one local write path for the three maps (store.ts's six setters): removes `ticketKey`
 *  from every map (tombstoning each map it was actually in), then — when `next` is given —
 *  sets the new record (stamped with `updatedAt = nowIso`) and drops that map's tombstone.
 *  Prunes old tombstones on the way. Never mutates its input. */
export function applyDailyCommandChange(state: DailyCommandState, ticketKey: string, next: DailyCommandRecord | null, nowIso: string): DailyCommandState {
  const completions = { ...state.dailyCommandCompletions };
  const skips = { ...state.dailyCommandSkips };
  const blocks = { ...state.dailyCommandBlocks };
  const base = state.dailyCommandTombstones ?? emptyTombstones();
  const tomb: DailyCommandTombstones = { completions: { ...base.completions }, skips: { ...base.skips }, blocks: { ...base.blocks } };
  const stone = { ticketKey, deletedAt: nowIso };
  if (ticketKey in completions && next?.kind !== "completion") {
    delete completions[ticketKey];
    tomb.completions[ticketKey] = stone;
  }
  if (ticketKey in skips && next?.kind !== "skip") {
    delete skips[ticketKey];
    tomb.skips[ticketKey] = stone;
  }
  if (ticketKey in blocks && next?.kind !== "block") {
    delete blocks[ticketKey];
    tomb.blocks[ticketKey] = stone;
  }
  if (next?.kind === "completion") {
    completions[ticketKey] = { ...next.record, updatedAt: nowIso };
    delete tomb.completions[ticketKey];
  } else if (next?.kind === "skip") {
    skips[ticketKey] = { ...next.record, updatedAt: nowIso };
    delete tomb.skips[ticketKey];
  } else if (next?.kind === "block") {
    blocks[ticketKey] = { ...next.record, updatedAt: nowIso };
    delete tomb.blocks[ticketKey];
  }
  return { dailyCommandCompletions: completions, dailyCommandSkips: skips, dailyCommandBlocks: blocks, dailyCommandTombstones: pruneTombstones(tomb, nowIso) };
}

/** A3 — Daily Review acknowledgments: a grow-only "latest reviewedAt per key" map, so the merge
 *  is a plain per-key max (an acknowledgment is never withdrawn, so no tombstones needed). */
export function mergeReviewAcks(a: Record<string, DailyReviewAck>, b: Record<string, DailyReviewAck>): Record<string, DailyReviewAck> {
  const out: Record<string, DailyReviewAck> = { ...a };
  for (const [key, ack] of Object.entries(b)) {
    if (!out[key] || ack.reviewedAt > out[key].reviewedAt) out[key] = ack;
  }
  return out;
}

/** Later of two optional ISO strings (undefined-safe). */
export function maxIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}
