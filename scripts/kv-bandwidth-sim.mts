// V2.53 — offline before/after KV bandwidth simulation (in-memory KV + the metrics wrapper).
//   npx tsx scripts/kv-bandwidth-sim.mts          prints the table that docs/KV-BANDWIDTH.md quotes
// Scenario: 3 members, one steady-state cron tick each (after the snapshot hour, nothing new in Jira), 20 focus events
// over ~3 minutes, 10 state edits. AFTER = the real code. BEFORE = the pre-V2.53 access pattern replayed on the same
// KV (whole 60-day reports blob read+written, notify state always written, prefs read 3x, full app-state GET on every
// focus and before every push). Values are invented sizes (documented below), not production data.

import { createInMemoryKv } from "../src/lib/command-center/kv/kv.ts";
import { aggregateKvMetrics, withKvMetrics } from "../src/lib/command-center/kv/kv-metrics.ts";
import {
  APP_STATE_KEY, BRIEFING_KEY, CRON_HEARTBEAT_KEY, NOTIFY_DIGEST_KEY, NOTIFY_PREFS_KEY, NOTIFY_STATE_KEY, REMINDER_INDEX_KEY, SERVER_REPORTS_KEY,
  createKvAppStateStore, createKvBriefingStore, createKvDigestStore, createKvHeartbeatStore, createKvNotifyPrefsStore, createKvNotifyStore, createKvReminderIndexStore, createKvServerReportStore,
} from "../src/lib/command-center/kv/kv-stores.ts";
import { runCronTick } from "../src/lib/command-center/jira/cron-tick.ts";
import { shouldPullNow } from "../src/lib/command-center/app-state-pull-throttle.ts";
import { scopedKey } from "../src/lib/command-center/auth/auth-config.ts";
import { strictJiraFake } from "./tests/helpers.mts";

export interface SimRow { scenario: string; callsBefore: number; bytesBefore: number; callsAfter: number; bytesAfter: number }

const UIDS = ["u_" + "1".repeat(24), "u_" + "2".repeat(24), "u_" + "3".repeat(24)];
const DAYS = 60, TICKETS_PER_DAY = 40;
const ticket = (n: number) => ({ key: `P-${n}`, url: `https://x.atlassian.net/browse/P-${n}`, title: "t".repeat(120) });
const day = (d: string) => ({ date: d, generatedAt: `${d}T18:00:00.000Z`, newAssigned: [], newMentions: [], closedInJira: [], openAssigned: Array.from({ length: TICKETS_PER_DAY }, (_, i) => ticket(i)) });
const dayKeys = Array.from({ length: DAYS }, (_, i) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10)).filter((d) => d < "2026-10-07");
const legacyReports = () => ({ baseline: { assignedOpenKeys: ["P-1"], assignedAllKeys: ["P-1"], seenMentionCommentIds: Array.from({ length: 1000 }, (_, i) => `c${i}`), lastRunIso: "2026-10-07T17:00:00.000Z" }, reports: Object.fromEntries(dayKeys.map((d) => [d, day(d)])) });
const appState = (iso: string) => ({ jiraWorkRelevancePolicy: {}, attentionState: {}, decisions: [{ pad: "x".repeat(100_000) }], actionPlanState: { actions: [], personalPlan: [] }, memoryEvents: [], uiPreferences: {}, updatedAtIso: iso });
const notifyState = () => ({ assignedIssueKeys: ["P-1"], notifiedCommentIds: Array.from({ length: 1000 }, (_, i) => `comment-${i}`), lastCheckedAtIso: "2026-10-07T17:55:00.000Z" });
const briefing = () => ({ prefs: { enabled: true, time: "08:30" }, links: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`P-${i}`, { title: "t".repeat(60), url: `https://x/P-${i}` }])) });

