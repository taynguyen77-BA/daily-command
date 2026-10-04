// A2 — cross-tab safety for store.ts's single persisted blob. Before this, persist() wrote the
// whole in-memory state blindly: a tab left idle with old state overwrote a newer write from
// another tab on its next mutation (e.g. tab B completes ticket X, idle tab A then snoozes an
// unrelated attention item → X is no longer completed in storage).
//
// The mechanism, in three parts:
//   1. A monotonic `stateRev` persisted with the state — serialized as the FIRST key of the
//      JSON blob, so a writer can read the stored rev with a cheap prefix match instead of
//      parsing megabytes of state on every write. A blob without it (every pre-A2 install)
//      reads as rev 0.
//   2. Every write is a read-modify-write through StateStorage.update(), atomic per backend
//      (one IndexedDB readwrite transaction; localStorage is synchronous). When the stored rev
//      is newer than the rev this tab last read/wrote, the write is REBASED, never blind: this
//      tab's own changes since that point (a 3-way diff against the state it last saw) are
//      re-applied on top of the newer stored state. Chosen over "refuse and re-read" because
//      a refused write would silently drop the user's click; the rebase keeps both tabs' work.
//   3. Notification: a BroadcastChannel("daily-command-state") message { rev, writerTabId }
//      after each successful write makes other tabs re-hydrate immediately. Where
//      BroadcastChannel is missing, tabs compare the stored rev on focus/visibilitychange.
//
// The rebase granularity is per top-level StoreState field, and per key inside plain-object
// fields (attentionState, the Daily Command maps, data's collections are arrays and so are
// taken whole from whichever side changed them). store.ts additionally re-runs the
// execution-state LWW merge over the result so tombstones/acks from both sides survive.

export const STATE_CHANNEL_NAME = "daily-command-state";

export interface StateStorage {
  /** The stored blob, or null. May be sync (localStorage) or async (IndexedDB). */
  read(): string | null | Promise<string | null>;
  /** Atomic read-modify-write: `fn` gets the current blob and returns the blob to write (or
   *  null to write nothing). Throws/rejects when the backend fails. */
  update(fn: (current: string | null) => string | null): void | Promise<void>;
}

export interface StateChannelMessage {
  rev: number;
  writerTabId: string;
}

export interface StateChannel {
  post(message: StateChannelMessage): void;
  close(): void;
}

export type StateChannelFactory = (onMessage: (message: StateChannelMessage) => void) => StateChannel | null;

const REV_PREFIX = /^\{"stateRev":(\d+)[,}]/;

/** The stored rev of a serialized blob; 0 for null or a pre-A2 blob. Never parses the body. */
export function readRevFromRaw(raw: string | null): number {
  if (!raw) return 0;
  const m = REV_PREFIX.exec(raw.slice(0, 40));
  return m ? Number(m[1]) : 0;
}

/** Serializes with `stateRev` as the first key (see readRevFromRaw). Any stale stateRev on
 *  the object itself is overwritten. */
export function serializeWithRev(state: object, rev: number): string {
  const rest: Record<string, unknown> = { ...state };
  delete rest.stateRev;
  return JSON.stringify({ stateRev: rev, ...rest });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 3-way rebase: the changes `next` made relative to `prev` (by reference — store.ts only
 *  ever updates immutably, so an untouched field keeps its identity), re-applied on top of
 *  `stored`. Recurses into plain objects up to `depth` levels; below that (and for arrays and
 *  scalars) a changed value is taken whole from `next`. A key `next` deleted is deleted. */
export function rebaseState<T>(prev: T, next: T, stored: T, depth = 2): T {
  if (prev === next) return stored;
  if (depth <= 0 || !isPlainObject(prev) || !isPlainObject(next) || !isPlainObject(stored)) return next;
  const out: Record<string, unknown> = { ...stored };
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of Array.from(keys)) {
    if (prev[key] === next[key]) continue;
    if (!(key in next)) delete out[key];
    else out[key] = rebaseState(prev[key], next[key], stored[key], depth - 1);
  }
  return out as T;
}

