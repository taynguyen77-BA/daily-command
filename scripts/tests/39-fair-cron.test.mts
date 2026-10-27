// P2.3 — fair scheduling for the team cron.
import fs from "node:fs";
import path from "node:path";
import { createInMemoryCronProgressStore, oldestWaitMinutes, orderByLongestWaiting, type CronProgressStore } from "../../src/lib/command-center/cron-progress";
import { createKvCronProgressStore } from "../../src/lib/command-center/kv/kv-stores";
import { createInMemoryKv } from "../../src/lib/command-center/kv/kv";
import { createInMemoryHeartbeatStore } from "../../src/lib/command-center/health";
import { runCronForMembers, type CronMemberPlan } from "../../src/lib/command-center/jira/cron-tick";
import { createInMemoryNotifyStore } from "../../src/lib/command-center/notify-state";
import type { FetchLike } from "../../src/lib/command-center/jira/http";
import { ok } from "./harness.mts";
import { strictJiraFake } from "./helpers.mts";

const uid = (n: number) => `u_${String(n).padStart(24, "0")}`;
const cfg = { baseUrl: "https://example.atlassian.net", email: "a@b.com", apiToken: "tok" };
const okFetch = strictJiraFake(async (url) => new URL(url).pathname.endsWith("/search/jql") ? { ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) } : { ok: true, status: 200, json: async () => ({ comments: [] }) });
const plan = (n: number, over: Partial<CronMemberPlan> = {}): CronMemberPlan => ({ uid: uid(n), email: `m${n}@x.com`, config: cfg, accountId: `acc-${n}`, webhookUrl: null, notify: true, snapshot: false, ...over });

{
  const group = "P2.3 Ordering";
  const o = orderByLongestWaiting([
    { uid: "c", lastProcessedAt: "2026-10-27T10:00:00.000Z" },
    { uid: "b", lastProcessedAt: "2026-10-27T09:00:00.000Z" },
    { uid: "z" },
    { uid: "a" },
    { uid: "d", lastProcessedAt: "2026-10-27T09:00:00.000Z" },
    { uid: "bad", lastProcessedAt: "garbage" },
  ]);
  ok(group, o.map((p) => p.uid).join() === "a,bad,z,b,d,c", `never/invalid first (by uid), then oldest first, ties by uid: ${o.map((p) => p.uid).join()}`);
  ok(group, oldestWaitMinutes([{}, { lastProcessedAt: "2026-10-27T10:00:00.000Z" }, { lastProcessedAt: "2026-10-27T11:30:00.000Z" }], new Date("2026-10-27T12:00:00.000Z")) === 120 && oldestWaitMinutes([{}], new Date()) === undefined, "oldestWaitMinutes uses members with a known last run");
  const kv = createInMemoryKv();
  const s = createKvCronProgressStore(kv, uid(1));
  ok(group, (await s.get()) === null, "nothing stored reads as never processed");
  await s.set("2026-10-27T10:00:00.000Z");
  ok(group, (await s.get()) === "2026-10-27T10:00:00.000Z" && (await createKvCronProgressStore(kv, uid(2)).get()) === null, "stored per member, same scoping as the other per-member records");
}

