// V2.36 H3 — server-built prompts. One entry per AI task: the task's structured INPUT schema
// (Zod), the prompt builder from ai/prompts/* that turns a validated input into the prompt, and
// the OUTPUT schema the model's answer must match. The route accepts only { task, input }: the
// browser never sends prompt text, so the endpoint can't be used as a free-form model proxy.
//
// Shared by both sides: the browser parses its input through the same schema before sending
// (which also strips every field a prompt doesn't read — less data leaves the browser), and the
// server parses it again before building anything.

import { z } from "zod";
import type { GroundingPolicy } from "./evaluation";
import { schemaLimitsText, schemaMaxChars } from "./schema-limits";
import { lockedFactViolations } from "./locked-facts";
import type { ArtifactType, ChangeEvent, DecisionConflictCandidate, Evidence, FollowUpContext, HealthTrend, PriorityScoreResult, Risk, WorkItem, Action } from "../types";
import type { WeeklyReviewFacts } from "../weekly-review";
import { actionOutcomePrompt } from "./prompts/action-outcome";
import { actionPlanPrompt } from "./prompts/action-plan";
import { changeAnalysisPrompt } from "./prompts/change-analysis";
import { communicationPrompt } from "./prompts/communication";
import { communicationArtifactPrompt } from "./prompts/communication-artifact";
import { dailyGuidancePrompt } from "./prompts/daily-guidance";
import { decisionConflictPrompt } from "./prompts/decision-conflict";
import { decisionOptionsPrompt } from "./prompts/decision-options";
import { endOfDayPrompt } from "./prompts/end-of-day";
import { outcomeInterpretationPrompt } from "./prompts/outcome-interpretation";
import { priorityAnalysisPrompt } from "./prompts/priority-analysis";
import { proactiveAssessmentPrompt } from "./prompts/proactive-assessment";
import { projectStoryPrompt } from "./prompts/project-story";
import { queryAnswerPrompt } from "./prompts/query-answer";
import { reportSummaryPolishPrompt } from "./prompts/report-summary-polish";
import { requirementCheckPrompt } from "./prompts/requirement-check";
import { ticketBriefPrompt } from "./prompts/ticket-brief";
import { triagePrompt } from "./prompts/triage";
import { mentionReplyPrompt } from "./prompts/mention-reply";
import { reportRewritePrompt } from "./prompts/report-rewrite";
import { baRequirementCheckPrompt } from "./prompts/ba-requirement-check";
import { blockerFollowUpsPrompt } from "./prompts/blocker-followups";
import { releaseGoNoGoPrompt } from "./prompts/release-go-no-go";
import { meetingActionsPrompt } from "./prompts/meeting-actions";
import { commandPrompt } from "./prompts/command";
import { weeklyInsightsPrompt } from "./prompts/weekly-insights";
import { riskAnalysisPrompt } from "./prompts/risk-analysis";
import { trendInterpretationPrompt } from "./prompts/trend-interpretation";
import { weeklyReviewPrompt } from "./prompts/weekly-review";
import { reportNarrativePrompt } from "./prompts/report-narrative";
import { narrativeViolations, type NarrativeFacts } from "../report-narrative";
import {
  assessmentResponseSchema,
  communicationArtifactResponseSchema,
  dailyGuidanceResponseSchema,
  decisionOptionsResponseSchema,
  outcomeInterpretationResponseSchema,
  proactiveAssessmentResponseSchema,
  projectStoryResponseSchema,
  queryAnswerResponseSchema,
  reasoningResponseSchema,
  requirementCheckResponseSchema,
  ticketBriefResponseSchema,
  triageResponseSchema,
  mentionReplyResponseSchema,
  reportRewriteResponseSchema,
  baRequirementCheckResponseSchema,
  followUpsResponseSchema,
  releaseBriefResponseSchema,
  meetingActionsResponseSchema,
  commandResponseSchema,
  weeklyInsightsResponseSchema,
  reportNarrativeResponseSchema,
  RELEASE_RECOMMENDATIONS,
  textResponseSchema,
  trendResponseSchema,
  type AITask,
} from "./schemas";

