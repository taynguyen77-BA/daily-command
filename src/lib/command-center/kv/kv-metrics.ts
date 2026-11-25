// V2.53 — opt-in KV bandwidth instrumentation (KV_METRICS=1). withKvMetrics() wraps any KvLike and
// logs ONE JSON line per call (op, key with the uid hashed, bytes in/out, ms, optional caller tag);
// values pass through untouched. aggregateKvMetrics() turns those lines into a per-key-base table
// (scripts/kv-metrics-report.mts). Pure: no I/O besides the injected `log`.

import type { KvLike } from "./kv";

export const KV_METRICS_PREFIX = "[kv-metrics] ";

export interface KvMetricLine {
  op: string;
  key: string;
  bytesIn: number;
  bytesOut: number;
  ms: number;
  tag?: string;
}

const bytesOf = (v: unknown): number => {
  if (v === undefined || v === null) return 0;
  try {
    return JSON.stringify(v).length;
  } catch {
    return 0;
  }
};

/** `base:u:<uid>` → `base:u:<8-char hash>` so a log never carries a user id. */
export function redactKey(key: string): string {
  const i = key.indexOf(":u:");
  if (i < 0) return key;
  const uid = key.slice(i + 3);
  let h = 5381;
  for (let c = 0; c < uid.length; c++) h = ((h << 5) + h + uid.charCodeAt(c)) >>> 0;
  return `${key.slice(0, i)}:u:${h.toString(16).padStart(8, "0")}`;
}

/** Strip the per-user suffix and any per-day / per-id tail so calls group by key family. */
export function keyBase(key: string): string {
  const i = key.indexOf(":u:");
  return i < 0 ? key : key.slice(0, i);
}

export function withKvMetrics(kv: KvLike, opts: { log?: (line: string) => void; tag?: () => string | undefined } = {}): KvLike {
  const log = opts.log ?? ((l: string) => console.log(l));
  const time = async <T>(op: string, key: string, bytesIn: number, run: () => Promise<T>, out: (r: T) => number): Promise<T> => {
    const t0 = Date.now();
    const r = await run();
    const line: KvMetricLine = { op, key: redactKey(key), bytesIn, bytesOut: out(r), ms: Date.now() - t0 };
    const tag = opts.tag?.();
    if (tag) line.tag = tag;
    log(KV_METRICS_PREFIX + JSON.stringify(line));
    return r;
  };
  const none = () => 0;
  return {
    get: (key) => time("get", key, 0, () => kv.get(key), bytesOf),
    set: (key, value) => time("set", key, bytesOf(value), () => kv.set(key, value), none),
    del: (key) => time("del", key, 0, () => kv.del(key), none),
    rpush: (key, ...values) => time("rpush", key, bytesOf(values), () => kv.rpush(key, ...values), none),
    lrange: (key, start, stop) => time("lrange", key, 0, () => kv.lrange(key, start, stop), bytesOf),
    ltrim: (key, start, stop) => time("ltrim", key, 0, () => kv.ltrim(key, start, stop), none),
    expire: (key, seconds) => time("expire", key, 0, () => kv.expire(key, seconds), none),
    sadd: (key, member) => time("sadd", key, bytesOf(member), () => kv.sadd(key, member), none),
    srem: (key, member) => time("srem", key, bytesOf(member), () => kv.srem(key, member), none),
    smembers: (key) => time("smembers", key, 0, () => kv.smembers(key), bytesOf),
    ...(kv.mget ? { mget: <T,>(keys: string[]) => time("mget", keys[0] ?? "", 0, () => kv.mget!<T>(keys), bytesOf) } : {}),
  };
}

export interface KvMetricRow {
  keyBase: string;
  calls: number;
  bytesRead: number;
  bytesWritten: number;
  avgBytes: number;
  maxBytes: number;
  pct: number;
}

export function aggregateKvMetrics(lines: string[]): KvMetricRow[] {
  const acc = new Map<string, { calls: number; read: number; written: number; max: number }>();
  for (const raw of lines) {
    const at = raw.indexOf(KV_METRICS_PREFIX);
    if (at < 0) continue;
    let m: KvMetricLine;
    try {
      m = JSON.parse(raw.slice(at + KV_METRICS_PREFIX.length)) as KvMetricLine;
    } catch {
      continue;
    }
    if (typeof m.key !== "string") continue;
    const base = keyBase(m.key);
    const a = acc.get(base) ?? { calls: 0, read: 0, written: 0, max: 0 };
    a.calls += 1;
    a.read += m.bytesOut || 0;
    a.written += m.bytesIn || 0;
    a.max = Math.max(a.max, m.bytesOut || 0, m.bytesIn || 0);
    acc.set(base, a);
  }
  const total = Array.from(acc.values()).reduce((s, a) => s + a.read + a.written, 0);
  return Array.from(acc.entries())
    .map(([base, a]) => ({ keyBase: base, calls: a.calls, bytesRead: a.read, bytesWritten: a.written, avgBytes: a.calls ? Math.round((a.read + a.written) / a.calls) : 0, maxBytes: a.max, pct: total ? Math.round(((a.read + a.written) / total) * 1000) / 10 : 0 }))
    .sort((x, y) => y.bytesRead + y.bytesWritten - (x.bytesRead + x.bytesWritten));
}
