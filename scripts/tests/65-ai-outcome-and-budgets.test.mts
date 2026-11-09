// V2.49 A1 — AI call foundation: per-call outcome + failure reasons, the Next-Best-Action AI gate bug, output-token budgets, truncation retry.
import fs from "node:fs";
import { ok } from "./harness.mts";
import { ClaudeProvider, clearAiBudgetStatus } from "../../src/lib/command-center/ai/claude-provider";
import { MockAIProvider } from "../../src/lib/command-center/ai/provider";
import { explainAiFailure, failureReasonFromResponse, isTransientAiFailure, type AiFailureReason } from "../../src/lib/command-center/ai/outcome";
import { thinkingHeadroom, isAlwaysThinkingModel } from "../../src/lib/command-center/ai/model-config";
import { visibleTokenBudget, TASK_OUTPUT_SCHEMAS } from "../../src/lib/command-center/ai/task-registry";
import { aiTaskSchema, type AITask } from "../../src/lib/command-center/ai/schemas";
import { handleAiRequest, ResponseCache, type AiServerDeps, type ModelCallParams, type ModelCallResult } from "../../src/lib/command-center/ai/server-runner";
import { MemoryUsageLedger } from "../../src/lib/command-center/ai/usage-ledger";
import { narrateNextBestActions, NARRATION_STORAGE_KEY, type NarrationStorage } from "../../src/lib/command-center/nba-narration";
import { SELFTEST_FIXTURES } from "../../src/lib/command-center/ai/selftest-fixtures";
import { parseTaskInput } from "../../src/lib/command-center/ai/task-registry";
import type { NbaCard } from "../../src/lib/command-center/next-best-action";