// ----- shared building blocks (bounded, so a request can never be unbounded) -----
const str = (max = 4000) => z.string().max(max);
const strList = (max = 200, len = 4000) => z.array(str(len)).max(max);
const num = z.number().finite();
const languageSchema = z.enum(["en", "vi"]);

const evidenceSchema = z.object({ content: str() });
const workItemSchema = z.object({ key: str(40), title: str(1000), status: str(200) });
const priorityResultSchema = z.object({
  score: num,
  classification: str(40),
  confidence: num,
  reasoning: str().optional(),
  factors: z.array(z.object({ name: str(200), contribution: num, max: num, detail: str(1000) })).max(30),
});
const actionSchema = z.object({ title: str(1000), why: str().optional() });
const titled = z.object({ title: str(1000) });
const riskSchema = z.object({ title: str(1000), level: str(40), confidence: num, reason: str(), potentialImpact: str(), mitigation: str() });
const changeSchema = z.object({ entityLabel: str(1000), entityType: str(40), field: str(200), before: str(), after: str(), impact: str() });
const trendSchema = z.object({
  hasHistory: z.boolean(),
  overall: str(40),
  deltas: z.array(z.object({ label: str(200), before: num, after: num, delta: num, direction: str(40) })).max(50),
});
const narrativeItemSchema = z.object({ key: str(40), title: str(200).optional(), project: str(100).optional() });
const decisionSchema = z.object({ title: str(1000), decision: str().optional(), status: str(60), date: str(40).optional(), dueDate: str(40).optional() });
const artifactTypeSchema = z.enum(["STATUS_UPDATE", "STAKEHOLDER_UPDATE", "RELEASE_UPDATE", "DECISION_BRIEF"]);

// V2.36 H — one ticket's content, AFTER the allow-list + redaction (ai/data-protection.ts).
export const ticketContextInputSchema = z.object({
  key: str(40),
  projectKey: str(40),
  summary: str(2000),
  status: str(200),
  description: str(20_000),
  acceptanceCriteria: str(20_000).optional(),
  comments: z.array(z.object({ author: str(200), created: str(40), body: str(4000) })).max(20),
  links: z.array(z.object({ key: str(40), summary: str(1000), status: str(200), relation: str(200) })).max(50),
  statusHistory: z.array(z.object({ at: str(40), from: str(200), to: str(200) })).max(10),
});
export type TicketContextInput = z.infer<typeof ticketContextInputSchema>;

