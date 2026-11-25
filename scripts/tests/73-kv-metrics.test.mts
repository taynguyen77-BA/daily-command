// V2.53 (Phase 0) — withKvMetrics counts bytes and changes nothing; the aggregation groups by key base.
import { ok } from "./harness.mts";
import { createInMemoryKv } from "../../src/lib/command-center/kv/kv.ts";
import { aggregateKvMetrics, redactKey, withKvMetrics } from "../../src/lib/command-center/kv/kv-metrics.ts";

const G = "kv-metrics";
const lines: string[] = [];
const raw = createInMemoryKv();
const kv = withKvMetrics(raw, { log: (l) => lines.push(l), tag: () => "test" });

const value = { a: "x".repeat(100), n: [1, 2, 3] };
const size = JSON.stringify(value).length;
await kv.set("daily-command:app-state:v1:u:alice", value);
const back = await kv.get("daily-command:app-state:v1:u:alice");
ok(G, JSON.stringify(back) === JSON.stringify(value), "get returns exactly what was set (pass-through)");
ok(G, (await raw.get("daily-command:app-state:v1:u:alice")) !== null, "the value really reached the underlying store");
ok(G, (await kv.get("missing")) === null, "a missing key still reads null");
await kv.sadd("s", "m1");
ok(G, (await kv.smembers("s")).join() === "m1", "sets pass through");
await kv.rpush("l", { z: 1 });
ok(G, (await kv.lrange("l", 0, -1)).length === 1, "lists pass through");
await kv.del("l");

const parsed = lines.map((l) => JSON.parse(l.replace("[kv-metrics] ", "")) as { op: string; key: string; bytesIn: number; bytesOut: number; tag?: string });
const set = parsed.find((p) => p.op === "set")!;
const get = parsed.find((p) => p.op === "get" && p.key.startsWith("daily-command"))!;
ok(G, set.bytesIn === size && set.bytesOut === 0, `set counts bytes in (${size})`);
ok(G, get.bytesOut === size && get.bytesIn === 0, `get counts bytes out (${size})`);
ok(G, !/alice/.test(lines.join("\n")), "the uid never appears in a log line");
ok(G, set.key === redactKey("daily-command:app-state:v1:u:alice") && set.tag === "test", "key is hashed deterministically; tag carried");
ok(G, parsed.find((p) => p.key === "missing")!.bytesOut === 0, "a null read is 0 bytes");

const rows = aggregateKvMetrics([...lines, "noise line", "[kv-metrics] {not json"]);
const app = rows.find((r) => r.keyBase === "daily-command:app-state:v1")!;
ok(G, app.calls === 2 && app.bytesRead === size && app.bytesWritten === size && app.maxBytes === size, "aggregation groups per key base (uid stripped) and ignores noise");
ok(G, rows[0].keyBase === "daily-command:app-state:v1" && Math.abs(rows.reduce((s, r) => s + r.pct, 0) - 100) < 0.5, "sorted by bytes; percentages sum to ~100");
