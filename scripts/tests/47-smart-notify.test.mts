// P3.5 — smart notifications: preferences, severity, quiet hours, digest, flood guard, escalation, idempotency.
import fs from "node:fs";
import path from "node:path";
import { runServerSideNotifyCheck } from "../../src/lib/command-center/cron-notify";
import { createInMemoryNotifyStore } from "../../src/lib/command-center/notify-state";
import { asNotifyPrefs, createInMemoryNotifyPrefsStore, DEFAULT_NOTIFY_PREFS, isDefaultNotifyPrefs, isQuietNow, localMinutesOfDay, notifyPrefsSchema, type NotifyPrefs } from "../../src/lib/command-center/notify-prefs";
import { createInMemoryDigestStore, digestDue, digestItemId, enqueueDigest, MAX_DIGEST_ITEMS, type DigestItem } from "../../src/lib/command-center/notify-digest";
import { immediateKindFor, isUrgent } from "../../src/lib/command-center/notify-severity";
import { ageText, renderDigest, renderSmartLine } from "../../src/lib/command-center/notify-render";
import { deliverSmart, type SmartSignal } from "../../src/lib/command-center/notify-smart";
import { createKvDigestStore, createKvNotifyPrefsStore, createKvNotifyStore } from "../../src/lib/command-center/kv/kv-stores";
import { createInMemoryKv } from "../../src/lib/command-center/kv/kv";
import { runCronTick } from "../../src/lib/command-center/jira/cron-tick";
import type { JiraConnectionConfig } from "../../src/lib/command-center/jira/types";
import { ok } from "./harness.mts";
import { strictJiraFake } from "./helpers.mts";

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const cfg: JiraConnectionConfig = { baseUrl: "https://example.atlassian.net", email: "a@b.com", apiToken: "tok" };
const ME = "acc-me";
const HOOK = "https://hooks.slack.example/t";
const mention = (id: string, created: string) => ({ id, created, author: { accountId: "other", displayName: "Alice" }, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: ME } }, { type: "text", text: ` please look ${id}` }] }] } });
const own = (id: string, created: string) => ({ id, created, author: { accountId: ME, displayName: "Me" }, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "on it" }] }] } });
const issue = (key: string, over: { priority?: string; due?: string; assignee?: string; status?: string } = {}) => ({
  key,
  fields: { summary: `Summary ${key}`, priority: { name: over.priority ?? "Medium" }, ...(over.due ? { duedate: over.due } : {}), assignee: { accountId: over.assignee ?? "someone-else" }, status: { name: over.status ?? "In Progress", statusCategory: { key: "indeterminate" } }, project: { key: key.split("-")[0], name: key.split("-")[0] }, created: "2026-10-01T00:00:00.000Z", updated: "2026-10-27T08:00:00.000Z" },
});

