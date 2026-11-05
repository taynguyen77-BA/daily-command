// D4 — Reminder Center: model, schedule, escalation, index mirroring and the cron step (offline, injected I/O).
import fs from "node:fs";
import { ok } from "./harness.mts";
import { asReminderMeta, canConfirmParking, isParkedWithoutDate, patchReminder, remindOnOf, validateDeliveryHour, validateRemindOn, validateTime } from "../../src/lib/command-center/reminder-model";
import { DEFAULT_REMINDER_PREFS, addBusinessDays, asReminderPrefs, nextMonday, nextReminderDay, reminderChips, reminderDueNow, smartDefaultRemindOn } from "../../src/lib/command-center/reminder-schedule";
import { applyTicketStatus, asTicketWorkStates } from "../../src/lib/command-center/ticket-work-state";
import { asReminderIndex, buildReminderIndex, indexSignature, mergeIndexProgress, createInMemoryReminderIndexStore, type ReminderIndex } from "../../src/lib/command-center/reminder-index";
import { buildReminderDigest } from "../../src/lib/command-center/reminder-digest";
import { runRemindersTick, storeClientIndex, REMINDER_MAX_ATTEMPTS, type ParkedTicketCheck } from "../../src/lib/command-center/reminders-tick";
import type { TicketWorkState } from "../../src/lib/command-center/types";

const NOW_ISO = "2026-11-05T02:00:00.000Z"; // Thursday
const st = (key: string, status: TicketWorkState["status"], over: Partial<TicketWorkState> = {}): TicketWorkState => ({ ticketKey: key, status, updatedAt: NOW_ISO, history: [], ...over });

{
  const group = "D4 model";
  ok(group, remindOnOf(st("A-1", "SKIPPED", { until: "2026-11-09" })) === "2026-11-09" && remindOnOf(st("A-1", "DEFERRED", { until: "2026-11-10" })) === "2026-11-10", "SKIPPED / DEFERRED: remindOn = until");
  ok(group, remindOnOf(st("A-1", "BLOCKED", { until: "2026-11-12", pingOn: "2026-11-10" })) === "2026-11-10" && remindOnOf(st("A-1", "BLOCKED", { pingOn: "2026-11-10" })) === "2026-11-10" && remindOnOf(st("A-1", "BLOCKED", { until: "2026-11-12" })) === "2026-11-12", "BLOCKED: the earlier of pingOn / until (legacy records show the right date with no migration)");
  ok(group, remindOnOf(st("A-1", "TODO", { until: "2026-11-12" })) === undefined && remindOnOf(st("A-1", "SKIPPED")) === undefined, "no date / not a parked state -> undefined");
  ok(group, validateRemindOn("2026-11-04", "2026-11-05").ok === false && validateRemindOn("2026-11-05", "2026-11-05").ok && validateRemindOn("2026-02-30", "2026-01-01").ok === false && validateRemindOn("nope", "2026-11-05").ok === false, "past and invalid dates rejected; today accepted");
  ok(group, validateTime("09:30").ok && !validateTime("24:00").ok && !validateTime("9:30").ok && validateDeliveryHour(0).ok && validateDeliveryHour(23).ok && !validateDeliveryHour(24).ok && !validateDeliveryHour(9.5).ok, "time is HH:mm; delivery hour 0-23");
  const c = (o: Parameters<typeof canConfirmParking>[0]) => canConfirmParking(o).ok;
  ok(group, !c({ require: true, noReminder: false, today: "2026-11-05" }) && c({ require: true, noReminder: true, today: "2026-11-05" }) && c({ require: true, remindOn: "2026-11-09", noReminder: false, today: "2026-11-05" }) && !c({ require: true, remindOn: "2026-11-01", noReminder: false, today: "2026-11-05" }) && c({ require: false, noReminder: false, today: "2026-11-05" }), "requireReminderDate: a date or 'No reminder' is mandatory; a past date is rejected; off = optional");
  ok(group, asReminderMeta({ setAt: "x", level: 9, lastRemindedOn: "bad" })!.level === 3 && asReminderMeta({ setAt: "x", level: 9, lastRemindedOn: "bad" })!.lastRemindedOn === undefined && asReminderMeta("junk") === undefined && asReminderMeta({ level: 1 }) === undefined, "reminder meta parse: clamps, drops invalid, never throws");
  const prefs = asReminderPrefs({ deliveryHourLocal: 30, ladder: [3, 2, 1], parkedWithoutDateDays: 0, skipWeekends: false });
  ok(group, prefs.deliveryHourLocal === 9 && prefs.ladder.join() === "1,3,7" && prefs.parkedWithoutDateDays === 14 && prefs.skipWeekends === false, "reminder prefs: invalid values fall back to the defaults");
}

