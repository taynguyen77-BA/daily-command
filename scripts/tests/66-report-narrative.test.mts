// V2.50 R1 — Report Narrative: pure builder, sentence counting, facts builder, server task with a fake model, browser verification, persistence.
import fs from "node:fs";
import { ok } from "./harness.mts";
import { buildNarrativeFacts, countSentences, deterministicNarrative, narrativeFactsHash, narrativeSourceText, narrativeViolations, asReportNarratives, asNarrativePrefs, putNarrative, MAX_STORED_NARRATIVES, NARRATIVE_LIMITS, type NarrativeFacts, type NarrativeLanguage, type NarrativeStyle } from "../../src/lib/command-center/report-narrative";
import type { DailyReportView, ReportTicket, WeeklyReportView } from "../../src/lib/command-center/reports";
import { improveNarrative } from "../../src/lib/command-center/ai/report-narrative-flow";
import { handleAiRequest, ResponseCache, type AiServerDeps, type ModelCallParams, type ModelCallResult } from "../../src/lib/command-center/ai/server-runner";
import { MemoryUsageLedger } from "../../src/lib/command-center/ai/usage-ledger";
import { parseTaskInput, buildTaskPrompt } from "../../src/lib/command-center/ai/task-registry";
import { AI_FEATURES, aiReadiness, aiReadinessMatrix, presetDiff, type AiReadinessContext } from "../../src/lib/command-center/ai/readiness";
import { DEFAULT_FEATURE_TOGGLES, emptyData } from "../../src/lib/command-center/types";
import { parseStoredState } from "../../src/lib/command-center/store";
import { MockAIProvider } from "../../src/lib/command-center/ai/provider";
import type { AIProvider } from "../../src/lib/command-center/ai/provider";
import type { AiOutcome } from "../../src/lib/command-center/ai/outcome";

const TODAY = "2026-11-09";
const t = (key: string, title: string, project = "Alpha", extra: Partial<ReportTicket> = {}): ReportTicket => ({ key, title, project, ...extra });
const daily = (o: Partial<DailyReportView> = {}): DailyReportView => ({
  date: TODAY, doneMine: [], inProgress: [], blocked: [], skipped: [], newToday: [], mentionsAwaitingReply: [], teamDone: [], removedFromScope: [], decisions: [], standupAvailable: true, identityConfigured: true, ...o,
});
const many = (n: number, prefix = "ABC", project = "Alpha"): ReportTicket[] => Array.from({ length: n }, (_, i) => t(`${prefix}-${100 + i}`, `Task number ${i}`, project));

const basic = daily({
  doneMine: [t("ABC-101", "Reminder email copy"), t("ABC-104", "Footer links"), t("DEF-212", "Contrast fix on login", "Beta"), t("DEF-215", "Icon sizes", "Beta")],
  inProgress: [t("ABC-110", "Expiry date API contract"), t("ABC-111", "Retry policy")],
  blocked: [t("ABC-130", "Newer blocker", "Alpha", { ageBusinessDays: 1 }), t("ABC-120", "Template engine", "Alpha", { ageBusinessDays: 3, waitsOn: ["Dev Team: API spec"] })],
  mentionsAwaitingReply: [t("ABC-140", "Question", "Alpha", { notes: ['Linh Tran: "can you confirm?"'] }), t("ABC-141", "Other")],
  newToday: [t("ABC-150", "New one")],
  decisions: ["Use the v2 API"],
  overdueBlockers: [t("ABC-120", "Template engine", "Alpha", { ageBusinessDays: 3 })],
  slaBusinessDays: 2,
});

const weekly = (o: Partial<WeeklyReportView> = {}): WeeklyReportView => ({
  weekStart: "2026-11-09", weekEnd: "2026-11-13", mode: "workweek", reportedDays: ["2026-11-09", "2026-11-10", "2026-11-11"], missingDays: ["2026-11-12"],
  totals: { doneMine: 3, teamDone: 5, blocked: 1, skipped: 2, newReceived: 4, decisions: 1 }, groupBy: "project",
  doneGroups: [{ name: "Alpha", tickets: [t("ABC-1", "One"), t("ABC-2", "Two")] }, { name: "Beta", tickets: [t("DEF-1", "Three", "Beta")] }],
  teamDone: [t("ZZZ-9", "Team thing", "Zed", { assignee: "Someone Else" })], carriedOver: [t("ABC-9", "Old", "Alpha", { since: "2026-10-01T00:00:00.000Z" })],
  blockers: [t("ABC-7", "Stuck", "Alpha", { ageBusinessDays: 5, notes: ["waiting for sign-off"] })], skipped: [t("ABC-8", "Skipped", "Alpha", { notes: ["Not my priority"] })], newReceived: many(4, "NEW"),
  decisions: ["Ship it"], nextWeek: [t("ABC-50", "Next A"), t("ABC-51", "Next B")], ...o,
});