async function seed(kv: ReturnType<typeof createInMemoryKv>) {
  for (const uid of UIDS) {
    await kv.set(scopedKey(SERVER_REPORTS_KEY, uid), legacyReports());
    await kv.set(scopedKey(APP_STATE_KEY, uid), appState("2026-10-07T17:00:00.000Z"));
    await kv.set(scopedKey(NOTIFY_STATE_KEY, uid), notifyState());
    await kv.set(scopedKey(BRIEFING_KEY, uid), briefing());
    await kv.set(scopedKey(REMINDER_INDEX_KEY, uid), { items: [], builtAt: "2026-10-07T17:00:00.000Z" });
    await kv.set(scopedKey(NOTIFY_PREFS_KEY, uid), { mode: "immediate", immediateKinds: ["ASSIGNMENT_P1P2", "MENTION_URGENT", "ESCALATION"], mutedProjects: [], maxPerRun: 0, escalateUnanswered: false });
    await kv.set(scopedKey(CRON_HEARTBEAT_KEY, uid), { lastRunAt: "2026-10-07T17:45:00.000Z", durationMs: 900, notified: 0, warnings: [] });
  }
}

function measure(lines: string[]): { calls: number; bytes: number } {
  const rows = aggregateKvMetrics(lines);
  return { calls: lines.filter((l) => l.includes("[kv-metrics]")).length, bytes: rows.reduce((s, r) => s + r.bytesRead + r.bytesWritten, 0) };
}

const NOW = new Date("2026-10-07T18:00:00.000Z"); // a Wednesday, after the snapshot hour
const config = { baseUrl: "https://example.atlassian.net", email: "a@b.com", apiToken: "t" } as never;
const jira = strictJiraFake(async (url) => {
  const u = new URL(url);
  if (u.pathname.endsWith("/search/jql")) return { ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) };
  return { ok: false, status: 404, json: async () => ({}) };
});

async function afterRun(): Promise<{ firstTick: { calls: number; bytes: number }; tick: { calls: number; bytes: number }; focus: { calls: number; bytes: number }; edits: { calls: number; bytes: number } }> {
  const raw = createInMemoryKv();
  await seed(raw);
  const lines: string[] = [];
  const kv = withKvMetrics(raw, { log: (l) => lines.push(l) });
  const tickAll = async (at: Date) => {
    for (const uid of UIDS) {
      await runCronTick(jira, config, "acc-me", {
        notifyStore: createKvNotifyStore(kv, uid),
        timeZone: "UTC",
        timezoneOffsetMinutes: 0,
        smartNotify: { prefsStore: createKvNotifyPrefsStore(kv, uid), digestStore: createKvDigestStore(kv, uid) },
        reminders: { store: createKvReminderIndexStore(kv, uid), now: at },
        briefing: { store: createKvBriefingStore(kv, uid), now: at },
        snapshot: { store: createKvServerReportStore(kv, uid), now: at, timezoneOffsetMinutes: 0, snapshotHourLocal: 0 },
      });
      await createKvHeartbeatStore(kv, uid).set({ lastRunAt: at.toISOString(), durationMs: 900, notified: 0, warnings: [] });
    }
  };
  await tickAll(NOW); // the first tick after deploy migrates the legacy reports blob
  const firstTick = measure(lines);
  lines.length = 0;
  await tickAll(new Date(NOW.getTime() + 15 * 60_000)); // steady state
  const tick = measure(lines);
  lines.length = 0;
  // 20 focus events, 10 s apart, device already current
  const store = createKvAppStateStore(kv, UIDS[0]);
  await store.set(appState("2026-10-07T17:00:00.000Z"));
  lines.length = 0;
  let last: number | null = null;
  for (let i = 0; i < 20; i++) {
    const t = i * 10_000;
    if (!shouldPullNow(last, t)) continue;
    last = t;
    await store.getIfChanged!("2026-10-07T17:00:00.000Z");
  }
  const focus = measure(lines);
  lines.length = 0;
  for (let i = 0; i < 10; i++) {
    await store.getIfChanged!(`2026-10-07T17:00:0${i}.000Z`.replace(/0(\d)\./, "0$1.")); // reconcile: conditional, current
    await store.set(appState(`2026-10-07T17:10:${String(i).padStart(2, "0")}.000Z`));
  }
  const edits = measure(lines);
  return { firstTick, tick, focus, edits };
}

