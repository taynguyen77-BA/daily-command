// D2 — grounding guard v2 (golden table EN + VN), schema-repair retry, schema limits in prompts, telemetry.
import { ok } from "./harness.mts";
import { checkGrounding } from "../../src/lib/command-center/ai/evaluation";
import { handleAiRequest, ResponseCache, type ModelCallParams, type ModelCallResult, type AiServerDeps } from "../../src/lib/command-center/ai/server-runner";
import { MemoryUsageLedger, healthByTask, summarizeUsage, type AiUsageRecord } from "../../src/lib/command-center/ai/usage-ledger";
import { GROUNDING_POLICY, TASK_OUTPUT_SCHEMAS, buildTaskPrompt } from "../../src/lib/command-center/ai/task-registry";
import { schemaLimits, schemaLimitsText } from "../../src/lib/command-center/ai/schema-limits";
import { aiTaskSchema } from "../../src/lib/command-center/ai/schemas";
import { DEFAULT_AI_DATA_PROTECTION, buildTicketAiInput } from "../../src/lib/command-center/ai/data-protection";
import type { IssueContext } from "../../src/lib/command-center/jira/issue-context";

const FACTS = [
  'Ticket WF-12 "Update reminder email" is due 2026-10-27, blocked by the API team. Assignee Tay Nguyen.',
  "WF-13 and WF-14 are open. Comments from Priya Shah and Tom Lee. 3 days since last update, 40% done, 5 story points.",
  "Meeting on 3 November 2026. Release 2.4 ships Dec 1.",
  "- first item\n- second item\n- third item",
].join("\n");

