// L4 — the real Redis/KV client behind the KvLike interface (kv/kv.ts) every store is written
// against. Server-only: credentials come from env and must never reach a browser bundle.
//
// P2.4 — this is the ONE file that imports the Redis SDK (@upstash/redis; @vercel/kv, a thin
// deprecated wrapper over it, is gone). Credentials: KV_REST_API_URL/TOKEN or
// UPSTASH_REDIS_REST_URL/TOKEN — the first complete pair wins (kv/kv-credentials.ts). Unconfigured
// still means "silent no-op" for every store (they check isKvConfigured before using this).

import "server-only";
import { Redis } from "@upstash/redis";
import { createInMemoryKv, type KvLike } from "../command-center/kv/kv";
import { resolveKvCredentials } from "../command-center/kv/kv-credentials";
import { kvFromRedis, type RedisLike } from "../command-center/kv/redis-adapter";

let client: KvLike | null = null;
let clientKey = "";

function realKv(): KvLike {
  const creds = resolveKvCredentials(process.env);
  if (!creds) throw new Error("KV is not configured.");
  const key = `${creds.url}|${creds.token}`;
  if (!client || clientKey !== key) {
    client = kvFromRedis(new Redis({ url: creds.url, token: creds.token }) as unknown as RedisLike);
    clientKey = key;
  }
  return client;
}

/** Resolved lazily on each call, so importing this module never needs credentials. (Name kept from
 *  the @vercel/kv days: every store binds to it.) */
export const vercelKv: KvLike = {
  get: (key) => realKv().get(key),
  set: (key, value) => realKv().set(key, value),
  del: (key) => realKv().del(key),
  rpush: (key, ...values) => realKv().rpush(key, ...values),
  lrange: (key, start, stop) => realKv().lrange(key, start, stop),
  ltrim: (key, start, stop) => realKv().ltrim(key, start, stop),
  expire: (key, seconds) => realKv().expire(key, seconds),
  sadd: (key, member) => realKv().sadd(key, member),
  srem: (key, member) => realKv().srem(key, member),
  smembers: (key) => realKv().smembers(key),
};

const devKv = globalThis as { __dailyCommandDevKv?: KvLike };

/** The user directory's KV: the real store when configured; otherwise — outside production only —
 *  one in-memory store per server process, so a local dev server can try sign-in without KV.
 *  (readAuthSettings refuses AUTH_ENABLED in production without KV.) */
export function directoryKv(): KvLike | null {
  if (resolveKvCredentials(process.env)) return vercelKv;
  if (process.env.NODE_ENV === "production") return null;
  return (devKv.__dailyCommandDevKv ??= createInMemoryKv());
}
