// D3 — AI self-test orchestrator + route handler, offline with a fake model: every verdict, the ceiling, no dedupe, ledger separation.
import fs from "node:fs";
import { ok } from "./harness.mts";
import { runSelfTest, gradeAnswer, estimateCostUsd, formatSelfTestTable, vietnameseRatio, PRICE_PER_MTOK } from "../../src/lib/command-center/ai/selftest";
import { handleSelfTestRequest } from "../../src/lib/command-center/ai/selftest-handler";
import { RateLimiter } from "../../src/lib/command-center/ai/provider-handlers";
import { SELFTEST_FIXTURES, quickFixtures, type SelfTestFixture } from "../../src/lib/command-center/ai/selftest-fixtures";
import { MemoryUsageLedger, summarizeUsage, lastSevenDays } from "../../src/lib/command-center/ai/usage-ledger";
import type { ModelCallParams, ModelCallResult } from "../../src/lib/command-center/ai/server-runner";

const NOW = new Date("2026-11-05T09:00:00.000Z");
const fx = (id: string) => SELFTEST_FIXTURES.find((f) => f.id === id)!;
const brief = fx("ticket-brief");
const replyVi = fx("mention-reply-vi");
const goodBrief = { whatIsAsked: "Send a reminder email before a subscription expires.", currentState: "In Progress; waiting on SELF-9.", waitingOn: [{ who: "Dev Team", what: "API date" }], openQuestions: ["Should the billing contact also receive the email?"], suggestedNextStep: "Confirm the wording with Linh Tran." };
const goodVi = { reply: "Em xác nhận nội dung email trước thứ Sáu. Em đang chờ Dev Team về SELF-9.", unansweredPoints: [] };
const model = (answers: (string | { text?: string; stopReason?: string })[]) => {
  let n = 0;
  return async (_p: ModelCallParams): Promise<ModelCallResult> => {
    const a = answers[Math.min(n++, answers.length - 1)];
    const o = typeof a === "string" ? { text: a } : a;
    return { stopReason: o.stopReason ?? "end_turn", text: o.text, usage: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  };
};
const run = (fixtures: SelfTestFixture[], answers: Parameters<typeof model>[0], extra: { maxTokens?: number; ledger?: MemoryUsageLedger } = {}) =>
  runSelfTest({ mode: "quick", fixtures, maxTokens: extra.maxTokens, deps: { env: {}, callModel: model(answers), ledger: extra.ledger ?? new MemoryUsageLedger(), now: () => NOW } });

{
  const group = "D3 verdicts";
  const perfect = (await run([brief], [JSON.stringify(goodBrief)])).rows[0];
  ok(group, perfect.outcome === "PASS" && perfect.rubric.every((r) => r.pass) && perfect.schemaOk && perfect.groundingOk && !perfect.retried, "perfect output -> PASS");
  ok(group, perfect.inputTokens === 500 && perfect.outputTokens === 200 && perfect.estCostUsd !== null && perfect.tier === "default", "row carries tokens, tier and an estimated cost");
  const long = (await run([brief], [JSON.stringify({ ...goodBrief, whatIsAsked: "x".repeat(1200) })])).rows[0];
  ok(group, long.outcome === "FAIL" && long.errorKind === "invalid-output" && long.schemaOk === false && long.retried, "over-long output -> repaired once, still invalid -> FAIL with errorKind");
  const ungrounded = (await run([brief], [JSON.stringify({ ...goodBrief, suggestedNextStep: "Close SELF-77 first." })])).rows[0];
  ok(group, ungrounded.outcome === "FAIL" && ungrounded.groundingOk === false && ungrounded.errorKind === "grounding-rejected", "ungrounded output (invented key) -> FAIL grounding");
  const english = (await run([replyVi], [JSON.stringify({ reply: "I will confirm the wording before Friday. Waiting on SELF-9.", unansweredPoints: [] })])).rows[0];
  ok(group, english.outcome === "WARN" && english.rubric.some((r) => r.name === "language" && !r.pass) && /Vietnamese/.test(english.note ?? ""), "English for a Vietnamese task -> WARN naming the language");
  const vi = (await run([replyVi], [JSON.stringify(goodVi)])).rows[0];
  ok(group, vi.outcome === "PASS", `a Vietnamese answer passes the language rubric (${vi.note ?? "ok"})`);
  const leak = (await run([brief], [JSON.stringify({ ...goodBrief, currentState: "Waiting for [EMAIL_1] and SELF-9." })])).rows[0];
  ok(group, leak.outcome === "WARN" && leak.rubric.some((r) => r.name === "no placeholder leak" && !r.pass), "a leaked placeholder -> WARN");
  const trunc = (await run([brief], [{ text: '{"whatIs', stopReason: "max_tokens" }])).rows[0];
  ok(group, trunc.outcome === "FAIL" && trunc.errorKind === "truncated", "truncated text -> FAIL truncated");
  const refusal = (await run([brief], [{ text: "I can't help with that.", stopReason: "refusal" }])).rows[0];
  ok(group, refusal.outcome === "FAIL" && refusal.errorKind === "refused", "a refusal -> FAIL refused");
  const mixed = await run([brief, replyVi], [{ text: "x", stopReason: "refusal" }, JSON.stringify(goodVi)]);
  ok(group, mixed.rows[0].outcome === "FAIL" && mixed.rows[1].outcome === "PASS", "a failing task does not stop the run");
}

{
  const group = "D3 ceiling, dedupe, ledger";
  const r = await run([brief, replyVi, brief], [JSON.stringify(goodBrief), JSON.stringify(goodVi), JSON.stringify(goodBrief)], { maxTokens: 1000 });
  ok(group, r.rows[0].outcome === "PASS" && r.rows[1].outcome === "PASS" && r.rows[2].outcome === "SKIPPED" && r.ceilingReached && /ceiling/.test(r.rows[2].note ?? ""), "ceiling reached -> remaining tasks SKIPPED (not PASS)");
  const ledger = new MemoryUsageLedger();
  let calls = 0;
  const counting = async (p: ModelCallParams) => { calls += 1; return model([JSON.stringify(goodBrief)])(p); };
  const deps = { env: {}, callModel: counting, ledger, now: () => NOW };
  await runSelfTest({ mode: "quick", fixtures: [brief], deps });
  await runSelfTest({ mode: "quick", fixtures: [brief], deps });
  ok(group, calls === 2, "re-running within a minute does not hit the dedupe cache");
  const recs = await ledger.listDays(["2026-11-05"]);
  ok(group, recs.length === 2 && recs.every((x) => x.selftest === true), "ledger entries are marked selftest");
  const real = { ...recs[0], id: "real", selftest: undefined };
  const summary = summarizeUsage([...recs, real], 100_000, NOW, "memory");
  ok(group, summary.selftestTokensToday === 1400 && summary.today.totalTokens === 2100, "the cap display separates self-test tokens from real usage");
}

{
  const group = "D3 route handler";
  const deps = (ledger = new MemoryUsageLedger(), env = {}) => ({ env, callModel: model([JSON.stringify(goodBrief)]), ledger, now: () => NOW });
  const base = { principalId: "p", limiter: new RateLimiter(), hasKey: true };
  ok(group, (await handleSelfTestRequest({ ...base, body: { mode: "x" }, deps: deps() })).status === 400, "bad mode -> 400");
  const nokey = await handleSelfTestRequest({ ...base, hasKey: false, body: { mode: "quick" }, deps: deps() });
  ok(group, nokey.status === 409 && /key first/.test(String(nokey.body.error)), "no key -> 409 'configure a key first'");
  const ledger = new MemoryUsageLedger();
  await ledger.append({ id: "u", at: NOW.toISOString(), day: "2026-11-05", task: "weeklyInsights", model: "m", tier: "fast", inputTokens: 395_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cached: false, outcome: "ok" });
  let called = 0;
  const near = await handleSelfTestRequest({ ...base, body: { mode: "quick" }, deps: { ...deps(ledger, { AI_DAILY_TOKEN_CAP: "400000" }), callModel: async (p: ModelCallParams) => { called += 1; return model(["{}"])(p); } } });
  ok(group, near.status === 429 && called === 0 && near.body.errorKind === "budget-too-low", "the daily cap nearly used -> refused before any call");
  const limiter = new RateLimiter();
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) statuses.push((await handleSelfTestRequest({ principalId: "p", limiter, hasKey: true, body: { mode: "quick" }, deps: deps() })).status);
  ok(group, statuses.slice(0, 3).every((s) => s === 200) && statuses[3] === 429, `3 runs per day per principal (${statuses.join(",")})`);
  const done = await handleSelfTestRequest({ ...base, limiter: new RateLimiter(), body: { mode: "quick" }, deps: deps() });
  ok(group, done.status === 200 && (done.body.report as { rows: unknown[] }).rows.length === quickFixtures().length, "quick runs the 5 core fixtures");
}