type Case = [name: string, text: string, expect: "pass" | "reject", policy?: "strict" | "counts"];
const cases: Case[] = [
  // dates in other written forms (supplied)
  ["vn dd/MM supplied", "WF-12 hạn chót ngày 27/10.", "pass"],
  ["vn ngày tháng supplied", "WF-12 đến hạn ngày 27 tháng 10.", "pass"],
  ["vn ngày tháng năm supplied", "WF-12 đến hạn ngày 27 tháng 10 năm 2026.", "pass"],
  ["vn 27 tháng 10 no ngày", "WF-12 hạn 27 tháng 10.", "pass"],
  ["dd/MM/yyyy supplied", "WF-12 is due 27/10/2026.", "pass"],
  ["dd-MM supplied", "WF-12 is due 27-10.", "pass"],
  ["dd.MM.yyyy supplied", "WF-12 is due 27.10.2026.", "pass"],
  ["27th of October", "WF-12 is due on the 27th of October.", "pass"],
  ["Oct 27", "WF-12 is due Oct 27.", "pass"],
  ["27 October", "WF-12 is due 27 October.", "pass"],
  ["ISO supplied", "WF-12 is due 2026-10-27.", "pass"],
  ["m/d reading accepted when it matches", "WF-12 is due 10/27.", "pass"],
  ["d/m vs m/d ambiguity (3/11 = 3 Nov)", "Meeting on 3/11.", "pass"],
  ["wordy date from facts", "The meeting is on 3 November.", "pass"],
  ["wordy with year", "The meeting is on 3 November 2026.", "pass"],
  ["Dec 1 supplied", "Release 2.4 ships on 1 December.", "pass"],
  ["month only vn supplied", "WF-12 hết hạn trong tháng 10.", "pass"],
  // dates not supplied
  ["vn wrong day", "WF-12 hạn chót ngày 28/10.", "reject"],
  ["vn wrong month", "WF-12 hạn chót ngày 27 tháng 11.", "reject"],
  ["iso wrong", "Ship by 2026-11-01.", "reject"],
  ["wordy wrong", "Ship by Nov 15.", "reject"],
  ["year differs", "WF-12 is due 27/10/2025.", "reject"],
  ["year differs vn", "WF-12 đến hạn ngày 27 tháng 10 năm 2025.", "reject"],
  ["month only wrong vn", "WF-12 hết hạn trong tháng 7.", "reject"],
  ["ordinal wrong", "It is due on the 5th of January.", "reject"],
  // markers
  ["Step markers", "Step 1: confirm the copy. Step 2: send the reply to Tay Nguyen.", "pass"],
  ["Bước markers", "Bước 1: xác nhận nội dung. Bước 2: gửi trả lời.", "pass"],
  ["paren marker inline", "(1) check copy (2) send reply", "pass"],
  ["paren-close marker inline", "1) check copy 2) send reply", "pass"],
  ["hash marker", "Do #1 then #2", "pass"],
  ["line-start list", "1. check copy\n2. send reply", "pass"],
  ["a real number is not a marker", "About 77 tickets are late.", "reject"],
  // keys
  ["supplied keys", "WF-12, WF-13 and WF-14 are open.", "pass"],
  ["invented key", "WF-99 is blocked.", "reject"],
  ["invented key vn", "WF-99 đang bị chặn.", "reject"],
  ["key inside a sentence", "Please check PAY-1.", "reject"],
  // numbers (strict)
  ["supplied number", "3 days since the last update.", "pass"],
  ["supplied percent", "The ticket is 40% done.", "pass"],
  ["supplied points", "It is worth 5 story points.", "pass"],
  ["invented number >= 13", "About 40 tickets are late and 99% done.", "reject"],
  ["invented small number strict", "There are 2 blockers.", "reject", "strict"],
  ["invented days", "Late by 9 days.", "reject"],
  ["invented percent", "It is 85% done.", "reject"],
  ["comma number normalised", "Release 2.4 and 5 points.", "pass"],
  // counts policy
  ["derived count accepted (counts)", "There are 2 tickets open.", "pass", "counts"],
  ["derived count of blockers", "1 blocker needs attention.", "pass", "counts"],
  ["count equals keys", "3 tickets are open.", "pass", "counts"],
  ["count over the keys", "4 tickets are open.", "reject", "counts"],
  ["count over 12 stays strict", "13 tickets are open.", "reject", "counts"],
  ["days stay strict in counts", "9 days late.", "reject", "counts"],
  ["percent stays strict in counts", "70% done.", "reject", "counts"],
  ["count derived from bullets", "3 items listed.", "pass", "counts"],
  // people
  ["supplied person", "Ask Tay Nguyen.", "pass"],
  ["supplied first name", "Ask Priya.", "pass"],
  ["invented @mention", "Ask @marcus.", "reject"],
  ["invented person in context", "Ask Marcus Wright.", "reject"],
  ["invented person said", "Marcus Wright replied that it is fine.", "reject"],
  ["invented person assigned to", "This is assigned to Marcus Wright.", "reject"],
  ["Go Live is not a person", "The Go Live step is ready.", "pass"],
  ["Slack Channel is not a person", "Post it to the Slack Channel.", "pass"],
  ["Happy Path is not a person", "Test the Happy Path first.", "pass"],
  ["capitalised phrase after 'from' that is supplied", "From Priya Shah we need the spec.", "pass"],
  ["unknown capitalised pair without context", "The Release Candidate is ready.", "pass"],
  // mixed vn
  ["vn full sentence", "WF-12 bị chặn bởi API team, hạn ngày 27/10, đã 3 days.", "pass"],
  ["vn full sentence wrong date", "WF-12 bị chặn bởi API team, hạn ngày 29/10.", "reject"],
  ["vn key + date ok", "Nhắc Tay Nguyen về WF-13 trước ngày 27 tháng 10.", "pass"],
  ["vn fraction not a date", "Đã xong 3/5 việc.", "pass"],
];
{
  const group = "D2 golden table (EN + VN)";
  ok(group, cases.length >= 60, `the table has ${cases.length} cases (>= 60)`);
  for (const [name, text, expect, policy] of cases) {
    const r = checkGrounding({ text }, FACTS, policy ?? "strict");
    ok(group, (expect === "pass") === r.ok, `${name}: "${text}" -> ${r.ok ? "pass" : "reject (" + r.violations.join("; ") + ")"}`);
  }
  const r = checkGrounding({ text: "WF-99 due 28/10 with 77 items, ask @zed" }, FACTS);
  ok(group, r.kinds.length === r.violations.length && ["key", "date", "number", "person"].every((k) => r.kinds.includes(k as never)), "every violation carries its kind (key/date/number/person)");
}

