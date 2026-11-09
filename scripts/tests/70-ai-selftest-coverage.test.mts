// V2.52 A4 — self-test covers every AI task; the rubric catches sentence-count / causal / truncation problems; per-task AI health alerts.
import fs from "node:fs";
import { ok } from "./harness.mts";
import { aiTaskSchema, type AITask } from "../../src/lib/command-center/ai/schemas";
import { SELFTEST_FIXTURES, quickFixtures, type SelfTestFixture } from "../../src/lib/command-center/ai/selftest-fixtures";
import { runSelfTest, gradeAnswer, estimateSelfTestTokens } from "../../src/lib/command-center/ai/selftest";
import { TASK_OUTPUT_SCHEMAS, GROUNDING_POLICY, buildTaskPrompt, parseTaskInput } from "../../src/lib/command-center/ai/task-registry";
import { MemoryUsageLedger, healthByTask, type AiUsageRecord } from "../../src/lib/command-center/ai/usage-ledger";
import type { ModelCallParams, ModelCallResult } from "../../src/lib/command-center/ai/server-runner";
import { checkGrounding } from "../../src/lib/command-center/ai/evaluation";
import { z } from "zod";

const NOW = new Date("2026-11-09T09:00:00.000Z");
const usage = { inputTokens: 400, outputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0 };

// ----- a fake model that answers every task from its own output schema -----
type J = { type?: string; enum?: unknown[]; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; minItems?: number; properties?: Record<string, J>; required?: string[]; items?: J; anyOf?: J[]; const?: unknown };
function fabricate(node: J, text: string): unknown {
  if (node.const !== undefined) return node.const;
  if (node.enum) return node.enum[0];
  if (node.anyOf) return fabricate(node.anyOf.find((a) => (a as J).type !== "null") ?? node.anyOf[0], text);
  switch (node.type) {
    case "string": { const t = text.length >= (node.minLength ?? 0) ? text : text.padEnd(node.minLength ?? 0, "."); return node.maxLength ? t.slice(0, node.maxLength) : t; }
    case "number": case "integer": return node.minimum !== undefined && node.maximum !== undefined ? (node.minimum + node.maximum) / 2 : (node.minimum ?? 0.5);
    case "boolean": return false;
    case "array": return Array.from({ length: node.minItems ?? 0 }, () => fabricate(node.items ?? {}, text));
    case "object": return Object.fromEntries((node.required ?? []).map((k) => [k, fabricate(node.properties?.[k] ?? {}, text)]));
    default: return text;
  }
}
const VI_TEXT = "Đã cập nhật tình hình công việc theo dữ liệu hiện có và chờ xác nhận thêm";
const EN_TEXT = "Status is unchanged and the open work is still tracked";
function answerFor(f: SelfTestFixture): string {
  const keys = Array.from(new Set(JSON.stringify(f.input).match(/\b[A-Z][A-Z0-9_]{1,19}-\d{1,9}\b/g) ?? [])).slice(0, 2).join(" and ");
  const base = f.expect.language === "vi" ? VI_TEXT : EN_TEXT;
  const must = (f.expect.mustMention ?? []).filter((m) => !/-\d/.test(m)).join(" ");
  const text = `${base} ${keys} ${must}`.trim();
  if (f.task === "summarizeReport") {
    const k = f.expect.language === "vi" ? "SELF-9" : "SELF-9";
    return JSON.stringify({ text: f.expect.language === "vi" ? `Ngày 2026-11-05 tôi đã hoàn thành 3 ticket. Tôi cũng làm tiếp 1 ticket. ${k} vẫn bị chặn 4 ngày làm việc.` : `Today I completed 3 tickets, including SELF-1 and SELF-2. I am continuing with 1 in progress. ${k} has been blocked for 4 business days, waiting on Dev Team: API date. 1 mention is awaiting my reply and 1 blocker is over SLA.` });
  }
  if (f.task === "generateWeeklyReview") return JSON.stringify({ text: `## EXECUTIVE SUMMARY\n${text}` });
  const out = fabricate(z.toJSONSchema(TASK_OUTPUT_SCHEMAS[f.task] as z.ZodType, { unrepresentable: "any", io: "output" }) as J, text) as Record<string, unknown>;
  // The two tasks with domain rules beyond the schema: the release recommendation must be one the readiness rules allow; stakeholders must be real people; an acceptance criterion must quote the ticket or say it is an assumption.
  if (f.task === "releaseGoNoGo") out.recommendation = (f.input as { allowedRecommendations: string[] }).allowedRecommendations[0];
  if (f.task === "baRequirementCheck") for (const ac of (out.acceptanceCriteria ?? []) as { source: { kind: string; quote?: string } }[]) ac.source = { kind: "assumption" };
  if (f.task === "baRequirementCheck") for (const q of (out.questionsByStakeholder ?? []) as { stakeholder: string }[]) q.stakeholder = "Dev Team";
  return JSON.stringify(out);
}
/** Answers the fixture the orchestrator is currently running (it runs them in order; `onRow` moves the cursor). */
function fakeModel(fixtures: SelfTestFixture[] = SELFTEST_FIXTURES) {
  let current = 0;
  const calls: ModelCallParams[] = [];
  return {
    calls,
    onRow: () => { current += 1; },
    deps: (ledger = new MemoryUsageLedger()) => ({
      env: {}, ledger, now: () => NOW,
      callModel: async (p: ModelCallParams): Promise<ModelCallResult> => {
        calls.push(p);
        const f = fixtures[current];
        return { stopReason: "end_turn", text: answerFor(f), usage };
      },
    }),
  };
}

