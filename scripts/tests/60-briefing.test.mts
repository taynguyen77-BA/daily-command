// W1 — Morning Briefing: content, schedule, idempotence, delivery guarantees, snapshot and sanitising (offline, injected I/O).
import fs from "node:fs";
import { ok } from "./harness.mts";
import { BRIEFING_MAX_ATTEMPTS, asBriefingPrefs, asBriefingRecord, briefingDueNow, buildBriefing, createInMemoryBriefingStore, runBriefingTick, validateBriefingTime, type BriefingRecord, type BriefingSnapshot } from "../../src/lib/command-center/briefing";
import { briefingLinks, buildBriefingSnapshot, dueSoonFrom } from "../../src/lib/command-center/briefing-snapshot";
import { buildReminderIndex } from "../../src/lib/command-center/reminder-index";
import type { TicketWorkState } from "../../src/lib/command-center/types";

const THU = "2026-11-05"; // Thursday
const NOW = new Date("2026-11-05T01:30:00.000Z");
const prefs = asBriefingPrefs({ enabled: true });
const snap = (over: Partial<BriefingSnapshot> = {}): BriefingSnapshot => ({ builtAt: "2026-11-05T00:30:00.000Z", nba: [{ key: "A-1", headline: "Reply to Linh about the wording" }, { key: "A-2", headline: "Unblock A-2" }], slipHigh: [{ key: "S-1", reason: "older than every comparable ticket" }], awaiting: [{ key: "M-1", ageBusinessDays: 3 }, { key: "M-2", ageBusinessDays: 1 }], ...over });
const rec = (over: Partial<BriefingRecord> = {}): BriefingRecord => ({ prefs, snapshot: snap(), links: { "A-1": { title: "Reminder email", url: "https://jira.example.com/browse/A-1" } }, ...over });
const parked = (n: number) => buildReminderIndex(Object.fromEntries(Array.from({ length: n }, (_, i) => [`P-${i + 1}`, { ticketKey: `P-${i + 1}`, status: "SKIPPED", until: THU, updatedAt: "2026-11-01T00:00:00.000Z", history: [], reason: "waiting", reminder: { level: 0, setAt: "2026-11-01T00:00:00.000Z" } } as TicketWorkState])), [], NOW.toISOString());
const slack = () => { const msgs: string[] = []; let up = true; return { msgs, set: (v: boolean) => { up = v; }, send: async (t: string) => { if (!up) return false; msgs.push(t); return true; } }; };
const local = (date: string, minutes: number) => ({ date, minutes });

