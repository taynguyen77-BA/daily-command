// V2.38 J1–J6 — BA requirement check, AI blocker follow-ups, Release Go/No-Go, meeting notes →
// actions, natural-language commands, weekly insights. Offline: fake model / store / data.

import fs from "node:fs";
import path from "node:path";
import { ok } from "./harness.mts";
import type { IssueContext } from "../../src/lib/command-center/jira/issue-context";
import { DEFAULT_AI_DATA_PROTECTION, buildTicketAiInput, type AiDataProtectionSettings } from "../../src/lib/command-center/ai/data-protection";
import { handleAiRequest, ResponseCache, type ModelCallParams, type ModelCallResult, type AiServerDeps } from "../../src/lib/command-center/ai/server-runner";
import { MemoryUsageLedger } from "../../src/lib/command-center/ai/usage-ledger";
import { aiTaskTier } from "../../src/lib/command-center/ai/model-config";
import { isGherkin, quoteFound } from "../../src/lib/command-center/ai/task-registry";
import { baCheckToCsv, baCheckToMarkdown, deGherkin, normalizeBaCheck, runBaRequirementCheck, ticketSourceText, BA_CHECK_TYPES } from "../../src/lib/command-center/ai/ba-requirements";
import { buildFollowUpInput, deadlineOptionsFor } from "../../src/lib/command-center/ai/blocker-followups-ai";
import { allowedRecommendations, buildReleaseBriefInput, checkReleaseBrief, deterministicReleaseBrief, runReleaseBrief } from "../../src/lib/command-center/ai/release-brief";
import { applyMeetingReview, toMeetingReview } from "../../src/lib/command-center/ai/meeting-actions";
import { applyCommandPlan, looksLikeCommand, parseCommandDeterministic, planCommand, resolveCommand } from "../../src/lib/command-center/ai/nl-commands";
import { resolveWhen } from "../../src/lib/command-center/ai/when";
import { buildWeeklyFacts, generateWeeklyInsights, weeklyInsightsText } from "../../src/lib/command-center/ai/weekly-insights";
import { MockAIProvider } from "../../src/lib/command-center/ai/provider";
import { planJiraComment } from "../../src/lib/command-center/jira/write-back";
import { applyTicketStatus } from "../../src/lib/command-center/ticket-work-state";
import { selectReleaseHealth } from "../../src/lib/command-center/release-health";
import { RedactionSession } from "../../src/lib/command-center/ai/redaction";
import { emptyData, DEFAULT_FEATURE_TOGGLES, DEFAULT_JIRA_WRITE_BACK_SETTINGS, type CommandCenterData, type TicketWorkState, type TicketWorkStatus, type TicketStatusSurface, type WorkItem } from "../../src/lib/command-center/types";
import type { BaRequirementCheckResponse, ReleaseBriefResponse } from "../../src/lib/command-center/ai/schemas";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const TODAY = "2026-10-05"; // Monday
const NOW = new Date("2026-10-05T09:00:00.000Z");
const settings: AiDataProtectionSettings = { ...DEFAULT_AI_DATA_PROTECTION, allowedProjectKeys: ["PAY"], customTerms: [{ term: "Acme Bank", alias: "Client A" }], previewSeenProjects: { PAY: "2026-10-01" } };