const fixtures: { name: string; view: DailyReportView | WeeklyReportView; kind: "daily" | "weekly" }[] = [
  { name: "basic day", view: basic, kind: "daily" },
  { name: "empty day", view: daily(), kind: "daily" },
  { name: "only done", view: daily({ doneMine: many(3) }), kind: "daily" },
  { name: "only blocked", view: daily({ blocked: [t("ABC-1", "Stuck", "Alpha", { ageBusinessDays: 4 })] }), kind: "daily" },
  { name: "60 done tickets", view: daily({ doneMine: [...many(35, "ABC"), ...many(25, "DEF", "Beta")], inProgress: many(30, "PRG") }), kind: "daily" },
  { name: "Vietnamese titles", view: daily({ doneMine: [t("VN-1", "Sửa lỗi đăng nhập. Đã kiểm tra lại", "Dự án A"), t("VN-2", "Cập nhật tài liệu API?", "Dự án A")], blocked: [t("VN-3", "Chờ phê duyệt", "Dự án A", { ageBusinessDays: 2, notes: ["Đang chờ khách hàng xác nhận"] })] }), kind: "daily" },
  { name: "identity not configured", view: daily({ identityConfigured: false, doneMine: [], inProgress: many(1) }), kind: "daily" },
  { name: "title with sentence punctuation", view: daily({ doneMine: [t("ABC-1", "Fix login. Again? Yes! e.g. SSO", "Alpha")] }), kind: "daily" },
  { name: "unknown block age", view: daily({ blocked: [t("ABC-2", "No age")] }), kind: "daily" },
  { name: "weekly with missing days", view: weekly(), kind: "weekly" },
  { name: "weekly empty", view: weekly({ totals: { doneMine: 0, teamDone: 0, blocked: 0, skipped: 0, newReceived: 0, decisions: 0 }, doneGroups: [], blockers: [], carriedOver: [], nextWeek: [], newReceived: [], decisions: [], reportedDays: [], missingDays: [] }), kind: "weekly" },
  { name: "weekly 60 done", view: weekly({ totals: { doneMine: 60, teamDone: 0, blocked: 0, skipped: 0, newReceived: 0, decisions: 0 }, doneGroups: [{ name: "Alpha", tickets: many(60) }] }), kind: "weekly" },
];
const STYLES: NarrativeStyle[] = ["standup", "worklog"];
const LANGS: NarrativeLanguage[] = ["en", "vi"];

{
  const group = "V2.50 R1 countSentences";
  ok(group, countSentences("One sentence here.") === 1, "one sentence");
  ok(group, countSentences("First one. Second one! Third one? Fourth.") === 4, "four sentences by . ! ?");
  ok(group, countSentences("Done 3.5 tickets in ABC-12. Then 2026-11-07 passed.") === 2, "decimals, ticket keys and ISO dates do not split");
  ok(group, countSentences("Use e.g. a list, i.e. a short one, vs. a long one. Then stop.") === 2 && countSentences("Lists, files, etc. Then stop.") === 1, "e.g. / i.e. / vs. / etc. do not split");
  ok(group, countSentences("Hôm nay tôi xong việc. Đã kiểm tra lại. 2 mention đang chờ.") === 3, "Vietnamese uppercase (incl. Đ) and a digit start a sentence");
  ok(group, countSentences("No terminator at the end") === 1 && countSentences("A. B. C") === 3, "a trailing fragment counts as a sentence");
  ok(group, countSentences("Wait… Then go.") === 2 && countSentences("") === 0, "an ellipsis splits; empty is 0");
  ok(group, countSentences('He said. "Quoted start" Done.') === 2 && countSentences("He said. (Bracketed start) Done.") === 2, "a quote or bracket after the terminator starts a sentence");
}