{
  const group = "W1 content";
  const b = buildBriefing({ today: THU, record: rec(), index: parked(2), dueSoon: [{ key: "D-1", title: "Invoice export", dueDate: "2026-11-04" }, { key: "D-2", dueDate: "2026-11-06" }], now: NOW });
  const t = b.text;
  ok(group, /Reminders due/.test(t) && /Do next/.test(t) && /Due within 2 days or overdue/.test(t) && /Waiting for your reply/.test(t) && /New high slip risk/.test(t), "all sections appear: reminders, next actions, due soon, mentions past SLA, new slip risks");
  ok(group, /<https:\/\/jira\.example\.com\/browse\/A-1\|A-1>/.test(t) && /D-1 — Invoice export · due 2026-11-04 \(overdue\)/.test(t), "lines link the ticket; overdue is marked");
  ok(group, /M-1/.test(t) && !/M-2/.test(t), "only mentions past the 2-business-day SLA are listed");
  ok(group, /Heads-up: 2 reminders due, 2 tickets due within 2 days\./.test(t), "a deterministic heads-up sentence closes it");
  const withNew = buildBriefing({ today: THU, record: rec({ prevSlipKeys: ["S-1"] }), index: null, dueSoon: [], now: NOW });
  ok(group, !/New high slip risk/.test(withNew.text), "a slip risk already in yesterday's briefing is not 'new'");
  const big = buildBriefing({ today: THU, record: rec(), index: parked(40), dueSoon: [], now: NOW });
  ok(group, big.lines.length <= 16 && /\+\d+ more in the app/.test(big.text) && big.moreInApp > 20, `more than 15 lines are truncated with '+N more in the app' (${big.lines.length} lines)`);
  const empty = buildBriefing({ today: THU, record: rec({ snapshot: undefined }), index: null, dueSoon: [], now: NOW });
  ok(group, empty.empty && /Nothing needs you today/.test(empty.text), "an empty day -> a short 'nothing needs you today' line");
  const jiraDown = buildBriefing({ today: THU, record: rec(), index: parked(1), dueSoon: null, now: NOW });
  ok(group, /Reminders due/.test(jiraDown.text) && /Do next/.test(jiraDown.text) && !/Due within 2 days/.test(jiraDown.text) && !/Waiting for your reply/.test(jiraDown.text) && /Jira could not be reached/.test(jiraDown.text), "Jira down -> the live sections are omitted with a note; the rest is still sent");
  const stale = buildBriefing({ today: THU, record: rec({ snapshot: snap({ builtAt: "2026-11-03T08:00:00.000Z" }) }), index: null, dueSoon: [], now: NOW });
  ok(group, /based on your last session \(2026-11-03 08:00 UTC\)/.test(stale.text), "a snapshot older than 12 h is labelled 'based on your last session'");
  const narrated = buildBriefing({ today: THU, record: rec(), index: null, dueSoon: [], now: NOW, narration: "Start with A-1." });
  ok(group, /Start with A-1\./.test(narrated.text), "an AI narration sentence replaces the deterministic one");
}

{
  const group = "W1 schedule";
  ok(group, briefingDueNow(asBriefingPrefs({}), local(THU, 600)).why === "disabled", "off by default (a new switch defaults to the previous behaviour)");
  ok(group, briefingDueNow(prefs, local(THU, 8 * 60 + 29)).why === "too-early" && briefingDueNow(prefs, local(THU, 8 * 60 + 30)).due, "due from 08:30 local");
  ok(group, briefingDueNow(prefs, local("2026-11-07", 600)).why === "weekend" && briefingDueNow({ ...prefs, skipWeekends: false }, local("2026-11-07", 600)).due, "weekends are skipped (setting)");
  ok(group, briefingDueNow({ ...prefs, skipDates: [THU] }, local(THU, 600)).why === "skip-date", "a listed holiday is skipped");
  ok(group, briefingDueNow(prefs, local(THU, 600), THU).why === "already-sent", "one briefing per local day");
  ok(group, !validateBriefingTime("25:00").ok && validateBriefingTime("08:30").ok && asBriefingPrefs({ time: "7:5" }).time === "08:30", "an invalid time is rejected / falls back to 08:30");
  ok(group, asBriefingPrefs({ enabled: true, skipDates: ["2026-12-25", "nope"] }).skipDates.join() === "2026-12-25", "skip dates are validated");
}

