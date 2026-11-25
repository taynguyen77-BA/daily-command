// V2.53 fix 1 — cron-tick read/write amplification: batch reads (mget seam), no write when only the cursor moved
// (and it is fresh), prefs read once per tick.
import fs from "node:fs";
import { ok } from "./harness.mts";
import { strictJiraFake } from "./helpers.mts";
import { runCronTick } from "../../src/lib/command-center/jira/cron-tick.ts";
import { createInMemoryNotifyStore } from "../../src/lib/command-center/notify-state.ts";
import { createInMemoryNotifyPrefsStore } from "../../src/lib/command-center/notify-prefs.ts";
import { createInMemoryDigestStore } from "../../src/lib/command-center/notify-digest.ts";
import { createInMemoryReminderIndexStore } from "../../src/lib/command-center/reminder-index.ts";
import { createInMemoryBriefingStore } from "../../src/lib/command-center/briefing.ts";
import { createInMemoryKv, kvMget } from "../../src/lib/command-center/kv/kv.ts";
import { kvFromRedis, type RedisLike } from "../../src/lib/command-center/kv/redis-adapter.ts";
import { withKvMetrics } from "../../src/lib/command-center/kv/kv-metrics.ts";
import { memoizePrefsStore, shouldWriteNotifyState } from "../../src/lib/command-center/cron-read-savings.ts";

const G = "kv-fix1";

// --- mget seam
const mem = createInMemoryKv();
await mem.set("a", { n: 1 });
await mem.set("c", [3]);
const got = await kvMget(mem, ["a", "b", "c"]);
ok(G, JSON.stringify(got) === JSON.stringify([{ n: 1 }, null, [3]]), "in-memory mget: values in order, missing = null");
ok(G, (await kvMget(mem, [])).length === 0, "empty key list = no call");
const plain = { ...mem, mget: undefined } as typeof mem;
ok(G, JSON.stringify(await kvMget(plain, ["a", "b"])) === JSON.stringify([{ n: 1 }, null]), "a KV without mget falls back to sequential gets");
let mgetCalls = 0;
const fakeRedis = { mget: async (...k: string[]) => { mgetCalls++; return k.map((x) => (x === "a" ? { n: 1 } : null)); } } as unknown as RedisLike;
const viaRedis = kvFromRedis(fakeRedis);
ok(G, JSON.stringify(await kvMget(viaRedis, ["a", "z"])) === JSON.stringify([{ n: 1 }, null]) && mgetCalls === 1, "redis adapter: ONE mget round trip");
const lines: string[] = [];
const wrapped = withKvMetrics(mem, { log: (l) => lines.push(l) });
await kvMget(wrapped, ["a", "c"]);
ok(G, lines.length === 1 && /"op":"mget"/.test(lines[0]), "the metrics wrapper passes mget through and logs it once");

// --- notify-state write skip
const base = { assignedIssueKeys: ["A-1"], notifiedCommentIds: ["c1"], lastCheckedAtIso: "2026-11-25T10:00:00.000Z" };
const now = new Date("2026-11-25T10:20:00.000Z");
ok(G, shouldWriteNotifyState(base, { ...base, lastCheckedAtIso: now.toISOString() }, now) === false, "only the cursor moved and it is 20 min old -> skip the write");
ok(G, shouldWriteNotifyState(base, { ...base, lastCheckedAtIso: now.toISOString() }, new Date("2026-11-25T11:10:00.000Z")) === true, "cursor older than 60 min -> write (keeps the cursor fresh)");
ok(G, shouldWriteNotifyState(base, { ...base, assignedIssueKeys: ["A-1", "A-2"], lastCheckedAtIso: now.toISOString() }, now) === true, "a real change always writes");
ok(G, shouldWriteNotifyState(base, { ...base, notifiedCommentIds: ["c1", "c2"] }, now) === true, "new notified id always writes");
ok(G, shouldWriteNotifyState(null, base, now) === true, "no previous state -> write");
ok(G, shouldWriteNotifyState({ ...base, lastCheckedAtIso: "garbage" }, { ...base, lastCheckedAtIso: now.toISOString() }, now) === true, "unreadable previous cursor -> write");
ok(G, shouldWriteNotifyState({ ...base, lastCheckedAtIso: "2026-11-25T12:00:00.000Z" }, { ...base, lastCheckedAtIso: now.toISOString() }, now) === true, "a cursor from the future -> write");