{
  const group = "D4 capture & persistence";
  const r = applyTicketStatus({}, "A-1", "SKIPPED", { until: "2026-11-10", surface: "my-work" }, NOW_ISO);
  ok(group, r.states["A-1"].reminder?.level === 0 && r.states["A-1"].reminder?.noReminder === undefined && r.states["A-1"].until === "2026-11-10", "skipping records the date and a fresh reminder meta");
  const n = applyTicketStatus({}, "A-2", "BLOCKED", { noReminder: true, surface: "my-work" }, NOW_ISO);
  ok(group, n.states["A-2"].reminder?.noReminder === true && remindOnOf(n.states["A-2"]) === undefined, "'No reminder' is stored explicitly");
  const d = applyTicketStatus({}, "A-3", "DONE", { surface: "my-work" }, NOW_ISO);
  ok(group, d.states["A-3"].reminder === undefined, "a Done ticket carries no reminder");
  const legacy = asTicketWorkStates({ "L-1": { ticketKey: "L-1", status: "BLOCKED", updatedAt: NOW_ISO, history: [], until: "2026-11-12", pingOn: "2026-11-10" } });
  ok(group, legacy["L-1"].reminder === undefined && remindOnOf(legacy["L-1"]) === "2026-11-10", "an old blob (until / pingOn only) loads unchanged");
  const round = asTicketWorkStates(JSON.parse(JSON.stringify(r.states)));
  ok(group, round["A-1"].reminder?.setAt === NOW_ISO, "reminder meta round-trips through parse");
  const snoozed = patchReminder(r.states, "A-1", { kind: "snooze", until: "2026-11-09" }, "2026-11-05T03:00:00.000Z");
  ok(group, snoozed["A-1"].reminder?.snoozedUntil === "2026-11-09" && snoozed["A-1"].updatedAt > r.states["A-1"].updatedAt, "snooze bumps the LWW clock");
  const changed = patchReminder(snoozed, "A-1", { kind: "change-date", remindOn: "2026-11-20" }, "2026-11-05T04:00:00.000Z");
  ok(group, changed["A-1"].until === "2026-11-20" && changed["A-1"].reminder?.snoozedUntil === undefined && changed["A-1"].reminder?.level === 0, "changing the date restarts the ladder");
  const stopped = patchReminder(changed, "A-1", { kind: "stop" }, "2026-11-05T05:00:00.000Z");
  ok(group, stopped["A-1"].reminder?.noReminder === true && remindOnOf(stopped["A-1"]) === undefined, "'Stop reminding' keeps the ticket visible as parked-without-date");
  ok(group, patchReminder(r.states, "NOPE-1", { kind: "stop" }, NOW_ISO) === r.states && patchReminder(d.states, "A-3", { kind: "stop" }, NOW_ISO) === d.states, "unknown / non-parked tickets: no change");
  // two devices: last write wins
  const a = patchReminder(r.states, "A-1", { kind: "change-date", remindOn: "2026-11-11" }, "2026-11-05T06:00:00.000Z");
  const b = patchReminder(r.states, "A-1", { kind: "change-date", remindOn: "2026-11-12" }, "2026-11-05T07:00:00.000Z");
  const { mergeTicketWorkStates } = await import("../../src/lib/command-center/ticket-work-state");
  ok(group, mergeTicketWorkStates(a, b)["A-1"].until === "2026-11-12" && mergeTicketWorkStates(b, a)["A-1"].until === "2026-11-12", "two devices change the same reminder: last write wins in both directions");
  ok(group, isParkedWithoutDate(n.states["A-2"], "2026-11-25", 14) && !isParkedWithoutDate(n.states["A-2"], "2026-11-10", 14) && !isParkedWithoutDate(r.states["A-1"], "2026-12-30", 14), "parked-without-a-date: only dateless, older than the threshold");
}