// ----- per-task input schemas -----
export const TASK_INPUT_SCHEMAS = {
  analyzePriorities: z.object({ item: workItemSchema, result: priorityResultSchema, facts: strList(), evidence: z.array(evidenceSchema).max(200) }),
  detectRisks: z.object({ risk: riskSchema, facts: strList(), evidence: z.array(evidenceSchema).max(200) }),
  explainChanges: z.object({ change: changeSchema }),
  generateActionPlan: z.object({
    budgetMinutes: num,
    candidates: z.array(z.object({ item: workItemSchema.optional(), action: actionSchema.optional(), result: z.object({ reasoning: str() }).optional(), estimateMinutes: num })).max(50),
  }),
  generateCommunication: z.object({ item: workItemSchema, audience: str(500), why: str() }),
  generateEndOfDaySummary: z.object({ completed: z.array(titled).max(200), deferred: z.array(titled).max(200), blocked: z.array(titled).max(200), newRisks: z.array(titled).max(200), language: languageSchema.optional() }),
  interpretTrend: z.object({ trend: trendSchema, currentConfidence: num }),
  detectDecisionConflicts: z.object({ candidate: z.object({ decision: decisionSchema, reasons: strList(), evidence: z.array(evidenceSchema).max(200) }) }),
  analyzeActionOutcomes: z.object({ ctx: z.object({ yesterdayRecommendation: str(), actionTaken: str(), outcome: str(), currentStateFacts: strList() }) }),
  generateWeeklyReview: z.object({
    language: languageSchema.optional(),
    facts: z.object({
      hasEnoughHistory: z.boolean(),
      windowDays: num,
      currentConfidence: num,
      confidenceDelta: num.nullable(),
      gettingBetter: strList(),
      gettingWorse: strList(),
      recurringRisks: z.array(titled).max(100),
      decisionsMade: z.array(titled).max(100),
      decisionsUnresolved: z.array(titled).max(100),
      actionsCompleted: z.array(titled).max(200),
      actionsThatDidNotResolveTheIssue: z.array(titled).max(200),
      carryOverRisks: strList(),
      nextWeekPriorities: z.array(z.object({ item: z.object({ key: str(40), title: str(1000) }) })).max(50),
    }),
  }),
  answerQuery: z.object({ query: str(1000), facts: strList(), recommendedActionSeed: str(2000) }),
  assessProactive: z.object({ category: str(200), facts: strList(), evidenceStrings: strList(), trendQualityNote: str(2000) }),
  generateProjectStory: z.object({ timelineFacts: strList(), evidenceStrings: strList(), hasEnoughHistory: z.boolean() }),
  generateDecisionOptions: z.object({ issueTitle: str(1000), facts: strList(), evidenceStrings: strList() }),
  interpretOutcome: z.object({ subjectTitle: str(1000), observedChangeFacts: strList(), evidenceStrings: strList() }),
  generateDailyGuidance: z.object({ topFocusFacts: strList(), watchFacts: strList(), planFacts: strList(), recentOutcomeFacts: strList(), evidenceStrings: strList() }),
  generateCommunicationArtifact: z.object({ type: artifactTypeSchema, facts: strList(), evidenceStrings: strList() }),
  polishReportSummary: z.object({ summary: str(4000) }),
  checkRequirements: z.object({ ticket: ticketContextInputSchema }),
  // V2.37 I1–I4
  generateTicketBrief: z.object({ ticket: ticketContextInputSchema, today: str(10), language: languageSchema.optional() }),
  triageNewItems: z.object({
    today: str(10),
    deferDates: z.array(str(10)).min(1).max(5),
    items: z
      .array(
        z.object({
          key: str(40),
          title: str(500),
          type: str(60),
          status: str(100),
          signal: str(300),
          role: str(200),
          /** Present only for allow-listed projects (≤ 300 chars, redacted). */
          lastCommentExcerpt: str(300).optional(),
        })
      )
      .min(1)
      .max(50),
  }),
  draftMentionReply: z.object({
    ticket: ticketContextInputSchema,
    mention: z.object({ author: str(200), created: str(40), body: str(4000) }),
    tone: z.enum(["client", "internal"]),
    language: z.enum(["en", "vi"]),
    length: z.enum(["short", "normal"]),
  }),
  rewriteReport: z.object({ audience: z.enum(["standup", "pm", "client", "vi"]), report: str(16_000) }),
  // V2.38 J1–J6
  baRequirementCheck: z.object({ ticket: ticketContextInputSchema }),
  draftBlockerFollowUps: z.object({
    today: str(10),
    channel: z.enum(["slack", "jira", "email"]),
    slaBusinessDays: num,
    deadlineOptions: z.array(str(10)).min(1).max(5),
    people: z
      .array(
        z.object({
          person: str(200),
          tickets: z.array(z.object({ key: str(40), title: str(500), reason: str(500).optional(), ageBusinessDays: num, overSla: z.boolean(), lastComment: str(300).optional() })).min(1).max(20),
        })
      )
      .min(1)
      .max(20),
  }),
  releaseGoNoGo: z.object({
    fixVersion: str(200),
    facts: z.object({
      completionPct: num,
      completedItems: num,
      totalItems: num,
      readiness: z.enum(["READY", "AT_RISK", "NOT_READY"]),
      blockedCount: num,
      overdueCount: num,
      unresolvedDependenciesCount: num,
      highPriorityIncompleteCount: num,
      openP1BlockerCount: num,
      deliveryConfidence: num,
    }),
    allowedRecommendations: z.array(z.enum(RELEASE_RECOMMENDATIONS)).min(1).max(3),
    ruleReasons: strList(10, 300),
    blockers: z.array(z.object({ key: str(40), title: str(500), status: str(100), priority: str(10).optional(), reason: str(500).optional() })).max(50),
    openItems: z.array(z.object({ key: str(40), title: str(500), status: str(100), priority: str(10).optional() })).max(100),
    drift: strList(10, 300),
    risks: strList(10, 300),
  }),
  extractMeetingActions: z.object({ today: str(10), notes: str(20_000) }),
  parseCommand: z.object({ today: str(10), command: str(500), knownProjects: z.array(z.object({ key: str(20), name: str(200).optional() })).max(200) }),
  weeklyInsights: z.object({ weekStart: str(10), weekEnd: str(10), facts: strList(80, 400), language: languageSchema.optional() }),
  // V2.50 R1 — facts of one Daily / Weekly report (built by report-narrative.ts; titles only for allow-listed projects).
  summarizeReport: z.object({
    kind: z.enum(["daily", "weekly"]),
    periodPhrase: str(60),
    style: z.enum(["standup", "worklog"]),
    language: z.enum(["en", "vi"]),
    counts: z.object({ done: num, inProgress: num, blocked: num, newReceived: num, mentionsAwaitingReply: num, overdueBlockers: num, decisions: num, projects: num, doneNotListed: num, carriedOver: num.optional(), reportedDays: num.optional(), missingDays: num.optional(), slaBusinessDays: num.optional(), nextWeek: num.optional() }),
    done: z.array(narrativeItemSchema).max(40),
    inProgress: z.array(narrativeItemSchema).max(25),
    blocked: z.array(narrativeItemSchema.extend({ ageBusinessDays: num.optional(), waitingFor: str(200).optional(), reason: str(300).optional() })).max(15),
    nextWeek: z.array(narrativeItemSchema).max(15).optional(),
    decisions: z.array(str(300)).max(10),
    risk: z.object({ title: str(300), level: str(10) }).optional(),
  }),
} satisfies Record<AITask, z.ZodType>;