{
  const group = "V2.50 R1 deterministic narrative";
  let allOk = true;
  const bad: string[] = [];
  for (const fx of fixtures) {
    for (const style of STYLES) {
      for (const language of LANGS) {
        const { facts } = buildNarrativeFacts({ kind: fx.kind, view: fx.view, style, language, today: TODAY });
        const text = deterministicNarrative(facts);
        const n = countSentences(text);
        const v = narrativeViolations(text, facts);
        if (n < 3 || n > 5 || v.length > 0 || text.length > 1000) {
          allOk = false;
          bad.push(`${fx.name}/${style}/${language}: ${n} sentences ${v.join("; ")}`);
        }
      }
    }
  }
  ok(group, allOk, `every calculated text (${fixtures.length} reports x 2 styles x 2 languages) has 3-5 sentences, only keys/numbers from the facts, the oldest blocker named${bad.length ? ` — ${bad.slice(0, 3).join(" | ")}` : ""}`);

  const std = deterministicNarrative(buildNarrativeFacts({ kind: "daily", view: basic, style: "standup", language: "en", today: TODAY }).facts);
  ok(group, /^Today I completed 4 tickets across 2 projects, including ABC-101 \(Reminder email copy\)/.test(std), `standup EN starts with the day and names done tickets (${std.slice(0, 100)}…)`);
  ok(group, /ABC-120 \(Template engine\) has been blocked for 3 business days, waiting on Dev Team: API spec/.test(std) && std.indexOf("ABC-120") < (std.indexOf("ABC-130") === -1 ? 1e9 : std.indexOf("ABC-130")), "the OLDEST blocked ticket is named with its age and who it waits on");
  ok(group, /2 mentions are awaiting my reply, 1 blocker over the 2-business-day SLA and 1 decision recorded/.test(std), "standup closes with what needs attention");
  const wl = deterministicNarrative(buildNarrativeFacts({ kind: "daily", view: basic, style: "worklog", language: "en", today: TODAY }).facts);
  ok(group, wl !== std && /^Today I completed 4 tickets across 2 projects: ABC-101/.test(wl) && /I also progressed 2 tickets \(ABC-110 \(Retry|I also progressed 2 tickets/.test(wl) && /remained blocked/.test(wl) && !/awaiting my reply/.test(wl), "work log style differs: past tense, no requests");
  const vi = deterministicNarrative(buildNarrativeFacts({ kind: "daily", view: basic, style: "standup", language: "vi", today: TODAY }).facts);
  ok(group, /^Hôm nay tôi đã hoàn thành 4 ticket/.test(vi) && /đang bị chặn/.test(vi) && vi !== std, "Vietnamese text differs and is Vietnamese");
  const past = deterministicNarrative(buildNarrativeFacts({ kind: "daily", view: daily({ date: "2026-11-07", doneMine: many(2) }), style: "worklog", language: "en", today: TODAY }).facts);
  ok(group, /^On 2026-11-07 I completed 2 tickets/.test(past), "a past day says 'On <date>', never 'Today'");
  const wk = deterministicNarrative(buildNarrativeFacts({ kind: "weekly", view: weekly(), style: "standup", language: "en", today: TODAY }).facts);
  ok(group, /^This week \(2026-11-09 to 2026-11-13\) I completed 3 tickets across 2 projects/.test(wk) && /1 ticket is carried over/.test(wk) && /next week has 2 open assigned/.test(wk) && /1 working day has no report/.test(wk), "weekly: done by project count, carried over, next week and missing days");
  const empty = deterministicNarrative(buildNarrativeFacts({ kind: "daily", view: daily(), style: "standup", language: "en", today: TODAY }).facts);
  ok(group, /No completed tickets are recorded for today\./.test(empty) && /Nothing is recorded as in progress\./.test(empty) && /No blockers are recorded\./.test(empty), "an empty day says so in short clauses");
  const sixty = buildNarrativeFacts({ kind: "daily", view: daily({ doneMine: [...many(35, "ABC"), ...many(25, "DEF", "Beta")] }), style: "standup", language: "en", today: TODAY });
  ok(group, /and 20 more/.test(deterministicNarrative(sixty.facts)) && (deterministicNarrative(sixty.facts).match(/\b[A-Z]+-\d+/g) ?? []).length <= 6, "60 done: 'and 20 more' comes from doneNotListed and at most 6 keys are named");
}

{
  const group = "V2.50 R1 facts builder";
  const big = buildNarrativeFacts({ kind: "daily", view: daily({ doneMine: many(60), inProgress: many(30, "PRG"), blocked: many(20, "BLK").map((x, i) => ({ ...x, ageBusinessDays: i })) }), style: "standup", language: "en", today: TODAY }).facts;
  ok(group, big.done.length === NARRATIVE_LIMITS.done && big.inProgress.length === NARRATIVE_LIMITS.inProgress && big.blocked.length === NARRATIVE_LIMITS.blocked, "lists are capped at 40 / 25 / 15");
  ok(group, big.counts.done === 60 && big.counts.doneNotListed === 20 && big.counts.inProgress === 30 && big.counts.blocked === 20, "counts are the real totals; doneNotListed = 60 - 40");
  ok(group, big.blocked[0].ageBusinessDays === 19, "blocked is oldest first");

  const view = daily({
    doneMine: [t("ABC-1", "Alpha ticket"), t("SEC-1", "Secret client work", "Secret")],
    blocked: [t("SEC-2", "Hidden blocker", "Secret", { ageBusinessDays: 2, waitsOn: ["Jane Doe: contract"], notes: ["#internal do not share", "visible reason"] }), t("ABC-3", "Open blocker", "Alpha", { ageBusinessDays: 1, notes: ["[internal] team gossip", "needs API"] })],
    skipped: [t("ABC-4", "Skipped thing", "Alpha", { notes: ["Not my priority"] })],
    mentionsAwaitingReply: [t("ABC-5", "Mention", "Alpha", { notes: ['Zed Person: "please look at the hidden thing"'] })],
    teamDone: [t("ABC-6", "Team done", "Alpha", { assignee: "Teammate Name" })],
    inProgress: [t("ABC-7", "Mine", "Alpha", { assignee: "Owner Name" })],
  });
  const r = buildNarrativeFacts({ kind: "daily", view, style: "standup", language: "en", today: TODAY, allowedProjects: ["abc"] });
  const json = JSON.stringify(r.facts);
  ok(group, r.keyOnly === 2 && !json.includes("Secret client work") && !json.includes("Hidden blocker") && !json.includes("Jane Doe") && !json.includes("visible reason"), "non-allow-listed projects: key + project name only; titles, reasons and waiting-for dropped (2 tickets)");
  ok(group, r.facts.done.find((d) => d.key === "SEC-1")?.project === "Secret" && r.facts.done.find((d) => d.key === "ABC-1")?.title === "Alpha ticket", "allow-listed titles stay; the key-only ticket keeps its project name");
  ok(group, !json.includes("team gossip") && !json.includes("do not share") && json.includes("needs API"), "notes marked internal never leave; ordinary reasons do (allow-listed projects)");
  ok(group, !json.includes("Not my priority") && !json.includes("Skipped thing") && !json.includes("Team done") && !json.includes("Teammate Name") && !json.includes("Owner Name") && !json.includes("Zed Person") && !json.includes("hidden thing"), "no skipped items or reasons, team work, assignee names or mention text");
  const local = buildNarrativeFacts({ kind: "daily", view, style: "standup", language: "en", today: TODAY });
  ok(group, local.facts.done.some((d) => d.title === "Secret client work") && local.keyOnly === 0, "the local calculated text may use every title");
  ok(group, parseTaskInput("summarizeReport", r.facts).ok, "the facts are a valid summarizeReport input");
  const h1 = narrativeFactsHash(local.facts);
  const h2 = narrativeFactsHash(buildNarrativeFacts({ kind: "daily", view: { ...view, doneMine: [...view.doneMine, t("ABC-9", "New")] }, style: "standup", language: "en", today: TODAY }).facts);
  ok(group, h1 === narrativeFactsHash(local.facts) && h1 !== h2, "the facts hash changes when the report changes (summary stale after a sync)");
  ok(group, buildNarrativeFacts({ kind: "daily", view: daily({ date: TODAY }), style: "standup", language: "en", today: TODAY }).facts.periodPhrase === "Today" && buildNarrativeFacts({ kind: "daily", view: daily({ date: "2026-11-08" }), style: "standup", language: "en", today: TODAY }).facts.periodPhrase === "On 2026-11-08", "'Today' only for the current local day");
}

{
  const group = "V2.50 R1 verification";
  const { facts } = buildNarrativeFacts({ kind: "daily", view: basic, style: "standup", language: "en", today: TODAY });
  const good = "Today I completed 4 tickets, including ABC-101 and DEF-212. I am continuing with 2 tickets in progress. ABC-120 has been blocked for 3 business days. 2 mentions are awaiting my reply.";
  ok(group, narrativeViolations(good, facts).length === 0, "a good AI text passes");
  ok(group, narrativeViolations("One. Two. Three. Four. Five. Six sentences ABC-120 now.", facts).some((x) => /3 to 5 sentences/.test(x)), "6 sentences fails");
  ok(group, narrativeViolations("Today I did work. It went well. ABC-120 stays blocked for 3 days. ZZZ-999 is done.", facts).some((x) => /ZZZ-999/.test(x)), "an invented ticket key fails");
  ok(group, narrativeViolations("Today I completed 17 tickets. ABC-120 is blocked for 3 days. More follows. Fine.", facts).some((x) => /number 17/.test(x)), "an invented number fails");
  ok(group, narrativeViolations("Today I completed 4 tickets. I continue with 2. Nothing else. The rest is fine.", facts).some((x) => /oldest blocked ticket ABC-120/.test(x)), "the oldest blocked key must be named");
  ok(group, narrativeViolations("Today I completed 4 tickets. ABC-120 was completed by me. Nothing else. Fine.", facts).some((x) => /completion verb/.test(x)), "a blocked ticket with a completion verb fails");
  ok(group, narrativeViolations("Done: ABC-101, ABC-104, DEF-212, DEF-215, ABC-110, ABC-111, ABC-120. Another. Third. Fourth.", facts).some((x) => /more than 6/.test(x)), "more than 6 keys fails");
}

{
  const group = "V2.50 R1 server task";
  const NOW = new Date("2026-11-09T10:00:00.000Z");
  const usage = { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const model = (answers: string[]) => {
    const calls: ModelCallParams[] = [];
    return { calls, callModel: async (p: ModelCallParams): Promise<ModelCallResult> => { calls.push(JSON.parse(JSON.stringify(p))); return { stopReason: "end_turn", text: answers[Math.min(calls.length - 1, answers.length - 1)], usage }; } };
  };
  const deps = (m: ReturnType<typeof model>): AiServerDeps & { ledger: MemoryUsageLedger } => ({ env: {}, callModel: m.callModel, ledger: new MemoryUsageLedger(), now: () => NOW, cache: new ResponseCache() });
  const { facts } = buildNarrativeFacts({ kind: "daily", view: basic, style: "standup", language: "en", today: TODAY });
  const good = "Today I completed 4 tickets, including ABC-101 and DEF-212. I am continuing with 2 tickets in progress. ABC-120 has been blocked for 3 business days. 2 mentions are awaiting my reply.";
  const six = "Today I completed 4 tickets. I am continuing with 2 tickets in progress. ABC-120 has been blocked for 3 business days. 2 mentions are awaiting my reply. Another sentence. Yet another one here.";
  const ghost = "Today I completed 4 tickets, including ZZZ-999. I am continuing with 2. ABC-120 has been blocked for 3 business days. 2 mentions are awaiting my reply.";

  const m1 = model([JSON.stringify({ text: good })]);
  const r1 = await handleAiRequest({ task: "summarizeReport", input: facts }, deps(m1));
  ok(group, r1.status === 200 && (r1.body.data as { text: string }).text === good && m1.calls.length === 1, "a good answer passes the server checks (one call)");
  const prompt = m1.calls[0].messages[0].content;
  ok(group, /EXACTLY 3 to 5 sentences/.test(prompt) && /OUTPUT LIMITS/.test(prompt) && prompt.includes("ABC-120") && /Refer to the period as: "Today"/.test(prompt), "the server-built prompt carries the rules, the period phrase, the facts and the output limits");
  ok(group, m1.calls[0].maxTokens >= 1024, `the narrative gets at least 1024 output tokens (is ${m1.calls[0].maxTokens})`);

  const m2 = model([JSON.stringify({ text: six }), JSON.stringify({ text: six })]);
  const r2 = await handleAiRequest({ task: "summarizeReport", input: facts }, deps(m2));
  ok(group, r2.status === 422 && m2.calls.length === 2, "6 sentences twice -> one repair, still wrong -> 422 (the browser shows the calculated text)");
  const m3 = model([JSON.stringify({ text: ghost }), JSON.stringify({ text: good })]);
  const r3 = await handleAiRequest({ task: "summarizeReport", input: facts }, deps(m3));
  ok(group, r3.status === 200 && m3.calls.length === 2 && /ZZZ-999/.test(JSON.stringify(m3.calls[1].messages)), "a hallucinated key triggers the repair with the violation listed, then passes");
  const m4 = model([JSON.stringify({ text: ghost })]);
  const r4 = await handleAiRequest({ task: "summarizeReport", input: facts }, deps(m4));
  ok(group, r4.status === 422, "a hallucinated key that stays -> 422");
  const bad = await handleAiRequest({ task: "summarizeReport", input: { ...facts, done: Array.from({ length: 41 }, () => ({ key: "ABC-1" })) } }, deps(model([JSON.stringify({ text: good })])));
  ok(group, bad.status === 400, "more than 40 done items is rejected as a bad input");
  ok(group, buildTaskPrompt("summarizeReport", facts).includes("STYLE to use now: standup"), "the style is in the prompt");
}

{
  const group = "V2.50 R1 browser flow";
  const { facts } = buildNarrativeFacts({ kind: "daily", view: daily({ doneMine: [t("ABC-1", "Mail jane@acme.com about Acme Bank"), t("ABC-2", "Second"), t("ABC-3", "Third")], inProgress: [t("ABC-4", "Four")], blocked: [t("ABC-5", "Five", "Alpha", { ageBusinessDays: 2 })] }), style: "standup", language: "en", today: TODAY, allowedProjects: ["ABC"] });
  const seen: string[] = [];
  const provider = (answer: AiOutcome<{ text: string }> | ((input: unknown) => AiOutcome<{ text: string }>)): Pick<AIProvider, "runTask"> => ({
    runTask: (async (_task: string, input: unknown) => {
      seen.push(JSON.stringify(input));
      return typeof answer === "function" ? answer(input) : answer;
    }) as AIProvider["runTask"],
  });
  const goodText = "Today I completed 3 tickets, including ABC-1 and ABC-2. I'm continuing with 1 in progress. ABC-5 has been blocked for 2 business days. Nothing else needs attention.";
  const okR = await improveNarrative({ facts, customTerms: [{ term: "Acme Bank", alias: "Client A" }], provider: provider({ ok: true, data: { text: goodText } }) });
  ok(group, okR.ok && okR.text === goodText, "a good outcome becomes the text");
  ok(group, !/jane@acme\.com|Acme Bank/.test(seen[0]) && /Client A/.test(seen[0]) && /\[EMAIL_1\]/.test(seen[0]), "emails and custom terms are redacted before sending");
  const restored = await improveNarrative({ facts, customTerms: [{ term: "Acme Bank", alias: "Client A" }], provider: provider({ ok: true, data: { text: "Today I completed 3 tickets including ABC-1 for Client A. I'm continuing with 1 in progress. ABC-5 has been blocked for 2 business days. Nothing else needs attention." } }) });
  ok(group, restored.ok && /Acme Bank/.test(restored.text) && !/Client A/.test(restored.text), "aliases in the answer are restored for display");
  for (const reason of ["budget", "truncated", "network", "unavailable"] as const) {
    const f = await improveNarrative({ facts, customTerms: [], provider: provider({ ok: false, reason }) });
    ok(group, !f.ok && f.reason === reason, `a failed outcome (${reason}) is returned with its reason`);
  }
  const six = await improveNarrative({ facts, customTerms: [], provider: provider({ ok: true, data: { text: "One thing. Two things. Three things. Four things. Five things. Six things ABC-5." } }) });
  ok(group, !six.ok && six.reason === "grounding" && (six.violations?.length ?? 0) > 0, "a browser-side violation (6 sentences) falls back with a reason");
  const noRun = await improveNarrative({ facts, customTerms: [], provider: {} });
  ok(group, !noRun.ok && noRun.reason === "unavailable", "no runTask -> unavailable");
  const mock = await new MockAIProvider().summarizeReport(facts);
  ok(group, mock.text === deterministicNarrative(facts), "the mock provider returns the calculated narrative");
  ok(group, !/assignee|owner|skip|mention/i.test(seen[0].replace(/mentions?AwaitingReply/g, "")), "the serialized request has no assignee, skip or mention text");
}

{
  const group = "V2.50 R1 persistence, flag and readiness";
  const old = parseStoredState(JSON.stringify({ schemaVersion: 1, data: emptyData(), snapshotHistory: [], dataSource: "jira", memoryEvents: [] }));
  ok(group, Object.keys(old.reportNarratives).length === 0 && old.reportNarrativePrefs.style === "standup" && old.reportNarrativePrefs.language === "en" && old.features.reportNarrativeAi === false, "an old blob without reportNarratives / reportNarrativePrefs loads with the defaults (standup + EN, flag off)");
  const roundTrip = parseStoredState(JSON.stringify({ schemaVersion: 1, data: emptyData(), snapshotHistory: [], dataSource: "jira", memoryEvents: [], reportNarratives: { "daily:2026-11-09:standup:en": { key: "daily:2026-11-09:standup:en", text: "Hi.", source: "ai", factsHash: "abc", createdAt: "2026-11-09T10:00:00.000Z" }, junk: 3 }, reportNarrativePrefs: { style: "worklog", language: "vi" } }));
  ok(group, Object.keys(roundTrip.reportNarratives).length === 1 && roundTrip.reportNarrativePrefs.style === "worklog" && roundTrip.reportNarrativePrefs.language === "vi", "stored narratives and prefs load; junk entries are dropped");
  ok(group, Object.keys(asReportNarratives([1, 2])).length === 0 && asNarrativePrefs("x").style === "standup", "defensive parsing");
  let all = {};
  for (let i = 0; i < MAX_STORED_NARRATIVES + 10; i++) all = putNarrative(all, { key: `daily:d${i}:standup:en`, text: "x", source: "ai", factsHash: "h", createdAt: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z` });
  ok(group, Object.keys(all).length === MAX_STORED_NARRATIVES && !("daily:d0:standup:en" in all) && "daily:d99:standup:en" in all, "at most 90 narratives; the oldest are evicted");

  ok(group, DEFAULT_FEATURE_TOGGLES.reportNarrativeAi === false, "reportNarrativeAi defaults to off");
  ok(group, AI_FEATURES.length === 13 && AI_FEATURES.some((f) => f.id === "reportNarrativeAi"), "the readiness matrix lists 13 features incl. reportNarrativeAi");
  const features = { ...DEFAULT_FEATURE_TOGGLES };
  const ctx = (over: Partial<AiReadinessContext> = {}): AiReadinessContext => ({ features, ai: { available: true }, usage: { remainingToday: 1000 }, allowedProjectKeys: ["ABC"], projectKeys: ["ABC"], ...over });
  ok(group, aiReadiness("reportNarrativeAi", ctx()).state === "OFF", "OFF when the switch is off");
  const on = { ...features, reportNarrativeAi: true };
  ok(group, aiReadiness("reportNarrativeAi", ctx({ features: on, ai: { available: false } })).state === "NEEDS_KEY", "NEEDS_KEY without a key");
  ok(group, aiReadiness("reportNarrativeAi", ctx({ features: on, allowedProjectKeys: [] })).state === "NEEDS_ALLOWLIST", "NEEDS_ALLOWLIST with an empty allow-list");
  ok(group, aiReadiness("reportNarrativeAi", ctx({ features: on, usage: { remainingToday: 0 } })).state === "CAP_REACHED", "CAP_REACHED when the daily cap is used");
  ok(group, aiReadiness("reportNarrativeAi", ctx({ features: on })).state === "READY", "READY otherwise");
  ok(group, aiReadinessMatrix(ctx({ features: on })).length === 13, "the matrix has a row for it");
  ok(group, presetDiff(features, "recommended").some((c) => c.feature === "reportNarrativeAi" && c.to), "the Recommended preset switches it on (the diff dialog shows it)");
  const comp = fs.readFileSync("src/components/command-center/ReportNarrative.tsx", "utf8");
  ok(group, /useAiReadiness\("reportNarrativeAi"\)/.test(comp) && /title=\{readiness\.title\}/.test(comp), "the button tooltip is the readiness matrix's next step");
  ok(group, /reportNarrativeAi/.test(fs.readFileSync("src/app/data-settings/page.tsx", "utf8")), "the switch is in Data & Settings -> Features");
  ok(group, !/no data|noData/.test("") && /noData/.test(comp), "the narrative is hidden for a day with no data");
  const src = narrativeSourceText(buildNarrativeFacts({ kind: "daily", view: basic, style: "standup", language: "en", today: TODAY }).facts);
  ok(group, src.includes("ABC-120") && src.includes("done=4"), "the source text carries the keys and counts");
}
