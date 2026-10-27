// P2.4 — the KV seam: credentials, Redis adapter contract, and "only kv-client.ts imports the SDK".
import fs from "node:fs";
import path from "node:path";
import { createInMemoryKv, type KvLike } from "../../src/lib/command-center/kv/kv";
import { isKvConfigured, resolveKvCredentials } from "../../src/lib/command-center/kv/kv-credentials";
import { kvFromRedis, type RedisLike } from "../../src/lib/command-center/kv/redis-adapter";
import { isNotifyStoreConfigured } from "../../src/lib/command-center/notify-state";
import { isAppStateStoreConfigured } from "../../src/lib/command-center/app-state";
import { isServerDailyReportConfigured } from "../../src/lib/command-center/server-daily-report";
import { readAuthSettings } from "../../src/lib/command-center/auth/auth-config";
import { ok } from "./harness.mts";

const root = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");

/** A fake of the Upstash client surface the adapter uses: JSON round-trip on write, Redis list/set semantics. */
function fakeRedis(): RedisLike & { calls: string[] } {
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const sets = new Map<string, Set<string>>();
  const ttl = new Map<string, number>();
  const calls: string[] = [];
  const enc = (v: unknown) => JSON.stringify(v);
  const dec = <T>(s: string) => JSON.parse(s) as T;
  const idx = (len: number, start: number, stop: number): [number, number] => [start < 0 ? Math.max(0, len + start) : start, stop < 0 ? len + stop : Math.min(stop, len - 1)];
  return {
    calls,
    async get<T>(k: string) { calls.push("get"); return values.has(k) ? dec<T>(values.get(k)!) : null; },
    async set(k: string, v: unknown) { calls.push("set"); values.set(k, enc(v)); return "OK"; },
    async del(...ks: string[]) { calls.push("del"); for (const k of ks) { values.delete(k); lists.delete(k); sets.delete(k); } return ks.length; },
    async rpush(k: string, ...vs: unknown[]) { calls.push("rpush"); const l = lists.get(k) ?? []; l.push(...vs.map(enc)); lists.set(k, l); return l.length; },
    async lrange<T>(k: string, a: number, b: number) { calls.push("lrange"); const l = lists.get(k) ?? []; const [s, e] = idx(l.length, a, b); return l.slice(s, e + 1).map((x) => { try { return dec<T>(x); } catch { return x as unknown as T; } }); },
    async ltrim(k: string, a: number, b: number) { calls.push("ltrim"); const l = lists.get(k) ?? []; const [s, e] = idx(l.length, a, b); lists.set(k, l.slice(s, e + 1)); return "OK"; },
    async expire(k: string, sec: number) { calls.push("expire"); ttl.set(k, sec); return 1; },
    async sadd(k: string, m: string, ...ms: string[]) { calls.push("sadd"); const st = sets.get(k) ?? new Set(); [m, ...ms].forEach((x) => st.add(x)); sets.set(k, st); return st.size; },
    async srem(k: string, ...ms: string[]) { calls.push("srem"); const st = sets.get(k); ms.forEach((x) => st?.delete(x)); return 1; },
    async smembers(k: string) { calls.push("smembers"); return Array.from(sets.get(k) ?? []); },
  };
}

async function contract(label: string, kv: KvLike) {
  const group = `P2.4 KV contract (${label})`;
  ok(group, (await kv.get("missing")) === null, "a missing key reads as null");
  await kv.set("obj", { a: 1, nested: { b: [1, 2] } });
  const got = await kv.get<{ a: number; nested: { b: number[] } }>("obj");
  ok(group, got?.a === 1 && got.nested.b[1] === 2, "set/get round-trips a JSON value");
  await kv.set("obj", { a: 2 });
  ok(group, (await kv.get<{ a: number }>("obj"))?.a === 2, "set overwrites");
  await kv.del("obj");
  ok(group, (await kv.get("obj")) === null, "del removes");
  for (const v of ["l1", "l2", "l3", "l4"]) await kv.rpush("list", v);
  ok(group, JSON.stringify(await kv.lrange("list", 0, -1)) === '["l1","l2","l3","l4"]', "rpush appends in order; lrange 0..-1 returns all");
  ok(group, JSON.stringify(await kv.lrange("list", -2, -1)) === '["l3","l4"]' && JSON.stringify(await kv.lrange("list", 1, 1)) === '["l2"]', "lrange with negative / single indexes");
  await kv.ltrim("list", -2, -1);
  ok(group, JSON.stringify(await kv.lrange("list", 0, -1)) === '["l3","l4"]', "ltrim keeps the newest entries");
  await kv.rpush("objs", JSON.stringify({ day: "2026-10-27" }));
  const raw = (await kv.lrange<unknown>("objs", 0, -1))[0];
  ok(group, (typeof raw === "string" ? JSON.parse(raw) : raw).day === "2026-10-27", "a JSON-string list entry (the usage ledger's shape) reads back parseable");
  await kv.expire("list", 60); // must not throw
  await kv.sadd("set", "a"); await kv.sadd("set", "b"); await kv.sadd("set", "a");
  ok(group, JSON.stringify((await kv.smembers("set")).sort()) === '["a","b"]', "sadd is idempotent; smembers lists members");
  await kv.srem("set", "a");
  ok(group, JSON.stringify(await kv.smembers("set")) === '["b"]' && (await kv.smembers("nope")).length === 0, "srem removes; an unknown set is empty");
}