// --- prefs read once
let prefsGets = 0;
const store = memoizePrefsStore({ get: async () => { prefsGets++; return null; }, set: async () => undefined });
await store.get(); await store.get(); await store.get();
ok(G, prefsGets === 1, "prefs store hit KV once for three reads in one tick");
let setSeen = false;
const s2 = memoizePrefsStore({ get: async () => { prefsGets++; return null; }, set: async () => { setSeen = true; } });
await s2.get();
await s2.set({ mode: "immediate", immediateKinds: [], mutedProjects: [], maxPerRun: 0, escalateUnanswered: false });
await s2.get();
ok(G, setSeen && prefsGets === 3, "a set invalidates the memo");

// --- wiring (static)
const notify = fs.readFileSync("src/lib/command-center/cron-notify.ts", "utf8");
ok(G, /shouldWriteNotifyState\(/.test(notify), "cron-notify uses the write-skip rule");
const tick = fs.readFileSync("src/lib/command-center/jira/cron-tick.ts", "utf8");
ok(G, /memoizePrefsStore\(/.test(tick), "cron-tick memoizes the prefs store per tick");
const users = fs.readFileSync("src/lib/command-center/auth/users.ts", "utf8");
ok(G, /kvMget\(/.test(users), "listUsers batches its reads with kvMget");
const yml = fs.readFileSync(".github/workflows/sync.yml", "utf8");
ok(G, /- cron: "\*\/15 \* \* \* \*"/.test(yml) && /KV-BANDWIDTH/.test(yml), "sync.yml keeps */15 as the default and documents the alternative");

// --- behaviour: a quiet member's two consecutive ticks
{
  const JIRA = { baseUrl: "https://example.atlassian.net", email: "me@example.com", apiToken: "t" } as never;
  const fetchImpl = strictJiraFake(async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/search/jql")) return { ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) };
    if (/\/myself/.test(u.pathname)) return { ok: true, status: 200, json: async () => ({ timeZone: "UTC" }) };
    return { ok: false, status: 404, json: async () => ({}) };
  });
  const counts = { prefsGet: 0, notifySet: 0 };
  const notifyInner = createInMemoryNotifyStore();
  const notifyStore = { get: () => notifyInner.get(), set: async (st: Parameters<typeof notifyInner.set>[0]) => { counts.notifySet++; await notifyInner.set(st); } };
  const prefsInner = createInMemoryNotifyPrefsStore();
  const prefsStore = { get: async () => { counts.prefsGet++; return prefsInner.get(); }, set: (p: never) => prefsInner.set(p) };
  const steps = () => ({
    notifyStore,
    timeZone: "UTC",
    smartNotify: { prefsStore, digestStore: createInMemoryDigestStore() },
    reminders: { store: createInMemoryReminderIndexStore(), now: new Date() },
    briefing: { store: createInMemoryBriefingStore(), now: new Date() },
  });
  await runCronTick(fetchImpl, JIRA, "acc-me", steps()); // cold start writes the baseline
  const afterFirst = { ...counts };
  await runCronTick(fetchImpl, JIRA, "acc-me", steps()); // nothing changed
  ok(G, afterFirst.notifySet === 1 && counts.notifySet === 1, "second quiet tick writes no notify state (only the cursor moved)");
  ok(G, counts.prefsGet - afterFirst.prefsGet === 1, `prefs read once per tick, not once per step (was 3) — saw ${counts.prefsGet - afterFirst.prefsGet}`);
}