// ----- repair retry -----
const NOW = new Date("2026-10-05T09:00:00.000Z");
function ctx(key: string): IssueContext {
  return { key, projectKey: key.split("-")[0], summary: "Statement export", status: "In Progress", updated: "2026-10-04T10:00:00.000+0000", description: "Users need CSV export.", comments: [{ author: "Priya Shah", created: "2026-10-03T09:00:00.000Z", body: "Is PDF in scope too?" }], links: [], statusHistory: [], fetchedAt: "2026-10-04T12:00:00.000Z" };
}
const settings = { ...DEFAULT_AI_DATA_PROTECTION, allowedProjectKeys: ["PAY"], previewSeenProjects: { PAY: "2026-10-01T00:00:00.000Z" } };
const built = buildTicketAiInput(ctx("PAY-1"), settings);
const input = { ticket: built.allowed ? built.input : undefined, today: "2026-10-05" };
const good = { whatIsAsked: "CSV export of statements.", currentState: "In Progress.", waitingOn: [{ who: "Priya Shah", what: "answer" }], openQuestions: ["Is PDF in scope too?"], suggestedNextStep: "Reply to Priya Shah." };
function model(answers: string[]) {
  const calls: ModelCallParams[] = [];
  return { calls, callModel: async (p: ModelCallParams): Promise<ModelCallResult> => { calls.push(JSON.parse(JSON.stringify(p))); return { stopReason: "end_turn", text: answers[Math.min(calls.length - 1, answers.length - 1)], usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 } }; } };
}
const mkDeps = (m: ReturnType<typeof model>, ledger = new MemoryUsageLedger(), env: AiServerDeps["env"] = {}): AiServerDeps => ({ env, callModel: m.callModel, ledger, now: () => NOW, cache: new ResponseCache() });

{
  const group = "D2 schema-repair retry";
  const verbose = { ...good, whatIsAsked: "x".repeat(1150) }; // 15% over the 1000 max
  const m = model([JSON.stringify(verbose), JSON.stringify(good)]);
  const ledger = new MemoryUsageLedger();
  const r = await handleAiRequest({ task: "generateTicketBrief", input }, mkDeps(m, ledger));
  ok(group, r.status === 200 && m.calls.length === 2, `a verbose-but-valid answer is repaired in ONE extra call (status ${r.status}, calls ${m.calls.length})`);
  const repairMsg = m.calls[1].messages[m.calls[1].messages.length - 1].content;
  ok(group, /whatIsAsked/.test(repairMsg) && /fixing only these/.test(repairMsg) && !repairMsg.includes("xxxxxxxxxx"), "the repair request lists the failing path + message, never the model text");
  const recs = await ledger.listDays(["2026-10-05"]);
  ok(group, recs.some((x) => x.outcome === "schema-retry" && x.errorKind === "schema") && recs.some((x) => x.outcome === "ok" && x.repaired === true), "telemetry: schema-retry then repaired ok");
  const m2 = model([JSON.stringify(verbose)]);
  const r2 = await handleAiRequest({ task: "generateTicketBrief", input }, mkDeps(m2));
  ok(group, r2.status === 502 && r2.body.errorKind === "invalid-output" && m2.calls.length === 2, "a repair that fails again -> 502 invalid-output, no third call");
  const m3 = model(["not json"]);
  const r3 = await handleAiRequest({ task: "generateTicketBrief", input }, mkDeps(m3));
  ok(group, r3.status === 502 && m3.calls.length === 1, "non-JSON is not repaired (no schema issues to list)");
  const inv = { ...good, suggestedNextStep: "Close PAY-77 first." };
  const m4 = model([JSON.stringify(inv)]);
  const ledger4 = new MemoryUsageLedger();
  const r4 = await handleAiRequest({ task: "generateTicketBrief", input }, mkDeps(m4, ledger4));
  const recs4 = await ledger4.listDays(["2026-10-05"]);
  ok(group, r4.status === 422 && m4.calls.length === 2 && recs4.some((x) => x.outcome === "grounding-rejected" && x.violationKinds?.includes("key")), "grounding fails twice -> 422 as before, logged with violationKinds");
  // cap re-checked before the repair call
  const capLedger = new MemoryUsageLedger();
  const m5 = model([JSON.stringify(verbose), JSON.stringify(good)]);
  const r5 = await handleAiRequest({ task: "generateTicketBrief", input }, mkDeps(m5, capLedger, { AI_DAILY_TOKEN_CAP: "150" }));
  ok(group, r5.status === 429 && m5.calls.length === 1, `at the cap boundary the repair call is refused (status ${r5.status}, calls ${m5.calls.length})`);
}