await contract("in-memory", createInMemoryKv());
const redis = fakeRedis();
await contract("Redis adapter", kvFromRedis(redis));
ok("P2.4 KV contract (Redis adapter)", ["get", "set", "del", "rpush", "lrange", "ltrim", "expire", "sadd", "srem", "smembers"].every((c) => redis.calls.includes(c)), "the adapter uses exactly the Redis commands the app needs (get/set/del/rpush/lrange/ltrim/expire/sadd/srem/smembers)");

{
  const group = "P2.4 Credentials";
  const kvPair = { KV_REST_API_URL: "https://kv.example", KV_REST_API_TOKEN: "kv-t" };
  const upPair = { UPSTASH_REDIS_REST_URL: "https://up.example", UPSTASH_REDIS_REST_TOKEN: "up-t" };
  ok(group, resolveKvCredentials({}) === null && !isKvConfigured({}), "nothing set -> not configured (every store stays a silent no-op)");
  ok(group, resolveKvCredentials(kvPair)?.url === "https://kv.example" && resolveKvCredentials(kvPair)?.source === "KV_REST_API", "KV_REST_API_* alone works (existing deployments)");
  ok(group, resolveKvCredentials(upPair)?.token === "up-t" && resolveKvCredentials(upPair)?.source === "UPSTASH_REDIS_REST", "UPSTASH_REDIS_REST_* alone works");
  ok(group, resolveKvCredentials({ ...upPair, ...kvPair })?.source === "KV_REST_API", "both complete pairs: the first (KV_*) wins");
  ok(group, resolveKvCredentials({ KV_REST_API_URL: "https://kv.example", ...upPair })?.source === "UPSTASH_REDIS_REST", "a half-set KV pair is skipped in favour of the complete Upstash pair");
  ok(group, resolveKvCredentials({ KV_REST_API_URL: "https://kv.example" }) === null && resolveKvCredentials({ KV_REST_API_URL: "  ", KV_REST_API_TOKEN: "t" }) === null, "half or blank pairs are not credentials");

  // every "is KV configured" check agrees, for both name pairs
  const saved = { u: process.env.KV_REST_API_URL, t: process.env.KV_REST_API_TOKEN, uu: process.env.UPSTASH_REDIS_REST_URL, ut: process.env.UPSTASH_REDIS_REST_TOKEN };
  for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) delete process.env[k];
  const off = [isNotifyStoreConfigured(), isAppStateStoreConfigured()];
  Object.assign(process.env, upPair);
  const on = [isNotifyStoreConfigured(), isAppStateStoreConfigured()];
  ok(group, off.every((v) => v === false) && on.every((v) => v === true), "notify-store and app-state-store configured checks honour the Upstash names");
  for (const k of Object.keys(upPair)) delete process.env[k];
  if (saved.u !== undefined) process.env.KV_REST_API_URL = saved.u;
  if (saved.t !== undefined) process.env.KV_REST_API_TOKEN = saved.t;
  if (saved.uu !== undefined) process.env.UPSTASH_REDIS_REST_URL = saved.uu;
  if (saved.ut !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = saved.ut;
  ok(group, isServerDailyReportConfigured({ ...upPair, APP_STATE_SECRET: "s", PERSONAL_JIRA_ACCOUNT_ID: "a" }) && !isServerDailyReportConfigured({ APP_STATE_SECRET: "s", PERSONAL_JIRA_ACCOUNT_ID: "a" }), "the daily-report gate honours both pairs");
  const authEnv = { AUTH_ENABLED: "true", NEXTAUTH_SECRET: "x", AUTH_ADMIN_EMAILS: "a@b.com", AUTH_GOOGLE_ID: "i", AUTH_GOOGLE_SECRET: "s", NODE_ENV: "production" } as Record<string, string>;
  ok(group, readAuthSettings(authEnv).missing.some((m) => m.startsWith("KV_REST_API_URL")) && !readAuthSettings({ ...authEnv, ...upPair }).missing.some((m) => m.startsWith("KV_REST_API_URL")), "sign-in's production KV requirement is met by the Upstash names too");
}

{
  const group = "P2.4 One seam";
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|tsx|mts)$/.test(e.name) ? [path.join(dir, e.name)] : []));
  const importers = [...walk(path.join(root, "src")), ...walk(path.join(root, "scripts"))].filter((f) => /^\s*(import|export)[^\n]*from ["']@upstash\/redis["']|import\(["']@upstash\/redis["']\)|["']@vercel\/kv["']\s*\)|from ["']@vercel\/kv["']/m.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(root, f));
  ok(group, JSON.stringify(importers) === JSON.stringify(["src/lib/server/kv-client.ts"]), `only kv-client.ts imports the Redis SDK (${importers.join(", ") || "none"})`);
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
  ok(group, !("@vercel/kv" in pkg.dependencies) && "@upstash/redis" in pkg.dependencies, "package.json: @vercel/kv removed, @upstash/redis added");
  ok(group, !fs.existsSync(path.join(root, "node_modules/@vercel/kv")), "@vercel/kv is not installed");
  const readme = read("README.md");
  ok(group, /UPSTASH_REDIS_REST_URL/.test(readme) && /first complete pair wins/.test(readme), "README documents both variable-name pairs");
  ok(group, /usage-ledger/.test("usage-ledger") && /server\/kv-client/.test(read("src/lib/command-center/ai/usage-ledger.ts")) && !/@vercel\/kv/.test(read("src/lib/command-center/ai/usage-ledger.ts")), "the AI usage ledger reaches KV through the seam");
}
