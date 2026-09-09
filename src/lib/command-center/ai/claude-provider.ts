// Real Claude/Anthropic provider (V1.1 §5-6). Runs entirely client-side EXCEPT the actual
// model call, which happens behind /api/command-center/ai — this file only ever POSTs an
// already-built prompt string and receives back validated JSON. No API key is ever present
// here or in the browser.
//
// Error handling (V1.1 §16): every method here falls back to MockAIProvider on ANY failure
// — network error, non-200, malformed JSON, or schema-validation failure — so a missing or
// invalid API key, a rate limit, or a bad model response never breaks the app. `mode`
// reflects whichever provider actually produced the last result, so the UI can honestly
// label its output as "AI assessment" (Claude) vs "Mock AI — development mode".

import type {
  Action,
  ArtifactType,
  ChangeEvent,
  DailyGuidanceResult,
  DecisionConflictAssessment,
  DecisionConflictCandidate,
  DecisionOptionsResult,
  Evidence,
  FollowUpContext,
  HealthTrend,
  OutcomeInterpretation,
  PriorityScoreResult,
  ProactiveAssessment,
  ProjectStoryResult,
  QueryAnswer,
  ReasoningTrace,
  Risk,
  TrendInterpretation,
  WorkItem,
} from "../types";
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
import { riskAnalysisPrompt } from "./prompts/risk-analysis";
import { trendInterpretationPrompt } from "./prompts/trend-interpretation";
import { weeklyReviewPrompt } from "./prompts/weekly-review";
import { MockAIProvider, type AIProvider, type CommunicationArtifactResult } from "./provider";
import { recordAiCall } from "./trace";
import { pairedAuthHeader } from "../device-pairing";
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
  textResponseSchema,
  trendResponseSchema,
  type AITask,
  type AssessmentResponse,
  type CommunicationArtifactResponse,
  type DailyGuidanceResponse,
  type DecisionOptionsResponse,
  type OutcomeInterpretationResponse,
  type ProactiveAssessmentResponse,
  type ProjectStoryResponse,
  type QueryAnswerResponse,
  type ReasoningResponse,
  type TextResponse,
  type TrendResponse,
} from "./schemas";

const ENDPOINT = "/api/command-center/ai";

type CallResult<T> = { ok: true; data: T } | { ok: false };

export class ClaudeProvider implements AIProvider {
  private mock = new MockAIProvider();
  private _mode: "mock" | "claude" = "mock";
  // Cache the one-time availability check so a missing server key doesn't cost a
  // failed network round-trip (and a noisy console 503) on every single AI call.
  private availability: Promise<boolean> | null = null;

  get mode(): "mock" | "claude" {
    return this._mode;
  }

  private async callReasoning(task: AITask, prompt: string): Promise<CallResult<ReasoningResponse>> {
    return this.call(task, prompt, reasoningResponseSchema);
  }

  private async callText(task: AITask, prompt: string): Promise<CallResult<TextResponse>> {
    return this.call(task, prompt, textResponseSchema);
  }

  private async callTrend(task: AITask, prompt: string): Promise<CallResult<TrendResponse>> {
    return this.call(task, prompt, trendResponseSchema);
  }

  private async callAssessment(task: AITask, prompt: string): Promise<CallResult<AssessmentResponse>> {
    return this.call(task, prompt, assessmentResponseSchema);
  }

  private async callQueryAnswer(task: AITask, prompt: string): Promise<CallResult<QueryAnswerResponse>> {
    return this.call(task, prompt, queryAnswerResponseSchema);
  }

  private async callProactiveAssessment(task: AITask, prompt: string): Promise<CallResult<ProactiveAssessmentResponse>> {
    return this.call(task, prompt, proactiveAssessmentResponseSchema);
  }

  private async callProjectStory(task: AITask, prompt: string): Promise<CallResult<ProjectStoryResponse>> {
    return this.call(task, prompt, projectStoryResponseSchema);
  }

  private async callDecisionOptions(task: AITask, prompt: string): Promise<CallResult<DecisionOptionsResponse>> {
    return this.call(task, prompt, decisionOptionsResponseSchema);
  }

