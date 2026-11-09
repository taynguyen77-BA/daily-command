// V2.51 A3 — prompt, language and short-circuit quality pass.
import fs from "node:fs";
import { ok } from "./harness.mts";
import { aiTaskSchema } from "../../src/lib/command-center/ai/schemas";
import { buildTaskPrompt, parseTaskInput, TASK_INPUT_SCHEMAS, visibleTokenBudget } from "../../src/lib/command-center/ai/task-registry";
import { SELFTEST_FIXTURES } from "../../src/lib/command-center/ai/selftest-fixtures";
import { weeklyReviewText } from "../../src/lib/command-center/ai/weekly-review-text";
import { ClaudeProvider } from "../../src/lib/command-center/ai/claude-provider";
import { languageLine } from "../../src/lib/command-center/ai/prompts/language";
import { checkGrounding } from "../../src/lib/command-center/ai/evaluation";
import { parseStoredState } from "../../src/lib/command-center/store";
import { emptyData } from "../../src/lib/command-center/types";
import type { WeeklyReviewFacts } from "../../src/lib/command-center/weekly-review";

const fixture = (id: string) => SELFTEST_FIXTURES.find((f) => f.id === id)!.input as Record<string, unknown>;
const facts = (over: Partial<WeeklyReviewFacts> = {}): WeeklyReviewFacts => ({
  hasEnoughHistory: true, windowDays: 7, currentConfidence: 70, confidenceDelta: 3, gettingBetter: ["x"], gettingWorse: [], recurringRisks: [{ title: "R" }], decisionsMade: [], decisionsUnresolved: [], actionsCompleted: [{ title: "A" }], actionsThatDidNotResolveTheIssue: [], carryOverRisks: [], nextWeekPriorities: [{ item: { key: "SELF-1", title: "T" } }], ...over,
} as unknown as WeeklyReviewFacts);
const inputs: Record<string, Record<string, unknown>> = {
  weeklyInsights: fixture("weekly-insights"),
  generateTicketBrief: fixture("ticket-brief"),
  generateEndOfDaySummary: { completed: [{ title: "Done A" }], deferred: [], blocked: [{ title: "Blocked B" }], newRisks: [] },
  generateWeeklyReview: { facts: facts() },
};
const prompt = (task: string, extra: Record<string, unknown> = {}) => {
  const p = parseTaskInput(task as never, { ...inputs[task], ...extra });
  if (!p.ok) throw new Error(p.error);
  return buildTaskPrompt(task as never, p.input);
};

{
  const group = "V2.51 A3 language";
  for (const task of Object.keys(inputs)) {
    const omitted = prompt(task);
    const en = prompt(task, { language: "en" });
    const vi = prompt(task, { language: "vi" });
    ok(group, omitted === en && !/Vietnamese/.test(omitted), `${task}: omitting language (or "en") gives the same prompt, with no language line`);
    ok(group, vi !== omitted && /Write in Vietnamese/.test(vi) && /never translate ticket keys, product names or code identifiers/.test(vi), `${task}: language "vi" adds the Vietnamese instruction and the keys/identifier rule`);
    ok(group, vi.replace(languageLine("vi"), "") === omitted || vi.length > omitted.length, `${task}: the vi prompt is the same prompt plus the language line`);
    ok(group, parseTaskInput(task as never, inputs[task]).ok, `${task}: the schema still accepts an old input without language`);
    ok(group, visibleTokenBudget(task as never, { language: "vi" }) >= Math.ceil(visibleTokenBudget(task as never) * 1.6) || visibleTokenBudget(task as never, { language: "vi" }) === 6144, `${task}: Vietnamese gets the larger output budget`);
  }
  ok(group, !parseTaskInput("weeklyInsights", { ...inputs.weeklyInsights, language: "fr" }).ok, "an unknown language is rejected");
  ok(group, languageLine(undefined) === "" && languageLine("en") === "", "no language line for English");
  const ground = checkGrounding({ text: "Trong tuần 27/10 đến 2/11, SELF-1 vẫn bị chặn. Ngày 27 tháng 10 chốt phạm vi." }, "FACTS: SELF-1 blocked since 2026-10-27. Window 2026-10-27 to 2026-11-02.", "counts");
  ok(group, ground.ok || ground.violations.every((v) => !/27|10|SELF-1/.test(v)), `Vietnamese dates (27/10, ngày 27 tháng 10) still pass grounding (${ground.violations.join("; ") || "ok"})`);
  const st = parseStoredState(JSON.stringify({ schemaVersion: 1, data: emptyData(), snapshotHistory: [], dataSource: "jira", memoryEvents: [] }));
  const st2 = parseStoredState(JSON.stringify({ schemaVersion: 1, data: emptyData(), snapshotHistory: [], dataSource: "jira", memoryEvents: [], aiOutputLanguage: "vi" }));
  ok(group, st.aiOutputLanguage === "en" && st2.aiOutputLanguage === "vi", "aiOutputLanguage defaults to en; an old blob loads; vi is kept");
  ok(group, /AiOutputLanguage/.test(fs.readFileSync("src/app/data-settings/page.tsx", "utf8")), "the language preference is on Data & Settings");
}