export function createLocalStorageStateStorage(getStorage: () => Pick<Storage, "getItem" | "setItem">, key: string): StateStorage {
  return {
    read: () => getStorage().getItem(key),
    update: (fn) => {
      const storage = getStorage();
      const next = fn(storage.getItem(key));
      if (next !== null) storage.setItem(key, next);
    },
  };
}

/** An in-memory StateStorage — what tests use to stand in for one origin's storage shared by
 *  several tabs. `async: true` makes every call resolve on a later tick, like IndexedDB. */
export function createMemoryStateStorage(options: { async?: boolean; initial?: string | null } = {}): StateStorage & { raw(): string | null } {
  let value: string | null = options.initial ?? null;
  const later = <T>(f: () => T): Promise<T> => new Promise((resolve, reject) => setTimeout(() => {
    try {
      resolve(f());
    } catch (err) {
      reject(err);
    }
  }, 0));
  return {
    raw: () => value,
    read: () => (options.async ? later(() => value) : value),
    update: (fn) => {
      const run = () => {
        const next = fn(value);
        if (next !== null) value = next;
      };
      if (options.async) return later(run);
      run();
    },
  };
}

function wrapChannel(channel: BroadcastChannel, onMessage: (m: StateChannelMessage) => void): StateChannel {
  channel.onmessage = (ev: MessageEvent) => {
    const data = ev.data as Partial<StateChannelMessage> | null;
    if (data && typeof data.rev === "number" && typeof data.writerTabId === "string") onMessage({ rev: data.rev, writerTabId: data.writerTabId });
  };
  return { post: (m) => channel.postMessage(m), close: () => channel.close() };
}

/** The real browser channel, or null where BroadcastChannel doesn't exist (the caller then
 *  relies on the focus/visibilitychange fallback). */
export const browserStateChannel: StateChannelFactory = (onMessage) => {
  if (typeof window === "undefined" || typeof (window as { BroadcastChannel?: unknown }).BroadcastChannel !== "function") return null;
  return wrapChannel(new window.BroadcastChannel(STATE_CHANNEL_NAME), onMessage);
};

/** L5 — the same channel under another name (one per signed-in member, so tabs of different
 *  members on one device never exchange revisions). */
export const namedBrowserStateChannel =
  (name: string): StateChannelFactory =>
  (onMessage) => {
    if (typeof window === "undefined" || typeof (window as { BroadcastChannel?: unknown }).BroadcastChannel !== "function") return null;
    return wrapChannel(new window.BroadcastChannel(name), onMessage);
  };

/** A same-process hub standing in for BroadcastChannel in tests: every channel created from
 *  one hub receives every other channel's posts (never its own, like the real API). */
export function createStateChannelHub(): StateChannelFactory {
  const members = new Set<(m: StateChannelMessage) => void>();
  return (onMessage) => {
    members.add(onMessage);
    return {
      post: (m) => members.forEach((deliver) => deliver !== onMessage && deliver(m)),
      close: () => members.delete(onMessage),
    };
  };
}

// ===== L5 — a keyed backend (one device's storage, many keys) =================================
// The store keeps each signed-in member's data under its own key on the device; this is the
// backend those keys live in: IndexedDB in the browser, localStorage where IndexedDB is missing,
// an in-memory map in tests (standing in for one device).

export interface KeyedStateBackend {
  read(key: string): Promise<string | null>;
  /** Atomic read-modify-write; `fn` returns the value to write, or null to write nothing. */
  update(key: string, fn: (current: string | null) => string | null): Promise<void>;
  remove(key: string): Promise<void>;
}

export function createMemoryKeyedBackend(initial: Record<string, string> = {}): KeyedStateBackend & { dump(): Record<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    dump: () => Object.fromEntries(values),
    read: async (key) => values.get(key) ?? null,
    update: async (key, fn) => {
      const next = fn(values.get(key) ?? null);
      if (next !== null) values.set(key, next);
    },
    remove: async (key) => {
      values.delete(key);
    },
  };
}

export function createLocalStorageKeyedBackend(getStorage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">): KeyedStateBackend {
  return {
    read: async (key) => getStorage().getItem(key),
    update: async (key, fn) => {
      const next = fn(getStorage().getItem(key));
      if (next !== null) getStorage().setItem(key, next);
    },
    remove: async (key) => getStorage().removeItem(key),
  };
}
