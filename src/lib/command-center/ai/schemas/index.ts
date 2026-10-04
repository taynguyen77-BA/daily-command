// Response schemas for validating Claude's structured output before it ever touches
// application state (V1.1 §5: "Validate Claude responses... malformed AI responses
// must never crash the application"). Every ClaudeProvider method parses through one
// of these and falls back to MockAIProvider on any failure.

import { z } from "zod";

export const reasoningResponseSchema = z.object({
  inference: z.string().min(1).max(2000),
  recommendation: z.string().min(1).max(1000),
  confidence: z.number().min(0).max(1),
  insufficientEvidence: z.boolean().optional(),
});
export type ReasoningResponse = z.infer<typeof reasoningResponseSchema>;

export const textResponseSchema = z.object({
  text: z.string().min(1).max(4000),
});
export type TextResponse = z.infer<typeof textResponseSchema>;

// V1.2 — trend interpretation response (BUILD REQUEST V1.2 §5).
export const trendResponseSchema = z.object({
  whatChanged: z.string().min(1).max(1000),
  whyItMatters: z.string().min(1).max(1000),
  likelyImpact: z.string().min(1).max(1000),
  recommendedResponse: z.string().min(1).max(1000),
  confidence: z.number().min(0).max(1),
  insufficientHistory: z.boolean().optional(),
});
export type TrendResponse = z.infer<typeof trendResponseSchema>;

// V1.2 — shared shape for decision-conflict assessment and action-outcome follow-up
// (BUILD REQUEST V1.2 §8, §10) — both are a single calibrated assessment + confidence.
export const assessmentResponseSchema = z.object({
  assessment: z.string().min(1).max(1500),
  confidence: z.number().min(0).max(1),
  insufficientEvidence: z.boolean().optional(),
});
export type AssessmentResponse = z.infer<typeof assessmentResponseSchema>;

// V1.3 §26 — natural-language command bar response.
export const queryAnswerResponseSchema = z.object({
  answer: z.string().min(1).max(1500),
  recommendedAction: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1),
  insufficientEvidence: z.boolean().optional(),
});
export type QueryAnswerResponse = z.infer<typeof queryAnswerResponseSchema>;

// V1.4 §27 — the general shape for every proactive narration (drift, risk aging,
// dependency radar): ASSESSMENT / IMPACT / RECOMMENDATION / CONFIDENCE.
export const proactiveAssessmentResponseSchema = z.object({
  assessment: z.string().min(1).max(1500),
  impact: z.string().min(1).max(1000),
  recommendation: z.string().min(1).max(1000),
  confidence: z.number().min(0).max(1),
  insufficientEvidence: z.boolean().optional(),
});
export type ProactiveAssessmentResponse = z.infer<typeof proactiveAssessmentResponseSchema>;

// V1.4 §43 — Project Story narration.
export const projectStoryResponseSchema = z.object({
  narrative: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  insufficientHistory: z.boolean().optional(),
});
export type ProjectStoryResponse = z.infer<typeof projectStoryResponseSchema>;

// V1.5 §8, §40 — Decision Options. Every option must be a real object with the full
// evidence-supported shape — never a bare label.
const decisionOptionSchema = z.object({
  id: z.string().min(1).max(4),
  label: z.string().min(1).max(200),
  rationale: z.string().min(1).max(1000),
  upside: z.string().min(1).max(500),
  downside: z.string().min(1).max(500),
  dependencies: z.array(z.string()).max(10),
  risks: z.array(z.string()).max(10),
  evidence: z.array(z.string()).max(10),
  confidence: z.number().min(0).max(1),
});

export const decisionOptionsResponseSchema = z.object({
  summary: z.string().min(1).max(1000),
  options: z.array(decisionOptionSchema).min(2).max(4),
  recommendedOptionId: z.string().max(4).optional(),
  tradeoffs: z.string().min(1).max(1000),
  confidence: z.number().min(0).max(1),
  insufficientEvidence: z.boolean().optional(),
});
export type DecisionOptionsResponse = z.infer<typeof decisionOptionsResponseSchema>;

// V1.5 §16, §41 — Outcome Interpretation. `observedChanges` must never assert causality
// (enforced by prompt instructions — see ai/prompts/outcome-interpretation.ts).
export const outcomeInterpretationResponseSchema = z.object({
  summary: z.string().min(1).max(1000),
  observedChanges: z.array(z.string()).max(10),
  limitations: z.string().min(1).max(500),
  assessment: z.string().min(1).max(1000),
  recommendation: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1),
});
export type OutcomeInterpretationResponse = z.infer<typeof outcomeInterpretationResponseSchema>;