{
  const group = "P2.3 Rotation under a budget";
  const N = 10, PER_RUN = 3;
  const plans = Array.from({ length: N }, (_, i) => plan(i + 1));
  const progress = new Map<string, CronProgressStore>(plans.map((p) => [p.uid, createInMemoryCronProgressStore()]));
  let wall = Date.parse("2026-10-27T00:00:00.000Z");
  const processedAt: Record<string, number[]> = {};
  const lastRunIndex = new Map<string, number>();
  let maxConsecutiveSkips = 0;
  const skipsInRow = new Map<string, number>();
  const processedRuns: string[][] = [];
  for (let run = 0; run < 4; run++) {
    wall += 15 * 60_000;
    // each member costs 1000 ms of the injected clock; budget 2500 ms -> exactly 3 members per run
    let tick = 0; // the injected clock advances 1000 ms each time a member starts (storesFor is called once per member)
    const ordered = orderByLongestWaiting(await Promise.all(plans.map(async (p) => ({ ...p, lastProcessedAt: (await progress.get(p.uid)!.get()) ?? undefined }))));
    const res = await runCronForMembers(okFetch, ordered, {
      storesFor: () => { tick += 1000; return { notifyStore: createInMemoryNotifyStore({ assignedIssueKeys: [], notifiedCommentIds: [], lastCheckedAtIso: "2026-10-27T00:00:00.000Z" }) }; },
      now: () => new Date(wall), budgetMs: 2500, clock: () => tick,
      progressFor: (u) => progress.get(u),
    });
    const done = ordered.map((p) => p.uid).filter((u) => !res.skipped.some((s) => s.uid === u));
    processedRuns.push(done);
    for (const u of done) { (processedAt[u] ??= []).push(run); skipsInRow.set(u, 0); lastRunIndex.set(u, run); }
    for (const s of res.skipped) { const n = (skipsInRow.get(s.uid) ?? 0) + 1; skipsInRow.set(s.uid, n); maxConsecutiveSkips = Math.max(maxConsecutiveSkips, n); }
  }
  ok(group, processedRuns.every((r, i) => r.length === (i < 3 ? 3 : 3)), `the budget fits 3 members per run (${processedRuns.map((r) => r.length).join(",")})`);
  ok(group, plans.every((p) => (processedAt[p.uid]?.length ?? 0) >= 1), "after 4 runs every one of the 10 members was processed at least once");
  // With 10 members and 3 per run, 7 are necessarily skipped each run; the fair guarantee is that nobody waits longer than ceil(N/k) runs.
  ok(group, maxConsecutiveSkips <= Math.ceil(N / PER_RUN) - 1, `no member is skipped more than ${Math.ceil(N / PER_RUN) - 1} runs in a row (worst: ${maxConsecutiveSkips})`);
  ok(group, processedRuns[0].join() === plans.slice(0, 3).map((p) => p.uid).join() && processedRuns[3].includes(plans[9].uid), "run 1 starts at the top; the member at the end of the list is reached in run 4 (it used to starve)");
}

{
  const group = "P2.3 Failures and reporting";
  const bad = plan(1), good = plan(2);
  const badPlan = { ...bad, config: { ...cfg, email: "revoked@x.com" } };
  const f2: FetchLike = async (url, init) => ((init?.headers?.Authorization ?? "") === "Basic " + Buffer.from("revoked@x.com:tok").toString("base64") ? { ok: false, status: 401, json: async () => ({}) } : okFetch(url, init));
  const progress = new Map([[bad.uid, createInMemoryCronProgressStore()], [good.uid, createInMemoryCronProgressStore()]]);
  const hb = new Map([[bad.uid, createInMemoryHeartbeatStore()], [good.uid, createInMemoryHeartbeatStore()]]);
  const NOW = new Date("2026-10-27T12:00:00.000Z");
  const res = await runCronForMembers(f2, [{ ...badPlan, lastProcessedAt: "2026-10-27T09:00:00.000Z" }, { ...good, lastProcessedAt: "2026-10-27T11:00:00.000Z" }], {
    storesFor: () => ({ notifyStore: createInMemoryNotifyStore({ assignedIssueKeys: [], notifiedCommentIds: [], lastCheckedAtIso: "2026-10-27T00:00:00.000Z" }) }),
    now: () => NOW, budgetMs: 60_000, progressFor: (u) => progress.get(u), heartbeatFor: (u) => hb.get(u),
  });
  ok(group, res.failures.length === 1 && res.failures[0].uid === bad.uid && res.usersProcessed === 2, "a member whose Jira returns 401 is reported and does not block the next member");
  ok(group, (await progress.get(bad.uid)!.get()) === NOW.toISOString() && (await progress.get(good.uid)!.get()) === NOW.toISOString(), "a failed member still counts as processed (goes to the back of the queue)");
  ok(group, res.oldestWaitMinutes === 180 && (await hb.get(good.uid)!.get())?.oldestWaitMinutes === 180, "the response and the heartbeat carry oldestWaitMinutes");

  // planCronMembers uses the progress lookup
  const route = fs.readFileSync(path.join(process.cwd(), "src/app/api/command-center/jira/sync/route.ts"), "utf8");
  ok(group, /planCronMembers\(directory, process\.env, encryptionKey\(\), authSettings\(\)\.allowSharedJira, \(uid\) => createCronProgressStore\(uid\)\.get\(\)\)/.test(route) && /progressFor: \(uid\) => createCronProgressStore\(uid\)/.test(route), "the member cron plans by longest wait and records progress");

  // single-user mode untouched
  const sync = fs.readFileSync(path.join(process.cwd(), "src/app/api/command-center/jira/sync/route.ts"), "utf8");
  ok(group, /runCronTickWithHeartbeat\(fetch, config, accountId/.test(sync) && !/progressFor/.test(sync.slice(sync.indexOf("export async function GET"), sync.indexOf("async function memberCron"))), "single-user mode (sign-in off) does not touch the progress store");
}