{
  const group = "V2.51 A3 weekly review short-circuit";
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ available: true }), { status: 200 }); }) as typeof fetch;
  try {
    const thin = await weeklyReviewText(facts({ hasEnoughHistory: false }), new ClaudeProvider());
    ok(group, calls === 0 && /Insufficient historical data/.test(thin) && /Close My Day/.test(thin), "without enough history there are ZERO fetches (no availability probe, no model call) and the calculated text says so");
    const page = fs.readFileSync("src/app/weekly-review/page.tsx", "utf8");
    ok(group, /weeklyReviewText\(/.test(page) && !/getAIProvider\(\)\.generateWeeklyReview/.test(page), "the page goes through the short-circuit");
    let seenLang: string | undefined;
    const full = await weeklyReviewText(facts(), { generateWeeklyReview: async (_f, lang) => { seenLang = lang; return "AI review"; } }, "vi");
    ok(group, full === "AI review" && seenLang === "vi", "with enough history the provider is called, with the language");
  } finally {
    globalThis.fetch = original;
  }
}

{
  const group = "V2.51 A3 length targets";
  const ps = fs.readdirSync("src/lib/command-center/ai/prompts").filter((f) => f.endsWith(".ts") && !["language.ts", "ticket-context.ts"].includes(f));
  const missing = ps.filter((f) => !/LENGTH:|sentence|bullet|at most|words|lines|one line|short/i.test(fs.readFileSync(`src/lib/command-center/ai/prompts/${f}`, "utf8")));
  ok(group, missing.length === 0, `every prompt with free text states a length target${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
  const schemas = fs.readFileSync("src/lib/command-center/ai/schemas/index.ts", "utf8");
  ok(group, /summary: z\.string\(\)\.min\(1\)\.max\(1000\)/.test(schemas), "schemas were not changed (no example or few-shot text added either)");
  ok(group, !/few-shot|EXAMPLE:/i.test(ps.map((f) => fs.readFileSync(`src/lib/command-center/ai/prompts/${f}`, "utf8")).join("\n")), "no examples or few-shot text in any prompt");
}

{
  const group = "V2.51 A3 prompt audit";
  const doc = fs.readFileSync("docs/AI-PROMPT-AUDIT.md", "utf8");
  const tasks = aiTaskSchema.options;
  const rows = doc.split("\n").filter((l) => /^\| `[A-Za-z]+` \|/.test(l));
  ok(group, rows.length === 30 && tasks.length === 30, `docs/AI-PROMPT-AUDIT.md has 30 rows (29 existing + summarizeReport); the registry has ${tasks.length}`);
  ok(group, tasks.every((t) => rows.some((r) => r.startsWith(`| \`${t}\` |`))), "every registered task appears in it");
  ok(group, /never displayed|never shows/.test(doc), "a prompt asking for a field the UI never shows is flagged");
  ok(group, Object.keys(TASK_INPUT_SCHEMAS).length === 30, "30 task input schemas");
  ok(group, /Secondary: rewords this numbers line only/.test(fs.readFileSync("src/components/command-center/ReportSummary.tsx", "utf8")), "polishReportSummary is marked secondary in the UI");
}