// ----- schema limits in prompts -----
{
  const group = "D2 schema limits in prompts";
  const tasks = aiTaskSchema.options;
  ok(group, tasks.every((t) => t in GROUNDING_POLICY), "every task has a documented grounding policy");
  ok(group, schemaLimits(TASK_OUTPUT_SCHEMAS.generateTicketBrief).some((l) => l.includes("whatIsAsked") && l.includes("1000")), "limits are read from the Zod schema (whatIsAsked <= 1000)");
  ok(group, schemaLimits(TASK_OUTPUT_SCHEMAS.generateTicketBrief).some((l) => l.includes("waitingOn") && l.includes("10 items")), "array sizes are listed too");
  const missing = tasks.filter((t) => schemaLimitsText(TASK_OUTPUT_SCHEMAS[t] as never) === "");
  ok(group, missing.length === 0, `every task's output schema yields limits (missing: ${missing.join(", ") || "none"})`);
  const p = buildTaskPrompt("generateTicketBrief", input);
  ok(group, /OUTPUT LIMITS/.test(p) && p.indexOf("REQUIRED OUTPUT SCHEMA") < p.indexOf("OUTPUT LIMITS"), "the built prompt carries the limits after the REQUIRED OUTPUT SCHEMA section");
}

// ----- telemetry -----
{
  const group = "D2 telemetry";
  const rec = (over: Partial<AiUsageRecord>): AiUsageRecord => ({ id: String(Math.random()), at: NOW.toISOString(), day: "2026-10-05", task: "generateTicketBrief", model: "m", tier: "default", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, cached: false, outcome: "ok", ...over });
  const records = [rec({}), rec({ outcome: "grounding-rejected", violationKinds: ["date", "number"] }), rec({ outcome: "grounding-rejected", violationKinds: ["date"] }), rec({ cached: true }), rec({ task: "rewriteReport", outcome: "ok", repaired: true })];
  const h = healthByTask(records);
  const t = h.find((x) => x.task === "generateTicketBrief")!;
  ok(group, t.calls === 3 && t.byOutcome.ok === 1 && t.byOutcome["grounding-rejected"] === 2 && t.topViolations[0].kind === "date" && t.topViolations[0].count === 2, "per task: counts by outcome (cached excluded) and top violation kinds");
  ok(group, h.find((x) => x.task === "rewriteReport")!.repaired === 1, "repaired answers are counted");
  const summary = summarizeUsage(records, 1000, NOW, "memory");
  ok(group, summary.today.calls === 5, "old records (no new fields) still summarise");
}
