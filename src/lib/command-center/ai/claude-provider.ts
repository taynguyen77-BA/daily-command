// Real Claude/Anthropic provider (V1.1 §5-6). Runs entirely client-side EXCEPT the actual
// model call, which happens behind /api/command-center/ai. V2.36 H3 — this file sends only
// { task, input }: the task's structured input, parsed through the same schema the server uses
// (task-registry.ts), which also strips every field the prompt doesn't read. The SERVER builds
// the prompt. No API key is ever present here or in the browser.
//
// Error handling (V1.1 §16): every method here falls back to MockAIProvider on ANY failure
// — network error, non-200, the daily AI budget being used up (429), a grounding rejection
// (422), malformed JSON, or schema-validation failure — so the app always shows deterministic
// text instead of an error. `mode` reflects whichever provider actually produced the last
// result, so the UI can honestly label its output.

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
import { MockAIProvider, type AIProvider, type CommunicationArtifactResult, type RequirementCheckResult } from "./provider";
import { recordAiCall } from "./trace";
import { pairedAuthHeader } from "../device-pairing";
import { parseTaskInput, TASK_OUTPUT_SCHEMAS, type TaskInput, type TicketContextInput } from "./task-registry";
import type { AITask, MentionReplyResponse, TicketBriefResponse, TriageResponse } from "./schemas";
import type { z } from "zod";

const ENDPOINT = "/api/command-center/ai";

type CallResult<T> = { ok: true; data: T } | { ok: false };
type Output<T extends AITask> = z.infer<(typeof TASK_OUTPUT_SCHEMAS)[T]>;

/** V2.36 H4 — what the server last said about today's AI budget (for the UI). */
export interface AiBudgetStatus {
  cap: number;
  remainingToday: number;
  exhausted: boolean;
  message?: string;
  at: string;
}

let lastBudget: AiBudgetStatus | null = null;
const budgetListeners = new Set<() => void>();
export function getLastAiBudget(): AiBudgetStatus | null {
  return lastBudget;
}
export function subscribeAiBudget(fn: () => void): () => void {
  budgetListeners.add(fn);
  return () => budgetListeners.delete(fn);
}
/** Forget the last budget answer (tests; and Data & Settings after the cap was raised). */
export function clearAiBudgetStatus(): void {
  lastBudget = null;
  budgetListeners.forEach((fn) => fn());
}
function setBudget(next: AiBudgetStatus) {
  lastBudget = next;
  budgetListeners.forEach((fn) => fn());
}

export class ClaudeProvider implements AIProvider {
  private mock = new MockAIProvider();
  private _mode: "mock" | "claude" = "mock";
  // Cache the one-time availability check so a missing server key doesn't cost a
  // failed network round-trip (and a noisy console 503) on every single AI call.
  private availability: Promise<boolean> | null = null;

  get mode(): "mock" | "claude" {
    return this._mode;
  }

  private fallback(task: AITask, providerState: "CLAUDE_UNAVAILABLE" | "CALL_FAILED" | "VALIDATION_FAILED" | "BUDGET_EXHAUSTED" | "GROUNDING_REJECTED"): { ok: false } {
    this._mode = "mock";
    recordAiCall({ task, mode: "mock", schemaValid: false, fallbackUsed: true, evidenceReferenceCount: 0, providerState });
    return { ok: false };
  }

