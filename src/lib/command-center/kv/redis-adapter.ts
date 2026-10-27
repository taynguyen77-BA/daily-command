// P2.4 — KvLike over a Redis client, written against the minimal RedisLike interface below (the
// subset of @upstash/redis this app uses) so the adapter is tested offline against a fake and
// ONLY src/lib/server/kv-client.ts ever imports the SDK. Key names, value shapes and TTL calls
// are exactly what the previous @vercel/kv wrapper (a thin layer over the same client) did.

import type { KvLike } from "./kv";

export interface RedisLike {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  rpush(key: string, ...values: unknown[]): Promise<unknown>;
  lrange<T = unknown>(key: string, start: number, stop: number): Promise<T[]>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  sadd(key: string, member: string, ...members: string[]): Promise<unknown>;
  srem(key: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
}

export function kvFromRedis(redis: RedisLike): KvLike {
  return {
    get: (key) => redis.get(key),
    set: async (key, value) => {
      await redis.set(key, value);
    },
    del: async (key) => {
      await redis.del(key);
    },
    rpush: async (key, ...values) => {
      await redis.rpush(key, ...values);
    },
    lrange: (key, start, stop) => redis.lrange(key, start, stop),
    ltrim: async (key, start, stop) => {
      await redis.ltrim(key, start, stop);
    },
    expire: async (key, seconds) => {
      await redis.expire(key, seconds);
    },
    sadd: async (key, member) => {
      await redis.sadd(key, member);
    },
    srem: async (key, member) => {
      await redis.srem(key, member);
    },
    smembers: (key) => redis.smembers(key),
  };
}