  private async callOutcomeInterpretation(task: AITask, prompt: string): Promise<CallResult<OutcomeInterpretationResponse>> {
    return this.call(task, prompt, outcomeInterpretationResponseSchema);
  }

  private async callDailyGuidance(task: AITask, prompt: string): Promise<CallResult<DailyGuidanceResponse>> {
    return this.call(task, prompt, dailyGuidanceResponseSchema);
  }

  private async callCommunicationArtifact(task: AITask, prompt: string): Promise<CallResult<CommunicationArtifactResponse>> {
    return this.call(task, prompt, communicationArtifactResponseSchema);
  }

  private async call<T>(task: AITask, prompt: string, schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }): Promise<CallResult<T>> {
    // V1.7 §27 — every path records a trace entry (never the prompt itself, never
    // credentials) so the local "AI Trust" diagnostic can show mode/schema/fallback status.
    if (!this.availability) this.availability = checkClaudeAvailability();
    const available = await this.availability;
    if (!available) {
      this._mode = "mock";
      recordAiCall({ task, mode: "mock", schemaValid: false, fallbackUsed: true, evidenceReferenceCount: 0, providerState: "CLAUDE_UNAVAILABLE" });
      return { ok: false };
    }
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...pairedAuthHeader() },
        body: JSON.stringify({ task, prompt }),
      });
      if (!res.ok) {
        // V2.1 §6/§14 — the request itself failed (non-200); Claude was never
        // meaningfully consulted. Distinct from a schema-validation failure below.
        this._mode = "mock";
        recordAiCall({ task, mode: "mock", schemaValid: false, fallbackUsed: true, evidenceReferenceCount: 0, providerState: "CALL_FAILED" });
        return { ok: false };
      }
      const json = (await res.json()) as { ok: boolean; data?: unknown };
      if (!json.ok) {
        this._mode = "mock";
        recordAiCall({ task, mode: "mock", schemaValid: false, fallbackUsed: true, evidenceReferenceCount: 0, providerState: "CALL_FAILED" });
        return { ok: false };
      }
      const parsed = schema.safeParse(json.data);
      if (!parsed.success || parsed.data === undefined) {
        // A response WAS received but didn't pass schema validation — distinct from the
        // request itself failing.
        this._mode = "mock";
        recordAiCall({ task, mode: "mock", schemaValid: false, fallbackUsed: true, evidenceReferenceCount: 0, providerState: "VALIDATION_FAILED" });
        return { ok: false };
      }
      this._mode = "claude";
      const evidenceReferenceCount = Array.isArray((parsed.data as Record<string, unknown>)?.evidenceReferences) ? ((parsed.data as { evidenceReferences: unknown[] }).evidenceReferences.length) : 0;
      recordAiCall({ task, mode: "claude", schemaValid: true, fallbackUsed: false, evidenceReferenceCount, providerState: "REAL_CLAUDE" });
      return { ok: true, data: parsed.data };
    } catch {
      // Network error, offline, server down — never let this reach the caller as a throw.
      this._mode = "mock";
      recordAiCall({ task, mode: "mock", schemaValid: false, fallbackUsed: true, evidenceReferenceCount: 0, providerState: "CALL_FAILED" });
      return { ok: false };
    }
  }

  async analyzePriorities(item: WorkItem, result: PriorityScoreResult, facts: string[], evidence: Evidence[]): Promise<ReasoningTrace> {
    const prompt = priorityAnalysisPrompt(item, result, facts, evidence);
    const r = await this.callReasoning("analyzePriorities", prompt);
    if (r.ok) {
      return {
        facts,
        evidence,
        inference: r.data.inference,
        recommendation: r.data.recommendation,
        confidence: Math.min(r.data.confidence, result.confidence),
        insufficientEvidence: r.data.insufficientEvidence,
      };
    }
    return this.mock.analyzePriorities(item, result, facts, evidence);
  }

  async detectRisks(risk: Risk, facts: string[], evidence: Evidence[]): Promise<ReasoningTrace> {
    const prompt = riskAnalysisPrompt(risk, facts, evidence);
    const r = await this.callReasoning("detectRisks", prompt);
    if (r.ok) {
      return {
        facts,
        evidence,
        inference: r.data.inference,
        recommendation: r.data.recommendation,
        confidence: Math.min(r.data.confidence, risk.confidence),
        insufficientEvidence: r.data.insufficientEvidence,
      };
    }
    return this.mock.detectRisks(risk, facts, evidence);
  }

  async explainChanges(change: ChangeEvent): Promise<string> {
    const r = await this.callText("explainChanges", changeAnalysisPrompt(change));
    return r.ok ? r.data.text : this.mock.explainChanges(change);
  }

  async generateActionPlan(
    budgetMinutes: number,
    candidates: { item?: WorkItem; action?: Action; result?: PriorityScoreResult; estimateMinutes: number }[]
  ): Promise<string> {
    const r = await this.callText("generateActionPlan", actionPlanPrompt(budgetMinutes, candidates));
    return r.ok ? r.data.text : this.mock.generateActionPlan(budgetMinutes, candidates);
  }

  async generateCommunication(item: WorkItem, audience: string, why: string): Promise<string> {
    const r = await this.callText("generateCommunication", communicationPrompt(item, audience, why));
    return r.ok ? r.data.text : this.mock.generateCommunication(item, audience, why);
  }

  async generateEndOfDaySummary(completed: Action[], deferred: Action[], blocked: Action[], newRisks: Risk[]): Promise<string> {
    const r = await this.callText("generateEndOfDaySummary", endOfDayPrompt(completed, deferred, blocked, newRisks));
    return r.ok ? r.data.text : this.mock.generateEndOfDaySummary(completed, deferred, blocked, newRisks);
  }

  async interpretTrend(trend: HealthTrend, currentConfidence: number): Promise<TrendInterpretation> {
    const r = await this.callTrend("interpretTrend", trendInterpretationPrompt(trend, currentConfidence));
    if (r.ok) {
      return {
        whatChanged: r.data.whatChanged,
        whyItMatters: r.data.whyItMatters,
        likelyImpact: r.data.likelyImpact,
        recommendedResponse: r.data.recommendedResponse,
        confidence: r.data.confidence,
        insufficientHistory: r.data.insufficientHistory,
      };
    }
    return this.mock.interpretTrend(trend, currentConfidence);
  }

  async detectDecisionConflicts(candidate: DecisionConflictCandidate): Promise<DecisionConflictAssessment> {
    const r = await this.callAssessment("detectDecisionConflicts", decisionConflictPrompt(candidate));
    if (r.ok) return { assessment: r.data.assessment, confidence: r.data.confidence, insufficientEvidence: r.data.insufficientEvidence };
    return this.mock.detectDecisionConflicts(candidate);
  }

  async analyzeActionOutcomes(ctx: FollowUpContext): Promise<DecisionConflictAssessment> {
    const r = await this.callAssessment("analyzeActionOutcomes", actionOutcomePrompt(ctx));
    if (r.ok) return { assessment: r.data.assessment, confidence: r.data.confidence, insufficientEvidence: r.data.insufficientEvidence };
    return this.mock.analyzeActionOutcomes(ctx);
  }

  async generateWeeklyReview(facts: WeeklyReviewFacts): Promise<string> {
    const r = await this.callText("generateWeeklyReview", weeklyReviewPrompt(facts));
    return r.ok ? r.data.text : this.mock.generateWeeklyReview(facts);
  }

  async answerQuery(query: string, facts: string[], evidence: Evidence[], recommendedActionSeed: string): Promise<QueryAnswer> {
    const r = await this.callQueryAnswer("answerQuery", queryAnswerPrompt(query, facts, recommendedActionSeed));
    if (r.ok) {
      return {
        answer: r.data.answer,
        evidence,
        recommendedAction: r.data.recommendedAction,
        confidence: r.data.confidence,
        insufficientEvidence: r.data.insufficientEvidence,
      };
    }
    return this.mock.answerQuery(query, facts, evidence, recommendedActionSeed);
  }

  async assessProactive(category: string, facts: string[], evidenceStrings: string[], trendQualityNote: string): Promise<ProactiveAssessment> {
    const r = await this.callProactiveAssessment("assessProactive", proactiveAssessmentPrompt(category, facts, evidenceStrings, trendQualityNote));
    if (r.ok) {
      return { assessment: r.data.assessment, impact: r.data.impact, recommendation: r.data.recommendation, confidence: r.data.confidence, insufficientEvidence: r.data.insufficientEvidence };
    }
    return this.mock.assessProactive(category, facts, evidenceStrings, trendQualityNote);
  }

  async generateProjectStory(timelineFacts: string[], evidenceStrings: string[], hasEnoughHistory: boolean): Promise<ProjectStoryResult> {
    const r = await this.callProjectStory("generateProjectStory", projectStoryPrompt(timelineFacts, evidenceStrings, hasEnoughHistory));
    if (r.ok) return { narrative: r.data.narrative, confidence: r.data.confidence, insufficientHistory: r.data.insufficientHistory };
    return this.mock.generateProjectStory(timelineFacts, evidenceStrings, hasEnoughHistory);
  }

  async generateDecisionOptions(issueTitle: string, facts: string[], evidenceStrings: string[]): Promise<DecisionOptionsResult> {
    const r = await this.callDecisionOptions("generateDecisionOptions", decisionOptionsPrompt(issueTitle, facts, evidenceStrings));
    if (r.ok) {
      return {
        summary: r.data.summary,
        options: r.data.options,
        recommendedOptionId: r.data.recommendedOptionId,
        tradeoffs: r.data.tradeoffs,
        confidence: r.data.confidence,
        insufficientEvidence: r.data.insufficientEvidence,
      };
    }
    return this.mock.generateDecisionOptions(issueTitle, facts, evidenceStrings);
  }

  async interpretOutcome(subjectTitle: string, observedChangeFacts: string[], evidenceStrings: string[]): Promise<OutcomeInterpretation> {
    const r = await this.callOutcomeInterpretation("interpretOutcome", outcomeInterpretationPrompt(subjectTitle, observedChangeFacts, evidenceStrings));
    if (r.ok) {
      return {
        summary: r.data.summary,
        observedChanges: r.data.observedChanges,
        limitations: r.data.limitations,
        assessment: r.data.assessment,
        recommendation: r.data.recommendation,
        confidence: r.data.confidence,
      };
    }
    return this.mock.interpretOutcome(subjectTitle, observedChangeFacts, evidenceStrings);
  }

  async generateDailyGuidance(topFocusFacts: string[], watchFacts: string[], planFacts: string[], recentOutcomeFacts: string[], evidenceStrings: string[]): Promise<DailyGuidanceResult> {
    const r = await this.callDailyGuidance("generateDailyGuidance", dailyGuidancePrompt(topFocusFacts, watchFacts, planFacts, recentOutcomeFacts, evidenceStrings));
    if (r.ok) {
      return {
        summary: r.data.summary,
        topFocus: r.data.topFocus,
        watch: r.data.watch,
        recommendation: r.data.recommendation,
        evidenceReferences: r.data.evidenceReferences,
        confidence: r.data.confidence,
        insufficientEvidence: r.data.insufficientEvidence,
      };
    }
    return this.mock.generateDailyGuidance(topFocusFacts, watchFacts, planFacts, recentOutcomeFacts, evidenceStrings);
  }

  async generateCommunicationArtifact(type: ArtifactType, facts: string[], evidenceStrings: string[]): Promise<CommunicationArtifactResult> {
    const r = await this.callCommunicationArtifact("generateCommunicationArtifact", communicationArtifactPrompt(type, facts, evidenceStrings));
    if (r.ok) return { text: r.data.text, confidence: r.data.confidence, insufficientEvidence: r.data.insufficientEvidence };
    return this.mock.generateCommunicationArtifact(type, facts, evidenceStrings);
  }
}

/** One-shot check of whether the server has an API key configured — used only for the
 *  "AI provider" status label; it never blocks provider construction or method calls. */
export async function checkClaudeAvailability(): Promise<boolean> {
  try {
    const res = await fetch(ENDPOINT, { method: "GET" });
    if (!res.ok) return false;
    const json = (await res.json()) as { available?: boolean };
    return Boolean(json.available);
  } catch {
    return false;
  }
}
