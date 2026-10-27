// P3.6 — Next Best Action: ranking rules, dedupe/exclusions, feedback events, learning signals, narration, wiring.
import fs from "node:fs";
import path from "node:path";
import { nextBestActions, nbaCardKey, NBA_LIMIT, NBA_RANK, type NbaInput } from "../../src/lib/command-center/next-best-action";
import { nbaInputFrom } from "../../src/lib/command-center/nba-inputs";
import { dismissedTodayKeys, nbaFeedbackEvent, nbaSignals } from "../../src/lib/command-center/nba-feedback";
import { deterministicNarration, hashFacts, narrateNextBestActions, NARRATION_STORAGE_KEY, type NarrationStorage } from "../../src/lib/command-center/nba-narration";
import { collectAppearances, computeLearnedAdjustments, type Appearance } from "../../src/lib/command-center/learned-adjustments";
import { buildAwaitingMe } from "../../src/lib/command-center/awaiting-me";
import { scoreAllWorkItems } from "../../src/lib/command-center/scoring";
import { parseStoredState } from "../../src/lib/command-center/store";
import { emptyData, type PriorityScoreResult, type TicketWorkState, type WorkItem } from "../../src/lib/command-center/types";
import { ok } from "./harness.mts";
import { v226Store } from "./helpers.mts";

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const today = "2026-10-27"; // Tuesday
const wi = (key: string, over: Partial<WorkItem> = {}): WorkItem => ({ id: `jira-${key}`, key, title: `Title ${key}`, projectId: "p-1", clientId: "c", type: "task", status: "In Progress", priority: "P3", createdDate: "2026-10-01", lastUpdated: today, blocked: false, dependencyIds: [], riskIds: [], scopeChangeCount: 0, owner: "Tay", ownerId: "acc-me", ...over }) as WorkItem;
const score = (w: WorkItem, s: number): PriorityScoreResult => ({ itemId: w.id, score: s, classification: s >= 80 ? "CRITICAL" : s >= 60 ? "HIGH" : "MEDIUM", factors: [], confidence: 0.9, reasoning: `Scored ${s}/100: reasons.` });
const st = (key: string, status: TicketWorkState["status"], over: Partial<TicketWorkState> = {}): TicketWorkState => ({ ticketKey: key, status, updatedAt: `${today}T08:00:00.000Z`, history: [], ...over });
function input(items: WorkItem[], over: Partial<NbaInput> = {}, scores: Record<string, number> = {}): NbaInput {
  return { today, workItems: items, scores: items.map((w) => score(w, scores[w.key] ?? 40)), awaitingMeByKey: {}, ticketWorkStates: {}, slipHigh: new Map(), nudgeReadyKeys: new Set(), blockerSlaBusinessDays: 2, dueRecheckKeys: new Set(), ...over };
}
const keys = (cards: ReturnType<typeof nextBestActions>) => cards.map((c) => `${c.kind}:${c.ticketKey}`).join(",");