const originalFetch = globalThis.fetch;
const withFetch = async <T,>(fake: (init?: RequestInit) => Response | Promise<Response>, fn: () => Promise<T>): Promise<T> => {
  clearAiBudgetStatus(); // the last budget answer is module state; one test must not leak into the next
  globalThis.fetch = (async (_u: string, init?: RequestInit) => (!init || !init.method || init.method === "GET" ? new Response(JSON.stringify({ available: true }), { status: 200 }) : fake(init))) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const guidance = { summary: "Start with SELF-1 — it is blocked.", topFocus: ["SELF-1"], watch: [], recommendation: "Nudge the Dev Team.", evidenceReferences: [], confidence: 0.7 };
const guidanceInput = { topFocusFacts: ["SELF-1 blocked"], watchFacts: [], planFacts: [], recentOutcomeFacts: [], evidenceStrings: ["SELF-1 blocked 3 days"] };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

{
  const group = "V2.49 A1 outcome mapping";
  const table: { status: number; kind?: string; reason: AiFailureReason }[] = [
    { status: 429, kind: "budget-exhausted", reason: "budget" },
    { status: 429, kind: "user-budget-exhausted", reason: "user-budget" },
    { status: 422, kind: "grounding-rejected", reason: "grounding" },
    { status: 502, kind: "truncated", reason: "truncated" },
    { status: 502, kind: "invalid-output", reason: "invalid-output" },
    { status: 502, kind: "refused", reason: "refused" },
    { status: 401, reason: "provider-error" },
    { status: 404, reason: "provider-error" },
    { status: 400, kind: "bad-request", reason: "bad-input" },
  ];
  for (const row of table) {
    ok(group, failureReasonFromResponse(row.status, row.kind) === row.reason, `HTTP ${row.status}${row.kind ? ` / ${row.kind}` : ""} -> ${row.reason}`);
    const out = await withFetch(() => json({ ok: false, error: "x", errorKind: row.kind, usage: { cap: 1000, remainingToday: 900 } }, row.status), () => new ClaudeProvider().runTask("generateDailyGuidance", guidanceInput));
    ok(group, !out.ok && out.reason === row.reason && out.httpStatus === row.status, `runTask over the wire: ${row.status} -> ${row.reason}`);
  }
  const net = await withFetch(() => { throw new Error("offline"); }, () => new ClaudeProvider().runTask("generateDailyGuidance", guidanceInput));
  ok(group, !net.ok && net.reason === "network", "a thrown fetch -> network");
  const bad = await new ClaudeProvider().runTask("generateDailyGuidance", { nope: 1 } as never);
  ok(group, !bad.ok && (bad.reason === "bad-input" || bad.reason === "unavailable"), "schema-invalid input never reaches the server");
  const unavailable = await withFetch(() => json({}), async () => {
    globalThis.fetch = (async () => json({ available: false })) as typeof fetch;
    return new ClaudeProvider().runTask("generateDailyGuidance", guidanceInput);
  });
  ok(group, !unavailable.ok && unavailable.reason === "unavailable", "availability false -> unavailable");
  const good = await withFetch(() => json({ ok: true, data: guidance, usage: { cap: 1000, remainingToday: 900 } }), () => new ClaudeProvider().runTask("generateDailyGuidance", guidanceInput));
  ok(group, good.ok && good.data.summary === guidance.summary, "runTask returns { ok: true, data } on success");
  const violations = await withFetch(() => json({ ok: false, errorKind: "grounding-rejected", violations: ["a", "b"] }, 422), () => new ClaudeProvider().runTask("generateDailyGuidance", guidanceInput));
  ok(group, !violations.ok && violations.violationCount === 2, "the violation count is carried (never the violations' text)");
  const provider = new ClaudeProvider();
  const text = await withFetch(() => json({ ok: false, errorKind: "budget-exhausted" }, 429), () => provider.generateDailyGuidance([], [], [], [], []));
  ok(group, text.summary === (await new MockAIProvider().generateDailyGuidance([], [], [], [], [])).summary && provider.mode === "mock", "existing methods still fall back to the mock exactly as before");
  ok(group, new MockAIProvider().runTask === undefined, "the mock does not implement runTask (callers treat that as unavailable)");
  ok(group, aiTaskSchema.options.every((t) => explainAiFailure("budget").title.length > 0 && !!t), "explainAiFailure gives plain text");
  ok(group, (["unavailable", "budget", "user-budget", "grounding", "truncated", "invalid-output", "refused", "provider-error", "network", "bad-input"] as AiFailureReason[]).every((r) => explainAiFailure(r).title && explainAiFailure(r).nextStep), "every reason has a title and a next step");
  ok(group, isTransientAiFailure("network") && isTransientAiFailure("truncated") && !isTransientAiFailure("budget") && !isTransientAiFailure("grounding"), "transient vs definitive failures");
}

{
  const group = "V2.49 A1 Next Best Action AI wording";
  const card = (k: string, h: string): NbaCard => ({ id: `nba-${k}`, kind: "BLOCKED_NUDGE" as NbaCard["kind"], ticketKey: k, headline: h, why: [{ id: "e", content: `${k} is blocked` } as NbaCard["why"][number]], primary: { label: "Nudge", intent: "nudge" }, rank: 4 });
  const cards = [card("SELF-1", "Nudge about SELF-1")];
  const mem = (): NarrationStorage & { map: Map<string, string> } => {
    const map = new Map<string, string>();
    return { map, get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v) };
  };
  // Exactly what NextBestActions.tsx does, with a FRESH provider (its `mode` is "mock" until a call has happened).
  const callAi = (provider: ClaudeProvider) => async (facts: { headlines: string[]; evidence: string[] }) => {
    const o = await provider.runTask("generateDailyGuidance", { topFocusFacts: facts.headlines, watchFacts: [], planFacts: [], recentOutcomeFacts: [], evidenceStrings: facts.evidence });
    if (!o.ok) return { text: null, reason: o.reason, httpStatus: o.httpStatus };
    return o.data.insufficientEvidence ? null : o.data.summary;
  };
  const run = (storage: NarrationStorage, provider: ClaudeProvider, today = "2026-11-09") => narrateNextBestActions({ cards, today, flagOn: true, aiAvailable: true, storage, callAi: callAi(provider) });

  let posts = 0;
  const okServer = () => { posts++; return json({ ok: true, data: guidance, usage: { cap: 1000, remainingToday: 900 } }); };
  const fresh = new ClaudeProvider();
  ok(group, fresh.mode === "mock", "precondition: a fresh provider reports mode 'mock' before any call");
  const r1 = await withFetch(okServer, () => run(mem(), fresh));
  ok(group, r1.source === "ai" && r1.text === guidance.summary && posts === 1, "a FRESH provider produces AI narration (source: ai) — the model is actually called");

  const src = fs.readFileSync("src/components/command-center/NextBestActions.tsx", "utf8");
  ok(group, !/provider\.mode|getAIProvider\(\)\.mode/.test(src) && /runTask\("generateDailyGuidance"/.test(src), "NextBestActions.tsx no longer gates on provider.mode and uses runTask");

  // transient failure -> exactly one more attempt that day
  const st = mem();
  let n = 0;
  const flaky = () => { n++; return json({ ok: false, errorKind: "provider-error" }, 502); };
  const a1 = await withFetch(flaky, () => run(st, new ClaudeProvider()));
  ok(group, a1.source === "deterministic" && a1.failure === "provider-error" && n === 1, "a transient failure shows the deterministic text and the reason");
  const a2 = await withFetch(flaky, () => run(st, new ClaudeProvider()));
  ok(group, n === 2 && a2.failure === "provider-error", "…and allows exactly one more attempt later that day");
  const a3 = await withFetch(flaky, () => run(st, new ClaudeProvider()));
  ok(group, n === 2 && a3.source === "deterministic", "…and then no more (max 2 attempts per day)");
  const a4 = await withFetch(okServer, () => run(st, new ClaudeProvider(), "2026-11-10"));
  ok(group, a4.source === "ai", "next day starts fresh");

  // network failure
  const stN = mem();
  let nn = 0;
  const down = () => { nn++; throw new Error("offline"); };
  await withFetch(down, () => run(stN, new ClaudeProvider()));
  await withFetch(down, () => run(stN, new ClaudeProvider()));
  await withFetch(down, () => run(stN, new ClaudeProvider()));
  ok(group, nn === 2, "after a network failure exactly one more attempt is made");

  // definitive failure
  const stB = mem();
  let nb = 0;
  const budget = () => { nb++; return json({ ok: false, errorKind: "budget-exhausted", usage: { cap: 10, remainingToday: 0 } }, 429); };
  const b1 = await withFetch(budget, () => run(stB, new ClaudeProvider()));
  const b2 = await withFetch(budget, () => run(stB, new ClaudeProvider()));
  ok(group, b1.failure === "budget" && b2.failure === "budget" && b2.source === "deterministic" && nb === 1, "after a budget failure no further attempt that day; deterministic text + reason");

  // same facts after success: cache, no call
  const stS = mem();
  posts = 0;
  await withFetch(okServer, () => run(stS, new ClaudeProvider()));
  const again = await withFetch(okServer, () => run(stS, new ClaudeProvider()));
  ok(group, posts === 1 && again.source === "ai", "same facts the same day: cached AI text, no second call");

  // old blob
  const old = mem();
  old.set(NARRATION_STORAGE_KEY, JSON.stringify({ day: "2026-11-09", hash: "zzz", text: "Old text", source: "deterministic" }));
  let no = 0;
  const o1 = await withFetch(() => { no++; return okServer(); }, () => run(old, new ClaudeProvider()));
  ok(group, no === 0 && o1.source === "deterministic" && o1.failure === undefined, "an old {day, hash, text, source} blob loads and behaves as before (no new required fields)");
}

{
  const group = "V2.49 A1 budgets";
  const tasks = aiTaskSchema.options as readonly AITask[];
  const prev: Record<string, number> = { rewriteReport: 4096, baRequirementCheck: 4096, draftBlockerFollowUps: 2048, extractMeetingActions: 2048, releaseGoNoGo: 2048, triageNewItems: 3072, generateDecisionOptions: 1536, checkRequirements: 1536, generateTicketBrief: 1536, draftMentionReply: 1536 };
  ok(group, tasks.every((t) => visibleTokenBudget(t) >= (prev[t] ?? 512)), "every task budget is >= its previous value");
  ok(group, visibleTokenBudget("weeklyInsights") >= 1024, `weeklyInsights >= 1024 (is ${visibleTokenBudget("weeklyInsights")})`);
  ok(group, tasks.every((t) => visibleTokenBudget(t, { language: "vi" }) >= Math.min(6144, Math.ceil(visibleTokenBudget(t) * 1.6)) && visibleTokenBudget(t, { language: "vi" }) <= 6144), "Vietnamese >= 1.6x English, capped at 6144");
  ok(group, tasks.every((t) => visibleTokenBudget(t) <= Math.max(3072, prev[t] ?? 0)), "English budgets stay within the 3072 ceiling (or the old explicit value)");
  ok(group, Object.keys(TASK_OUTPUT_SCHEMAS).length === tasks.length, "every task has an output schema");

  ok(group, thinkingHeadroom("claude-sonnet-5-5") === 6000 && isAlwaysThinkingModel("claude-sonnet-5-5"), "known always-thinking Claude id -> 6000 (unchanged)");
  ok(group, thinkingHeadroom("anthropic/claude-sonnet-4.5") === 2048, "gateway id anthropic/claude-sonnet-4.5 -> 2048");
  ok(group, thinkingHeadroom("claude-sonnet-5-5", { customBaseUrl: true }) === 6000 && thinkingHeadroom("claude-sonnet-4-5", { customBaseUrl: true }) === 2048, "a custom base URL gives unknown/non-thinking ids 2048; known thinking ids keep 6000");
  ok(group, thinkingHeadroom("claude-sonnet-4-5") === 0 && thinkingHeadroom("claude-haiku-4-5") === 0, "known non-thinking Claude ids -> 0");
  ok(group, thinkingHeadroom("some-unknown-model") === 2048, "unrecognised id -> 2048");
}

{
  const group = "V2.49 A1 truncation retry";
  const NOW = new Date("2026-11-09T10:00:00.000Z");
  const input = { change: { entityLabel: "PAY-1 Export", entityType: "WorkItem", field: "status", before: "To Do", after: "Blocked", impact: "Release 2.4 at risk" } };
  const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const model = (answers: ({ text?: string; stopReason?: string })[]) => {
    const calls: ModelCallParams[] = [];
    return { calls, callModel: async (p: ModelCallParams): Promise<ModelCallResult> => { calls.push(JSON.parse(JSON.stringify(p))); const a = answers[Math.min(calls.length - 1, answers.length - 1)]; return { stopReason: a.stopReason ?? "end_turn", text: a.text, usage }; } };
  };
  const deps = (m: ReturnType<typeof model>, env: AiServerDeps["env"] = {}, ledger = new MemoryUsageLedger(), extra: Partial<AiServerDeps> = {}): AiServerDeps & { ledger: MemoryUsageLedger } => ({ env, callModel: m.callModel, ledger, now: () => NOW, cache: new ResponseCache(), ...extra });
  const good = { text: JSON.stringify({ text: "PAY-1 moved from To Do to Blocked." }) };
  const cut = { text: '{"text": "PAY', stopReason: "max_tokens" };

  const m1 = model([cut, good]);
  const d1 = deps(m1);
  const r1 = await handleAiRequest({ task: "explainChanges", input }, d1);
  const led = await d1.ledger.listDays(["2026-11-09"]);
  ok(group, r1.status === 200 && m1.calls.length === 2, "first call max_tokens, second fine -> request succeeds with 2 model calls");
  ok(group, led.some((r) => r.outcome === "truncated-retry") && led[led.length - 1].outcome === "ok", "the ledger shows truncated-retry then ok");
  ok(group, m1.calls[1].maxTokens === Math.min(m1.calls[0].maxTokens * 2, 8192 + 6000) && m1.calls[1].maxTokens > m1.calls[0].maxTokens, "the retry doubles the output room (capped)");

  const m2 = model([cut, cut]);
  const r2 = await handleAiRequest({ task: "explainChanges", input }, deps(m2));
  ok(group, r2.status === 502 && r2.body.errorKind === "truncated" && m2.calls.length === 2, "both truncated -> 502 truncated, still only 2 calls");

  const m3 = model([cut, good]);
  const capLedger = new MemoryUsageLedger();
  const r3 = await handleAiRequest({ task: "explainChanges", input }, deps(m3, { AI_DAILY_TOKEN_CAP: "100" }, capLedger));
  ok(group, r3.status === 429 && m3.calls.length === 1, "cap exhausted between attempts -> 429 and no second call");

  const badThenCut = model([{ text: JSON.stringify({ nope: 1 }) }, cut, good]);
  const r4 = await handleAiRequest({ task: "explainChanges", input }, deps(badThenCut));
  ok(group, badThenCut.calls.length === 2 && r4.status === 502, "schema repair + truncation in one request never exceeds 2 model calls");

  const mg = model([good]);
  await handleAiRequest({ task: "explainChanges", input }, deps(mg, { ANTHROPIC_MODEL_FAST: "gw-haiku-4.5" }, undefined, { customBaseUrl: true }));
  const mn = model([good]);
  await handleAiRequest({ task: "explainChanges", input }, deps(mn, { ANTHROPIC_MODEL_FAST: "claude-haiku-4-5" }));
  ok(group, mg.calls[0]?.maxTokens === visibleTokenBudget("explainChanges") + 2048 && mn.calls[0]?.maxTokens === visibleTokenBudget("explainChanges"), "gateway ids get 2048 thinking headroom, known non-thinking ids none");
  const logText = JSON.stringify(await d1.ledger.listDays(["2026-11-09"]));
  ok(group, !/PAY-1|moved from/.test(logText), "no prompt or answer text in the ledger");
}

{
  const group = "V2.49 A1 fixtures reach runTask";
  const withInput = SELFTEST_FIXTURES.filter((f) => parseTaskInput(f.task, f.input).ok);
  const rejected = SELFTEST_FIXTURES.filter((f) => !parseTaskInput(f.task, f.input).ok).map((f) => f.id);
  ok(group, withInput.length === SELFTEST_FIXTURES.length, `every self-test fixture input is accepted by the browser-side parse that runTask performs (rejected: ${rejected.join(",") || "none"})`);
  const src = fs.readFileSync("src/components/command-center/AiFailureNote.tsx", "utf8");
  ok(group, /explainAiFailure/.test(src) && !/prompt/i.test(src), "AiFailureNote renders explainAiFailure only");
}