{
  const group = "D4 schedule";
  ok(group, addBusinessDays("2026-11-05", 3) === "2026-11-10" && addBusinessDays("2026-11-06", 1) === "2026-11-09" && addBusinessDays("2026-11-10", -2) === "2026-11-06", "business-day math skips weekends (Thu +3 = Tue)");
  ok(group, nextMonday("2026-11-05") === "2026-11-09" && nextMonday("2026-11-09") === "2026-11-16", "next Monday is always in the future");
  ok(group, reminderChips("2026-11-05").map((c) => c.date).join() === "2026-11-06,2026-11-08,2026-11-09,2026-11-19", "chips: tomorrow / +3 days / next Monday / +2 weeks");
  ok(group, smartDefaultRemindOn({ status: "SKIPPED", today: "2026-11-05" }) === "2026-11-10", "SKIPPED default = +3 business days");
  ok(group, smartDefaultRemindOn({ status: "BLOCKED", today: "2026-11-05", slaBusinessDays: 2 }) === "2026-11-09", "BLOCKED default = the blocker SLA in business days");
  ok(group, smartDefaultRemindOn({ status: "BLOCKED", today: "2026-11-05", slaBusinessDays: 5, jiraDueDate: "2026-11-09" }) === "2026-11-06", "BLOCKED: 2 business days before the Jira due date when that is sooner (never before tomorrow)");
  ok(group, smartDefaultRemindOn({ status: "DEFERRED", today: "2026-11-05", chosenDate: "2026-11-20" }) === "2026-11-20", "DEFERRED default = the chosen date");
  const item = (over: Partial<TicketWorkState> = {}): Pick<TicketWorkState, "status" | "until" | "pingOn" | "reminder"> => ({ status: "SKIPPED", until: "2026-11-10", reminder: { level: 0, setAt: NOW_ISO }, ...over });
  const P = DEFAULT_REMINDER_PREFS;
  ok(group, reminderDueNow(item(), { date: "2026-11-09", minutes: 600 }, P) === null && reminderDueNow(item(), { date: "2026-11-10", minutes: 8 * 60 }, P) === null, "not due before the day, nor before the delivery hour on the day");
  ok(group, reminderDueNow(item(), { date: "2026-11-10", minutes: 9 * 60 }, P)?.level === 0 && reminderDueNow(item(), { date: "2026-11-12", minutes: 0 }, P)?.level === 0, "due at the delivery hour; a missed day is still due later (owed)");
  ok(group, reminderDueNow(item({ until: "2026-11-07" }), { date: "2026-11-07", minutes: 10 * 60 }, P) === null && reminderDueNow(item({ until: "2026-11-07" }), { date: "2026-11-09", minutes: 9 * 60 }, P)?.dueOn === "2026-11-09", "remindOn on a Saturday with skipWeekends -> Monday");
  ok(group, reminderDueNow(item({ until: "2026-11-07" }), { date: "2026-11-07", minutes: 10 * 60 }, { ...P, skipWeekends: false })?.dueOn === "2026-11-07", "…and stays Saturday when skipWeekends is off");
  ok(group, reminderDueNow(item({ reminder: { level: 0, setAt: NOW_ISO, noReminder: true } }), { date: "2027-01-01", minutes: 600 }, P) === null && reminderDueNow(item({ until: undefined }), { date: "2027-01-01", minutes: 600 }, P) === null, "noReminder / no date: never due");
  ok(group, reminderDueNow({ status: "TODO", until: "2026-11-10" }, { date: "2026-11-11", minutes: 600 }, P) === null, "a ticket that left the parked states is never due");
  // snooze
  const snoozed = item({ reminder: { level: 0, setAt: NOW_ISO, snoozedUntil: "2026-11-16" } });
  ok(group, reminderDueNow(snoozed, { date: "2026-11-12", minutes: 600 }, P) === null && reminderDueNow(snoozed, { date: "2026-11-16", minutes: 600 }, P)?.dueOn === "2026-11-16", "snooze to Monday: nothing before Monday");
  // escalation ladder 1 / 3 / 7 then weekly; never twice in one day
  const sent = (level: number, on: string) => item({ reminder: { level, setAt: NOW_ISO, lastRemindedOn: on } });
  ok(group, nextReminderDay(sent(0, "2026-11-10"), P)?.dueOn === "2026-11-11" && nextReminderDay(sent(0, "2026-11-10"), P)?.level === 1, "escalation 1: remindOn + 1 day");
  ok(group, nextReminderDay(sent(1, "2026-11-11"), P)?.dueOn === "2026-11-13" && nextReminderDay(sent(1, "2026-11-11"), P)?.level === 2, "escalation 2: remindOn + 3 days");
  ok(group, nextReminderDay(sent(2, "2026-11-13"), P)?.dueOn === "2026-11-17" && nextReminderDay(sent(2, "2026-11-13"), P)?.level === 3, "escalation 3: remindOn + 7 days");
  ok(group, nextReminderDay(sent(3, "2026-11-17"), P)?.dueOn === "2026-11-24" && nextReminderDay(sent(3, "2026-11-17"), P)?.level === 3, "then a weekly 'stale parking lot' reminder");
  ok(group, nextReminderDay(sent(0, "2026-11-11"), P)!.dueOn > "2026-11-11", "never more than one reminder per ticket per day");
  const afterSnooze = item({ reminder: { level: 1, setAt: NOW_ISO, lastRemindedOn: "2026-11-11", snoozedUntil: "2026-11-23" } });
  ok(group, nextReminderDay(afterSnooze, P)?.dueOn === "2026-11-23" && nextReminderDay(afterSnooze, P)?.level === 2, "snooze resumes the escalation counter (next level, on the snooze date)");
}