// V1.6 §38-39 — Daily Guidance. Strict schema; narrates already-computed facts only.
export const dailyGuidanceResponseSchema = z.object({
  summary: z.string().min(1).max(1000),
  topFocus: z.array(z.string()).max(5),
  watch: z.array(z.string()).max(5),
  recommendation: z.string().min(1).max(500),
  evidenceReferences: z.array(z.string()).max(10),
  confidence: z.number().min(0).max(1),
  insufficientEvidence: z.boolean().optional(),
});
export type DailyGuidanceResponse = z.infer<typeof dailyGuidanceResponseSchema>;

// V2.2 §8 — COMMUNICATION_ARTIFACT. A distinct task from generateCommunication: that one
// drafts a single-recipient follow-up ask about one work item; this drafts a whole
// artifact-section narrative from many already-assembled facts/evidence, with `type`
// controlling tone (see ai/prompts/communication-artifact.ts).
export const communicationArtifactResponseSchema = z.object({
  text: z.string().min(1).max(4000),
  confidence: z.number().min(0).max(1),
  insufficientEvidence: z.boolean().optional(),
});
export type CommunicationArtifactResponse = z.infer<typeof communicationArtifactResponseSchema>;

// Request payloads the server route accepts — one variant per AIProvider task
// (V1.1 §6, extended by V1.2 §20, V1.3 §26, V1.5 §40-41, V1.6 §38-39, V2.2 §8).
export const aiTaskSchema = z.enum([
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
  // V1.4 §27
  "assessProactive",
  "generateProjectStory",
  // V1.5 §40-41
  "generateDecisionOptions",
  "interpretOutcome",
  // V1.6 §38-39
  "generateDailyGuidance",
  // V2.2 §8
  "generateCommunicationArtifact",
  // V2.34 F5 — optional rewording of a deterministic report summary
  "polishReportSummary",
  // V2.36 H — task-level: requirement check over one ticket's (allow-listed, redacted) content
  "checkRequirements",
  // V2.37 I1–I4 — task-level features
  "generateTicketBrief",
  "triageNewItems",
  "draftMentionReply",
  "rewriteReport",
  // V2.38 J1–J6
  "baRequirementCheck",
  "draftBlockerFollowUps",
  "releaseGoNoGo",
  "extractMeetingActions",
  "parseCommand",
  "weeklyInsights",
]);
export type AITask = z.infer<typeof aiTaskSchema>;

// V2.36 H3 — the request shape: a task plus that task's own structured input (validated by the
// task's Zod schema in ai/task-registry.ts). The SERVER builds the prompt from ai/prompts/*.
export const aiStructuredRequestSchema = z.object({
  task: aiTaskSchema,
  input: z.unknown(),
});
export type AIStructuredRequest = z.infer<typeof aiStructuredRequestSchema>;

// V2.36 H — requirement check over one ticket. Lists, never a verdict; every item must be
// traceable to the supplied ticket text (grounding guard, ai/evaluation.ts).
export const requirementCheckResponseSchema = z.object({
  summary: z.string().min(1).max(1500),
  gaps: z.array(z.string().min(1).max(500)).max(10),
  questions: z.array(z.string().min(1).max(500)).max(10),
  risks: z.array(z.string().min(1).max(500)).max(10),
  confidence: z.number().min(0).max(1),
  insufficientEvidence: z.boolean().optional(),
});
export type RequirementCheckResponse = z.infer<typeof requirementCheckResponseSchema>;

// ===== V2.37 I1–I4 =====

export const BRIEF_STATUSES = ["IN_PROGRESS", "BLOCKED", "DONE", "DEFERRED", "SKIPPED"] as const;

export const ticketBriefResponseSchema = z.object({
  whatIsAsked: z.string().min(1).max(1000),
  currentState: z.string().min(1).max(1000),
  waitingOn: z.array(z.object({ who: z.string().min(1).max(200), what: z.string().min(1).max(500) })).max(10),
  openQuestions: z.array(z.string().min(1).max(500)).max(10),
  suggestedNextStep: z.string().min(1).max(500),
  suggestedStatus: z.object({ status: z.enum(BRIEF_STATUSES), reason: z.string().min(1).max(300) }).optional(),
});
export type TicketBriefResponse = z.infer<typeof ticketBriefResponseSchema>;

export const TRIAGE_CATEGORIES = ["Reply needed", "Review needed", "Do", "FYI"] as const;
export const TRIAGE_ACTIONS = ["keep", "done", "defer", "block", "skip"] as const;

export const triageResponseSchema = z.object({
  items: z
    .array(
      z.object({
        key: z.string().min(1).max(40),
        category: z.enum(TRIAGE_CATEGORIES),
        action: z.object({ kind: z.enum(TRIAGE_ACTIONS), until: z.string().max(10).optional(), reason: z.string().max(200).optional() }),
        confidence: z.number().min(0).max(1),
        rationale: z.string().min(1).max(300),
      })
    )
    .max(50),
});
export type TriageResponse = z.infer<typeof triageResponseSchema>;