{
  const group = "W1 tick";
  const s = slack();
  const store = createInMemoryBriefingStore(rec());
  const deps = (over: Partial<Parameters<typeof runBriefingTick>[0]> = {}) => ({ store, remindersStore: { get: async () => parked(2) }, fetchDueSoon: async () => [{ key: "D-1", dueDate: "2026-11-06" }], send: s.send, now: NOW, local: local(THU, 8 * 60 + 40), ...over });
  const r1 = await runBriefingTick(deps());
  ok(group, r1.sent && s.msgs.length === 1 && /Morning briefing — 2026-11-05/.test(s.msgs[0]), "at 08:30+ local on a workday exactly one Slack message is sent");
  const r2 = await runBriefingTick(deps());
  const r3 = await runBriefingTick(deps({ local: local(THU, 9 * 60) }));
  ok(group, !r2.sent && r2.skipped === "already-sent" && !r3.sent && s.msgs.length === 1, "two cron runs inside the window do not double-send");
  ok(group, (await store.get())!.prevSlipKeys!.join() === "S-1", "after sending, today's slip keys become tomorrow's 'already seen'");
  const r4 = await runBriefingTick(deps({ local: local("2026-11-06", 8 * 60 + 31) }));
  ok(group, r4.sent && s.msgs.length === 2 && !/New high slip risk/.test(s.msgs[1]), "the next workday sends again without repeating yesterday's slip risk as new");

  const down = slack();
  down.set(false);
  const st = createInMemoryBriefingStore(rec());
  const d = { store: st, remindersStore: null, fetchDueSoon: null, send: down.send, now: NOW, local: local(THU, 9 * 60) };
  const fail = await runBriefingTick(d);
  ok(group, !fail.sent && /Slack/.test(fail.error ?? "") && (await st.get())!.lastSentOn === undefined && (await st.get())!.attempts === 1, "Slack down -> owed (nothing consumed, attempt counted)");
  down.set(true);
  const back = await runBriefingTick({ ...d, local: local(THU, 14 * 60) });
  const again = await runBriefingTick({ ...d, local: local(THU, 15 * 60) });
  ok(group, back.sent && down.msgs.length === 1 && !again.sent, "delivered later the same day, never twice");
  const dead = slack();
  dead.set(false);
  const st2 = createInMemoryBriefingStore(rec());
  for (let i = 0; i < BRIEFING_MAX_ATTEMPTS; i++) await runBriefingTick({ store: st2, remindersStore: null, fetchDueSoon: null, send: dead.send, now: NOW, local: local(THU, 9 * 60) });
  ok(group, (await st2.get())!.lastSentOn === THU, `attempts are bounded (${BRIEFING_MAX_ATTEMPTS}): then it stops for the day`);

  const jira = slack();
  await runBriefingTick({ store: createInMemoryBriefingStore(rec()), remindersStore: null, fetchDueSoon: async () => { throw new Error("jira"); }, send: jira.send, now: NOW, local: local(THU, 9 * 60) });
  ok(group, jira.msgs.length === 1 && /Jira could not be reached/.test(jira.msgs[0]), "a throwing Jira query does not stop the briefing");
  const skipEmpty = slack();
  const r5 = await runBriefingTick({ store: createInMemoryBriefingStore({ prefs: { ...prefs, skipIfEmpty: true } }), remindersStore: null, fetchDueSoon: async () => [], send: skipEmpty.send, now: NOW, local: local(THU, 9 * 60) });
  ok(group, r5.skipped === "empty" && skipEmpty.msgs.length === 0, "skipIfEmpty: an empty day sends nothing");
  const noSlack = await runBriefingTick({ store: createInMemoryBriefingStore(rec()), remindersStore: null, fetchDueSoon: null, send: null, now: NOW, local: local(THU, 9 * 60) });
  ok(group, noSlack.skipped === "no-slack", "a member without Slack gets only the in-app card");
  const quiet = await runBriefingTick({ store: createInMemoryBriefingStore(rec()), remindersStore: null, fetchDueSoon: null, send: s.send, now: NOW, local: local(THU, 9 * 60), quiet: { start: "00:00", end: "23:59" } });
  ok(group, quiet.skipped === "quiet-hours", "quiet hours defer it");
  ok(group, (await runBriefingTick({ store: createInMemoryBriefingStore(null), remindersStore: null, fetchDueSoon: null, send: s.send, now: NOW, local: local(THU, 9 * 60) })).skipped === "no-record", "nothing mirrored yet -> nothing to send");
  const narrated = slack();
  await runBriefingTick({ store: createInMemoryBriefingStore(rec()), remindersStore: null, fetchDueSoon: async () => [], send: narrated.send, now: NOW, local: local(THU, 9 * 60), narrate: async () => "Focus on A-1 first." });
  const failedNarration = slack();
  await runBriefingTick({ store: createInMemoryBriefingStore(rec()), remindersStore: null, fetchDueSoon: async () => [], send: failedNarration.send, now: NOW, local: local(THU, 9 * 60), narrate: async () => { throw new Error("capped"); } });
  ok(group, /Focus on A-1 first\./.test(narrated.msgs[0]) && /Heads-up/.test(failedNarration.msgs[0]), "AI narration is used when it answers; capped/failed -> the deterministic line");
  // DST change day: the member's local date comes from the zone offset the caller computes; the tick only compares local parts
  ok(group, briefingDueNow(prefs, local("2026-03-29", 8 * 60 + 30)).why === "weekend" && briefingDueNow(prefs, local("2026-03-30", 8 * 60 + 30)).due, "local-parts comparison is DST-neutral (the zone resolver supplies date + minutes)");
}