async function beforeRun(): Promise<{ tick: { calls: number; bytes: number }; focus: { calls: number; bytes: number }; edits: { calls: number; bytes: number } }> {
  const raw = createInMemoryKv();
  await seed(raw);
  const lines: string[] = [];
  const kv = withKvMetrics(raw, { log: (l) => lines.push(l) });
  for (const uid of UIDS) {
    const k = (b: string) => scopedKey(b, uid);
    const notify = await kv.get(k(NOTIFY_STATE_KEY));
    await kv.get(k(NOTIFY_PREFS_KEY)); await kv.get(k(NOTIFY_DIGEST_KEY));
    await kv.get(k(REMINDER_INDEX_KEY));
    await kv.get(k(NOTIFY_PREFS_KEY)); // reminders step: quiet hours
    await kv.get(k(BRIEFING_KEY));
    await kv.get(k(NOTIFY_PREFS_KEY)); // briefing step: quiet hours
    await kv.set(k(NOTIFY_STATE_KEY), notify); // always rewritten
    const reports = await kv.get(k(SERVER_REPORTS_KEY)); // whole 60-day blob
    await kv.set(k(SERVER_REPORTS_KEY), reports);
    await kv.get(k(CRON_HEARTBEAT_KEY));
    await kv.set(k(CRON_HEARTBEAT_KEY), { lastRunAt: NOW.toISOString(), durationMs: 900, notified: 0, warnings: [] });
  }
  const tick = measure(lines);
  lines.length = 0;
  for (let i = 0; i < 20; i++) await kv.get(scopedKey(APP_STATE_KEY, UIDS[0])); // every focus: full GET
  const focus = measure(lines);
  lines.length = 0;
  for (let i = 0; i < 10; i++) {
    await kv.get(scopedKey(APP_STATE_KEY, UIDS[0])); // reconcile before the push
    await kv.set(scopedKey(APP_STATE_KEY, UIDS[0]), appState(`2026-10-07T17:10:${String(i).padStart(2, "0")}.000Z`));
  }
  const edits = measure(lines);
  return { tick, focus, edits };
}

export async function runSim(): Promise<{ rows: SimRow[]; firstTickAfter: { calls: number; bytes: number } }> {
  const before = await beforeRun();
  const after = await afterRun();
  const row = (scenario: string, b: { calls: number; bytes: number }, a: { calls: number; bytes: number }): SimRow => ({ scenario, callsBefore: b.calls, bytesBefore: b.bytes, callsAfter: a.calls, bytesAfter: a.bytes });
  return {
    rows: [
      row("cron tick, 3 members (steady state)", before.tick, after.tick),
      row("20 focus events (~3 min, device current)", before.focus, after.focus),
      row("10 state edits (reconcile + push)", before.edits, after.edits),
    ],
    firstTickAfter: after.firstTick,
  };
}

const isMain = process.argv[1]?.endsWith("kv-bandwidth-sim.mts");
if (isMain) {
  const { rows, firstTickAfter } = await runSim();
  const fmt = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);
  console.log("scenario".padEnd(44), "calls b→a".padStart(10), "bytes before".padStart(14), "bytes after".padStart(14), "delta".padStart(8));
  for (const r of rows) console.log(r.scenario.padEnd(44), `${r.callsBefore}→${r.callsAfter}`.padStart(10), fmt(r.bytesBefore).padStart(14), fmt(r.bytesAfter).padStart(14), `${Math.round((1 - r.bytesAfter / r.bytesBefore) * 100)}%`.padStart(8));
  console.log(`\nfirst tick after deploy (one-time legacy migration, 3 members): ${firstTickAfter.calls} calls, ${fmt(firstTickAfter.bytes)}`);
}
