// L4 — the subset of Vercel KV this app uses, as an interface, so every KV-backed store runs
// unchanged against the real client (src/lib/server/kv-client.ts) or the in-memory one below
// (tests, and a non-production dev server without KV).

export interface KvLike {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  rpush(key: string, ...values: unknown[]): Promise<void>;
  lrange<T = unknown>(key: string, start: number, stop: number): Promise<T[]>;
  ltrim(key: string, start: number, stop: number): Promise<void>;
  expire(key: string, seconds: number): Promise<void>;
  sadd(key: string, member: string): Promise<void>;
  srem(key: string, member: string): Promise<void>;
  smembers(key: string): Promise<string[]>;
}

/** Redis-style list index → array index (negative counts from the end). */
function range(len: number, start: number, stop: number): [number, number] {
  const s = start < 0 ? Math.max(0, len + start) : Math.min(start, len);
  const e = stop < 0 ? len + stop : Math.min(stop, len - 1);
  return [s, e];
}

/** In-memory KV. Values are JSON round-tripped, like the real store, so a caller can never
 *  mutate what is stored by holding a reference. */
export function createInMemoryKv(): KvLike & { keys(): string[] } {
  const values = new Map<string, unknown>();
  const lists = new Map<string, unknown[]>();
  const sets = new Map<string, Set<string>>();
  const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
  return {
    keys: () => [...Array.from(values.keys()), ...Array.from(lists.keys()), ...Array.from(sets.keys())],
    async get<T>(key: string) {
      return values.has(key) ? clone(values.get(key) as T) : null;
    },
    async set(key, value) {
      values.set(key, clone(value));
    },
    async del(key) {
      values.delete(key);
      lists.delete(key);
      sets.delete(key);
    },
    async rpush(key, ...items) {
      const l = lists.get(key) ?? [];
      l.push(...items.map(clone));
      lists.set(key, l);
    },
    async lrange<T>(key: string, start: number, stop: number) {
      const l = lists.get(key) ?? [];
      const [s, e] = range(l.length, start, stop);
      return e < s ? [] : (clone(l.slice(s, e + 1)) as T[]);
    },
    async ltrim(key, start, stop) {
      const l = lists.get(key) ?? [];
      const [s, e] = range(l.length, start, stop);
      lists.set(key, e < s ? [] : l.slice(s, e + 1));
    },
    async expire() {
      // no expiry in memory
    },
    async sadd(key, member) {
      const s = sets.get(key) ?? new Set<string>();
      s.add(member);
      sets.set(key, s);
    },
    async srem(key, member) {
      sets.get(key)?.delete(member);
    },
    async smembers(key) {
      return Array.from(sets.get(key) ?? []);
    },
  };
}