  private async call<T extends AITask>(task: T, input: TaskInput<T>): Promise<CallResult<Output<T>>> {
    // V1.7 §27 — every path records a trace entry (never the input itself, never
    // credentials) so the local "AI Trust" diagnostic can show mode/schema/fallback status.
    if (!this.availability) this.availability = checkClaudeAvailability();
    const available = await this.availability;
    if (!available) return this.fallback(task, "CLAUDE_UNAVAILABLE");
    if (lastBudget?.exhausted && lastBudget.at.slice(0, 10) === new Date().toISOString().slice(0, 10)) {
      // Don't keep hitting a server that already said the budget is gone today.
      return this.fallback(task, "BUDGET_EXHAUSTED");
    }
    const parsedInput = parseTaskInput(task, input);
    if (!parsedInput.ok) return this.fallback(task, "CALL_FAILED");
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...pairedAuthHeader() },
        body: JSON.stringify({ task, input: parsedInput.input }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: unknown; error?: string; usage?: { cap?: number; remainingToday?: number } };
      if (json.usage && typeof json.usage.cap === "number" && typeof json.usage.remainingToday === "number") {
        setBudget({ cap: json.usage.cap, remainingToday: json.usage.remainingToday, exhausted: res.status === 429 || json.usage.remainingToday <= 0, message: res.status === 429 ? json.error : undefined, at: new Date().toISOString() });
      }
      if (res.status === 429) return this.fallback(task, "BUDGET_EXHAUSTED");
      if (res.status === 422) return this.fallback(task, "GROUNDING_REJECTED");
      // V2.1 §6/§14 — the request itself failed; Claude was never meaningfully consulted.
      if (!res.ok || !json.ok) return this.fallback(task, "CALL_FAILED");
      const parsed = (TASK_OUTPUT_SCHEMAS[task] as z.ZodType).safeParse(json.data);
      // A response WAS received but didn't pass schema validation.
      if (!parsed.success || parsed.data === undefined) return this.fallback(task, "VALIDATION_FAILED");
      this._mode = "claude";
      const data = parsed.data as Record<string, unknown>;
      const evidenceReferenceCount = Array.isArray(data?.evidenceReferences) ? (data.evidenceReferences as unknown[]).length : 0;
      recordAiCall({ task, mode: "claude", schemaValid: true, fallbackUsed: false, evidenceReferenceCount, providerState: "REAL_CLAUDE" });
      return { ok: true, data: parsed.data as Output<T> };
    } catch {
      // Network error, offline, server down — never let this reach the caller as a throw.
      return this.fallback(task, "CALL_FAILED");
    }
  }

  async analyzePriorities(item: WorkItem, result: PriorityScoreResult, facts: string[], evidence: Evidence[]): Promise<ReasoningTrace> {
    const r = await this.call("analyzePriorities", { item, result, facts, evidence });
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
    const r = await this.call("detectRisks", { risk, facts, evidence });
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
    const r = await this.call("explainChanges", { change });
    return r.ok ? r.data.text : this.mock.explainChanges(change);
  }

  async generateActionPlan(
    budgetMinutes: number,
    candidates: { item?: WorkItem; action?: Action; result?: PriorityScoreResult; estimateMinutes: number }[]
  ): Promise<string> {
    const r = await this.call("generateActionPlan", { budgetMinutes, candidates });
    return r.ok ? r.data.text : this.mock.generateActionPlan(budgetMinutes, candidates);
  }

  async generateCommunication(item: WorkItem, audience: string, why: string): Promise<string> {
    const r = await this.call("generateCommunication", { item, audience, why });
    return r.ok ? r.data.text : this.mock.generateCommunication(item, audience, why);
  }

  async generateEndOfDaySummary(completed: Action[], deferred: Action[], blocked: Action[], newRisks: Risk[]): Promise<string> {
    const r = await this.call("generateEndOfDaySummary", { completed, deferred, blocked, newRisks });
    return r.ok ? r.data.text : this.mock.generateEndOfDaySummary(completed, deferred, blocked, newRisks);
  }

  async polishReportSummary(summary: string): Promise<string> {
    const r = await this.call("polishReportSummary", { summary });
    return r.ok ? r.data.text : this.mock.polishReportSummary(summary);
  }

  async interpretTrend(trend: HealthTrend, currentConfidence: number): Promise<TrendInterpretation> {
    const r = await this.call("interpretTrend", { trend, currentConfidence });
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
    const r = await this.call("detectDecisionConflicts", { candidate });
    if (r.ok) return { assessment: r.data.assessment, confidence: r.data.confidence, insufficientEvidence: r.data.insufficientEvidence };
    return this.mock.detectDecisionConflicts(candidate);
  }

  async analyzeActionOutcomes(ctx: FollowUpContext): Promise<DecisionConflictAssessment> {
    const r = await this.call("analyzeActionOutcomes", { ctx });
    if (r.ok) return { assessment: r.data.assessment, confidence: r.data.confidence, insufficientEvidence: r.data.insufficientEvidence };
    return this.mock.analyzeActionOutcomes(ctx);
  }

  async generateWeeklyReview(facts: WeeklyReviewFacts): Promise<string> {
    const r = await this.call("generateWeeklyReview", { facts });
    return r.ok ? r.data.text : this.mock.generateWeeklyReview(facts);
  }

  async answerQuery(query: string, facts: string[], evidence: Evidence[], recommendedActionSeed: string): Promise<QueryAnswer> {
    const r = await this.call("answerQuery", { query, facts, recommendedActionSeed });
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
    const r = await this.call("assessProactive", { category, facts, evidenceStrings, trendQualityNote });
    if (r.ok) {
      return { assessment: r.data.assessment, impact: r.data.impact, recommendation: r.data.recommendation, confidence: r.data.confidence, insufficientEvidence: r.data.insufficientEvidence };
    }
    return this.mock.assessProactive(category, facts, evidenceStrings, trendQualityNote);
  }

  async generateProjectStory(timelineFacts: string[], evidenceStrings: string[], hasEnoughHistory: boolean): Promise<ProjectStoryResult> {
    const r = await this.call("generateProjectStory", { timelineFacts, evidenceStrings, hasEnoughHistory });
    if (r.ok) return { narrative: r.data.narrative, confidence: r.data.confidence, insufficientHistory: r.data.insufficientHistory };
    return this.mock.generateProjectStory(timelineFacts, evidenceStrings, hasEnoughHistory);
  }

  async generateDecisionOptions(issueTitle: string, facts: string[], evidenceStrings: string[]): Promise<DecisionOptionsResult> {
    const r = await this.call("generateDecisionOptions", { issueTitle, facts, evidenceStrings });
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
    const r = await this.call("interpretOutcome", { subjectTitle, observedChangeFacts, evidenceStrings });
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
    const r = await this.call("generateDailyGuidance", { topFocusFacts, watchFacts, planFacts, recentOutcomeFacts, evidenceStrings });
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
    const r = await this.call("generateCommunicationArtifact", { type, facts, evidenceStrings });
    if (r.ok) return { text: r.data.text, confidence: r.data.confidence, insufficientEvidence: r.data.insufficientEvidence };
    return this.mock.generateCommunicationArtifact(type, facts, evidenceStrings);
  }

  async checkRequirements(ticket: TicketContextInput): Promise<RequirementCheckResult> {
    const r = await this.call("checkRequirements", { ticket });
    if (r.ok) return { summary: r.data.summary, gaps: r.data.gaps, questions: r.data.questions, risks: r.data.risks, confidence: r.data.confidence, insufficientEvidence: r.data.insufficientEvidence };
    return this.mock.checkRequirements(ticket);
  }

  async generateTicketBrief(ticket: TicketContextInput, today: string): Promise<TicketBriefResponse> {
    const r = await this.call("generateTicketBrief", { ticket, today });
    return r.ok ? r.data : this.mock.generateTicketBrief(ticket, today);
  }

  async triageNewItems(input: TaskInput<"triageNewItems">): Promise<TriageResponse["items"]> {
    const r = await this.call("triageNewItems", input);
    return r.ok ? r.data.items : this.mock.triageNewItems(input);
  }

  async draftMentionReply(input: TaskInput<"draftMentionReply">): Promise<MentionReplyResponse> {
    const r = await this.call("draftMentionReply", input);
    return r.ok ? r.data : this.mock.draftMentionReply(input);
  }

  async rewriteReport(audience: TaskInput<"rewriteReport">["audience"], report: string): Promise<string> {
    const r = await this.call("rewriteReport", { audience, report });
    return r.ok ? r.data.text : this.mock.rewriteReport(audience, report);
  }
}

/** One-shot check of whether the server has an API key configured — used only for the
 *  "AI provider" status label; it never blocks provider construction or method calls. */
/** C4 — the server's AI status: whether a key is configured and which models it will use
 *  (ids only). null when the endpoint is unreachable. */
export async function checkAiModelStatus(): Promise<{ available: boolean; model?: string; fastModel?: string; modelFromEnv?: boolean; fastModelFromEnv?: boolean } | null> {
  try {
    const res = await fetch(ENDPOINT, { method: "GET" });
    if (!res.ok) return null;
    return (await res.json()) as { available: boolean; model?: string; fastModel?: string; modelFromEnv?: boolean; fastModelFromEnv?: boolean };
  } catch {
    return null;
  }
}

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
