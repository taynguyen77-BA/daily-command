// V2.53 fix 3 — app-state: conditional GET (tiny meta key, no blob when the client is current), legacy blobs without
// meta still work (lazy meta), focus pulls throttled, no push when nothing is pending.
import fs from "node:fs";
import { ok } from "./harness.mts";
import { createInMemoryKv } from "../../src/lib/command-center/kv/kv.ts";
import { APP_STATE_KEY, createKvAppStateStore } from "../../src/lib/command-center/kv/kv-stores.ts";
import { withKvMetrics, aggregateKvMetrics } from "../../src/lib/command-center/kv/kv-metrics.ts";
import { shouldPullNow, PULL_MIN_INTERVAL_MS } from "../../src/lib/command-center/app-state-pull-throttle.ts";

const G = "kv-fix3";
const slice = (updatedAtIso: string, pad = 0) => ({
  jiraWorkRelevancePolicy: {}, attentionState: {}, decisions: [{ pad: "x".repeat(pad) }], actionPlanState: { actions: [], personalPlan: [] }, memoryEvents: [], uiPreferences: {}, updatedAtIso,
}) as never;

const T1 = "2026-11-25T10:00:00.000Z", T2 = "2026-11-25T11:00:00.000Z";

// ---- a legacy blob (no meta key) is still served in full, and meta appears lazily
{
  const kv = createInMemoryKv();
  await kv.set(APP_STATE_KEY, slice(T1, 50_000));
  const store = createKvAppStateStore(kv);
  ok(G, (await store.get())!.updatedAtIso === T1, "plain get() on a legacy blob is unchanged");
  const full = await store.getIfChanged!(undefined);
  ok(G, "state" in full && full.state?.updatedAtIso === T1, "no known time -> the blob");
  ok(G, kv.keys().some((k) => k.includes("app-state-meta")), "meta is written lazily on that read");
  const same = await store.getIfChanged!(T1);
  ok(G, "unchanged" in same && same.unchanged === true, "known == stored -> unchanged");
  const newer = await store.getIfChanged!("2026-11-25T09:00:00.000Z");
  ok(G, "state" in newer && !!newer.state, "known older than stored -> the blob");
}

// ---- unchanged answers read only the tiny meta key
{
  const raw = createInMemoryKv();
  const lines: string[] = [];
  const kv = withKvMetrics(raw, { log: (l) => lines.push(l) });
  const store = createKvAppStateStore(kv);
  await store.set(slice(T1, 100_000));
  lines.length = 0;
  const r = await store.getIfChanged!(T1);
  const rows = aggregateKvMetrics(lines);
  ok(G, "unchanged" in r && rows.reduce((s, x) => s + x.bytesRead, 0) < 200, `an up-to-date client costs ${rows.reduce((s, x) => s + x.bytesRead, 0)} B of KV reads (blob is ~100 KB)`);
  await store.set(slice(T2, 100_000));
  const after = await store.getIfChanged!(T1);
  ok(G, "state" in after && after.state?.updatedAtIso === T2, "after a newer set the old client gets the blob");
  ok(G, "unchanged" in (await store.getIfChanged!(T2)), "and the new client is up to date");
}

// ---- throttle
{
  ok(G, shouldPullNow(null, 1_000) === true, "first pull always runs");
  ok(G, shouldPullNow(1_000, 1_000 + PULL_MIN_INTERVAL_MS - 1) === false, "a second focus within the interval is skipped");
  ok(G, shouldPullNow(1_000, 1_000 + PULL_MIN_INTERVAL_MS) === true, "after the interval it runs");
  ok(G, shouldPullNow(5_000, 1_000) === true, "a clock that went backwards never blocks pulls");
  ok(G, PULL_MIN_INTERVAL_MS === 60_000, "minimum interval is 60 s");
}

// ---- wiring (static)
const route = fs.readFileSync("src/app/api/command-center/state/route.ts", "utf8");
ok(G, /knownUpdatedAt/.test(route) && /getIfChanged/.test(route), "GET state supports ?knownUpdatedAt=");
const sync = fs.readFileSync("src/lib/command-center/app-state-sync.ts", "utf8");
ok(G, /knownUpdatedAt=/.test(sync), "the client asks conditionally");
ok(G, /shouldPullNow\(/.test(sync), "focus/visibility pulls are throttled");
const flush = sync.slice(sync.indexOf("async function flushPendingPush"), sync.indexOf("async function pullIfServerNewer"));
ok(G, /comparableJson\(store\.getSnapshot\(\)\) === lastKnownSliceJson/.test(flush.slice(0, 500)), "flush skips the push when nothing is pending");