{
  const group = "V2.52 A4 coverage";
  const tasks = aiTaskSchema.options as readonly AITask[];
  const missing = tasks.filter((t) => !SELFTEST_FIXTURES.some((f) => f.task === t));
  ok(group, missing.length === 0, `every AITask (${tasks.length}) has at least one fixture${missing.length ? ` — missing: ${missing.join(", ")}` : ""}`);
  const bad = SELFTEST_FIXTURES.filter((f) => !parseTaskInput(f.task, f.input).ok).map((f) => f.id);
  ok(group, bad.length === 0, `every fixture input is accepted by its task schema${bad.length ? ` (rejected: ${bad.join(", ")})` : ""}`);
  const text = JSON.stringify(SELFTEST_FIXTURES);
  ok(group, !/@[a-z0-9-]+\.[a-z]{2,}|sk-ant-|ghp_|xox[bp]-|Bearer |https?:\/\//i.test(text), "fixtures contain no emails, URLs or keys");
  ok(group, new Set(SELFTEST_FIXTURES.map((f) => f.id)).size === SELFTEST_FIXTURES.length, "fixture ids are unique");
  ok(group, SELFTEST_FIXTURES.some((f) => f.task === "summarizeReport" && f.expect.language === "en" && f.core) && SELFTEST_FIXTURES.some((f) => f.task === "summarizeReport" && f.expect.language === "vi"), "summarizeReport has an EN standup (core) and a VI work-log fixture");
  for (const t of ["weeklyInsights", "generateWeeklyReview", "generateEndOfDaySummary", "generateTicketBrief"] as AITask[]) ok(group, SELFTEST_FIXTURES.some((f) => f.task === t && f.expect.language === "vi"), `${t} has a Vietnamese variant`);
  ok(group, quickFixtures().length === 6, `Quick = 6 core tasks (is ${quickFixtures().length})`);
  ok(group, estimateSelfTestTokens("quick") === quickFixtures().reduce((n, f) => n + f.estTokens, 0) && estimateSelfTestTokens("full") === SELFTEST_FIXTURES.reduce((n, f) => n + f.estTokens, 0), "the up-front estimate is the sum of estTokens");
}

{
  const group = "V2.52 A4 runs";
  const coreList = SELFTEST_FIXTURES.filter((f) => f.core);
  const m = fakeModel(coreList);
  const quick = await runSelfTest({ mode: "quick", fixtures: coreList, deps: m.deps(), onRow: m.onRow });
  ok(group, quick.rows.length === 6 && quick.rows.every((r) => r.outcome === "PASS" || r.outcome === "WARN"), `a Quick run (6 core tasks) completes: ${quick.rows.map((r) => `${r.id}=${r.outcome}`).join(", ")}`);
  const m2 = fakeModel();
  const full = await runSelfTest({ mode: "full", deps: m2.deps(), onRow: m2.onRow });
  ok(group, full.rows.length === SELFTEST_FIXTURES.length, `a Full run reports every fixture (${full.rows.length})`);
  const why = (id: string) => {
    const f = SELFTEST_FIXTURES.find((x) => x.id === id)!;
    const parsed = parseTaskInput(f.task, f.input);
    return parsed.ok ? checkGrounding(JSON.parse(answerFor(f)), buildTaskPrompt(f.task, parsed.input), GROUNDING_POLICY[f.task]).violations.slice(0, 2).join("; ") : "bad input";
  };
  const notPass = full.rows.filter((r) => r.outcome !== "PASS" && r.outcome !== "WARN").map((r) => `${r.id}: ${r.note} [${why(r.id)}]`);
  ok(group, notPass.length === 0, `every fixture is answered through the real path (schema, grounding, extra checks)${notPass.length ? ` — ${notPass.slice(0, 4).join(" | ")}` : ""}`);
  ok(group, full.rows.every((r) => !r.truncated && (r.outcome !== "FAIL" || !!r.reason)), "rows carry a reason when they fail and no truncation flag when nothing was cut");
}

{
  const group = "V2.52 A4 rubric";
  const f = SELFTEST_FIXTURES.find((x) => x.id === "report-narrative")!;
  const grade = (text: string, flags = {}) => gradeAnswer(f, { text }, "claude-sonnet-5-5", "claude-sonnet-5-5", flags);
  const good = "Today I completed 3 tickets. I am continuing with 1 in progress. SELF-9 has been blocked for 4 business days.";
  ok(group, grade(good).every((r) => r.pass), "a 3-sentence narrative passes every rubric item");
  const seven = grade("One thing. Two things. Three things. Four things. Five things. Six things. Seven things SELF-9.");
  ok(group, seven.some((r) => r.name === "sentence count" && !r.pass && /found 7/.test(r.detail)), "7 sentences fail the sentence-count rubric with a readable message");
  ok(group, grade(`${good} The outage caused the delay.`).some((r) => r.name === "no causal claims" && !r.pass), "a causal phrase fails the rubric");
  ok(group, grade(`${good} Since you are the manager.`).some((r) => r.name === "no inferred hierarchy" && !r.pass), "a hierarchy phrase fails the rubric");
  ok(group, grade(`${good} Contact [EMAIL_1].`).some((r) => r.name === "no placeholder leak" && !r.pass), "a placeholder leak fails the rubric");
  ok(group, grade(good, { truncated: true }).some((r) => r.name === "no truncation" && !r.pass && /output budget/.test(r.detail)), "a first answer cut off at max_tokens is flagged even when the retry worked");

  const brief = SELFTEST_FIXTURES.find((x) => x.id === "ticket-brief")!;
  const goodBrief = JSON.stringify({ whatIsAsked: "Send a reminder email before a subscription expires.", currentState: "In Progress; waiting on SELF-9.", waitingOn: [{ who: "Dev Team", what: "API date" }], openQuestions: [], suggestedNextStep: "Confirm the wording with Linh Tran." });
  const cut = { stopReason: "max_tokens", text: '{"whatIs' };
  let n = 0;
  const callModel = async (): Promise<ModelCallResult> => (n++ === 0 ? { ...cut, usage } : { stopReason: "end_turn", text: goodBrief, usage });
  const t = await runSelfTest({ mode: "quick", fixtures: [brief], deps: { env: {}, callModel, ledger: new MemoryUsageLedger(), now: () => NOW } });
  ok(group, t.rows[0].outcome === "WARN" && t.rows[0].truncated === true && t.rows[0].retried && /no truncation/.test(t.rows[0].note ?? ""), "truncated once, then fine -> WARN 'no truncation' with the retry noted");
  const always = await runSelfTest({ mode: "quick", fixtures: [brief], deps: { env: {}, callModel: async () => ({ ...cut, usage }), ledger: new MemoryUsageLedger(), now: () => NOW } });
  ok(group, always.rows[0].outcome === "FAIL" && always.rows[0].reason === "truncated" && always.rows[0].errorKind === "truncated" && /cut off/.test(always.rows[0].note ?? ""), "always truncated -> FAIL reported as truncated (not a generic failure), in plain words");
  const budget = await runSelfTest({ mode: "quick", fixtures: [brief], deps: { env: {}, callModel: async () => ({ stopReason: "end_turn", text: JSON.stringify({ nope: 1 }), usage }), ledger: new MemoryUsageLedger(), now: () => NOW } });
  ok(group, budget.rows[0].outcome === "FAIL" && budget.rows[0].reason === "invalid-output", "an invalid answer fails with its plain reason");
  const six = SELFTEST_FIXTURES.filter((x) => x.core);
  const stopped = await runSelfTest({ mode: "quick", fixtures: six, maxTokens: 800, deps: { env: {}, callModel: async () => ({ stopReason: "end_turn", text: JSON.stringify({ nope: 1 }), usage }), ledger: new MemoryUsageLedger(), now: () => NOW } });
  ok(group, stopped.ceilingReached && stopped.rows.some((r) => r.outcome === "SKIPPED" && /Skipped \(budget\)/.test(r.note ?? "")), "the token ceiling stops the run midway and reports the rest as 'Skipped (budget)'");
}

{
  const group = "V2.52 A4 AI health";
  const rec = (task: AITask, outcome: AiUsageRecord["outcome"], i: number, day = "2026-11-09"): AiUsageRecord => ({ id: `${task}-${outcome}-${i}`, at: `${day}T10:00:00.000Z`, day, task, model: "m", tier: "default", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, cached: false, outcome });
  const records: AiUsageRecord[] = [
    ...Array.from({ length: 16 }, (_, i) => rec("weeklyInsights", "ok", i)),
    ...Array.from({ length: 4 }, (_, i) => rec("weeklyInsights", "truncated", i)),
    ...Array.from({ length: 20 }, (_, i) => rec("explainChanges", "ok", i)),
    ...Array.from({ length: 6 }, (_, i) => rec("parseCommand", i < 3 ? "grounding-rejected" : "ok", i)),
  ];
  const h = healthByTask(records);
  const wi = h.find((x) => x.task === "weeklyInsights")!;
  ok(group, wi.alert !== undefined && Math.abs(wi.alert.failRate - 0.2) < 1e-9 && /output budget/.test(wi.alert.nextStep) && /different model/.test(wi.alert.nextStep), "20 calls, 4 truncated -> that task is red with 'raise the output budget / pick a different model'");
  ok(group, h.filter((x) => x.alert).map((x) => x.task).join() === "weeklyInsights", "only that task is red (20 clean calls and a 6-call task with 50% failures stay quiet)");
  ok(group, wi.rates!.truncated === 0.2 && wi.rates!.groundingRejected === 0 && wi.byDay!.length === 1 && wi.byDay![0].truncated === 4, "per-task rates and per-day counts are reported");
  const exactly = healthByTask([...Array.from({ length: 9 }, (_, i) => rec("explainChanges", "ok", i)), rec("explainChanges", "error", 99)]);
  ok(group, exactly[0].alert === undefined, "exactly 10% is not over the threshold");
  const days = healthByTask([rec("answerQuery", "error", 1, "2026-11-08"), rec("answerQuery", "ok", 2, "2026-11-09")]);
  ok(group, days[0].byDay!.map((d) => d.day).join() === "2026-11-08,2026-11-09", "days are listed oldest first");
  const retried = healthByTask([...Array.from({ length: 9 }, (_, i) => rec("weeklyInsights", "ok", i)), rec("weeklyInsights", "truncated-retry", 1), rec("weeklyInsights", "schema-retry", 2), rec("weeklyInsights", "ok", 3)]);
  ok(group, retried[0].rates!.truncated > 0 && retried[0].rates!.schemaRetry > 0, "a truncated-retry counts toward the truncation rate; a schema retry has its own rate");
  const panel = fs.readFileSync("src/components/command-center/AiProviderPanel.tsx", "utf8");
  ok(group, /data-ai-health-alert/.test(panel) && /h\.alert\.nextStep/.test(panel), "the AI health panel highlights a task red with its next step");
  const noReal = healthByTask([{ ...rec("weeklyInsights", "error", 1), selftest: true }, { ...rec("weeklyInsights", "error", 2), cached: true }]);
  ok(group, noReal.length === 0, "self-test and cached records are not health data");
  const smoke = fs.readFileSync("scripts/ai-smoke.mts", "utf8");
  ok(group, /coreIds/.test(smoke) && /coreFailed/.test(smoke) && /process\.exit\(coreFailed/.test(smoke), "smoke:ai exits non-zero when a core task fails");
  ok(group, !/package\.json/.test(smoke) && !/"smoke:ai"[^\n]*npm test/.test(fs.readFileSync("package.json", "utf8")), "smoke:ai stays out of npm test / CI");
}