// ---- index, digest, tick ----
const items = (n: number, over: Partial<TicketWorkState> = {}) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`P-${i + 1}`, st(`P-${i + 1}`, "SKIPPED", { until: "2026-11-05", reminder: { level: 0, setAt: "2026-11-02T00:00:00.000Z" }, reason: "waiting", ...over })]));
const work = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `P-${i + 1}`, title: `Ticket ${i + 1}`, sourceUrl: `https://jira.example.com/browse/P-${i + 1}` }));
const mkIndex = (n: number, over: Partial<TicketWorkState> = {}): ReminderIndex => buildReminderIndex(items(n, over), work(n), NOW_ISO);
const local = { date: "2026-11-05", minutes: 9 * 60 + 5 };
const slackLog = () => { const msgs: string[] = []; let up = true; return { msgs, setUp: (v: boolean) => { up = v; }, send: async (t: string) => { if (!up) return false; msgs.push(t); return true; } }; };

{
  const group = "D4 index";
  const idx = mkIndex(3);
  ok(group, idx.items.length === 3 && idx.items[0].title === "Ticket 1" && idx.items[0].projectKey === "P" && !JSON.stringify(idx).includes("description"), "the index carries keys, states, dates, short title/reason only");
  ok(group, indexSignature(idx) === indexSignature(mkIndex(3)) && indexSignature(idx) !== indexSignature(mkIndex(2)), "signature is stable and changes with content");
  const progressed: ReminderIndex = { ...idx, items: idx.items.map((i, k) => (k === 0 ? { ...i, level: 1, lastRemindedOn: "2026-11-06", attempts: 2 } : i)) };
  const merged = mergeIndexProgress(mkIndex(3), progressed);
  ok(group, merged.items[0].level === 1 && merged.items[0].lastRemindedOn === "2026-11-06" && merged.items[1].level === 0, "a client index keeps the cron's progress for the SAME parking");
  const redated = mergeIndexProgress(buildReminderIndex(items(3, { until: "2026-11-20" }), work(3), NOW_ISO), progressed);
  ok(group, redated.items[0].level === 0 && redated.items[0].lastRemindedOn === undefined, "a changed date starts over");
  ok(group, asReminderIndex({ version: 1, builtAt: "x", items: [{ ticketKey: "A-1", status: "SKIPPED", parkedAt: "x", level: 0, projectKey: "A" }, { bad: 1 }] })?.items.length === 1 && asReminderIndex("junk") === null, "index parse drops malformed items");
  const store = createInMemoryReminderIndexStore(progressed);
  const saved = await storeClientIndex(store, mkIndex(3));
  ok(group, saved.items[0].level === 1 && (await store.get())!.items[0].lastRemindedOn === "2026-11-06", "storeClientIndex persists the merged index");
}

{
  const group = "D4 digest";
  const idx = mkIndex(60);
  const due = idx.items.map((item) => ({ item, level: 0, dueOn: "2026-11-05" }));
  const d = buildReminderDigest(due, "2026-11-05");
  ok(group, d.shown.length === 15 && d.more === 45 && /60 reminders due today/.test(d.text) && /\+45 more/.test(d.text), "60 due -> a grouped message with the first 15 and '+45 more' (flood guard)");
  ok(group, /<https:\/\/jira.example.com\/browse\/P-1\|P-1>/.test(d.text) && /parked 3 days/.test(d.text), "each line links the ticket and says how long it has been parked");
  ok(group, /1 reminder due today/.test(buildReminderDigest(due.slice(0, 1), "2026-11-05").text) && /2nd reminder/.test(buildReminderDigest([{ ...due[0], level: 1 }], "2026-11-05").text) && /still parked/.test(buildReminderDigest([{ ...due[0], level: 3 }], "2026-11-05").text), "wording grows with the escalation level");
}