{
  const group = "W1 snapshot and sanitising";
  const s = buildBriefingSnapshot({ nowIso: NOW.toISOString(), today: THU, cards: [{ ticketKey: "A-1", headline: "x".repeat(300) }, { ticketKey: "A-2", headline: "y" }, { ticketKey: "A-3", headline: "z" }, { ticketKey: "A-4", headline: "w" }], slipHigh: new Map([["S-1", { explanation: "slow" }]]), awaitingMeByKey: { "M-1": { sinceIso: "2026-10-28", count: 1 } } });
  ok(group, s.nba.length === 3 && s.nba[0].headline.length === 140 && s.slipHigh[0].key === "S-1" && s.awaiting[0].ageBusinessDays >= 5, "the snapshot keeps the top 3 next actions, short reasons and mention ages — keys only");
  ok(group, dueSoonFrom([{ key: "A-1", title: "t", dueDate: "2026-11-06", status: "In Progress" }, { key: "A-2", title: "t", dueDate: "2026-11-20", status: "To Do" }, { key: "A-3", title: "t", dueDate: "2026-11-01", status: "Done" }] as never, THU).map((t) => t.key).join() === "A-1", "due-soon = open tickets due within 2 days or overdue");
  const links = briefingLinks(["A-1", "NOPE-1"], [{ key: "A-1", title: "T", sourceUrl: "http://insecure.example.com/x" }] as never);
  ok(group, links["A-1"].url === undefined && !("NOPE-1" in links), "links: https only; unknown keys dropped");
  const r = asBriefingRecord({ prefs: { enabled: true }, links: { "A-1": { title: "Hi <script>|x", url: "https://ok.example.com/a b" }, "bad key": { title: "x" }, "B-2": { url: "https://ok.example.com/b" } } })!;
  ok(group, !r.links!["A-1"]?.title?.includes("<") && !r.links!["A-1"]?.title?.includes("|") && r.links!["A-1"]?.url === undefined && !("bad key" in r.links!) && r.links!["B-2"].url === "https://ok.example.com/b", "links are sanitised before they are rendered into Slack");
  ok(group, asBriefingRecord("junk") === null && asBriefingRecord({ prefs: { time: "x" } })!.prefs.time === "08:30", "record parse never throws");
}

{
  const group = "W1 wiring";
  const tick = fs.readFileSync("src/lib/command-center/jira/cron-tick.ts", "utf8");
  const route = fs.readFileSync("src/app/api/command-center/jira/sync/route.ts", "utf8");
  const home = fs.readFileSync("src/app/page.tsx", "utf8");
  ok(group, /runBriefingTick/.test(tick) && /createBriefingStore\(\)/.test(route) && /briefingStore: isNotifyStoreConfigured\(\) \? createBriefingStore\(uid\)/.test(route), "the cron (single-user and per member) runs the briefing step");
  ok(group, (home.match(/<BriefingCard \/>/g) ?? []).length === 2, "the in-app card is the top of the Command Center (normal and compact)");
  const r = fs.readFileSync("src/app/api/command-center/briefing/route.ts", "utf8");
  ok(group, /mirrorWho/.test(r) && /isSameOrigin/.test(r) && /no-store|noStore/.test(r), "the briefing route: paired/signed-in auth, same-origin writes, no-store");
}