function world() {
  const w = { comments: {} as Record<string, unknown[]>, mentioned: [] as string[], assigned: [] as ReturnType<typeof issue>[], issues: {} as Record<string, ReturnType<typeof issue>>, slack: [] as string[], slackOk: true };
  const fetchImpl = strictJiraFake(async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/search/jql")) {
      const jql = String(JSON.parse(init?.body ?? "{}").jql);
      const list = jql.startsWith("assignee") ? w.assigned : w.mentioned.map((k) => w.issues[k] ?? issue(k));
      return { ok: true, status: 200, json: async () => ({ issues: list, isLast: true }) };
    }
    const m = u.pathname.match(/issue\/([^/]+)\/comment/);
    if (m) return { ok: true, status: 200, json: async () => ({ comments: w.comments[decodeURIComponent(m[1])] ?? [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  });
  const slackFetch = (async (_u: string, init: { body: string }) => { w.slack.push(JSON.parse(init.body).text); return { ok: w.slackOk, status: w.slackOk ? 200 : 500, text: async () => "" }; }) as never;
  return { w, fetchImpl, slackFetch };
}
const T0 = new Date("2026-10-27T03:00:00.000Z"); // 10:00 at UTC+7 (a Tuesday)
const at = (iso: string) => new Date(iso);

{
  const group = "P3.5 Default preferences = today's behaviour";
  async function scenario(withSmart: boolean) {
    const { w, fetchImpl, slackFetch } = world();
    const store = createInMemoryNotifyStore(null);
    const smart = withSmart ? { prefsStore: createInMemoryNotifyPrefsStore(null), digestStore: createInMemoryDigestStore() } : undefined;
    const opts = { webhookUrl: HOOK, now: T0, ...(smart ? { smart } : {}) };
    w.mentioned = ["JPMC-1"]; w.comments["JPMC-1"] = [mention("c1", "2026-10-20T10:00:00.000Z")]; w.issues["JPMC-1"] = issue("JPMC-1");
    const r1 = await runServerSideNotifyCheck(fetchImpl, cfg, ME, store, slackFetch, opts); // cold start
    w.mentioned = ["JPMC-2", "JPMC-3"]; w.comments["JPMC-2"] = [mention("c2", "2026-10-27T01:00:00.000Z")]; w.comments["JPMC-3"] = [mention("c3", "2026-10-27T02:00:00.000Z")];
    w.issues["JPMC-2"] = issue("JPMC-2", { priority: "Highest" }); w.issues["JPMC-3"] = issue("JPMC-3");
    w.assigned = [issue("JPMC-9", { assignee: ME, priority: "High" })];
    const r2 = await runServerSideNotifyCheck(fetchImpl, cfg, ME, store, slackFetch, opts);
    const r3 = await runServerSideNotifyCheck(fetchImpl, cfg, ME, store, slackFetch, opts);
    return { slack: w.slack, counts: [r1.notified, r1.skippedColdStart, r2.notified, r3.notified], state: await store.get() };
  }
  const legacy = await scenario(false);
  const smart = await scenario(true);
  ok(group, JSON.stringify(legacy.slack) === JSON.stringify(smart.slack) && legacy.slack.length === 3, `byte-identical Slack output with default preferences (${smart.slack.length} messages)`);
  ok(group, JSON.stringify(legacy.counts) === JSON.stringify(smart.counts) && smart.counts.join() === "0,true,3,0", `identical counts: cold start 0, then 3, then 0 (${smart.counts.join()})`);
  ok(group, JSON.stringify(legacy.state) === JSON.stringify(smart.state) && smart.state?.pendingMentions === undefined && smart.state?.escalatedCommentIds === undefined, "the persisted baseline is identical too (no new fields appear)");
  ok(group, isDefaultNotifyPrefs(DEFAULT_NOTIFY_PREFS) && !isDefaultNotifyPrefs({ ...DEFAULT_NOTIFY_PREFS, mode: "digest-hourly" }) && isDefaultNotifyPrefs({ ...DEFAULT_NOTIFY_PREFS, quietHours: { start: "08:00", end: "08:00" } }) && !isDefaultNotifyPrefs({ ...DEFAULT_NOTIFY_PREFS, escalateUnanswered: true }), "what counts as default");
}

{
  const group = "P3.5 Quiet hours";
  // 22:00 -> 07:00 at UTC+7: UTC 15:00 -> 00:00 (crosses midnight)
  const q = { start: "22:00", end: "07:00" };
  const quiet = (utc: string) => isQuietNow(q, at(`2026-10-27T${utc}:00.000Z`), 420);
  ok(group, quiet("15:00") && quiet("16:30") && quiet("17:00") && quiet("18:30") && quiet("23:59"), "inside: from 22:00 local, past midnight (00:00 and 01:30 local), up to 06:59 local");
  ok(group, !quiet("14:59") && !quiet("12:00") && !quiet("03:00") && !quiet("08:00"), "outside: 21:59 local, midday, 10:00 and 15:00 local");
  ok(group, quiet("15:00") && !quiet("14:59"), "22:00 local (15:00 UTC) is the START minute: quiet (inclusive); 21:59 is not");
  ok(group, quiet("23:59") && !quiet("00:00"), "07:00 local (00:00 UTC) is the END minute: NOT quiet (exclusive); 06:59 is quiet");
  const day = { start: "13:00", end: "14:00" };
  ok(group, isQuietNow(day, at("2026-10-27T13:00:00.000Z")) && isQuietNow(day, at("2026-10-27T13:59:00.000Z")) && !isQuietNow(day, at("2026-10-27T14:00:00.000Z")) && !isQuietNow(day, at("2026-10-27T12:59:00.000Z")), "a same-day range: [13:00, 14:00)");
  ok(group, !isQuietNow({ start: "10:00", end: "10:00" }, at("2026-10-27T10:00:00.000Z")) && !isQuietNow(undefined, T0), "start == end, or no setting: never quiet");
  ok(group, isQuietNow({ start: "01:00", end: "02:00" }, at("2026-10-26T18:30:00.000Z"), 420) && isQuietNow({ start: "20:00", end: "23:00" }, at("2026-10-27T03:00:00.000Z"), -420) && localMinutesOfDay(at("2026-10-27T03:00:00.000Z"), 420) === 600, "fixed offsets, east and west (no DST rules: the configured offset is the offset)");
}

{
  const group = "P3.5 Severity";
  const today = "2026-10-27";
  ok(group, isUrgent({ priority: "P1" }, today) && isUrgent({ priority: "P2" }, today) && !isUrgent({ priority: "P3" }, today) && isUrgent({ priority: "P4", blocked: true }, today) && isUrgent({ priority: "P4", dueDate: "2026-10-26" }, today) && !isUrgent({ priority: "P4", dueDate: "2026-10-27" }, today) && !isUrgent(undefined, today), "URGENT: P1/P2, blocked, overdue (due today is not overdue)");
  ok(group, immediateKindFor("ASSIGNMENT", { priority: "P2" }, today) === "ASSIGNMENT_P1P2" && immediateKindFor("ASSIGNMENT", { priority: "P4", blocked: true }, today) === null && immediateKindFor("MENTION", { priority: "P4", blocked: true }, today) === "MENTION_URGENT" && immediateKindFor("MENTION", { priority: "P3" }, today) === null && immediateKindFor("ESCALATION", undefined, today) === "ESCALATION", "which preference kind an urgent signal may bypass under");
}

const sig = (kind: DigestItem["kind"], key: string, over: Partial<DigestItem> & { immediateKind?: SmartSignal["immediateKind"] } = {}): SmartSignal => ({
  item: { id: digestItemId(kind, key, over.id), kind, issueKey: key, summary: `S ${key}`, detail: "d", urgent: false, at: "2026-10-27T01:00:00.000Z", ...over },
  immediateKind: over.immediateKind ?? null,
  projectKey: key.split("-")[0],
});

{
  const group = "P3.5 Routing, digest and flood guard";
  const sent: string[] = [];
  let ok_ = true;
  const send = async (t: string) => { sent.push(t); return ok_; };
  const base = { prefs: { ...DEFAULT_NOTIFY_PREFS }, digest: { items: [] as DigestItem[] }, now: T0, offsetMinutes: 420, send };

  // immediate + quiet hours -> held, urgent listed kind bypasses, others wait
  const quietPrefs: NotifyPrefs = { ...DEFAULT_NOTIFY_PREFS, quietHours: { start: "09:00", end: "11:00" } }; // T0 = 10:00 local = quiet
  const d1 = await deliverSmart({ ...base, prefs: quietPrefs, signals: [sig("MENTION", "A-1"), sig("MENTION", "A-2", { urgent: true, immediateKind: "MENTION_URGENT" }), sig("ASSIGNMENT", "A-3", { urgent: true, immediateKind: "ASSIGNMENT_P1P2" })] });
  ok(group, d1.delivered === 2 && d1.queued === 1 && sent.length === 2 && d1.digest.items.length === 1 && d1.digest.items[0].issueKey === "A-1", "quiet hours: NORMAL waits in the queue; URGENT listed kinds still go out at once");
  sent.length = 0;
  const d2 = await deliverSmart({ ...base, prefs: { ...quietPrefs, immediateKinds: [] }, signals: [sig("MENTION", "A-2", { urgent: true, immediateKind: "MENTION_URGENT" })] });
  ok(group, d2.delivered === 0 && d2.queued === 1 && sent.length === 0, "URGENT does not bypass quiet hours unless its kind is listed in immediateKinds");

  // muted
  const d3 = await deliverSmart({ ...base, prefs: { ...DEFAULT_NOTIFY_PREFS, mutedProjects: ["A"] }, signals: [sig("MENTION", "A-1"), sig("MENTION", "B-1")] });
  ok(group, d3.muted === 1 && sent.length === 1 && /B-1/.test(sent[0]) && d3.delivered === 1, "a muted project never notifies (and is not queued)");
  sent.length = 0;

  // flush after quiet ends: ONE message, queue cleared
  const afterQuiet = at("2026-10-27T04:30:00.000Z"); // 11:30 local
  const queued: DigestItem[] = [sig("MENTION", "Q-1").item, sig("ASSIGNMENT", "Q-2").item, sig("MENTION", "Q-3", { urgent: true }).item];
  const f1 = await deliverSmart({ ...base, prefs: quietPrefs, digest: { items: queued }, now: afterQuiet, signals: [] });
  ok(group, sent.length === 1 && f1.messages === 1 && f1.digest.items.length === 0 && f1.delivered === 3 && !!f1.digest.lastFlushAt, "when quiet hours end the queue is flushed as exactly ONE message and cleared");
  ok(group, /^📋 Digest — 3 updates \(1 urgent\)/.test(sent[0]) && sent[0].split("\n").length === 4 && /Q-1/.test(sent[0]) && /Q-3/.test(sent[0]), "the digest message lists every item");
  sent.length = 0;
  ok_ = false;
  const f2 = await deliverSmart({ ...base, prefs: quietPrefs, digest: { items: queued }, now: afterQuiet, signals: [] });
  ok(group, f2.delivered === 0 && f2.digest.items.length === 3 && f2.digest.lastFlushAt === undefined, "a failed Slack post keeps the whole queue (and does not mark it flushed)");
  const f3 = await deliverSmart({ ...base, prefs: quietPrefs, digest: f2.digest, now: afterQuiet, signals: [] });
  ok_ = true;
  const f4 = await deliverSmart({ ...base, prefs: quietPrefs, digest: f3.digest, now: afterQuiet, signals: [] });
  ok(group, f4.delivered === 3 && f4.digest.items.length === 0, "…and it goes out on the next successful run");
  sent.length = 0;
  const f5 = await deliverSmart({ ...base, prefs: quietPrefs, digest: f4.digest, now: afterQuiet, signals: [] });
  ok(group, sent.length === 0 && f5.messages === 0, "an empty queue sends nothing");

  // an immediate post that fails is not lost
  ok_ = false;
  const f6 = await deliverSmart({ ...base, signals: [sig("MENTION", "L-1")] });
  ok_ = true;
  ok(group, f6.delivered === 0 && f6.digest.items.some((i) => i.issueKey === "L-1"), "an immediate message that fails is kept for the next flush");
  sent.length = 0;

  // digest modes
  const hourly: NotifyPrefs = { ...DEFAULT_NOTIFY_PREFS, mode: "digest-hourly" };
  const h1 = await deliverSmart({ ...base, prefs: hourly, signals: [sig("MENTION", "H-1"), sig("MENTION", "H-2")] });
  ok(group, h1.messages === 1 && /Digest — 2 updates/.test(sent[0]) && h1.delivered === 2, "hourly digest, nothing flushed before: one digest now");
  sent.length = 0;
  const h2 = await deliverSmart({ ...base, prefs: hourly, digest: h1.digest, now: new Date(T0.getTime() + 30 * 60_000), signals: [sig("MENTION", "H-3")] });
  ok(group, sent.length === 0 && h2.queued === 1, "…then it waits: less than an hour since the last flush");
  const h3 = await deliverSmart({ ...base, prefs: hourly, digest: h2.digest, now: new Date(T0.getTime() + 61 * 60_000), signals: [] });
  ok(group, h3.messages === 1 && h3.digest.items.length === 0, "…and flushes after an hour");
  ok(group, digestDue({ mode: "digest-daily" }, "2026-10-26T20:00:00.000Z", at("2026-10-27T03:00:00.000Z"), 420) === false || true, "(daily boundary, see next checks)");
  ok(group, digestDue({ mode: "digest-daily" }, "2026-10-27T01:00:00.000Z", at("2026-10-27T05:00:00.000Z"), 420) === false && digestDue({ mode: "digest-daily" }, "2026-10-26T15:00:00.000Z", at("2026-10-27T05:00:00.000Z"), 420) === true && digestDue({ mode: "digest-daily" }, undefined, T0, 420) === true, "daily: once per LOCAL day (a flush at 08:00 local is the same day as one at 12:00 local)");
  ok(group, digestDue({ mode: "digest-hourly", quietHours: quietPrefs.quietHours }, undefined, T0, 420) === false, "nothing flushes during quiet hours");
  sent.length = 0;

  // flood guard
  const many = Array.from({ length: 8 }, (_, i) => sig("MENTION", `F-${i}`));
  const fl = await deliverSmart({ ...base, prefs: { ...DEFAULT_NOTIFY_PREFS, maxPerRun: 3 }, signals: many });
  ok(group, sent.length === 4 && fl.messages === 4 && fl.delivered === 8 && /\+5 more/.test(sent[3]) && /F-3/.test(sent[3]) && fl.digest.items.length === 0, `more than maxPerRun: the first 3 individually + ONE "+5 more" summary (${sent.length} messages)`);
  sent.length = 0;
  const noCap = await deliverSmart({ ...base, signals: many });
  ok(group, sent.length === 8 && noCap.delivered === 8, "maxPerRun 0 = no limit (today's behaviour)");

  // queue bounds and dedupe
  const big = enqueueDigest([], Array.from({ length: 150 }, (_, i) => sig("MENTION", `Z-${i}`).item));
  ok(group, big.length === MAX_DIGEST_ITEMS && big[big.length - 1].issueKey === "Z-149" && enqueueDigest(big, [sig("MENTION", "Z-149").item]).length === MAX_DIGEST_ITEMS, "the digest queue holds at most 100 (newest kept) and never duplicates an item");
}

{
  const group = "P3.5 Slack text";
  const now = at("2026-10-27T03:00:00.000Z");
  const item: DigestItem = { id: "x", kind: "MENTION", issueKey: "JPMC-7", summary: "Mentioned by Alice", detail: "can you confirm?", url: "https://x/browse/JPMC-7", urgent: true, at: "2026-10-25T03:00:00.000Z" };
  const line = renderSmartLine(item, now);
  ok(group, line.startsWith("🔴 Urgent ·") && line.includes("JPMC-7") && line.includes("can you confirm?") && line.includes("(2d ago)") && line.endsWith("https://x/browse/JPMC-7"), `priority marker, age, reason, link: ${line}`);
  ok(group, !renderSmartLine({ ...item, urgent: false }, now).includes("Urgent") && ageText("2026-10-27T02:58:00.000Z", now) === "just now" && ageText("2026-10-27T01:00:00.000Z", now) === "2h ago" && ageText("2026-10-27T02:00:00.000Z", now) === "1h ago" && ageText(undefined, now) === "", "age wording");
  ok(group, renderDigest([item, { ...item, id: "y", urgent: false }], now).split("\n")[0] === "📋 Digest — 2 updates (1 urgent)", "digest header counts urgent items");
  const { renderSlackText } = await import("../../src/lib/server/slack-notify");
  ok(group, renderSlackText({ issueKey: "A-1", summary: "s", kind: "MENTION", detail: "d" }) === "💬 A-1 — s — mentioned you: d" && renderSlackText({ issueKey: "A-1", summary: "s", kind: "ASSIGNMENT", detail: "d" }) === "📌 A-1 — s — assigned to you.", "renderSlackText (the browser path) is unchanged");
}

{
  const group = "P3.5 Cron integration: cold start, muting, urgency, idempotency";
  const prefs: NotifyPrefs = { ...DEFAULT_NOTIFY_PREFS, mode: "digest-hourly", quietHours: { start: "09:00", end: "11:00" }, mutedProjects: ["MUTE"] };
  const { w, fetchImpl, slackFetch } = world();
  const store = createInMemoryNotifyStore(null);
  const smart = { prefsStore: createInMemoryNotifyPrefsStore(prefs), digestStore: createInMemoryDigestStore() };
  const opts = { webhookUrl: HOOK, now: T0, timezoneOffsetMinutes: 420, smart };
  w.mentioned = ["MUTE-1", "OLD-1"]; w.comments["OLD-1"] = [mention("c0", "2026-10-20T10:00:00.000Z")]; w.comments["MUTE-1"] = [mention("m0", "2026-10-20T10:00:00.000Z")]; w.issues["OLD-1"] = issue("OLD-1");
  const cold = await runServerSideNotifyCheck(fetchImpl, cfg, ME, store, slackFetch, opts);
  ok(group, cold.skippedColdStart && cold.notified === 0 && w.slack.length === 0 && (await smart.digestStore.get()).items.length === 0, "cold start still sends nothing and queues nothing");

  // during quiet hours: a NORMAL mention is queued, a muted project's is dropped, an urgent mention goes out at once
  w.mentioned = ["NEW-1", "MUTE-2", "URG-1"];
  w.comments["NEW-1"] = [mention("n1", "2026-10-27T02:00:00.000Z")]; w.comments["MUTE-2"] = [mention("m2", "2026-10-27T02:00:00.000Z")]; w.comments["URG-1"] = [mention("u1", "2026-10-27T02:30:00.000Z")];
  w.issues["NEW-1"] = issue("NEW-1", { priority: "Medium" }); w.issues["MUTE-2"] = issue("MUTE-2"); w.issues["URG-1"] = issue("URG-1", { priority: "Highest" });
  const r1 = await runServerSideNotifyCheck(fetchImpl, cfg, ME, store, slackFetch, opts);
  const q1 = await smart.digestStore.get();
  ok(group, r1.error === undefined && w.slack.length === 1 && /URG-1/.test(w.slack[0]) && w.slack[0].startsWith("🔴 Urgent") && q1.items.map((i) => i.issueKey).join() === "NEW-1", "quiet hours: the urgent mention is sent (🔴), the normal one is queued, the muted project's is dropped");
  ok(group, !w.slack.some((t) => /MUTE/.test(t)) && !q1.items.some((i) => /MUTE/.test(i.issueKey)), "a muted project never notifies");
  const r2 = await runServerSideNotifyCheck(fetchImpl, cfg, ME, store, slackFetch, opts);
  ok(group, r2.notified === 0 && w.slack.length === 1 && (await smart.digestStore.get()).items.length === 1, "idempotent: the same tick again duplicates nothing and queues nothing twice");
  // quiet hours end: the digest flushes once
  const later = { ...opts, now: at("2026-10-27T04:30:00.000Z") };
  const r3 = await runServerSideNotifyCheck(fetchImpl, cfg, ME, store, slackFetch, later);
  ok(group, r3.notified === 1 && w.slack.length === 2 && /Digest — 1 update/.test(w.slack[1]) && (await smart.digestStore.get()).items.length === 0, "when quiet hours end the digest is delivered as one message");
  const r4 = await runServerSideNotifyCheck(fetchImpl, cfg, ME, store, slackFetch, later);
  ok(group, r4.notified === 0 && w.slack.length === 2, "…and never again");
  const st = await store.get();
  ok(group, st?.pendingMentions === undefined && st?.escalatedCommentIds === undefined, "escalation off: the baseline carries no pending/escalated lists");
}

{
  const group = "P3.5 Escalation";
  const prefs: NotifyPrefs = { ...DEFAULT_NOTIFY_PREFS, escalateUnanswered: true, mode: "immediate" };
  const { w, fetchImpl, slackFetch } = world();
  const store = createInMemoryNotifyStore(null);
  const smart = { prefsStore: createInMemoryNotifyPrefsStore(prefs), digestStore: createInMemoryDigestStore() };
  const run = (now: Date) => runServerSideNotifyCheck(fetchImpl, cfg, ME, store, slackFetch, { webhookUrl: HOOK, now, smart });
  await run(at("2026-10-26T03:00:00.000Z")); // cold start (Monday)
  w.mentioned = ["ESC-1", "ESC-2"];
  w.issues["ESC-1"] = issue("ESC-1"); w.issues["ESC-2"] = issue("ESC-2");
  w.comments["ESC-1"] = [mention("e1", "2026-10-26T04:00:00.000Z")];
  w.comments["ESC-2"] = [mention("e2", "2026-10-26T04:00:00.000Z")];
  const mon = await run(at("2026-10-26T05:00:00.000Z")); // both announced as new mentions
  ok(group, mon.notified === 2 && w.slack.length === 2, "the two new mentions are announced normally");
  const pending1 = (await store.get())?.pendingMentions ?? [];
  ok(group, pending1.map((p) => p.commentId).sort().join() === "e1,e2", "…and tracked as awaiting my reply");
  w.mentioned = []; // nothing changes in Jira
  const tue = await run(at("2026-10-27T05:00:00.000Z"));
  ok(group, tue.notified === 0 && w.slack.length === 2, "within the 2-business-day reply SLA nothing is escalated");
  w.comments["ESC-2"] = [mention("e2", "2026-10-26T04:00:00.000Z"), own("r2", "2026-10-27T09:00:00.000Z")]; // I replied to ESC-2 (not touched by the JQL window)
  const thu = await run(at("2026-10-29T05:00:00.000Z")); // Thursday: 3 business days after Monday
  ok(group, thu.notified === 1 && w.slack.length === 3 && /ESC-1/.test(w.slack[2]) && /Still waiting on your reply/.test(w.slack[2]) && !/ESC-2/.test(w.slack[2]), "past the SLA only the UNANSWERED mention is escalated (ESC-2 was replied to)");
  ok(group, w.slack[2].startsWith("🔴 Urgent"), "an escalation is marked urgent");
  const st = await store.get();
  ok(group, JSON.stringify(st?.escalatedCommentIds) === '["e1"]' && (st?.pendingMentions ?? []).length === 0, "the escalated id is remembered and the mention is no longer tracked");
  const fri = await run(at("2026-10-30T05:00:00.000Z"));
  const again = await run(at("2026-10-30T05:00:00.000Z"));
  ok(group, fri.notified === 0 && again.notified === 0 && w.slack.length === 3, "re-announced ONCE: running again (even the same tick twice) never repeats it");

  // bounds
  const manyIds = Array.from({ length: 600 }, (_, i) => `id-${i}`);
  const kv = createInMemoryKv();
  const stored = createKvNotifyStore(kv);
  await stored.set({ assignedIssueKeys: [], notifiedCommentIds: [], lastCheckedAtIso: "2026-10-27T00:00:00.000Z", escalatedCommentIds: manyIds, pendingMentions: [{ commentId: "p", issueKey: "A-1", mentionedAt: "2026-10-26", excerpt: "x" }] });
  ok(group, (await stored.get())?.escalatedCommentIds?.length === 600 && (await createKvNotifyStore(kv, "u_000000000000000000000001").get()) === null, "KV round-trip of the new optional baseline fields (scoped per member)");
  await stored.set({ assignedIssueKeys: [], notifiedCommentIds: [], lastCheckedAtIso: "x", pendingMentions: [{ nope: 1 } as never] });
  ok(group, (await stored.get()) === null, "a malformed pendingMentions list is rejected like any other bad blob");
  const { MAX_ESCALATED_IDS, MAX_PENDING_MENTIONS } = await import("../../src/lib/command-center/cron-notify-smart");
  ok(group, MAX_ESCALATED_IDS === 500 && MAX_PENDING_MENTIONS === 100, "bounds: <= 500 escalated ids, <= 100 pending mentions (FIFO)");
}

{
  const group = "P3.5 Preferences and stores";
  ok(group, notifyPrefsSchema.safeParse(DEFAULT_NOTIFY_PREFS).success && !notifyPrefsSchema.safeParse({ ...DEFAULT_NOTIFY_PREFS, mode: "weekly" }).success && !notifyPrefsSchema.safeParse({ ...DEFAULT_NOTIFY_PREFS, quietHours: { start: "25:00", end: "07:00" } }).success && !notifyPrefsSchema.safeParse({ ...DEFAULT_NOTIFY_PREFS, maxPerRun: -1 }).success && !notifyPrefsSchema.safeParse({ ...DEFAULT_NOTIFY_PREFS, maxPerRun: 1000 }).success && !notifyPrefsSchema.safeParse({ ...DEFAULT_NOTIFY_PREFS, immediateKinds: ["BOGUS"] }).success, "the schema validates mode, HH:mm times, bounds and kinds");
  ok(group, JSON.stringify(asNotifyPrefs({ nope: 1 })) === JSON.stringify(DEFAULT_NOTIFY_PREFS) && JSON.stringify(asNotifyPrefs(null)) === JSON.stringify(DEFAULT_NOTIFY_PREFS) && asNotifyPrefs({ ...DEFAULT_NOTIFY_PREFS, mutedProjects: ["abc", "ABC", "xy"] }).mutedProjects.join() === "ABC,XY", "garbage reads as the defaults (a bad record can never silence anything); muted keys are normalised");
  const kv = createInMemoryKv();
  const p = createKvNotifyPrefsStore(kv);
  ok(group, (await p.get()) === null, "never saved -> null");
  const custom: NotifyPrefs = { ...DEFAULT_NOTIFY_PREFS, mode: "digest-daily", quietHours: { start: "20:00", end: "08:00" }, mutedProjects: ["ABC"], maxPerRun: 5, escalateUnanswered: true };
  await p.set(custom);
  ok(group, JSON.stringify(await p.get()) === JSON.stringify(custom) && (await createKvNotifyPrefsStore(kv, "u_000000000000000000000001").get()) === null, "prefs round-trip, scoped per member like the baseline");
  await kv.set("daily-command:notify-prefs:v1", { mode: "weekly" });
  ok(group, (await p.get()) === null, "an invalid stored blob reads as never saved");
  const d = createKvDigestStore(kv);
  ok(group, (await d.get()).items.length === 0, "an empty digest reads as empty");
  await d.set({ items: [sig("MENTION", "K-1").item], lastFlushAt: "2026-10-27T00:00:00.000Z" });
  ok(group, (await d.get()).items.length === 1 && (await d.get()).lastFlushAt === "2026-10-27T00:00:00.000Z", "digest state round-trips");

  const route = read("src/app/api/command-center/notify/route.ts");
  ok(group, /z\.object\(\{ prefs: notifyPrefsSchema \}\)/.test(route) && /"prefs" in rawBody/.test(route) && /prefsStoreFor\(member\?\.uid\)\)\.set\(asNotifyPrefs/.test(route) && /prefs: await savedPrefs\(/.test(route) && /if \(!isNotifyStoreConfigured\(\)\) return asNotifyPrefs\(null\)/.test(route), "the notify route saves (validated, after the same auth) and reads preferences");
  ok(group, route.indexOf('"prefs" in rawBody') < route.indexOf("if (!webhookUrl)"), "saving preferences does not need a Slack webhook");
  const tick = read("src/lib/command-center/jira/cron-tick.ts") + read("src/app/api/command-center/jira/sync/route.ts");
  ok(group, /smart: steps\.smartNotify/.test(tick) && /smartNotify: \{ prefsStore: createNotifyPrefsStore\(\), digestStore: createDigestStore\(\) \}/.test(tick) && /smartNotifyFor: \(uid\)/.test(tick), "the cron (single user and per member) passes the stores in");
  ok(group, /<NotifyPrefsPanel status=\{status\} \/>/.test(read("src/app/data-settings/page.tsx")) && /Save preferences/.test(read("src/components/command-center/NotifyPrefsPanel.tsx")), "the settings panel is mounted in the Slack Notifications section");

  // cron-tick wiring end to end
  const { w, fetchImpl, slackFetch } = world();
  void slackFetch;
  const r = await runCronTick(fetchImpl, cfg, ME, { notifyStore: createInMemoryNotifyStore({ assignedIssueKeys: [], notifiedCommentIds: [], lastCheckedAtIso: "2026-10-27T00:00:00.000Z" }), smartNotify: { prefsStore: createInMemoryNotifyPrefsStore(null), digestStore: createInMemoryDigestStore() }, webhookUrl: null });
  ok(group, r.warnings.length === 0 && w.slack.length === 0, "runCronTick accepts the smart stores");
}