function fakeModel(answers: string[]) {
  const calls: ModelCallParams[] = [];
  return {
    calls,
    callModel: async (p: ModelCallParams): Promise<ModelCallResult> => {
      calls.push(JSON.parse(JSON.stringify(p)));
      return { stopReason: "end_turn", text: answers[Math.min(calls.length - 1, answers.length - 1)], usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    },
  };
}
const deps = (m: ReturnType<typeof fakeModel>): AiServerDeps => ({ env: {}, callModel: m.callModel, ledger: new MemoryUsageLedger(), now: () => NOW, cache: new ResponseCache() });

function wi(key: string, over: Partial<WorkItem> = {}): WorkItem {
  return { id: `w-${key}`, key, title: `Title ${key}`, projectId: "p-pay", clientId: "c1", type: "story", status: "To Do", priority: "P3", createdDate: "2026-09-01", lastUpdated: "2026-10-01", blocked: false, dependencyIds: [], riskIds: [], scopeChangeCount: 0, sourceType: "jira", ...over } as WorkItem;
}
function data(items: WorkItem[]): CommandCenterData {
  return { ...emptyData(), workItems: items, projects: [{ id: "p-pay", name: "Payments Web", clientId: "c1" } as never, { id: "p-wf", name: "Workflow", clientId: "c1" } as never] };
}
function fakeStore() {
  let states: Record<string, TicketWorkState> = {};
  const decisions: unknown[] = [];
  const actions: { title: string; dueDate?: string; relatedWorkItemId?: string }[] = [];
  return {
    decisions,
    actions,
    get states() {
      return states;
    },
    set states(v) {
      states = v;
    },
    setTicketStatus(key: string, status: TicketWorkStatus, opts: { surface: TicketStatusSurface; reason?: string; until?: string }) {
      const r = applyTicketStatus(states, key, status, opts, NOW.toISOString());
      states = r.states;
      return r.changed;
    },
    addDecision(d: unknown) {
      decisions.push(d);
      return `d${decisions.length}`;
    },
    addAction(a: { title: string; dueDate?: string; relatedWorkItemId?: string }) {
      actions.push(a);
      return `a${actions.length}`;
    },
  };
}

const ctx = (over: Partial<IssueContext> = {}): IssueContext => ({
  key: "PAY-1",
  projectKey: "PAY",
  summary: "Statement export for Acme Bank",
  status: "To Do",
  updated: "2026-10-04T10:00:00Z",
  description: "Users must be able to export monthly statements as CSV.\nGiven a signed-in user, when they click Export, then the CSV downloads.\nThe file should include all transactions of the month.",
  comments: [{ author: "Priya Shah", created: "2026-10-03T09:00:00Z", body: "Should PDF be supported too?" }],
  links: [{ key: "PAY-9", summary: "Statement API", status: "In Progress", relation: "is blocked by" }],
  statusHistory: [],
  fetchedAt: "2026-10-04T12:00:00Z",
  ...over,
});

{
  const group = "V2.38 Toggles";
  const keys = ["baRequirementCheck", "aiBlockerFollowUp", "releaseGoNoGo", "meetingNotesActions", "nlCommands", "weeklyInsights"] as const;
  ok(group, keys.every((k) => DEFAULT_FEATURE_TOGGLES[k] === false), "all six are off by default");
  const ds = read("src/app/data-settings/page.tsx");
  ok(group, keys.every((k) => ds.includes(`key: "${k}"`)), "each has a Data & Settings switch");
  const readme = read("README.md");
  ok(group, ["Requirement check", "Go/No-Go", "Meeting notes", "Command Bar commands", "Weekly insights", "AI blocker follow-ups"].every((t) => readme.includes(t)), "README documents all six");
}

// ===== J1 =====
{
  const group = "V2.38 J1 BA requirement check";
  ok(group, aiTaskTier("baRequirementCheck") === "deep" && BA_CHECK_TYPES.has("story") && BA_CHECK_TYPES.has("task") && !BA_CHECK_TYPES.has("bug"), "deep tier, Story/Task only");
  ok(group, isGherkin("Given a user, when they log in, then they see the dashboard") && isGherkin("When the form is empty") && isGherkin("Then an error shows") && isGherkin("And the CSV downloads") && !isGherkin("An error shows when the form is empty"), "Gherkin detector: Given/When/Then phrasing, not an ordinary 'when'");
  const built = buildTicketAiInput(ctx(), settings);
  const ticket = built.allowed ? built.input : (undefined as never);
  const src = ticketSourceText(ticket);

  // AC test — the deterministic output (no AI) contains no Given/When/Then, even with a Gherkin description.
  const mock = await new MockAIProvider().baRequirementCheck(ticket);
  ok(group, mock.acceptanceCriteria.length > 0 && mock.acceptanceCriteria.every((a) => !isGherkin(a.text)), "AC output contains no Given/When/Then phrasing (deterministic)");
  ok(group, mock.acceptanceCriteria.every((a) => a.source.kind === "assumption" || quoteFound(a.source.quote, src)), "each AC item is traceable to a ticket sentence or flagged assumption (deterministic)");
  ok(group, (["happy-path", "validation", "error", "edge-case"] as const).every((c) => mock.acceptanceCriteria.some((a) => a.category === c)), "covers happy path, validation, error and edge cases");

  // Server: Gherkin or an untraceable quote → violation (retry, then 422).
  const gherkin: BaRequirementCheckResponse = { acceptanceCriteria: [{ text: "Given a user, when they export, then a CSV downloads", category: "happy-path", source: { kind: "description", quote: "Users must be able to export monthly statements as CSV." } }], questionsByStakeholder: [], missingInformation: [], risks: [] };
  const m1 = fakeModel([JSON.stringify(gherkin), JSON.stringify(gherkin)]);
  const r1 = await handleAiRequest({ task: "baRequirementCheck", input: { ticket } }, deps(m1));
  ok(group, r1.status === 422 && (r1.body.violations as string[]).some((v) => /Given\/When\/Then/.test(v)), "the server rejects Given/When/Then acceptance criteria");
  const invented: BaRequirementCheckResponse = { acceptanceCriteria: [{ text: "Export completes in under two seconds", category: "happy-path", source: { kind: "description", quote: "Exports must finish quickly for every customer" } }], questionsByStakeholder: [], missingInformation: [], risks: [] };
  const m2 = fakeModel([JSON.stringify(invented), JSON.stringify(invented)]);
  const r2 = await handleAiRequest({ task: "baRequirementCheck", input: { ticket } }, deps(m2));
  ok(group, r2.status === 422 && (r2.body.violations as string[]).some((v) => v.includes("not in the ticket")), "the server rejects an item quoting text that isn't in the ticket");
  const good: BaRequirementCheckResponse = {
    acceptanceCriteria: [
      { text: "Export downloads a CSV of the month's statements", category: "happy-path", source: { kind: "description", quote: "Users must be able to export monthly statements as CSV." } },
      { text: "Export is unavailable when the user is signed out", category: "validation", source: { kind: "assumption" } },
    ],
    questionsByStakeholder: [{ stakeholder: "Priya Shah", questions: ["Should PDF be supported too?"] }],
    missingInformation: ["File naming convention"],
    risks: ["PAY-9 is still in progress"],
  };
  ok(group, (await handleAiRequest({ task: "baRequirementCheck", input: { ticket } }, deps(fakeModel([JSON.stringify(good)])))).status === 200, "a checklist with verbatim quotes / assumptions passes");

  // Browser normalizer: whatever arrives, the contract holds.
  const n = normalizeBaCheck({ ...good, acceptanceCriteria: [...good.acceptanceCriteria, { text: "When saving, then it works", category: "error", source: { kind: "comment", quote: "never said" } }] }, src);
  const last = n.acceptanceCriteria[2];
  ok(group, !isGherkin(last.text) && last.source.kind === "assumption", "the browser rewrites Gherkin and flags an untraceable item as assumption");
  ok(group, deGherkin("Given a user, when they click Export, then the CSV downloads").toLowerCase().includes("csv downloads") && !isGherkin(deGherkin("Given a, when b, then c")), "deGherkin keeps the meaning without the keywords");

  // Flow: allow-list + aliases.
  const provider = { mode: "claude" as const, baRequirementCheck: async () => ({ ...good, risks: ["Client A depends on PAY-9"] }) };
  const done = await runBaRequirementCheck(ctx(), settings, provider);
  ok(group, done.kind === "done" && done.result.risks[0] === "Acme Bank depends on PAY-9", "runs through the allow-list gate; aliases restored");
  const off = await runBaRequirementCheck(ctx({ key: "OPS-1", projectKey: "OPS" }), settings, provider);
  ok(group, off.kind === "disabled", "allowed projects only");

  // Exports.
  const md = baCheckToMarkdown("PAY-1", good);
  ok(group, md.includes("- [ ] Export downloads a CSV") && md.includes("_(assumption)_") && md.includes("**Priya Shah**") && !/given|then/i.test(md.split("### Clarification")[0]), "Markdown: checklist, assumptions marked, questions by stakeholder");
  const csv = baCheckToCsv("PAY-1", { ...good, risks: ['=HYPERLINK("x")', 'He said "ok", fine'] });
  ok(group, csv.startsWith("﻿") && csv.includes("\r\n") && csv.split("\r\n")[0] === '﻿"Ticket","Type","Category / Stakeholder","Item","Source"', "CSV is Excel-compatible: BOM, CRLF, quoted header");
  ok(group, csv.includes(`"'=HYPERLINK(""x"")"`) && csv.includes('"He said ""ok"", fine"'), "CSV escapes quotes and neutralizes formulas");
  const ws = { ...DEFAULT_JIRA_WRITE_BACK_SETTINGS, projects: ["PAY"] };
  ok(group, planJiraComment({ features: { jiraWriteBack: false }, settings: ws, ticketKey: "PAY-1", text: md }) === null && planJiraComment({ features: { jiraWriteBack: true }, settings: ws, ticketKey: "PAY-1", text: md })?.trigger === "comment", "posting is only a write-back proposal (feature on + allow-listed), confirmed in the dialog");
  ok(group, /proposeJiraComment\(/.test(read("src/components/command-center/BaRequirementCheck.tsx")) && !/sendJiraWrite/.test(read("src/components/command-center/BaRequirementCheck.tsx")), "the panel never writes directly");
}

// ===== J2 =====
{
  const group = "V2.38 J2 AI blocker follow-up";
  let states: Record<string, TicketWorkState> = {};
  states = applyTicketStatus(states, "PAY-1", "BLOCKED", { surface: "my-work", reason: "Waiting on API spec" }, "2026-09-28T09:00:00Z").states;
  states = applyTicketStatus(states, "OPS-2", "BLOCKED", { surface: "my-work", reason: "Ops sign-off" }, "2026-10-02T09:00:00Z").states;
  const d = { workItems: [wi("PAY-1", { title: "Export for Acme Bank" }), wi("OPS-2", { projectId: "p-ops" })], dependencies: [{ id: "dep1", workItemId: "w-PAY-1", dependsOnTeam: "API team", description: "Statement API spec", status: "unresolved" } as never] };
  const mentions = [
    { issueKey: "PAY-1", commentId: "c1", commentAuthor: "Tom", excerpt: "Spec ETA unknown", mentionedAt: "2026-10-04T08:00:00Z" },
    { issueKey: "OPS-2", commentId: "c2", commentAuthor: "Ann", excerpt: "secret ops detail", mentionedAt: "2026-10-04T08:00:00Z" },
  ];
  const built = buildFollowUpInput({ states, data: d, mentionEvents: mentions, settings, slaBusinessDays: 2, today: TODAY, channel: "slack" })!;
  const api = built.input.people.find((p) => p.person === "API team")!;
  ok(group, !!api && api.tickets[0].key === "PAY-1" && api.tickets[0].ageBusinessDays === 5 && api.tickets[0].overSla, "grouped by person (Needs From Others rows) with age and SLA");
  ok(group, api.tickets[0].lastComment?.includes("Spec ETA unknown") === true && api.tickets[0].title.includes("Client A"), "last comment for allowed projects; redacted");
  const unknown = built.input.people.find((p) => p.person === "Unknown")!;
  ok(group, unknown.tickets[0].key === "OPS-2" && unknown.tickets[0].lastComment === undefined, "no comment text from non-allowed projects");
  ok(group, built.input.deadlineOptions.join() === deadlineOptionsFor(TODAY).join() && deadlineOptionsFor(TODAY).includes("2026-10-09"), "deadlines are offered dates (e.g. this Friday)");
  const bad = JSON.stringify({ messages: [{ person: "Bob", text: "hi", suggestedDeadline: "2026-12-31" }] });
  const r = await handleAiRequest({ task: "draftBlockerFollowUps", input: built.input }, deps(fakeModel([bad, bad])));
  ok(group, r.status === 422 && (r.body.violations as string[]).some((v) => v.includes("Bob")) && (r.body.violations as string[]).some((v) => v.includes("deadline")), "a message to someone not listed, or an invented deadline, is rejected");
  const mock = await new MockAIProvider().draftBlockerFollowUps(built.input);
  ok(group, mock.messages.length === 2 && mock.messages.some((m) => m.person === "team") && mock.messages.every((m) => m.suggestedDeadline === built.input.deadlineOptions[0]), "deterministic: one message per person, 'team' for no owner");
  const comp = read("src/components/command-center/AiFollowUpDrafter.tsx");
  ok(group, /confirming === m\.person/.test(comp) && /Yes, send/.test(comp) && /proposeJiraComment\(/.test(comp) && /emailDraftUrl\(/.test(comp), "send only after confirm, through existing channels (Slack confirm, write-back dialog, email draft)");
  ok(group, /<AiFollowUpDrafter/.test(read("src/components/command-center/AskFollowUp.tsx")), "offered alongside the existing Ask");
}

// ===== J3 =====
{
  const group = "V2.38 J3 Release Go/No-Go";
  // The rule table.
  const t = (readiness: "READY" | "AT_RISK" | "NOT_READY", hp: number, p1: number) => allowedRecommendations({ readiness, highPriorityIncompleteCount: hp }, p1).allowed.join("|");
  ok(group, t("READY", 0, 1) === "No-Go" && t("AT_RISK", 0, 1) === "No-Go" && t("NOT_READY", 0, 1) === "No-Go", "rule: an open P1 blocker → No-Go only (never Go)");
  ok(group, t("NOT_READY", 0, 0) === "No-Go", "rule: NOT_READY → No-Go only");
  ok(group, t("AT_RISK", 0, 0) === "Go with conditions|No-Go", "rule: AT_RISK → no unconditional Go");
  ok(group, t("READY", 2, 0) === "Go with conditions|No-Go", "rule: READY with open P1/P2 → no unconditional Go");
  ok(group, t("READY", 0, 0) === "Go|Go with conditions|No-Go", "rule: READY and nothing high-priority open → any");

  const items = [
    wi("PAY-1", { fixVersion: "2.4", priority: "P1", blocked: true, status: "Blocked", blockerReason: "Bank API" }),
    wi("PAY-2", { fixVersion: "2.4", priority: "P3", status: "Done" }),
    wi("PAY-3", { fixVersion: "2.4", priority: "P2", status: "In Progress" }),
  ];
  const dd = data(items);
  const health = selectReleaseHealth(dd, "2.4", TODAY);
  const { input, session } = buildReleaseBriefInput(health, dd, undefined, []);
  ok(group, input.facts.openP1BlockerCount === 1 && input.allowedRecommendations.join() === "No-Go", "an open P1 blocker in the release limits the brief to No-Go");
  const go: ReleaseBriefResponse = { recommendation: "Go", conditions: [], evidence: ["PAY-1"], risks: [], communicationDraft: "Release 2.4 can ship." };
  const sr = await handleAiRequest({ task: "releaseGoNoGo", input }, deps(fakeModel([JSON.stringify(go), JSON.stringify(go)])));
  ok(group, sr.status === 422 && (sr.body.violations as string[]).some((v) => v.includes("contradicts the readiness rules")), "the server rejects a recommendation that contradicts the rules");
  ok(group, checkReleaseBrief(go, input).length > 0, "the browser re-checks it too");
  const fallback = await runReleaseBrief(input, session, { mode: "claude", releaseGoNoGo: async () => go });
  ok(group, !fallback.usedAi && fallback.brief.recommendation === "No-Go" && /broke a rule/.test(fallback.notice ?? ""), "a contradicting answer falls back to the deterministic brief with a notice");
  const numbers: ReleaseBriefResponse = { recommendation: "No-Go", conditions: [], evidence: ["PAY-1"], risks: [], communicationDraft: "Release 2.4 is 80% done." };
  ok(group, checkReleaseBrief(numbers, input).some((v) => v.includes("80")), "numbers are locked to the facts");
  ok(group, checkReleaseBrief({ ...numbers, communicationDraft: "Release 2.4 is not ready: PAY-1 is blocked.", evidence: ["PAY-77"] }, input).some((v) => v.includes("PAY-77")), "evidence must be the release's open items");
  for (const readiness of ["READY", "AT_RISK", "NOT_READY"] as const) {
    for (const p1 of [0, 1]) {
      for (const hp of [0, 1]) {
        const allowed = allowedRecommendations({ readiness, highPriorityIncompleteCount: hp }, p1).allowed;
        const det = deterministicReleaseBrief({ ...input, facts: { ...input.facts, readiness, openP1BlockerCount: p1, highPriorityIncompleteCount: hp }, allowedRecommendations: allowed });
        if (!allowed.includes(det.recommendation)) ok(group, false, `deterministic brief contradicts rules for ${readiness}/${p1}/${hp}`);
      }
    }
  }
  ok(group, true, "the deterministic brief never contradicts the rule table (all 12 combinations)");
  ok(group, aiTaskTier("releaseGoNoGo") === "deep", "deep tier");
  ok(group, /<ReleaseGoNoGo/.test(read("src/components/command-center/ReleaseHealthPanel.tsx")), "on Release Health cards");
}

// ===== J4 =====
{
  const group = "V2.38 J4 Meeting notes → actions";
  const known = new Set(["PAY-1", "PAY-3"]);
  const review = toMeetingReview(
    {
      decisions: [{ title: "Ship CSV first" }],
      actions: [{ title: "Send API spec", owner: "Tom", due: "Friday", relatedTicketKey: "PAY-1" }, { title: "Check FAKE-9 status", relatedTicketKey: "FAKE-9" }],
      statusChanges: [{ ticketKey: "PAY-3", status: "DEFERRED", when: "next week", reason: "after release" }, { ticketKey: "NOPE-1", status: "DONE" }],
      openQuestions: ["Is PDF in scope?"],
    },
    known,
    TODAY
  );
  ok(group, review.droppedKeys.join() === "FAKE-9,NOPE-1" && review.statusChanges.length === 1 && !review.actions[1].relatedTicketKey, "unknown ticket keys are dropped (listed), never created");
  ok(group, review.actions[0].dueDate === "2026-10-09" && review.statusChanges[0].until === "2026-10-12", "dates resolved from the notes' words (Friday, next week)");
  const store = fakeStore();
  ok(group, store.decisions.length === 0 && store.actions.length === 0 && Object.keys(store.states).length === 0, "nothing is created before confirm");
  const reviewed = { ...review, actions: review.actions.map((a, i) => (i === 1 ? { ...a, selected: false } : { ...a, title: "Send API spec v2" })) };
  const res = applyMeetingReview(store, reviewed, { today: TODAY, meetingLabel: "standup", projectIdFor: () => "p-pay", workItemIdFor: (k) => `w-${k}` });
  ok(group, res.decisions === 1 && res.actions === 1 && res.statusChanges === 1 && store.actions[0].title === "Send API spec v2" && store.actions[0].relatedWorkItemId === "w-PAY-1", "Create selected: only ticked, edited items, via the normal store APIs");
  const h = store.states["PAY-3"].history.at(-1)!;
  ok(group, h.surface === "ai-meeting" && store.states["PAY-3"].until === "2026-10-12", "status changes recorded with surface ai-meeting");
  const mock = await new MockAIProvider().extractMeetingActions({ today: TODAY, notes: "- Decision: ship CSV first\n- Action: Tom to send the spec for PAY-1\n- Is PDF in scope?\nchit chat" });
  ok(group, mock.decisions[0].title === "ship CSV first" && mock.actions[0].owner === "Tom" && mock.actions[0].relatedTicketKey === "PAY-1" && mock.openQuestions[0] === "Is PDF in scope?" && mock.statusChanges.length === 0, "without AI: only explicit Decision/Action lines and questions");
  ok(group, /<MeetingNotesActions/.test(read("src/components/command-center/MeetingModePanel.tsx")), "in Meeting Mode");
}

// ===== J5 =====
{
  const group = "V2.38 J5 Commands";
  const d = data([wi("WF-1", { projectId: "p-wf" }), wi("WF-2", { projectId: "p-wf" }), wi("MCWS-123", { projectId: "p-pay" }), wi("PAY-1")]);
  const mentions = [
    { issueKey: "WF-1", commentId: "m1", excerpt: "x", mentionedAt: "2026-10-04T00:00:00Z" },
    { issueKey: "WF-2", commentId: "m2", excerpt: "y", mentionedAt: "2026-10-04T00:00:00Z" },
    { issueKey: "PAY-1", commentId: "m3", excerpt: "z", mentionedAt: "2026-10-04T00:00:00Z" },
  ];
  const ctxC = { data: d, states: {}, mentionEvents: mentions, repliedCommentIds: new Set(["m2"]), newKeys: [], today: TODAY };
  ok(group, resolveWhen("Monday", TODAY) === "2026-10-12" && resolveWhen("tomorrow", TODAY) === "2026-10-06" && resolveWhen("someday", TODAY) === undefined, "dates are resolved deterministically (Monday on a Monday = next week)");
  ok(group, looksLikeCommand("defer all WF mentions to Monday") && looksLikeCommand("block MCWS-123 waiting for API spec") && !looksLikeCommand("What should I focus on today?"), "commands are told apart from questions");

  const p1 = resolveCommand(parseCommandDeterministic("defer all WF mentions to Monday"), ctxC);
  ok(group, p1.kind === "preview" && p1.operations.length === 1 && p1.operations[0].op === "setTicketStatus" && p1.operations[0].ticketKey === "WF-1" && p1.operations[0].status === "DEFERRED" && p1.operations[0].until === "2026-10-12", "'defer all WF mentions to Monday' → a preview of exactly the open WF mentions (answered ones excluded)");
  const p2 = resolveCommand(parseCommandDeterministic("block MCWS-123 waiting for API spec"), ctxC);
  ok(group, p2.kind === "preview" && p2.operations[0].op === "setTicketStatus" && p2.operations[0].status === "BLOCKED" && p2.operations[0].reason === "waiting for API spec", "'block MCWS-123 waiting for API spec' → one BLOCKED change with the reason");

  // Allow-listed operations only.
  const evil = { operations: [{ op: "deleteTicket", target: { kind: "ticket", ticketKey: "PAY-1" } }] } as never;
  const pe = resolveCommand(evil, ctxC);
  ok(group, pe.kind === "clarify", "an operation outside the allow-list is never produced");
  const sr = await handleAiRequest({ task: "parseCommand", input: { today: TODAY, command: "delete PAY-1", knownProjects: [] } }, deps(fakeModel([JSON.stringify({ operations: [{ op: "deleteTicket" }] })])));
  ok(group, sr.status === 502 && sr.body.errorKind === "invalid-output", "the server's schema rejects any non-allow-listed op");
  ok(group, read("src/lib/command-center/ai/schemas/index.ts").includes('export const COMMAND_OPS = ["setTicketStatus", "addAction"] as const;'), "the allow-list: setTicketStatus, addAction");

  // Ambiguity → clarification, never a guess.
  const twoProjects = { ...ctxC, data: data([wi("WF-1", { projectId: "p-wf" }), wi("PAY-1")]) };
  twoProjects.data.projects = [{ id: "p-wf", name: "Web Platform" } as never, { id: "p-pay", name: "Web Payments" } as never];
  const amb = resolveCommand({ operations: [{ op: "setTicketStatus", status: "SKIPPED", target: { kind: "mentions", project: "web" } }] }, twoProjects);
  ok(group, amb.kind === "clarify" && /several projects/.test(amb.question), "a project name matching two projects asks which one");
  const unk = resolveCommand(parseCommandDeterministic("block ZZZ-9 waiting"), ctxC);
  ok(group, unk.kind === "clarify" && /can't find ticket ZZZ-9/.test(unk.question), "an unknown ticket asks instead of guessing");
  const when = resolveCommand(parseCommandDeterministic("defer PAY-1 to someday"), ctxC);
  ok(group, when.kind === "clarify" && /When is/.test(when.question), "an unresolvable date asks");
  const vague = resolveCommand(parseCommandDeterministic("defer stuff to Monday"), ctxC);
  ok(group, vague.kind === "clarify", "no target → clarification");
  const modelAsks = resolveCommand({ operations: [], clarification: "Which WF tickets?" }, ctxC);
  ok(group, modelAsks.kind === "clarify" && modelAsks.question === "Which WF tickets?", "the model's own clarification is shown");
  const sv = await handleAiRequest({ task: "parseCommand", input: { today: TODAY, command: "block MCWS-123", knownProjects: [] } }, deps(fakeModel([JSON.stringify({ operations: [{ op: "setTicketStatus", status: "BLOCKED", target: { kind: "ticket", ticketKey: "PAY-1" } }] }), JSON.stringify({ operations: [{ op: "setTicketStatus", status: "BLOCKED", target: { kind: "ticket", ticketKey: "PAY-1" } }] })])));
  ok(group, sv.status === 422, "a target the command didn't name is rejected server-side");

  // Apply = normal store APIs, nothing before.
  const store = fakeStore();
  const plan = await planCommand("defer all WF mentions to Monday", ctxC, new MockAIProvider(), [{ key: "WF" }]);
  ok(group, Object.keys(store.states).length === 0 && plan.kind === "preview", "a preview changes nothing");
  if (plan.kind === "preview") applyCommandPlan(store, plan.operations, "defer all WF mentions to Monday", (k) => `w-${k}`);
  ok(group, store.states["WF-1"]?.status === "DEFERRED" && store.states["WF-1"].history.at(-1)!.surface === "ai-command", "Apply runs setTicketStatus (surface ai-command)");
  const act = resolveCommand(parseCommandDeterministic("add action: chase the spec for PAY-1 by friday"), ctxC);
  ok(group, act.kind === "preview" && act.operations[0].op === "addAction" && act.operations[0].ticketKey === "PAY-1" && act.operations[0].dueDate === "2026-10-09", "addAction with a ticket and a resolved due date");
  ok(group, aiTaskTier("parseCommand") === "fast", "fast tier");
  ok(group, /state\.features\.nlCommands && looksLikeCommand\(q\)/.test(read("src/components/command-center/CommandBar.tsx")), "wired into the Command Bar");
}

// ===== J6 =====
{
  const group = "V2.38 J6 Weekly insights";
  let states: Record<string, TicketWorkState> = {};
  states = applyTicketStatus(states, "PAY-1", "DONE", { surface: "my-work" }, "2026-10-05T08:00:00Z").states;
  states = applyTicketStatus(states, "PAY-2", "SKIPPED", { surface: "ai-triage", reason: "AI-suggested: Not my action" }, "2026-10-05T08:10:00Z").states;
  states = applyTicketStatus(states, "PAY-3", "BLOCKED", { surface: "my-work", reason: "API" }, "2026-10-05T08:20:00Z").states;
  states = applyTicketStatus(states, "PAY-9", "DONE", { surface: "my-work" }, "2026-09-20T08:00:00Z").states;
  const facts = buildWeeklyFacts({ states, data: { workItems: [wi("PAY-3")], dependencies: [] }, triageStats: { [TODAY]: { Do: { suggested: 4, accepted: 3 } } }, weekStart: TODAY, weekEnd: "2026-10-11" });
  ok(group, facts[0] === "Status changes this week: done 1, blocked 1, skipped 1.", "ticket history this week only");
  ok(group, facts.some((f) => f.includes('"Not my action" ×1')) && facts.some((f) => f.includes("Blocked waiting on") && f.includes("PAY-3")) && facts.some((f) => f.includes('"Do": 3 of 4')) && facts.some((f) => f.includes("ai-triage 1")), "skip reasons, blockers by person, triage acceptance, AI-applied changes");
  const stored = await generateWeeklyInsights({ facts, weekStart: TODAY, weekEnd: "2026-10-11", customTerms: [], provider: new MockAIProvider(), nowIso: NOW.toISOString() });
  ok(group, stored.insights.observations.length >= 1 && stored.insights.observations.length <= 5 && stored.insights.suggestions.length === 3 && stored.insights.observations.every((o) => o.evidence.length > 0), "observations with evidence, 3 suggestions");
  const invented = JSON.stringify({ observations: [{ text: "Blocked tickets rose to 7.", evidence: ["x"] }], suggestions: ["a"] });
  const r = await handleAiRequest({ task: "weeklyInsights", input: { weekStart: TODAY, weekEnd: "2026-10-11", facts } }, deps(fakeModel([invented, invented])));
  ok(group, r.status === 422, "an invented number is rejected");
  ok(group, weeklyInsightsText(stored).includes("Suggestions for next week:"), "renders for the weekly report");
  ok(group, /<WeeklyInsights \/>/.test(read("src/app/weekly-review/page.tsx")) && /includeInsights \? `\\n\\n\$\{weeklyInsightsText/.test(read("src/app/reports/page.tsx")), "shown in Weekly Review; optional in the weekly report copy");
  const s = new RedactionSession([{ term: "Acme Bank", alias: "Client A" }]);
  ok(group, s.redact("Acme Bank") === "Client A", "facts go through redaction aliases");
}