export type TaskInput<T extends AITask> = z.infer<(typeof TASK_INPUT_SCHEMAS)[T]>;

// The prompts were written against the domain types; each input schema above validates
// exactly the fields that prompt reads, so the casts below are field-for-field safe.
type Builders = { [T in AITask]: (input: TaskInput<T>) => string };
const BUILDERS: Builders = {
  analyzePriorities: (i) => priorityAnalysisPrompt(i.item as WorkItem, i.result as unknown as PriorityScoreResult, i.facts, i.evidence as Evidence[]),
  detectRisks: (i) => riskAnalysisPrompt(i.risk as unknown as Risk, i.facts, i.evidence as Evidence[]),
  explainChanges: (i) => changeAnalysisPrompt(i.change as unknown as ChangeEvent),
  generateActionPlan: (i) =>
    actionPlanPrompt(
      i.budgetMinutes,
      i.candidates as { item?: WorkItem; action?: Action; result?: PriorityScoreResult; estimateMinutes: number }[]
    ),
  generateCommunication: (i) => communicationPrompt(i.item as WorkItem, i.audience, i.why),
  generateEndOfDaySummary: (i) => endOfDayPrompt(i.completed as Action[], i.deferred as Action[], i.blocked as Action[], i.newRisks as Risk[], i.language),
  interpretTrend: (i) => trendInterpretationPrompt(i.trend as unknown as HealthTrend, i.currentConfidence),
  detectDecisionConflicts: (i) => decisionConflictPrompt(i.candidate as unknown as DecisionConflictCandidate),
  analyzeActionOutcomes: (i) => actionOutcomePrompt(i.ctx as FollowUpContext),
  generateWeeklyReview: (i) => weeklyReviewPrompt(i.facts as unknown as WeeklyReviewFacts, i.language),
  answerQuery: (i) => queryAnswerPrompt(i.query, i.facts, i.recommendedActionSeed),
  assessProactive: (i) => proactiveAssessmentPrompt(i.category, i.facts, i.evidenceStrings, i.trendQualityNote),
  generateProjectStory: (i) => projectStoryPrompt(i.timelineFacts, i.evidenceStrings, i.hasEnoughHistory),
  generateDecisionOptions: (i) => decisionOptionsPrompt(i.issueTitle, i.facts, i.evidenceStrings),
  interpretOutcome: (i) => outcomeInterpretationPrompt(i.subjectTitle, i.observedChangeFacts, i.evidenceStrings),
  generateDailyGuidance: (i) => dailyGuidancePrompt(i.topFocusFacts, i.watchFacts, i.planFacts, i.recentOutcomeFacts, i.evidenceStrings),
  generateCommunicationArtifact: (i) => communicationArtifactPrompt(i.type as ArtifactType, i.facts, i.evidenceStrings),
  polishReportSummary: (i) => reportSummaryPolishPrompt(i.summary),
  checkRequirements: (i) => requirementCheckPrompt(i.ticket),
  generateTicketBrief: (i) => ticketBriefPrompt(i.ticket, i.today, i.language),
  triageNewItems: (i) => triagePrompt(i),
  draftMentionReply: (i) => mentionReplyPrompt(i),
  rewriteReport: (i) => reportRewritePrompt(i),
  baRequirementCheck: (i) => baRequirementCheckPrompt(i.ticket),
  draftBlockerFollowUps: (i) => blockerFollowUpsPrompt(i),
  releaseGoNoGo: (i) => releaseGoNoGoPrompt(i),
  extractMeetingActions: (i) => meetingActionsPrompt(i),
  parseCommand: (i) => commandPrompt(i),
  weeklyInsights: (i) => weeklyInsightsPrompt(i),
  summarizeReport: (i) => reportNarrativePrompt(i),
};