export const mentionReplyResponseSchema = z.object({
  reply: z.string().min(1).max(3000),
  unansweredPoints: z.array(z.string().min(1).max(500)).max(10),
});
export type MentionReplyResponse = z.infer<typeof mentionReplyResponseSchema>;

export const reportRewriteResponseSchema = z.object({
  text: z.string().min(1).max(12000),
});
export type ReportRewriteResponse = z.infer<typeof reportRewriteResponseSchema>;

// ===== V2.38 J1–J6 =====

export const AC_CATEGORIES = ["happy-path", "validation", "error", "edge-case"] as const;
export const AC_SOURCES = ["description", "acceptance-criteria", "comment", "assumption"] as const;

export const baRequirementCheckResponseSchema = z.object({
  acceptanceCriteria: z
    .array(z.object({ text: z.string().min(1).max(500), category: z.enum(AC_CATEGORIES), source: z.object({ kind: z.enum(AC_SOURCES), quote: z.string().max(400).optional() }) }))
    .min(1)
    .max(30),
  questionsByStakeholder: z.array(z.object({ stakeholder: z.string().min(1).max(100), questions: z.array(z.string().min(1).max(400)).min(1).max(10) })).max(8),
  missingInformation: z.array(z.string().min(1).max(400)).max(15),
  risks: z.array(z.string().min(1).max(400)).max(10),
});
export type BaRequirementCheckResponse = z.infer<typeof baRequirementCheckResponseSchema>;

export const followUpsResponseSchema = z.object({
  messages: z.array(z.object({ person: z.string().min(1).max(200), subject: z.string().max(200).optional(), text: z.string().min(1).max(3000), suggestedDeadline: z.string().max(10).optional() })).max(20),
});
export type FollowUpsResponse = z.infer<typeof followUpsResponseSchema>;

export const RELEASE_RECOMMENDATIONS = ["Go", "Go with conditions", "No-Go"] as const;
export const releaseBriefResponseSchema = z.object({
  recommendation: z.enum(RELEASE_RECOMMENDATIONS),
  conditions: z.array(z.string().min(1).max(400)).max(10),
  evidence: z.array(z.string().min(1).max(40)).max(30),
  risks: z.array(z.string().min(1).max(400)).max(10),
  communicationDraft: z.string().min(1).max(3000),
});
export type ReleaseBriefResponse = z.infer<typeof releaseBriefResponseSchema>;

export const COMMAND_STATUSES = ["TODO", "IN_PROGRESS", "BLOCKED", "SKIPPED", "DEFERRED", "DONE"] as const;
export const meetingActionsResponseSchema = z.object({
  decisions: z.array(z.object({ title: z.string().min(1).max(300), detail: z.string().max(1000).optional() })).max(20),
  actions: z.array(z.object({ title: z.string().min(1).max(300), owner: z.string().max(100).optional(), due: z.string().max(40).optional(), relatedTicketKey: z.string().max(40).optional() })).max(30),
  statusChanges: z.array(z.object({ ticketKey: z.string().min(1).max(40), status: z.enum(COMMAND_STATUSES), reason: z.string().max(300).optional(), when: z.string().max(40).optional() })).max(30),
  openQuestions: z.array(z.string().min(1).max(400)).max(20),
});
export type MeetingActionsResponse = z.infer<typeof meetingActionsResponseSchema>;

/** J5 — the ONLY operations a natural-language command may produce. */
export const COMMAND_OPS = ["setTicketStatus", "addAction"] as const;
export const COMMAND_TARGETS = ["ticket", "mentions", "blocked", "new", "in-progress"] as const;
export const commandResponseSchema = z.object({
  operations: z
    .array(
      z.object({
        op: z.enum(COMMAND_OPS),
        target: z.object({ kind: z.enum(COMMAND_TARGETS), ticketKey: z.string().max(40).optional(), project: z.string().max(60).optional() }).optional(),
        status: z.enum(COMMAND_STATUSES).optional(),
        when: z.string().max(40).optional(),
        reason: z.string().max(300).optional(),
        title: z.string().max(300).optional(),
      })
    )
    .max(10),
  clarification: z.string().max(400).optional(),
});
export type CommandResponse = z.infer<typeof commandResponseSchema>;

export const weeklyInsightsResponseSchema = z.object({
  observations: z.array(z.object({ text: z.string().min(1).max(500), evidence: z.array(z.string().min(1).max(300)).min(1).max(5) })).min(1).max(5),
  suggestions: z.array(z.string().min(1).max(400)).min(1).max(3),
});
export type WeeklyInsightsResponse = z.infer<typeof weeklyInsightsResponseSchema>;
