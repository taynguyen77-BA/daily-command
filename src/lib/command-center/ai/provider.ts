// AI provider abstraction (BUILD REQUEST §18-19, hardened in V1.1 §1-7).
//
// Deterministic logic (scoring, risk detection, change detection) never lives here —
// see ../scoring.ts, ../risk-detection.ts, ../change-detection.ts. This layer only turns
// already-computed, already-explainable results into prose: summarization, reasoning
// narration, and communication drafting.
//
// Core rule (V1.1 §1, §4): deterministic code computes FACTS. This layer only receives
// those facts as input and returns INFERENCE + RECOMMENDATION + CONFIDENCE — it never
// computes a fact itself, and every trace-returning method is handed the exact facts/
// evidence it's allowed to reason over. See MockAIProvider below for the offline
// implementation and ./claude-provider.ts for the real-Claude implementation.

import type {
  Action,
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

export interface AIProvider {
  readonly mode: "mock" | "claude";
  analyzePriorities(item: WorkItem, result: PriorityScoreResult, facts: string[], evidence: Evidence[]): Promise<ReasoningTrace>;
  detectRisks(risk: Risk, facts: string[], evidence: Evidence[]): Promise<ReasoningTrace>;
  explainChanges(change: ChangeEvent): Promise<string>;
  generateActionPlan(
    budgetMinutes: number,
    candidates: { item?: WorkItem; action?: Action; result?: PriorityScoreResult; estimateMinutes: number }[]
  ): Promise<string>;
  generateCommunication(item: WorkItem, audience: string, why: string): Promise<string>;
  generateEndOfDaySummary(completed: Action[], deferred: Action[], blocked: Action[], newRisks: Risk[]): Promise<string>;
  // V1.2 — Project Memory & Decision Intelligence (BUILD REQUEST V1.2 §20)
  interpretTrend(trend: HealthTrend, currentConfidence: number): Promise<TrendInterpretation>;
  detectDecisionConflicts(candidate: DecisionConflictCandidate): Promise<DecisionConflictAssessment>;
  analyzeActionOutcomes(ctx: FollowUpContext): Promise<DecisionConflictAssessment>;
  generateWeeklyReview(facts: WeeklyReviewFacts): Promise<string>;
  // V1.3 §26 — Natural Language Command Bar. `facts`/`evidence` are already retrieved
  // deterministically by query-router.ts; this only narrates them into one grounded answer.
  answerQuery(query: string, facts: string[], evidence: Evidence[], recommendedActionSeed: string): Promise<QueryAnswer>;
  // V1.4 §27 — the shared proactive-narration shape (drift, risk aging, dependency radar).
  // Called selectively (§48), never per-item across the whole dataset.
  assessProactive(category: string, facts: string[], evidenceStrings: string[], trendQualityNote: string): Promise<ProactiveAssessment>;
  // V1.4 §43 — Project Story.
  generateProjectStory(timelineFacts: string[], evidenceStrings: string[], hasEnoughHistory: boolean): Promise<ProjectStoryResult>;
  // V1.5 §8-10, §40 — "What Should I Do?" Called strictly on-demand (§50), never automatically.
  generateDecisionOptions(issueTitle: string, facts: string[], evidenceStrings: string[]): Promise<DecisionOptionsResult>;
  // V1.5 §14-16, §41 — outcome interpretation. Causality-safe by construction (§16).
  interpretOutcome(subjectTitle: string, observedChangeFacts: string[], evidenceStrings: string[]): Promise<OutcomeInterpretation>;
  // V1.6 §38-40 — Daily Guidance. On-demand only (§59), never called per-item.
  generateDailyGuidance(topFocusFacts: string[], watchFacts: string[], planFacts: string[], recentOutcomeFacts: string[], evidenceStrings: string[]): Promise<DailyGuidanceResult>;
}

/**
 * Deterministic, template-based provider. It does not call any external model — it
 * composes the already-computed scoring/risk/change data into the required
 * FACTS/EVIDENCE/INFERENCE/RECOMMENDATION shape. This keeps V1 honest: no network
 * calls, no fabricated certainty, works fully offline. It never introduces a fact that
 * wasn't handed to it by the caller.
 */
export class MockAIProvider implements AIProvider {
  readonly mode = "mock" as const;

  async analyzePriorities(item: WorkItem, result: PriorityScoreResult, facts: string[], evidence: Evidence[]): Promise<ReasoningTrace> {
    void priorityAnalysisPrompt(item, result); // kept for parity with the real-provider call site
    const top = result.factors.filter((f) => f.contribution > 0).sort((a, b) => b.contribution - a.contribution)[0];
    return {
      facts,
      evidence,
      inference: top
        ? `${item.key} is scored ${result.classification} (${result.score}/100), mainly due to ${top.detail.toLowerCase()}.`
        : `${item.key} is scored ${result.classification} (${result.score}/100) — no significant risk factors detected.`,
      recommendation: result.reasoning,
      confidence: result.confidence,
    };
  }

  async detectRisks(risk: Risk, facts: string[], evidence: Evidence[]): Promise<ReasoningTrace> {
    void riskAnalysisPrompt(risk);
    return {
      facts,
      evidence,
      inference: `${risk.title}. ${risk.potentialImpact}`,
      recommendation: risk.mitigation,
      confidence: risk.confidence,
    };
  }

  async explainChanges(change: ChangeEvent): Promise<string> {
    void changeAnalysisPrompt(change);
    return `${change.entityLabel}: ${change.field} changed from "${change.before}" to "${change.after}". ${change.impact}`;
  }

  async generateActionPlan(
    budgetMinutes: number,
    candidates: { item?: WorkItem; action?: Action; result?: PriorityScoreResult; estimateMinutes: number }[]
  ): Promise<string> {
    void actionPlanPrompt(budgetMinutes, candidates);
    return candidates
      .map((c, i) => {
        const title = c.item ? `${c.item.key} — ${c.item.title}` : c.action?.title ?? "Untitled";
        return `${i + 1}. ${title} — ${c.estimateMinutes} min`;
      })
      .join("\n");
  }

  async generateCommunication(item: WorkItem, audience: string, why: string): Promise<string> {
    void communicationPrompt(item, audience, why);
    return `Hi team, could you please help with ${item.key} — ${item.title}? ${why} Any update or ETA would help us keep this on track.`;
  }

  async generateEndOfDaySummary(completed: Action[], deferred: Action[], blocked: Action[], newRisks: Risk[]): Promise<string> {
    void endOfDayPrompt(completed, deferred, blocked, newRisks);
    const focus = blocked[0]?.title ?? deferred[0]?.title ?? newRisks[0]?.title;
    const starting = focus
      ? `Start with "${focus}" because it remains unresolved from today.`
      : "No carry-over items — start tomorrow with the next highest-priority item.";
    const bullet = (label: string, items: { title: string }[]) =>
      items.length ? `${label}:\n${items.map((i) => `- ${i.title}`).join("\n")}` : `${label}: none`;
    return [
      `TOMORROW'S STARTING POINT: ${starting}`,
      bullet("CARRY-OVER ACTIONS", [...deferred, ...blocked]),
      bullet("NEW RISKS", newRisks),
    ].join("\n\n");
  }

  async interpretTrend(trend: HealthTrend, currentConfidence: number): Promise<TrendInterpretation> {
    void trendInterpretationPrompt(trend, currentConfidence);
    if (!trend.hasHistory) {
      return {
        whatChanged: "No previous snapshot exists yet.",
        whyItMatters: "Insufficient historical evidence.",
        likelyImpact: "Insufficient historical evidence.",
        recommendedResponse: "Run \"Close My Day\" to start building history.",
        confidence: 0.5,
        insufficientHistory: true,
      };
    }
    const worst = [...trend.deltas].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
    return {
      whatChanged: trend.deltas.map((d) => `${d.label}: ${d.before} → ${d.after}`).join("; "),
      whyItMatters: worst ? `${worst.label} moved the most (${worst.delta > 0 ? "+" : ""}${worst.delta}), driving the ${trend.overall} trend.` : "No significant single driver.",
      likelyImpact: trend.overall === "deteriorating" ? "Delivery risk is trending up." : trend.overall === "improving" ? "Delivery risk is trending down." : "Delivery risk is holding steady.",
      recommendedResponse: trend.overall === "deteriorating" ? "Review the items behind the worsening metrics today." : "Keep monitoring — no immediate action required from the trend alone.",
      confidence: 0.75,
    };
  }

  async detectDecisionConflicts(candidate: DecisionConflictCandidate): Promise<DecisionConflictAssessment> {
    void decisionConflictPrompt(candidate);
    if (candidate.reasons.length === 0) {
      return { assessment: "Insufficient evidence.", confidence: 0.4, insufficientEvidence: true };
    }
    return {
      assessment: `Potential conflict: ${candidate.reasons.join("; ")}. Decision "${candidate.decision.title}" may need review.`,
      confidence: Math.min(0.5 + candidate.reasons.length * 0.1, 0.85),
    };
  }

  async analyzeActionOutcomes(ctx: FollowUpContext): Promise<DecisionConflictAssessment> {
    void actionOutcomePrompt(ctx);
    if (ctx.currentStateFacts.length === 0) {
      return { assessment: "Insufficient evidence.", confidence: 0.4, insufficientEvidence: true };
    }
    return {
      assessment: `Yesterday: ${ctx.yesterdayRecommendation} — Action: ${ctx.actionTaken} — Outcome: ${ctx.outcome}. Current state: ${ctx.currentStateFacts.join("; ")}.`,
      confidence: 0.7,
    };
  }

  async generateWeeklyReview(facts: WeeklyReviewFacts): Promise<string> {
    void weeklyReviewPrompt(facts);
    if (!facts.hasEnoughHistory) {
      return "## EXECUTIVE SUMMARY\nInsufficient historical data for a full weekly review yet — \"Close My Day\" needs to run on at least two different days first.";
    }
    const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- none");
    return [
      `## EXECUTIVE SUMMARY\nDelivery confidence is ${facts.currentConfidence}/100${facts.confidenceDelta !== null ? ` (${facts.confidenceDelta > 0 ? "+" : ""}${facts.confidenceDelta} over ${facts.windowDays} day(s))` : ""}.`,
      `## WHAT WENT WELL\n${list(facts.gettingBetter)}`,
      `## WHAT GOT WORSE\n${list(facts.gettingWorse)}`,
      `## RECURRING RISKS\n${list(facts.recurringRisks.map((p) => p.title))}`,
      `## DECISIONS MADE\n${list(facts.decisionsMade.map((d) => d.title))}`,
      `## DECISIONS STILL UNRESOLVED\n${list(facts.decisionsUnresolved.map((d) => d.title))}`,
      `## ACTIONS COMPLETED\n${list(facts.actionsCompleted.map((a) => a.title))}`,
      `## ACTIONS THAT DID NOT RESOLVE THE ISSUE\n${list(facts.actionsThatDidNotResolveTheIssue.map((a) => a.title))}`,
      `## CARRY-OVER RISKS\n${list(facts.carryOverRisks)}`,
      `## NEXT WEEK'S PRIORITIES\n${list(facts.nextWeekPriorities.map((p) => `${p.item.key} — ${p.item.title}`))}`,
    ].join("\n\n");
  }

  async answerQuery(query: string, facts: string[], evidence: Evidence[], recommendedActionSeed: string): Promise<QueryAnswer> {
    void queryAnswerPrompt(query, facts, recommendedActionSeed);
    if (facts.length === 0) {
      return { answer: "I don't have enough current data to answer that.", evidence, recommendedAction: "", confidence: 0.4, insufficientEvidence: true };
    }
    return {
      answer: facts.join(" "),
      evidence,
      recommendedAction: recommendedActionSeed,
      confidence: 0.75,
    };
  }

  async assessProactive(category: string, facts: string[], evidenceStrings: string[], trendQualityNote: string): Promise<ProactiveAssessment> {
    void proactiveAssessmentPrompt(category, facts, evidenceStrings, trendQualityNote);
    if (facts.length === 0) {
      return { assessment: "Insufficient evidence.", impact: "Insufficient evidence.", recommendation: "Gather more data before acting.", confidence: 0.4, insufficientEvidence: true };
    }
    return {
      assessment: `${category}: ${facts[0]}`,
      impact: facts[1] ?? "Impact not yet clear from available facts.",
      recommendation: "Review the evidence below and confirm whether action is needed.",
      confidence: 0.7,
    };
  }

  async generateProjectStory(timelineFacts: string[], evidenceStrings: string[], hasEnoughHistory: boolean): Promise<ProjectStoryResult> {
    void projectStoryPrompt(timelineFacts, evidenceStrings, hasEnoughHistory);
    if (!hasEnoughHistory || timelineFacts.length === 0) {
      return { narrative: "Not enough project history has been recorded yet to tell a coherent story — keep closing days or syncing to build it up.", confidence: 0.4, insufficientHistory: true };
    }
    return { narrative: timelineFacts.slice(0, 4).join(" "), confidence: 0.65 };
  }

  async generateDecisionOptions(issueTitle: string, facts: string[], evidenceStrings: string[]): Promise<DecisionOptionsResult> {
    void decisionOptionsPrompt(issueTitle, facts, evidenceStrings);
    if (facts.length === 0) {
      return {
        summary: "Insufficient evidence to propose options.",
        options: [
          { id: "A", label: "Keep current approach", rationale: "Not enough evidence to propose an alternative.", upside: "No change in course.", downside: "Underlying issue may persist.", dependencies: [], risks: [], evidence: [], confidence: 0.4 },
          { id: "B", label: "Gather more evidence", rationale: "Not enough evidence to propose an alternative.", upside: "Better-informed next decision.", downside: "Delays action.", dependencies: [], risks: [], evidence: [], confidence: 0.4 },
        ],
        tradeoffs: "Insufficient evidence to compare options meaningfully.",
        confidence: 0.4,
        insufficientEvidence: true,
      };
    }
    return {
      summary: `Options for: ${issueTitle}`,
      options: [
        { id: "A", label: "Address it directly", rationale: facts[0], upside: "Resolves the immediate issue.", downside: "May require additional capacity.", dependencies: [], risks: [], evidence: evidenceStrings.slice(0, 2), confidence: 0.6 },
        { id: "B", label: "Escalate and monitor", rationale: facts[0], upside: "Keeps the team focused elsewhere.", downside: "Issue may worsen while monitored.", dependencies: [], risks: [], evidence: evidenceStrings.slice(0, 2), confidence: 0.5 },
      ],
      recommendedOptionId: "A",
      tradeoffs: "Direct action resolves faster but costs capacity; escalating preserves capacity but risks delay.",
      confidence: 0.6,
    };
  }

  async interpretOutcome(subjectTitle: string, observedChangeFacts: string[], evidenceStrings: string[]): Promise<OutcomeInterpretation> {
    void outcomeInterpretationPrompt(subjectTitle, observedChangeFacts, evidenceStrings);
    if (observedChangeFacts.length === 0) {
      return { summary: "No measurable change observed yet.", observedChanges: [], limitations: "Not enough evidence to interpret an outcome yet.", assessment: "Insufficient evidence.", recommendation: "Continue monitoring.", confidence: 0.4 };
    }
    return {
      summary: `Observed changes after ${subjectTitle}.`,
      observedChanges: observedChangeFacts,
      limitations: "This reflects tracked delivery signals only, over a short time window; other concurrent factors may also have contributed.",
      assessment: observedChangeFacts.join(" "),
      recommendation: "Continue monitoring the related signals before drawing further conclusions.",
      confidence: 0.6,
    };
  }

  async generateDailyGuidance(topFocusFacts: string[], watchFacts: string[], planFacts: string[], recentOutcomeFacts: string[], evidenceStrings: string[]): Promise<DailyGuidanceResult> {
    void dailyGuidancePrompt(topFocusFacts, watchFacts, planFacts, recentOutcomeFacts, evidenceStrings);
    if (topFocusFacts.length === 0) {
      return { summary: "Nothing currently needs your attention.", topFocus: [], watch: watchFacts.slice(0, 3), recommendation: "No action needed right now.", evidenceReferences: [], confidence: 0.5, insufficientEvidence: true };
    }
    return {
      summary: `${topFocusFacts.length} item(s) currently need your attention today.`,
      topFocus: topFocusFacts.slice(0, 3),
      watch: watchFacts.slice(0, 3),
      recommendation: `Start with: ${topFocusFacts[0]}`,
      evidenceReferences: evidenceStrings.slice(0, 5),
      confidence: 0.65,
    };
  }
}