export const TASK_OUTPUT_SCHEMAS = {
  analyzePriorities: reasoningResponseSchema,
  detectRisks: reasoningResponseSchema,
  explainChanges: textResponseSchema,
  generateActionPlan: textResponseSchema,
  generateCommunication: textResponseSchema,
  generateEndOfDaySummary: textResponseSchema,
  interpretTrend: trendResponseSchema,
  detectDecisionConflicts: assessmentResponseSchema,
  analyzeActionOutcomes: assessmentResponseSchema,
  generateWeeklyReview: textResponseSchema,
  answerQuery: queryAnswerResponseSchema,
  assessProactive: proactiveAssessmentResponseSchema,
  generateProjectStory: projectStoryResponseSchema,
  generateDecisionOptions: decisionOptionsResponseSchema,
  interpretOutcome: outcomeInterpretationResponseSchema,
  generateDailyGuidance: dailyGuidanceResponseSchema,
  generateCommunicationArtifact: communicationArtifactResponseSchema,
  polishReportSummary: textResponseSchema,
  checkRequirements: requirementCheckResponseSchema,
  generateTicketBrief: ticketBriefResponseSchema,
  triageNewItems: triageResponseSchema,
  draftMentionReply: mentionReplyResponseSchema,
  rewriteReport: reportRewriteResponseSchema,
  baRequirementCheck: baRequirementCheckResponseSchema,
  draftBlockerFollowUps: followUpsResponseSchema,
  releaseGoNoGo: releaseBriefResponseSchema,
  extractMeetingActions: meetingActionsResponseSchema,
  parseCommand: commandResponseSchema,
  weeklyInsights: weeklyInsightsResponseSchema,
  summarizeReport: reportNarrativeResponseSchema,
} satisfies Record<AITask, z.ZodType>;

/** Previous explicit per-task values — kept as the floor (V2.49 A1 only ever raises a budget). */
function baseVisibleBudget(task: AITask): number {
  if (task === "rewriteReport" || task === "baRequirementCheck") return 4096;
  if (task === "draftBlockerFollowUps" || task === "extractMeetingActions" || task === "releaseGoNoGo") return 2048;
  if (task === "triageNewItems") return 3072;
  if (task === "generateDecisionOptions" || task === "checkRequirements" || task === "generateTicketBrief" || task === "draftMentionReply") return 1536;
  return 512;
}

/** Visible-output budget per task (thinking models get extra room on top, server-side).
 *  V2.49 A1: max(previous value, min(3072, ceil(schemaMaxChars / 4 x 0.5))); Vietnamese x1.6 (cap 6144). */
