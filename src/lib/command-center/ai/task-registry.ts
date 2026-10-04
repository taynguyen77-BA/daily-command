// V2.36 H3 — server-built prompts. One entry per AI task: the task's structured INPUT schema
// (Zod), the prompt builder from ai/prompts/* that turns a validated input into the prompt, and
// the OUTPUT schema the model's answer must match. The route accepts only { task, input }: the
// browser never sends prompt text, so the endpoint can't be used as a free-form model proxy.
//
// Shared by both sides: the browser parses its input through the same schema before sending
// (which also strips every field a prompt doesn't read — less data leaves the browser), and the
// server parses it again before building anything.

import { z } from "zod";
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
import { riskAnalysisPrompt } from "./prompts/risk-analysis";
import { trendInterpretationPrompt } from "./prompts/trend-interpretation";
import { weeklyReviewPrompt } from "./prompts/weekly-review";
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
  textResponseSchema,
  trendResponseSchema,
  type AITask,
} from "./schemas";

// ----- shared building blocks (bounded, so a request can never be unbounded) -----
const str = (max = 4000) => z.string().max(max);
const strList = (max = 200, len = 4000) => z.array(str(len)).max(max);
const num = z.number().finite();

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
  generateEndOfDaySummary: z.object({ completed: z.array(titled).max(200), deferred: z.array(titled).max(200), blocked: z.array(titled).max(200), newRisks: z.array(titled).max(200) }),
  interpretTrend: z.object({ trend: trendSchema, currentConfidence: num }),
  detectDecisionConflicts: z.object({ candidate: z.object({ decision: decisionSchema, reasons: strList(), evidence: z.array(evidenceSchema).max(200) }) }),
  analyzeActionOutcomes: z.object({ ctx: z.object({ yesterdayRecommendation: str(), actionTaken: str(), outcome: str(), currentStateFacts: strList() }) }),
  generateWeeklyReview: z.object({
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
  generateEndOfDaySummary: (i) => endOfDayPrompt(i.completed as Action[], i.deferred as Action[], i.blocked as Action[], i.newRisks as Risk[]),
  interpretTrend: (i) => trendInterpretationPrompt(i.trend as unknown as HealthTrend, i.currentConfidence),
  detectDecisionConflicts: (i) => decisionConflictPrompt(i.candidate as unknown as DecisionConflictCandidate),
  analyzeActionOutcomes: (i) => actionOutcomePrompt(i.ctx as FollowUpContext),
  generateWeeklyReview: (i) => weeklyReviewPrompt(i.facts as unknown as WeeklyReviewFacts),
  answerQuery: (i) => queryAnswerPrompt(i.query, i.facts, i.recommendedActionSeed),
  assessProactive: (i) => proactiveAssessmentPrompt(i.category, i.facts, i.evidenceStrings, i.trendQualityNote),
  generateProjectStory: (i) => projectStoryPrompt(i.timelineFacts, i.evidenceStrings, i.hasEnoughHistory),
  generateDecisionOptions: (i) => decisionOptionsPrompt(i.issueTitle, i.facts, i.evidenceStrings),
  interpretOutcome: (i) => outcomeInterpretationPrompt(i.subjectTitle, i.observedChangeFacts, i.evidenceStrings),
  generateDailyGuidance: (i) => dailyGuidancePrompt(i.topFocusFacts, i.watchFacts, i.planFacts, i.recentOutcomeFacts, i.evidenceStrings),
  generateCommunicationArtifact: (i) => communicationArtifactPrompt(i.type as ArtifactType, i.facts, i.evidenceStrings),
  polishReportSummary: (i) => reportSummaryPolishPrompt(i.summary),
  checkRequirements: (i) => requirementCheckPrompt(i.ticket),
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
} satisfies Record<AITask, z.ZodType>;

/** Visible-output budget per task (thinking models get extra room on top, server-side). */
export function visibleTokenBudget(task: AITask): number {
  if (task === "generateDecisionOptions" || task === "checkRequirements") return 1536;
  return 512;
}

/** The tasks the deprecated free-form `{ task, prompt }` path may still serve while
 *  AI_LEGACY_PROMPT_PATH=on — only those that existed before V2.36. New tasks never do. */
export const LEGACY_PROMPT_TASKS: ReadonlySet<AITask> = new Set<AITask>([
  "analyzePriorities",
  "detectRisks",
  "explainChanges",
  "generateActionPlan",
  "generateCommunication",
  "generateEndOfDaySummary",
  "interpretTrend",
  "detectDecisionConflicts",
  "analyzeActionOutcomes",
  "generateWeeklyReview",
  "answerQuery",
  "assessProactive",
  "generateProjectStory",
  "generateDecisionOptions",
  "interpretOutcome",
  "generateDailyGuidance",
  "generateCommunicationArtifact",
  "polishReportSummary",
]);

export type ParsedTaskInput = { ok: true; input: unknown } | { ok: false; error: string };

export function parseTaskInput(task: AITask, input: unknown): ParsedTaskInput {
  const parsed = (TASK_INPUT_SCHEMAS[task] as z.ZodType).safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `Input for "${task}" did not match its schema${first ? ` (${first.path.join(".") || "input"}: ${first.message})` : ""}.` };
  }
  return { ok: true, input: parsed.data };
}

/** Builds the prompt from an input that has ALREADY been through parseTaskInput. */
export function buildTaskPrompt(task: AITask, parsedInput: unknown): string {
  return (BUILDERS[task] as (i: unknown) => string)(parsedInput);
}