{
  const group = "D3 fixtures and helpers";
  ok(group, quickFixtures().length === 5 && SELFTEST_FIXTURES.length >= 12, `quick = 5 core tasks, full = ${SELFTEST_FIXTURES.length} fixtures`);
  const tasks = new Set(SELFTEST_FIXTURES.map((f) => f.task));
  ok(group, ["generateTicketBrief", "triageNewItems", "draftMentionReply", "rewriteReport", "draftBlockerFollowUps", "releaseGoNoGo", "baRequirementCheck", "weeklyInsights", "parseCommand", "extractMeetingActions", "generateDailyGuidance", "checkRequirements"].every((t) => tasks.has(t as never)), "every AI feature has a fixture");
  ok(group, SELFTEST_FIXTURES.some((f) => f.task === "draftMentionReply" && f.expect.language === "vi") && SELFTEST_FIXTURES.some((f) => f.task === "rewriteReport" && f.expect.language === "vi") && SELFTEST_FIXTURES.some((f) => f.task === "draftMentionReply" && f.expect.language === "en"), "Vietnamese and English variants exist for the language-bearing tasks");
  const text = fs.readFileSync("src/lib/command-center/ai/selftest-fixtures.ts", "utf8") + JSON.stringify(SELFTEST_FIXTURES);
  ok(group, !/[\w.+-]+@[\w-]+\.[\w.]+/.test(text.replace(/@Tay/g, "")) && !/sk-[A-Za-z0-9]/.test(text) && !/sk-ant/.test(text), "no fixture contains an email address or a key");
  const baFix = fx("ba-requirement-check");
  ok(group, gradeAnswer(baFix, { items: ["Given a user, When x, Then y"] }, "m", "m").some((r) => !r.pass), "the BA check rubric rejects Given/When/Then");
  ok(group, vietnameseRatio("Em xác nhận nội dung email") > 0.05 && vietnameseRatio("I will confirm the wording") === 0, "Vietnamese detection by diacritic ratio");
  ok(group, PRICE_PER_MTOK.verifiedOn === "2026-11-05" && estimateCostUsd("claude-haiku-5-5", 1_000_000, 1_000_000) === 0.6 && estimateCostUsd("unknown-model", 1, 1) === null, "cost = tokens × constants table (verifiedOn recorded); unknown model -> null");
  const table = formatSelfTestTable(await run([brief], [JSON.stringify(goodBrief)]));
  ok(group, /estimate/.test(table) && /PASS/.test(table), "the printed table labels the cost an estimate");
  const pkg = fs.readFileSync("package.json", "utf8");
  ok(group, /"smoke:ai"/.test(pkg) && /ai-smoke-report\.json/.test(fs.readFileSync(".gitignore", "utf8")) && !/smoke:ai/.test(fs.readFileSync(".github/workflows/ci.yml", "utf8")), "npm run smoke:ai exists, its report is gitignored, CI does not run it");
}