export function visibleTokenBudget(task: AITask, opts?: { language?: "en" | "vi" }): number {
  const base = baseVisibleBudget(task);
  const fromSchema = Math.min(3072, Math.ceil((schemaMaxChars(TASK_OUTPUT_SCHEMAS[task] as z.ZodType) / 4) * 0.5));
  const en = Math.max(base, fromSchema);
  return opts?.language === "vi" ? Math.min(6144, Math.max(en, Math.ceil(en * 1.6))) : en;
}

// ===== Task-specific fact checks (on top of the generic grounding guard) =====
// Run server-side on every answer; a violation is treated exactly like a grounding violation
// (one retry with the violations listed, then 422 → the browser shows deterministic output).

export { lockedFactViolations };

type ExtraCheck = (output: unknown, input: unknown, prompt: string) => string[];

const NOBODY = /^(unknown|nobody|no one|none|n\/a|-)$/i;

export const TASK_EXTRA_CHECKS: Partial<Record<AITask, ExtraCheck>> = {
  // V2.50 R1 — 3-5 sentences, keys/numbers from the facts, the oldest blocker named, no blocked ticket described as done.
  summarizeReport: (out, input) => narrativeViolations((out as { text: string }).text, input as NarrativeFacts),
  generateTicketBrief: (out, _input, prompt) => {
    const o = out as z.infer<typeof ticketBriefResponseSchema>;
    const lower = prompt.toLowerCase();
    return o.waitingOn.filter((w) => !NOBODY.test(w.who.trim()) && !lower.includes(w.who.trim().replace(/^@/, "").toLowerCase())).map((w) => `person "${w.who}" in waitingOn is not named in the ticket`);
  },
  triageNewItems: (out, input) => {
    const o = out as z.infer<typeof triageResponseSchema>;
    const i = input as TaskInput<"triageNewItems">;
    const keys = new Set(i.items.map((x) => x.key));
    const seen = new Set<string>();
    const v: string[] = [];
    for (const it of o.items) {
      if (!keys.has(it.key)) v.push(`item ${it.key} was not in the list`);
      if (seen.has(it.key)) v.push(`item ${it.key} appears twice`);
      seen.add(it.key);
      if (it.action.kind === "defer" && (!it.action.until || !i.deferDates.includes(it.action.until))) v.push(`defer date for ${it.key} must be one of ${i.deferDates.join(", ")}`);
    }
    return v;
  },
  rewriteReport: (out, input) => lockedFactViolations((out as { text: string }).text, (input as TaskInput<"rewriteReport">).report),
  // J1 — checklist, not Gherkin; every non-assumption item quotes the ticket.
  baRequirementCheck: (out, _input, prompt) => {
    const o = out as z.infer<typeof baRequirementCheckResponseSchema>;
    const v: string[] = [];
    for (const ac of o.acceptanceCriteria) {
      if (isGherkin(ac.text)) v.push(`acceptance criterion "${ac.text.slice(0, 60)}" uses Given/When/Then phrasing — write a checklist item`);
      if (ac.source.kind !== "assumption" && !quoteFound(ac.source.quote, prompt)) v.push(`acceptance criterion "${ac.text.slice(0, 60)}" quotes text that is not in the ticket — quote it verbatim or mark it an assumption`);
    }
    return v;
  },
  draftBlockerFollowUps: (out, input) => {
    const o = out as z.infer<typeof followUpsResponseSchema>;
    const i = input as TaskInput<"draftBlockerFollowUps">;
    const people = new Set(i.people.map((p) => p.person.toLowerCase()));
    const v: string[] = [];
    for (const m of o.messages) {
      if (!people.has(m.person.toLowerCase()) && !(m.person.toLowerCase() === "team" && people.has("unknown"))) v.push(`message to "${m.person}" — not one of the people listed`);
      if (m.suggestedDeadline && !i.deadlineOptions.includes(m.suggestedDeadline)) v.push(`deadline ${m.suggestedDeadline} must be one of ${i.deadlineOptions.join(", ")}`);
    }
    return v;
  },
  releaseGoNoGo: (out, input) => {
    const o = out as z.infer<typeof releaseBriefResponseSchema>;
    const i = input as TaskInput<"releaseGoNoGo">;
    const keys = new Set([...i.blockers, ...i.openItems].map((x) => x.key));
    const v: string[] = [];
    if (!i.allowedRecommendations.includes(o.recommendation)) v.push(`recommendation "${o.recommendation}" contradicts the readiness rules (allowed: ${i.allowedRecommendations.join(", ")})`);
    for (const k of o.evidence) if (!keys.has(k)) v.push(`evidence ${k} is not one of the release's open items`);
    return v;
  },
  parseCommand: (out, input) => {
    const o = out as z.infer<typeof commandResponseSchema>;
    const i = input as TaskInput<"parseCommand">;
    const v: string[] = [];
    for (const op of o.operations) {
      if (op.op === "setTicketStatus" && !op.status) v.push("setTicketStatus needs a status");
      if (op.target?.kind === "ticket" && (!op.target.ticketKey || !i.command.toUpperCase().includes(op.target.ticketKey.toUpperCase()))) v.push(`ticket ${op.target.ticketKey ?? "(none)"} is not in the command`);
      if (op.target?.project && !i.command.toLowerCase().includes(op.target.project.toLowerCase())) v.push(`project "${op.target.project}" is not in the command`);
    }
    return v;
  },
};

