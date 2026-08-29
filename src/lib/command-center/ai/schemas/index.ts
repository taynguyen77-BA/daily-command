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
]);
export type AITask = z.infer<typeof aiTaskSchema>;

export const aiRequestSchema = z.object({
  task: aiTaskSchema,
  prompt: z.string().min(1).max(20000),
});
export type AIRequest = z.infer<typeof aiRequestSchema>;