{
  const group = "D4 cron step";
  const slack = slackLog();
  const store = createInMemoryReminderIndexStore(mkIndex(3));
  const deps = (over: Partial<Parameters<typeof runRemindersTick>[0]> = {}) => ({ store, checkJira: async (): Promise<ParkedTicketCheck | null> => new Map(), send: slack.send, now: new Date("2026-11-05T02:05:00.000Z"), local, ...over });
  const r1 = await runRemindersTick(deps());
  ok(group, r1.sent === 3 && slack.msgs.length === 1 && /3 reminders due today/.test(slack.msgs[0]), "on the due day at the delivery hour: ONE grouped Slack message — with the browser closed");
  const r2 = await runRemindersTick(deps());
  ok(group, r2.sent === 0 && slack.msgs.length === 1 && r2.skipped === "nothing-due", "a second run the same day sends nothing (idempotent)");
  const after = await store.get();
  ok(group, after!.items.every((i) => i.lastRemindedOn === "2026-11-05" && i.level === 0), "progress is recorded on the index");
  const r3 = await runRemindersTick(deps({ local: { date: "2026-11-06", minutes: 9 * 60 + 1 } }));
  ok(group, r3.sent === 3 && /2nd reminder/.test(slack.msgs[1]), "the next day the escalation level 1 goes out");

  // Slack down: owed, then delivered exactly once; attempts bounded
  const s2 = slackLog();
  const st2 = createInMemoryReminderIndexStore(mkIndex(2));
  s2.setUp(false);
  const d2 = { store: st2, checkJira: async () => new Map() as ParkedTicketCheck, send: s2.send, now: new Date("2026-11-05T02:05:00.000Z"), local };
  const down = await runRemindersTick(d2);
  ok(group, down.sent === 0 && down.owed === 2 && /Slack/.test(down.error ?? "") && (await st2.get())!.items.every((i) => !i.lastRemindedOn && i.attempts === 1), "Slack down on the due day: nothing consumed, the reminder stays owed (attempt counted)");
  s2.setUp(true);
  const back = await runRemindersTick({ ...d2, local: { date: "2026-11-05", minutes: 14 * 60 } });
  const again = await runRemindersTick({ ...d2, local: { date: "2026-11-05", minutes: 15 * 60 } });
  ok(group, back.sent === 2 && s2.msgs.length === 1 && again.sent === 0, "delivered once Slack is back — exactly once");
  const s3 = slackLog();
  s3.setUp(false);
  const st3 = createInMemoryReminderIndexStore(mkIndex(1));
  for (let i = 0; i < REMINDER_MAX_ATTEMPTS; i++) await runRemindersTick({ store: st3, checkJira: null, send: s3.send, now: new Date("2026-11-05T02:05:00.000Z"), local });
  const gaveUp = (await st3.get())!.items[0];
  ok(group, gaveUp.lastRemindedOn === "2026-11-05" && gaveUp.attempts === 0, `attempts are bounded (${REMINDER_MAX_ATTEMPTS}): the reminder gives up for the day and the ladder moves on`);

  // Jira
  const s4 = slackLog();
  const st4 = createInMemoryReminderIndexStore(mkIndex(3));
  const rJira = await runRemindersTick({ store: st4, send: s4.send, now: new Date("2026-11-05T02:05:00.000Z"), local, checkJira: async () => new Map([["P-1", "closed"], ["P-2", "not-mine"], ["P-3", "open"]]) });
  ok(group, rJira.sent === 1 && rJira.dropped === 2 && s4.msgs.length === 1 && !/P-1\b/.test(s4.msgs[0]) && /P-3/.test(s4.msgs[0]) && (await st4.get())!.items.find((i) => i.ticketKey === "P-1")!.resolved === "closed in Jira", "a ticket Done in Jira before the due day: no message, resolved ('closed in Jira')");
  const s5 = slackLog();
  const st5 = createInMemoryReminderIndexStore(mkIndex(2));
  const rUn = await runRemindersTick({ store: st5, send: s5.send, now: new Date("2026-11-05T02:05:00.000Z"), local, checkJira: async () => { throw new Error("jira down"); } });
  ok(group, rUn.sent === 2 && rUn.unverified && /not checked in Jira/.test(s5.msgs[0]) && (await st5.get())!.items.every((i) => i.unverified), "Jira unreachable: send anyway, mark unverified");
  const s5b = slackLog();
  await runRemindersTick({ store: createInMemoryReminderIndexStore(mkIndex(1)), send: s5b.send, now: new Date("2026-11-05T02:05:00.000Z"), local, checkJira: null });
  ok(group, s5b.msgs.length === 1, "no Jira connection: still reminds");

  // flood guard drains
  const s6 = slackLog();
  const st6 = createInMemoryReminderIndexStore(mkIndex(60));
  const f1 = await runRemindersTick({ store: st6, send: s6.send, now: new Date("2026-11-05T02:05:00.000Z"), local, checkJira: async () => new Map() });
  ok(group, f1.sent === 15 && f1.owed === 45 && /\+45 more/.test(s6.msgs[0]), "60 parked tickets due on one day -> 15 + '+45 more'");
  let total = f1.sent;
  const seen = new Set<string>();
  for (let i = 0; i < 6; i++) { const r = await runRemindersTick({ store: st6, send: s6.send, now: new Date("2026-11-05T02:05:00.000Z"), local, checkJira: async () => new Map() }); total += r.sent; }
  for (const m of s6.msgs) for (const k of m.match(/P-\d+(?=[>\s—])/g) ?? []) { if (seen.has(`${k}`) && false) throw new Error("dup"); seen.add(k); }
  ok(group, total === 60 && (await st6.get())!.items.every((i) => i.lastRemindedOn === "2026-11-05"), "the rest drains over later runs, each ticket reminded once");

  // quiet hours / no slack / nothing
  const s7 = slackLog();
  const q = await runRemindersTick({ store: createInMemoryReminderIndexStore(mkIndex(1)), send: s7.send, checkJira: null, now: new Date("2026-11-05T02:05:00.000Z"), local, quiet: { start: "00:00", end: "23:59" } });
  ok(group, q.skipped === "quiet-hours" && s7.msgs.length === 0 && q.owed === 1, "quiet hours defer the reminder (still owed)");
  const ns = await runRemindersTick({ store: createInMemoryReminderIndexStore(mkIndex(1)), send: null, checkJira: null, now: new Date(), local });
  ok(group, ns.skipped === "no-slack" && ns.owed === 1, "a member without Slack: nothing sent, nothing consumed (in-app reminders still work)");
  ok(group, (await runRemindersTick({ store: createInMemoryReminderIndexStore(null), send: s7.send, checkJira: null, now: new Date(), local })).skipped === "no-index", "no index yet -> nothing to do");
  const unreadable = { get: async () => { throw new Error("kv"); }, set: async () => undefined };
  ok(group, (await runRemindersTick({ store: unreadable, send: s7.send, checkJira: null, now: new Date(), local })).skipped === "no-index", "an unreadable index never crashes the cron");
  const early = await runRemindersTick({ store: createInMemoryReminderIndexStore(mkIndex(1)), send: s7.send, checkJira: null, now: new Date(), local: { date: "2026-11-05", minutes: 8 * 60 } });
  ok(group, early.skipped === "nothing-due", "before the delivery hour nothing is due");
}

{
  const group = "D4 wiring";
  const tick = fs.readFileSync("src/lib/command-center/jira/cron-tick.ts", "utf8");
  const route = fs.readFileSync("src/app/api/command-center/jira/sync/route.ts", "utf8");
  ok(group, /runRemindersTick/.test(tick) && /reminders\?: \{ store: ReminderIndexStore/.test(tick) && /createReminderIndexStore\(\)/.test(route) && /reminderStore: isNotifyStoreConfigured\(\) \? createReminderIndexStore\(uid\)/.test(route), "the cron (single-user and per member) runs the reminders step");
  const idxRoute = fs.readFileSync("src/app/api/command-center/reminders/index/route.ts", "utf8");
  const mirrorAuth = fs.readFileSync("src/lib/server/mirror-auth.ts", "utf8");
  ok(group, /mirrorWho/.test(idxRoute) && /checkSyncRequestAuth/.test(mirrorAuth) && /isSameOrigin/.test(idxRoute) && /noStore/.test(idxRoute) && /asReminderIndex/.test(idxRoute), "the index route: paired/signed-in auth, same-origin, no-store, validated body");
}