/** J1 — Given/When/Then (Gherkin) phrasing in an acceptance criterion. */
export function isGherkin(text: string): boolean {
  return /^\s*(given|when|then|and|but)\b/i.test(text) || /\bgiven\b[\s\S]*\bwhen\b[\s\S]*\bthen\b/i.test(text) || /\b(scenario|feature):/i.test(text);
}

const squash = (t: string) => t.toLowerCase().replace(/[“”"'‘’`*_]/g, "").replace(/\s+/g, " ").trim();
/** The quote appears (whitespace/quote-insensitive) in the supplied text. */
export function quoteFound(quote: string | undefined, source: string): boolean {
  if (!quote || squash(quote).length < 8) return false;
  return squash(source).includes(squash(quote));
}

export type ParsedTaskInput = { ok: true; input: unknown } | { ok: false; error: string };

export function parseTaskInput(task: AITask, input: unknown): ParsedTaskInput {
  const parsed = (TASK_INPUT_SCHEMAS[task] as z.ZodType).safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `Input for "${task}" did not match its schema${first ? ` (${first.path.join(".") || "input"}: ${first.message})` : ""}.` };
  }
  return { ok: true, input: parsed.data };
}

/** D2 — grounding policy per task. "strict" = every number must be in the facts (reports, rewrites, locked facts,
 *  release brief). "counts" = narrative tasks may state a derived count ("2 blockers") when n <= 12 and n <= the number of
 *  ticket keys / listed items in the prompt; days, hours, %, points and dates stay strict in both. */
export const GROUNDING_POLICY: Record<AITask, GroundingPolicy> = {
  analyzePriorities: "counts",
  detectRisks: "counts",
  explainChanges: "counts",
  generateActionPlan: "counts",
  generateCommunication: "strict",
  generateEndOfDaySummary: "counts",
  interpretTrend: "strict",
  detectDecisionConflicts: "strict",
  analyzeActionOutcomes: "strict",
  generateWeeklyReview: "counts",
  answerQuery: "counts",
  assessProactive: "counts",
  generateProjectStory: "counts",
  generateDecisionOptions: "strict",
  interpretOutcome: "strict",
  generateDailyGuidance: "counts",
  generateCommunicationArtifact: "strict",
  polishReportSummary: "strict",
  checkRequirements: "counts",
  generateTicketBrief: "counts",
  triageNewItems: "counts",
  draftMentionReply: "strict",
  rewriteReport: "strict",
  baRequirementCheck: "counts",
  draftBlockerFollowUps: "strict",
  releaseGoNoGo: "strict",
  extractMeetingActions: "counts",
  parseCommand: "strict",
  weeklyInsights: "counts",
  summarizeReport: "strict",
};

/** Builds the prompt from an input that has ALREADY been through parseTaskInput. The output limits come from the output schema (D2). */
export function buildTaskPrompt(task: AITask, parsedInput: unknown): string {
  return (BUILDERS[task] as (i: unknown) => string)(parsedInput) + schemaLimitsText(TASK_OUTPUT_SCHEMAS[task] as z.ZodType);
}
