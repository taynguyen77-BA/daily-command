// L4 — the real Vercel KV client behind the KvLike interface (kv/kv.ts) every store is written
// against. Server-only: KV credentials come from env and must never reach a browser bundle.

import "server-only";
import { kv } from "@vercel/kv";
import { createInMemoryKv, type KvLike } from "../command-center/kv/kv";

export const vercelKv: KvLike = {
  get: (key) => kv.get(key),
  set: async (key, value) => {
    await kv.set(key, value);
  },
  del: async (key) => {
    await kv.del(key);
  },
  rpush: async (key, ...values) => {
    await kv.rpush(key, ...values);
  },
  lrange: (key, start, stop) => kv.lrange(key, start, stop),
  ltrim: async (key, start, stop) => {
    await kv.ltrim(key, start, stop);
  },
  expire: async (key, seconds) => {
    await kv.expire(key, seconds);
  },
  sadd: async (key, member) => {
    await kv.sadd(key, member);
  },
  srem: async (key, member) => {
    await kv.srem(key, member);
  },
  smembers: (key) => kv.smembers(key),
};

const devKv = globalThis as { __dailyCommandDevKv?: KvLike };

/** The user directory's KV: Vercel KV when configured; otherwise — outside production only —
 *  one in-memory store per server process, so a local dev server can try sign-in without KV.
 *  (readAuthSettings refuses AUTH_ENABLED in production without KV.) */
export function directoryKv(): KvLike | null {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) return vercelKv;
  if (process.env.NODE_ENV === "production") return null;
  return (devKv.__dailyCommandDevKv ??= createInMemoryKv());
}