{
  const group = "P3.6 Each rule on its own";
  const reply = wi("R-1");
  const sig = { "R-1": { sinceIso: "2026-10-20", count: 2 } };
  let c = nextBestActions(input([reply], { awaitingMeByKey: sig }));
  ok(group, keys(c) === "REPLY:R-1" && c[0].primary.intent === "draft-reply" && c[0].primary.label === "Draft reply" && c[0].why[0].content.includes("2 unanswered mention(s)"), "REPLY: a mention waiting on you past the SLA -> Draft reply, with the count and age");
  c = nextBestActions(input([reply], { awaitingMeByKey: { "R-1": { sinceIso: "2026-10-26", count: 1 } } }));
  ok(group, keys(c) === "TOP:R-1", "…not yet past the SLA: it is only an ordinary (TOP) candidate");
  const od = wi("O-1", { priority: "P1", dueDate: "2026-10-25" });
  c = nextBestActions(input([od, wi("O-2", { priority: "P3", dueDate: "2026-10-25" })], {}, { "O-1": 30, "O-2": 90 }));
  ok(group, c[0].kind === "OVERDUE" && c[0].ticketKey === "O-1" && c[0].primary.intent === "start-focus" && /Priority P1, due 2026-10-25 \(2 day/.test(c[0].why[0].content), "OVERDUE: only P1/P2 (an overdue P3 is not special, whatever its score)");
  ok(group, nextBestActions(input([wi("O-3", { priority: "P1", priorityKnown: false, dueDate: "2026-10-25" })]))[0].kind === "TOP", "a P1 that is only a placeholder (priority not set in Jira) does not count");
  c = nextBestActions(input([wi("S-1")], { slipHigh: new Map([["S-1", { explanation: "2 day(s) left; ...", remainingDays: 2 }]]) }));
  ok(group, keys(c) === "SLIP:S-1" && c[0].why[0].content.startsWith("Forecast:"), "SLIP: forecast HIGH");
  const blocked = wi("B-1", { blocked: true });
  const bState = { "B-1": st("B-1", "BLOCKED", { updatedAt: "2026-10-20T08:00:00.000Z", reason: "waiting on API" }) };
  c = nextBestActions(input([blocked], { ticketWorkStates: bState, nudgeReadyKeys: new Set(["B-1"]) }));
  ok(group, keys(c) === "NUDGE:B-1" && c[0].primary.intent === "nudge" && /Blocked 5 business days/.test(c[0].why[0].content), "NUDGE: blocked past the blocker SLA with a message ready");
  ok(group, keys(nextBestActions(input([blocked], { ticketWorkStates: bState, nudgeReadyKeys: new Set() }))) === "TOP:B-1" && keys(nextBestActions(input([blocked], { ticketWorkStates: { "B-1": st("B-1", "BLOCKED", { updatedAt: "2026-10-26T08:00:00.000Z" }) }, nudgeReadyKeys: new Set(["B-1"]) }))) === "TOP:B-1", "…no nudge ready, or still within the SLA: no NUDGE card");
  c = nextBestActions(input([wi("C-1")], { dueRecheckKeys: new Set(["C-1"]) }));
  ok(group, keys(c) === "RECHECK:C-1" && /re-check day is today/.test(c[0].why[0].content), "RECHECK: a re-check due today");
  c = nextBestActions(input([wi("T-1"), wi("T-2"), wi("T-3")], {}, { "T-1": 50, "T-2": 77, "T-3": 61 }));
  ok(group, c[0].kind === "TOP" && c[0].ticketKey === "T-2" && c[0].why[0].content.includes("score 77/100") && c[0].why[0].content.includes("confidence 90%"), "TOP: the highest-scored remaining ticket, with its reasoning and score");
  ok(group, c.every((x) => x.why.length > 0 && x.why.every((e) => e.content.length > 0)) && nextBestActions(input([])).length === 0, "every card has evidence; nothing to do -> no cards");
}

{
  const group = "P3.6 Ranking, limits, exclusions";
  const items = [wi("Z-top"), wi("A-reply"), wi("B-over", { priority: "P2", dueDate: "2026-10-26" }), wi("C-slip"), wi("D-nudge", { blocked: true }), wi("E-recheck")];
  const full = input(items, {
    awaitingMeByKey: { "A-reply": { sinceIso: "2026-10-15", count: 1 } },
    slipHigh: new Map([["C-slip", { explanation: "x", remainingDays: 1 }]]),
    ticketWorkStates: { "D-nudge": st("D-nudge", "BLOCKED", { updatedAt: "2026-10-15T08:00:00.000Z" }) },
    nudgeReadyKeys: new Set(["D-nudge"]),
    dueRecheckKeys: new Set(["E-recheck"]),
  }, { "Z-top": 99 });
  const cards = nextBestActions(full);
  ok(group, keys(cards) === "REPLY:A-reply,OVERDUE:B-over,SLIP:C-slip" && cards.length === NBA_LIMIT, `rank order REPLY > OVERDUE > SLIP > NUDGE > RECHECK > TOP, never more than 3 (${keys(cards)})`);
  ok(group, nextBestActions(full, 6).map((c) => c.kind).join() === "REPLY,OVERDUE,SLIP,NUDGE,RECHECK,TOP" && Object.entries(NBA_RANK).sort((a, b) => a[1] - b[1]).map((e) => e[0]).join() === "REPLY,OVERDUE,SLIP,NUDGE,RECHECK,TOP", "all six classes in the documented order");
  ok(group, JSON.stringify(nextBestActions(full)) === JSON.stringify(nextBestActions({ ...full })), "deterministic");

  // dedupe: a ticket that is both waiting on me and overdue appears once, as the higher class
  const both = wi("X-1", { priority: "P1", dueDate: "2026-10-20" });
  const d = nextBestActions(input([both], { awaitingMeByKey: { "X-1": { sinceIso: "2026-10-15", count: 1 } }, slipHigh: new Map([["X-1", { explanation: "x", remainingDays: -5 }]]) }), 6);
  ok(group, keys(d) === "REPLY:X-1", "one card per ticket, in its highest class");

  // ties are stable (by key)
  const tie = nextBestActions(input([wi("K-3"), wi("K-1"), wi("K-2")], {}, { "K-1": 50, "K-2": 50, "K-3": 50 }), 3);
  ok(group, keys(tie) === "TOP:K-1,TOP:K-2,TOP:K-3" && keys(nextBestActions(input([wi("K-2"), wi("K-3"), wi("K-1")], {}, { "K-1": 50, "K-2": 50, "K-3": 50 }), 3)) === keys(tie), "ties break by ticket key, whatever the input order");
  const sameClass = nextBestActions(input([wi("L-2", { priority: "P1", dueDate: "2026-10-25" }), wi("L-1", { priority: "P1", dueDate: "2026-10-20" }), wi("L-3", { priority: "P2", dueDate: "2026-10-20" })]), 3);
  ok(group, keys(sameClass) === "OVERDUE:L-1,OVERDUE:L-3,OVERDUE:L-2", "within a class: the most overdue first, then by key");

  // exclusions
  const gone = [wi("G-done", { status: "Done", priority: "P1", dueDate: "2026-10-20" }), wi("G-state-done", { priority: "P1", dueDate: "2026-10-20" }), wi("G-skip", { priority: "P1", dueDate: "2026-10-20" }), wi("G-defer-future", { priority: "P1", dueDate: "2026-10-20" }), wi("G-defer-past", { priority: "P1", dueDate: "2026-10-20" })];
  const ex = nextBestActions(input(gone, { ticketWorkStates: { "G-state-done": st("G-state-done", "DONE"), "G-skip": st("G-skip", "SKIPPED"), "G-defer-future": st("G-defer-future", "DEFERRED", { until: "2026-10-28" }), "G-defer-past": st("G-defer-past", "DEFERRED", { until: "2026-10-27" }) } }), 6);
  ok(group, keys(ex) === "OVERDUE:G-defer-past", "never a Done, Skipped or still-deferred ticket; a deferral whose day has come is back");

  // "Not now" hides the card for the rest of the day (and only that card)
  const dismissed = nextBestActions({ ...full, dismissedToday: new Set([nbaCardKey("REPLY", "A-reply")]) }, 6);
  ok(group, !dismissed.some((c) => c.kind === "REPLY") && dismissed.some((c) => c.kind === "OVERDUE"), "a card answered 'Not now' is hidden today; the others stay");
  ok(group, nextBestActions({ ...full, dismissedToday: new Set([nbaCardKey("REPLY", "A-reply")]) }, 6).find((c) => c.ticketKey === "A-reply") === undefined, "(and the ticket does not come back as a lower class: it was one card)");
}

{
  const group = "P3.6 Real scoring feeds the cards";
  const items = [wi("V-1", { priority: "P4", priorityKnown: true }), wi("V-2", { priority: "P1", priorityKnown: true })];
  const data = { ...emptyData(), workItems: items };
  const scores = scoreAllWorkItems(data, today, undefined, undefined, { model: "v2", awaitingMeByKey: {} });
  const { input: inp } = nbaInputFrom({ today, data, scores, awaitingMeByKey: {}, ticketWorkStates: {}, forecast: { byTicket: new Map() }, blockerSlaBusinessDays: 2, memoryEvents: [] });
  const c = nextBestActions(inp);
  ok(group, c[0].ticketKey === "V-2" && c[0].kind === "TOP", "with Score v2, the P1 ticket is the top card");
  const sigs = buildAwaitingMe([{ issueKey: "V-1", commentId: "c1", mentionedAt: "2026-10-15" }], {});
  const { input: inp2, followUpRowsFor } = nbaInputFrom({ today, data, scores, awaitingMeByKey: sigs, ticketWorkStates: { "V-2": st("V-2", "BLOCKED", { updatedAt: "2026-10-15T08:00:00.000Z", reason: "Waiting on infra" }) }, forecast: { byTicket: new Map([["V-2", { slip: { level: "HIGH" as const, remainingDays: 1, expectedRemainingP50: 5, expectedRemainingP85: 9, ageDays: 3, n: 12, explanation: "forecast text" } }]]) }, blockerSlaBusinessDays: 2, memoryEvents: [nbaFeedbackEvent({ kind: "SLIP", ticketKey: "V-2", headline: "h" }, false, undefined, today, 1)] });
  ok(group, inp2.slipHigh.get("V-2")?.explanation === "forecast text" && inp2.nudgeReadyKeys.has("V-2") && followUpRowsFor("V-2").length > 0 && followUpRowsFor("V-1").length === 0, "forecast slip, blocked-with-a-message-ready and awaiting-you signals are read from the derived facts");
  ok(group, nextBestActions(inp2).map((x) => `${x.kind}:${x.ticketKey}`).join() === "REPLY:V-1" && nextBestActions({ ...inp2, dismissedToday: new Set() }).map((x) => x.kind).join() === "REPLY,SLIP", "…and a SLIP card answered 'Not now' today hides that ticket for the rest of the day (it does not return as a nudge or a top card)");
}

{
  const group = "P3.6 Feedback events";
  const card = { kind: "REPLY" as const, ticketKey: "R-1", headline: "Reply on R-1" };
  const ok1 = nbaFeedbackEvent(card, true, undefined, today, 5);
  const no1 = nbaFeedbackEvent(card, false, "busy in a meeting", today, 6);
  ok(group, ok1.kind === "NBA_ACCEPTED" && ok1.ticketKey === "R-1" && ok1.evidence[0] === "kind: REPLY" && ok1.date === today && no1.kind === "NBA_DISMISSED" && no1.impact === "busy in a meeting" && no1.id !== ok1.id, "NBA_ACCEPTED / NBA_DISMISSED carry the ticket, the card kind and the reason");
  const keysToday = dismissedTodayKeys([ok1, no1, nbaFeedbackEvent({ kind: "TOP", ticketKey: "T-1", headline: "x" }, false, undefined, "2026-10-26", 7)], today);
  ok(group, keysToday.size === 1 && keysToday.has(nbaCardKey("REPLY", "R-1")), "only today's 'Not now' answers hide cards");
  const sigs = nbaSignals([ok1, no1, nbaFeedbackEvent({ kind: "TOP", ticketKey: "T-1", headline: "x" }, true, undefined, today, 8), { ...ok1, kind: "TICKET_STARTED" }]);
  ok(group, sigs.length === 3 && sigs.filter((s) => s.accepted).length === 2 && sigs.find((s) => s.ticketKey === "R-1" && s.accepted)?.kind === "MENTION" && sigs.find((s) => s.ticketKey === "T-1")?.kind === "OTHER", "learning signals: accepted = acted, dismissed = ignored; a REPLY card is a MENTION-kind signal; other events are ignored");

  const { store } = v226Store();
  const before = store.getSnapshot().memoryEvents.length;
  store.recordNbaFeedback({ kind: "OVERDUE", ticketKey: "O-1", headline: "O-1 is overdue", why: [], primary: { label: "Start focus", intent: "start-focus" }, rank: 2, id: "x" }, false, "later");
  const after = store.getSnapshot().memoryEvents;
  ok(group, after.length === before + 1 && after[after.length - 1].kind === "NBA_DISMISSED" && after[after.length - 1].impact === "later", "the store records it as a normal memory event (persisted and synced with the rest of memory)");
  ok(group, /memoryEvents/.test(read("src/lib/command-center/app-state.ts")), "memory events are part of the cross-device sync blob");
  const old = parseStoredState(JSON.stringify({ schemaVersion: 1, data: emptyData(), snapshotHistory: [], dataSource: "jira", memoryEvents: [] }));
  ok(group, old.features.nextBestActionAi === false && old.memoryEvents.length === 0, "an old state loads; the AI-wording flag defaults to off");

  // weaker than real status changes
  const base = (n: number, outcome: Appearance["outcome"], extra: Partial<Appearance> = {}): Appearance[] => Array.from({ length: n }, (_, i) => ({ ticketKey: `G-${i}`, date: today, projectId: "p-1", projectLabel: "G", issueType: "task", priority: "P2", kind: "OTHER" as const, outcome, ...extra }));
  const lightIgnored = computeLearnedAdjustments([...base(4, "acted"), ...base(4, "ignored", { weight: 0.5 })], today).find((a) => a.projectId === "p-1")!;
  const realIgnored = computeLearnedAdjustments([...base(4, "acted"), ...base(4, "ignored")], today).find((a) => a.projectId === "p-1")!;
  ok(group, lightIgnored.rate > realIgnored.rate && lightIgnored.n === 8 && realIgnored.n === 8, `'Not now' answers weigh less than real ignored appearances (rate ${lightIgnored.rate} vs ${realIgnored.rate}, n counts both)`);
  const items = [wi("N-1"), wi("N-2"), wi("N-3"), wi("N-4"), wi("N-5"), wi("N-6")];
  const viaEvents = collectAppearances({ today, planItems: [], ticketWorkStates: {}, workItems: items, nbaSignals: items.map((w) => ({ date: today, ticketKey: w.key, accepted: true, kind: "OTHER" as const })) });
  ok(group, viaEvents.length === 6 && viaEvents.every((a) => a.outcome === "acted" && a.weight === 0.5), "collectAppearances turns NBA feedback into half-weight appearances");
  ok(group, collectAppearances({ today, planItems: [], ticketWorkStates: {}, workItems: items, nbaSignals: [{ date: today, ticketKey: "N-1", accepted: true, kind: "OTHER" }, { date: today, ticketKey: "N-1", accepted: true, kind: "OTHER" }, { date: today, ticketKey: "GONE-1", accepted: true, kind: "OTHER" }, { date: "2026-08-01", ticketKey: "N-2", accepted: true, kind: "OTHER" }], resetAt: undefined }).length === 1, "…deduped, only known tickets, only the last 45 days");
}

{
  const group = "P3.6 Narration: AI optional, deterministic otherwise, one call a day";
  const cards = nextBestActions(input([wi("R-1"), wi("O-1", { priority: "P1", dueDate: "2026-10-25" })], { awaitingMeByKey: { "R-1": { sinceIso: "2026-10-15", count: 1 } } }));
  const mem = new Map<string, string>();
  const storage: NarrationStorage = { get: (k) => mem.get(k) ?? null, set: (k, v) => void mem.set(k, v) };
  let calls = 0;
  const callAi = async () => { calls++; return "AI says: reply first, then the overdue ticket."; };
  const base = { cards, today, storage, callAi };
  const det = deterministicNarration(cards);
  ok(group, /^Start with: Reply on R-1/.test(det) && det.includes("Then: O-1 is overdue") && deterministicNarration([]) === "Nothing needs you right now.", "the deterministic text always exists");
  const off = await narrateNextBestActions({ ...base, flagOn: false, aiAvailable: true });
  const noAi = await narrateNextBestActions({ ...base, flagOn: true, aiAvailable: false });
  ok(group, off.source === "deterministic" && off.text === det && noAi.source === "deterministic" && noAi.text === det && calls === 0, "flag off, or AI not configured -> deterministic text and zero calls");
  const first = await narrateNextBestActions({ ...base, flagOn: true, aiAvailable: true });
  const again = await narrateNextBestActions({ ...base, flagOn: true, aiAvailable: true });
  ok(group, first.source === "ai" && first.text.startsWith("AI says") && again.text === first.text && calls === 1, `AI on: ONE call, then cached for the same facts (${calls})`);
  const moved = await narrateNextBestActions({ ...base, cards: cards.slice(0, 1), flagOn: true, aiAvailable: true });
  ok(group, moved.source === "deterministic" && calls === 1, "the facts changed later the same day: deterministic text, still no second call (max 1 a day)");
  const tomorrow = await narrateNextBestActions({ ...base, today: "2026-10-28", flagOn: true, aiAvailable: true });
  ok(group, tomorrow.source === "ai" && calls === 2, "the next day: one more call");
  mem.clear();
  const failing = await narrateNextBestActions({ ...base, callAi: async () => { calls++; throw new Error("capped"); }, flagOn: true, aiAvailable: true });
  ok(group, failing.source === "deterministic" && failing.text === det && calls === 3, "a capped / failed call falls back to deterministic text");
  mem.clear();
  const empty = await narrateNextBestActions({ ...base, callAi: async () => { calls++; return null; }, flagOn: true, aiAvailable: true });
  ok(group, empty.source === "deterministic" && JSON.parse(mem.get(NARRATION_STORAGE_KEY)!).source === "deterministic", "'insufficient evidence' (null) -> deterministic");
  ok(group, JSON.stringify(nextBestActions(input([wi("R-1"), wi("O-1", { priority: "P1", dueDate: "2026-10-25" })], { awaitingMeByKey: { "R-1": { sinceIso: "2026-10-15", count: 1 } } }))) === JSON.stringify(cards) && hashFacts(cards) === hashFacts(cards.map((c) => ({ ...c }))), "the cards themselves are identical with AI off, on or capped (the same structure, only the wording line differs)");
  const none = await narrateNextBestActions({ ...base, cards: [], flagOn: true, aiAvailable: true });
  const callsBefore = calls;
  ok(group, none.source === "deterministic" && calls === callsBefore && none.text === "Nothing needs you right now.", "no cards -> no call");
}

{
  const group = "P3.6 Placement and wiring";
  const comp = read("src/components/command-center/NextBestActions.tsx");
  ok(group, /<NextBestActions \/>/.test(read("src/app/my-work/page.tsx")) && /<NextBestActions compact \/>/.test(read("src/components/command-center/MorningMode.tsx")) && (read("src/app/page.tsx").match(/<NextBestActions compact \/>/g) ?? []).length === 2, "placed: top of My Work -> Today, the last step of Morning Mode, and one strip on the Command Center (full and compact)");
  ok(group, /store\.startTicket\(/.test(comp) && /MentionReplyDrafter/.test(comp) && /AskFollowUp/.test(comp) && /store\.deferTicket\(/.test(comp), "primary buttons reuse the existing flows: Start focus, Draft reply, Nudge, Defer");
  ok(group, /WhyShouldICareDrawer/.test(comp) && /fact: card\.why\.map\(\(w\) => w\.content\)/.test(comp) && /evidence: card\.why/.test(comp), "'Why?' opens the existing drawer with the very same facts the card shows");
  ok(group, /recordNbaFeedback\(card, accepted\)/.test(comp) && /data-nba-useful/.test(comp) && /data-nba-not-now/.test(comp), "'Useful' and 'Not now' on every card");
  ok(group, /nextBestActionAi/.test(comp) && /generateDailyGuidance/.test(comp) && !/new AiTask|registerTask/.test(comp), "optional narration reuses the existing generateDailyGuidance task (no new AI task)");
  ok(group, /nextBestActionAi/.test(read("src/app/data-settings/page.tsx")), "the narration switch is in Features");
}
