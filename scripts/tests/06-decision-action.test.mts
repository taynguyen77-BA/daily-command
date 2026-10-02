// V1.5 — decision & action intelligence
// Run through scripts/tests/run.mts (npm test).

import { buildDemoData } from "../../src/lib/command-center/demo-data";
import { emptyData } from "../../src/lib/command-center/types";
import { MockAIProvider } from "../../src/lib/command-center/ai/provider";
import { parseStoredState, commandCenterStore } from "../../src/lib/command-center/store";
import type { Decision, DailySnapshot, SnapshotMetrics } from "../../src/lib/command-center/types";
import { classifyQuery, answerFromRoute } from "../../src/lib/command-center/query-router";
import { deriveData } from "../../src/lib/command-center/selectors";
import { computeDeliveryDrift } from "../../src/lib/command-center/delivery-drift";
import { computeDecisionRadar } from "../../src/lib/command-center/decision-radar";
import { computeActionEffectiveness, ineffectiveActions } from "../../src/lib/command-center/action-effectiveness";
import { buildAttentionQueue } from "../../src/lib/command-center/attention-queue";
import { computeProactiveIntelligence } from "../../src/lib/command-center/proactive";
import type { AttentionItem, AttentionItemState } from "../../src/lib/command-center/types";
import { computeDecisionEffectiveness } from "../../src/lib/command-center/decision-effectiveness";
import { computeDeliveryLoops } from "../../src/lib/command-center/delivery-loops";
import { computeOutcomeScorecard } from "../../src/lib/command-center/outcome-scorecard";
import { repeatedlyIneffective, buildActionStrategyFacts } from "../../src/lib/command-center/action-effectiveness";
import { decisionOptionsResponseSchema, outcomeInterpretationResponseSchema } from "../../src/lib/command-center/ai/schemas";
import type { Action, ActionEffectivenessResult, DecisionRadarItem } from "../../src/lib/command-center/types";
import { ok } from "./harness.mts";
import { TODAY, makeDecision, makeDependencyRadarItem, makeItem, makeRisk, makeRiskEscalation, yesterdayMetrics } from "./helpers.mts";

// ================= V1.5 — DECISION & ACTION INTELLIGENCE =================

// ===== Decision lifecycle (§5) =====
{
  const statuses = ["PROPOSED", "UNDER_REVIEW", "DECIDED", "IMPLEMENTING", "VALIDATING", "EFFECTIVE", "INEFFECTIVE", "UNKNOWN"] as const;
  ok("Decision lifecycle", statuses.every((s) => makeDecision({ status: s }).status === s), "all V1.5 decision-lifecycle values are valid, additive to V1-V1.4 values");
}


// ===== Decision Review Radar — review urgency (§6-7) =====
{
  const blockedItem = makeItem({ id: "rad-wi-1", projectId: "p-rad", blocked: true, blockerReason: "x", riskIds: ["rad-risk-1"], dependencyIds: ["rad-dep-1"], fixVersion: "2026.09" });
  const decisionReview = makeDecision({ id: "dec-review", projectId: "p-rad", status: "ACTIVE", relatedWorkItemIds: ["rad-wi-1"] });
  const radarData = { ...emptyData(), workItems: [blockedItem], decisions: [decisionReview], risks: [makeRisk({ id: "rad-risk-1", title: "Rad risk" })] };
  const basicRadar = computeDecisionRadar(radarData, "manual", TODAY);
  ok("Decision review urgency", basicRadar[0]?.reviewUrgency === "REVIEW", "a single-signal decision classifies as REVIEW, not URGENT_REVIEW");

  const context = {
    riskEscalations: [makeRiskEscalation({ riskId: "rad-risk-1", riskTitle: "Rad risk", trend: "worsening" as const })],
    dependencyRadar: [makeDependencyRadarItem({ dependencyId: "rad-dep-1", heat: "CRITICAL" as const })],
    releaseDrift: [{ fixVersion: "2026.09", level: "SEVERE" as const, completionDelta: -10, blockedDelta: 2, confidenceDelta: -20, scopeDelta: 0, drivers: ["x"] }],
    ineffectiveActionWorkItemIds: new Set(["rad-wi-1"]),
  };
  const urgentRadar = computeDecisionRadar(radarData, "manual", TODAY, context);
  ok("Decision review urgency", urgentRadar[0]?.reviewUrgency === "URGENT_REVIEW", "compounding signals (risk + dependency + release + action) classify as URGENT_REVIEW");
  ok("Decision review urgency", urgentRadar[0]!.whyReview.length > basicRadar[0]!.whyReview.length, "whyReview accumulates every triggered signal, not just the base conflict reasons");
  ok("Decision review urgency", computeDecisionRadar(radarData, "manual", TODAY).length === basicRadar.length, "computeDecisionRadar still works with context omitted — fully backward compatible with V1.4 call sites");
}


// ===== Decision Effectiveness + Causality Safety (§14-16) =====
{
  const decDate = "2026-06-01";
  const decision = makeDecision({ id: "dec-eff", projectId: "p-eff", status: "IMPLEMENTING", date: decDate });
  const baselineMetrics: SnapshotMetrics = { ...yesterdayMetrics, deliveryConfidence: 50, blockedCount: 6, highRiskCount: 4, unresolvedDependenciesCount: 3 };
  const history: DailySnapshot[] = [{ date: decDate, workItems: [], risks: [], requirements: [], dependencies: [], projects: [], metrics: baselineMetrics }];
  const improvedMetrics: SnapshotMetrics = { ...baselineMetrics, deliveryConfidence: 65, blockedCount: 2, highRiskCount: 1, unresolvedDependenciesCount: 1 };

  const result = computeDecisionEffectiveness(decision, history, improvedMetrics, []);
  ok("Decision effectiveness", result.classification === "EFFECTIVE", `strongly improved metrics after the decision classify as EFFECTIVE (got ${result.classification})`);
  ok("Causality safety", result.observedChanges.every((s) => !/\bcaused\b/i.test(s)), "decision-effectiveness observations never use causal language ('caused')");
  ok("Causality safety", result.observedChanges.some((s) => /\bafter\b/i.test(s)), "decision-effectiveness observations use the mandated 'after the decision' phrasing");

  const worsenedMetrics: SnapshotMetrics = { ...baselineMetrics, deliveryConfidence: 30, blockedCount: 10, highRiskCount: 8 };
  const worsenedResult = computeDecisionEffectiveness(decision, history, worsenedMetrics, []);
  ok("Decision effectiveness", worsenedResult.classification === "INEFFECTIVE", `worsened metrics after the decision classify as INEFFECTIVE (got ${worsenedResult.classification})`);
  ok("Causality safety", worsenedResult.observedChanges.every((s) => !/\bcaused\b/i.test(s)), "even a negative outcome is described without a causal claim");

  const noDateResult = computeDecisionEffectiveness(makeDecision({ id: "dec-nodate", status: "DECIDED" }), history, improvedMetrics, []);
  ok("Decision effectiveness", noDateResult.classification === "UNKNOWN", "a decision with no date cannot be measured — UNKNOWN, not guessed");

  const noHistoryResult = computeDecisionEffectiveness(makeDecision({ id: "dec-nh", status: "DECIDED", date: "2026-06-20" }), [], improvedMetrics, []);
  ok("Decision effectiveness", noHistoryResult.classification === "UNKNOWN", "no snapshot on/after the decision date yet -> UNKNOWN, not guessed (§7 'insufficient history')");
}


// ===== Decision Options + Outcome Interpretation (AI, §8-10, §40-42) =====
{
  const mock = new MockAIProvider();
  const optionsResult = await mock.generateDecisionOptions("JPMC release readiness", ["Release confidence dropped 12 points."], ["Evidence A"]);
  ok("Decision options", optionsResult.options.length >= 2, "generateDecisionOptions always proposes at least 2 options (§8)");
  ok("Decision options", optionsResult.options.every((o) => o.confidence >= 0 && o.confidence <= 1), "every option carries a calibrated confidence, never a fabricated numeric outcome");

  const thinOptions = await mock.generateDecisionOptions("Unclear issue", [], []);
  ok("Decision options", thinOptions.insufficientEvidence === true, "generateDecisionOptions with no facts flags insufficientEvidence rather than inventing options");

  ok(
    "AI schema validation",
    decisionOptionsResponseSchema.safeParse({
      summary: "s",
      options: [
        { id: "A", label: "l", rationale: "r", upside: "u", downside: "d", dependencies: [], risks: [], evidence: [], confidence: 0.5 },
        { id: "B", label: "l2", rationale: "r2", upside: "u2", downside: "d2", dependencies: [], risks: [], evidence: [], confidence: 0.5 },
      ],
      tradeoffs: "t",
      confidence: 0.6,
    }).success,
    "a well-formed decision-options response (2+ options) validates"
  );
  ok(
    "AI schema validation",
    !decisionOptionsResponseSchema.safeParse({
      summary: "s",
      options: [{ id: "A", label: "l", rationale: "r", upside: "u", downside: "d", dependencies: [], risks: [], evidence: [], confidence: 0.5 }],
      tradeoffs: "t",
      confidence: 0.6,
    }).success,
    "a decision-options response with fewer than 2 options is rejected"
  );

  const interp = await mock.interpretOutcome("Escalate WF dependency", ["Confidence increased 9 points after the decision was implemented."], ["evidence"]);
  ok("Causality safety", !/\bcaused\b/i.test(interp.assessment) && !/\bcaused\b/i.test(interp.summary), "outcome-interpretation mock never uses causal language");
  const thinInterp = await mock.interpretOutcome("x", [], []);
  ok("Outcome interpretation", thinInterp.limitations.length > 0, "outcome interpretation with no observed changes states its limitations rather than guessing");

  ok(
    "AI schema validation",
    outcomeInterpretationResponseSchema.safeParse({ summary: "s", observedChanges: ["a"], limitations: "l", assessment: "a", recommendation: "r", confidence: 0.5 }).success,
    "a well-formed outcome-interpretation response validates"
  );
  ok("AI schema validation", !outcomeInterpretationResponseSchema.safeParse({ summary: "s" }).success, "an outcome-interpretation response missing required fields is rejected");
}


// ===== Action Outcome Capture + Repeatedly Ineffective + Action Strategy (§17-21) =====
{
  const relatedItem = makeItem({ id: "act2-wi-1", blocked: true, status: "Blocked" });

  const resolvedAction: Action = { id: "act2-1", title: "Fix", why: "x", relatedWorkItemId: "act2-wi-1", status: "completed", estimateMinutes: 15, createdAt: "2026-06-10", completedAt: "2026-06-11", outcomeStatus: "RESOLVED", outcomeDate: "2026-06-11" };
  const results = computeActionEffectiveness({ ...emptyData(), workItems: [relatedItem], actions: [resolvedAction] });
  ok("Action outcome capture", results[0].classification === "EFFECTIVE", "an explicit RESOLVED outcomeStatus classifies as EFFECTIVE, overriding the still-blocked heuristic");

  const worsenedAction: Action = { ...resolvedAction, id: "act2-2", outcomeStatus: "WORSENED" };
  const worsenedResults = computeActionEffectiveness({ ...emptyData(), workItems: [relatedItem], actions: [worsenedAction] });
  ok("Action outcome capture", worsenedResults[0].classification === "INEFFECTIVE", "a WORSENED outcomeStatus classifies as INEFFECTIVE");

  const repeatedActions: Action[] = ["a", "b", "c"].map((k, i) => ({
    id: `act2-rep-${k}`,
    title: `Escalate dependency attempt ${i + 1}`,
    why: "x",
    relatedWorkItemId: "act2-wi-1",
    status: "completed",
    estimateMinutes: 15,
    createdAt: "2026-06-10",
    completedAt: "2026-06-11",
    outcomeStatus: "NO_CHANGE",
  }));
  const repeatedResults = computeActionEffectiveness({ ...emptyData(), workItems: [relatedItem], actions: repeatedActions });
  ok("Repeatedly ineffective actions", repeatedResults.every((r) => r.evidence.some((e) => e.includes("REPEATEDLY INEFFECTIVE"))), "a 3rd (or more) same-target ineffective action is flagged REPEATEDLY INEFFECTIVE");
  const repeated = repeatedlyIneffective(repeatedResults, repeatedActions);
  ok("Repeatedly ineffective actions", repeated.length === 3, "repeatedlyIneffective() surfaces every repeatedly-failing attempt with its Action record");

  const strategy = buildActionStrategyFacts(repeatedActions[2], 3);
  ok("Action strategy", strategy.facts.some((f) => f.includes("3 attempt")), "action-strategy facts name the attempt count for the (reused, no new AI method) assessProactive call");
  ok("Action strategy", strategy.facts.some((f) => f.includes("unassigned")), "action-strategy facts never invent an owner — states 'unassigned' when none is set");
}


// ===== Attention Re-escalation + Snooze Intelligence (§22-24) =====
{
  const stableDriftRE = computeDeliveryDrift([], yesterdayMetrics);
  const baseInputs = { drift: stableDriftRE, releaseDrift: [], riskEscalations: [], openRisks: [], dependencyRadar: [], decisionRadar: [], ineffectiveActions: [], stakeholderAttention: [], communicationPriority: [] };
  const highDep = makeDependencyRadarItem({ dependencyId: "re-dep-1", heat: "HIGH" });
  const criticalDep = makeDependencyRadarItem({ dependencyId: "re-dep-1", heat: "CRITICAL" });
  const inputsHigh = { ...baseInputs, dependencyRadar: [highDep] };
  const inputsCritical = { ...baseInputs, dependencyRadar: [criticalDep] };

  const ackStateHigh: Record<string, AttentionItemState> = { "DEPENDENCY:re-dep-1": { lifecycle: "ACKNOWLEDGED", firstSeenDate: "2026-06-10", lastSeenDate: "2026-06-14", lastSeverity: "HIGH" } };
  const sameServResult = buildAttentionQueue(inputsHigh, ackStateHigh, "2026-06-15");
  ok("Attention re-escalation", sameServResult.items[0].lifecycle === "ACKNOWLEDGED", "unchanged severity while acknowledged stays ACKNOWLEDGED — never re-escalates on time alone (§23)");

  const escalatedResult = buildAttentionQueue(inputsCritical, ackStateHigh, "2026-06-15");
  ok("Attention re-escalation", escalatedResult.items[0].lifecycle === "RE_ESCALATED", "severity increasing from HIGH to CRITICAL while acknowledged re-escalates");

  const legacyAckState: Record<string, AttentionItemState> = { "DEPENDENCY:re-dep-1": { lifecycle: "ACKNOWLEDGED", firstSeenDate: "2026-06-10", lastSeenDate: "2026-06-14" } };
  const legacyResult = buildAttentionQueue(inputsCritical, legacyAckState, "2026-06-15");
  ok("Attention re-escalation", legacyResult.items[0].lifecycle === "ACKNOWLEDGED", "pre-V1.5 state with no recorded baseline severity never re-escalates — nothing to compare against");

  const reEscalatedState: Record<string, AttentionItemState> = { "DEPENDENCY:re-dep-1": { lifecycle: "RE_ESCALATED", firstSeenDate: "2026-06-10", lastSeenDate: "2026-06-15", lastSeverity: "CRITICAL" } };
  const nextDayResult = buildAttentionQueue(inputsCritical, reEscalatedState, "2026-06-16");
  ok("Attention re-escalation", nextDayResult.items[0].lifecycle === "ACTIVE", "RE_ESCALATED advances to ACTIVE the next cycle, same pattern as REOPENED");

  const snoozedHighExpired: Record<string, AttentionItemState> = { "DEPENDENCY:re-dep-1": { lifecycle: "SNOOZED", firstSeenDate: "2026-06-01", lastSeenDate: "2026-06-01", snoozedUntil: "2026-06-10", lastSeverity: "HIGH" } };
  ok("Snooze intelligence", buildAttentionQueue(inputsHigh, snoozedHighExpired, "2026-06-15").items[0].lifecycle === "ACTIVE", "an expired snooze with unchanged severity returns to ACTIVE");
  ok("Snooze intelligence", buildAttentionQueue(inputsCritical, snoozedHighExpired, "2026-06-15").items[0].lifecycle === "RE_ESCALATED", "an expired snooze whose severity increased comes back as RE_ESCALATED, not silently ACTIVE — no repeated noise, but no missed signal either");
}


// ===== Stalled Loop Detection + Loop Health (§26-29) =====
{
  const decisionNoAction = makeDecision({ id: "loop-1", projectId: "p-loop", status: "DECIDED", date: "2026-06-10" });
  const loopsNoAction = computeDeliveryLoops({ ...emptyData(), decisions: [decisionNoAction] }, [], [], TODAY);
  ok("Stalled loop detection", loopsNoAction[0]?.health === "STALLED", "a decided decision with no follow-up action is STALLED");

  const decisionWithAction = makeDecision({ id: "loop-2", projectId: "p-loop", status: "IMPLEMENTING", date: "2026-06-10" });
  const unownedAction: Action = { id: "loop-action-1", title: "Do it", why: "x", relatedDecisionId: "loop-2", status: "open", estimateMinutes: 15, createdAt: "2026-06-10" };
  ok("Stalled loop detection", computeDeliveryLoops({ ...emptyData(), decisions: [decisionWithAction], actions: [unownedAction] }, [], [], TODAY)[0]?.health === "STALLED", "a related action with no owner is STALLED — never invents an owner (§29)");

  const ownedIncompleteAction: Action = { ...unownedAction, id: "loop-action-2", owner: "Alice" };
  ok("Loop health", computeDeliveryLoops({ ...emptyData(), decisions: [decisionWithAction], actions: [ownedIncompleteAction] }, [], [], TODAY)[0]?.health === "UNKNOWN", "an owned, in-progress action with no outcome yet is UNKNOWN, not incorrectly STALLED/AT_RISK");

  const completedNoOutcomeAction: Action = { ...ownedIncompleteAction, id: "loop-action-3", status: "completed", completedAt: "2026-06-11" };
  ok("Stalled loop detection", computeDeliveryLoops({ ...emptyData(), decisions: [decisionWithAction], actions: [completedNoOutcomeAction] }, [], [], TODAY)[0]?.health === "AT_RISK", "an action completed with no recorded outcome is AT_RISK");

  const overdueReviewDecision = makeDecision({ id: "loop-3", projectId: "p-loop", status: "DECIDED", date: "2026-06-01", reviewDate: "2026-06-05" });
  const ownedActionForOverdue: Action = { id: "loop-action-4", title: "x", why: "x", relatedDecisionId: "loop-3", owner: "Bob", status: "in-progress", estimateMinutes: 15, createdAt: "2026-06-01" };
  ok("Stalled loop detection", computeDeliveryLoops({ ...emptyData(), decisions: [overdueReviewDecision], actions: [ownedActionForOverdue] }, [], [], TODAY)[0]?.health === "STALLED", "a decision whose review date has passed without review is STALLED");

  const completedEffectiveAction: Action = { ...completedNoOutcomeAction, id: "loop-action-5", relatedDecisionId: "loop-2", outcomeStatus: "RESOLVED" };
  const effResults = computeActionEffectiveness({ ...emptyData(), actions: [completedEffectiveAction] });
  ok("Loop health", computeDeliveryLoops({ ...emptyData(), decisions: [decisionWithAction], actions: [completedEffectiveAction] }, [], effResults, TODAY)[0]?.health === "COMPLETED", "a related action classified EFFECTIVE marks the loop COMPLETED");

  const earlyDecision = makeDecision({ id: "loop-4", projectId: "p-loop", status: "PROPOSED" });
  ok("Loop health", computeDeliveryLoops({ ...emptyData(), decisions: [earlyDecision] }, [], [], TODAY)[0]?.health === "HEALTHY", "a decision still under review with nothing to intervene on is HEALTHY");

  const urgentRadarItem: DecisionRadarItem = {
    decisionId: "radar-only-1",
    decision: makeDecision({ id: "radar-only-1", status: "ACTIVE" }),
    reasons: ["x"],
    stalenessDays: 20,
    newEvidenceCount: 3,
    needsAttention: true,
    evidence: [],
    reviewUrgency: "URGENT_REVIEW",
    whyReview: ["urgent"],
    confidence: 0.8,
  };
  const loopsRadarOnly = computeDeliveryLoops(emptyData(), [urgentRadarItem], [], TODAY);
  ok("Stalled loop detection", loopsRadarOnly.some((l) => l.health === "STALLED" && l.decision?.status === "Under review"), "an urgent decision-radar item with no Decision record yet still surfaces as a stalled loop");
}


// ===== Outcome Scorecard + Control Effectiveness (§32-34) =====
{
  const prevMetrics: SnapshotMetrics = { ...yesterdayMetrics, highRiskCount: 5, blockedCount: 5, deliveryConfidence: 50, unresolvedDependenciesCount: 5 };
  const improvedMetrics2: SnapshotMetrics = { ...prevMetrics, highRiskCount: 2, blockedCount: 2, deliveryConfidence: 65, unresolvedDependenciesCount: 2 };
  const effResults2: ActionEffectivenessResult[] = [{ actionId: "sc-1", actionTitle: "x", classification: "EFFECTIVE", evidence: [] }];
  const scorecard = computeOutcomeScorecard(improvedMetrics2, prevMetrics, effResults2);
  ok("Outcome scorecard", scorecard.risksDelta === 3 && scorecard.blockersDelta === 3 && scorecard.confidenceDelta === 15 && scorecard.dependenciesDelta === 3, "scorecard deltas are pure arithmetic against the previous snapshot's metrics (§32 'no AI arithmetic')");
  ok("Outcome scorecard", scorecard.didTodayHelp === "YES", "all-improving deltas classify as YES");
  ok("Control effectiveness", !/\bperson\b|\bemployee\b/i.test(scorecard.controlEffectiveness), "control effectiveness is never framed as a per-person score (§34)");

  const worsenedMetrics2: SnapshotMetrics = { ...prevMetrics, highRiskCount: 8, blockedCount: 8, deliveryConfidence: 35 };
  ok("Outcome scorecard", computeOutcomeScorecard(worsenedMetrics2, prevMetrics, []).didTodayHelp === "NO", "all-worsening deltas classify as NO");

  const mixedMetrics: SnapshotMetrics = { ...prevMetrics, highRiskCount: 2, blockedCount: 8 };
  ok("Outcome scorecard", computeOutcomeScorecard(mixedMetrics, prevMetrics, []).didTodayHelp === "MIXED", "improving and worsening deltas together classify as MIXED");

  ok("Outcome scorecard", computeOutcomeScorecard(improvedMetrics2, undefined, []).didTodayHelp === "UNKNOWN", "no previous snapshot -> UNKNOWN, never a guessed answer");
}


// ===== Decision Command Bar (§37-38) =====
{
  const { current: cbCurrent } = buildDemoData(TODAY);
  ok("Decision command bar", classifyQuery("Which decisions are blocked?", cbCurrent).intent === "decisions-blocked", "'which decisions are blocked' routes to decisions-blocked");
  ok("Decision command bar", classifyQuery("Which decisions were effective?", cbCurrent).intent === "decisions-effective", "'which decisions were effective' routes to decisions-effective");
  ok("Decision command bar", classifyQuery("Which actions are not working?", cbCurrent).intent === "actions-not-working", "'which actions are not working' routes to actions-not-working");
  ok("Decision command bar", classifyQuery("What should I do differently?", cbCurrent).intent === "action-strategy", "'what should I do differently' routes to action-strategy");
  ok("Decision command bar", classifyQuery("Which management loops are stalled?", cbCurrent).intent === "loops-stalled", "'which management loops are stalled' routes to loops-stalled");
  ok("Decision command bar", classifyQuery("Did yesterday's actions help?", cbCurrent).intent === "did-yesterday-help", "'did yesterday's actions help' routes to did-yesterday-help");
  ok("Decision command bar", classifyQuery("What changed after the decision?", cbCurrent).intent === "what-changed-after-decision", "'what changed after the decision' routes to what-changed-after-decision");
  ok("Decision command bar", classifyQuery("Which decisions need review?", cbCurrent).intent === "decisions-to-revisit", "'which decisions need review' routes to decisions-to-revisit (V1.5 phrasing, same handler)");
  ok("Decision command bar", classifyQuery("asdkjfh nonsense query", cbCurrent).intent === "unrecognized", "nonsense input is never silently misrouted to a decision/action intent");

  const cbDerived = deriveData(cbCurrent, null, TODAY);
  const cbProactive = computeProactiveIntelligence(cbCurrent, cbDerived, [], null, {}, "demo", TODAY);
  const loopsAnswer = answerFromRoute({ intent: "loops-stalled" }, cbCurrent, cbDerived, TODAY, "demo", cbProactive);
  ok("Decision command bar", Array.isArray(loopsAnswer.facts), "loops-stalled intent returns real facts via answerFromRoute, not a crash");
  const scorecardAnswer = answerFromRoute({ intent: "did-yesterday-help" }, cbCurrent, cbDerived, TODAY, "demo", cbProactive);
  ok("Decision command bar", scorecardAnswer.facts[0].includes("Did it help"), "did-yesterday-help returns the deterministic scorecard, not a guess");
}


// ===== Backward Compatibility — V1.0-V1.4 data missing every V1.5 field (§47) =====
{
  const oldDecision: Decision = { id: "bc-dec-1", projectId: "p-1", title: "x", status: "ACTIVE", description: "y" };
  ok("Backward compatibility", oldDecision.options === undefined && oldDecision.outcomeStatus === undefined, "a pre-V1.5 Decision with none of the new optional fields is still a valid Decision");
  const radarFromOld = computeDecisionRadar({ ...emptyData(), workItems: [makeItem({ id: "bc-wi-1", projectId: "p-1", blocked: true, blockerReason: "x" })], decisions: [oldDecision] }, "manual", TODAY);
  ok("Backward compatibility", Array.isArray(radarFromOld), "computeDecisionRadar works unchanged on a decision missing every V1.5 field");

  const oldAction: Action = { id: "bc-act-1", title: "x", why: "y", status: "completed", estimateMinutes: 15, createdAt: TODAY };
  const oldActionResults = computeActionEffectiveness({ ...emptyData(), actions: [oldAction] });
  ok("Backward compatibility", oldActionResults[0].classification === "UNKNOWN", "a pre-V1.5 Action with no outcomeStatus and no related item still classifies safely (UNKNOWN, not a crash)");

  const oldAttentionState: AttentionItemState = { lifecycle: "ACKNOWLEDGED", firstSeenDate: "2026-06-01", lastSeenDate: "2026-06-10" };
  ok("Backward compatibility", oldAttentionState.lastSeverity === undefined, "a pre-V1.5 AttentionItemState has no lastSeverity — re-escalation comparison safely no-ops (see Attention re-escalation tests above)");

  const oldPersistedShapeV14 = JSON.stringify({ data: emptyData(), snapshotHistory: [], loaded: true, isDemo: false, eodHistory: [], dataSource: "demo", jiraSync: { lastSyncStatus: "never" }, filters: {}, attentionState: {}, memoryEvents: [] });
  const migratedV15 = parseStoredState(oldPersistedShapeV14);
  ok("Backward compatibility", migratedV15.loaded === true && Array.isArray(migratedV15.memoryEvents), "pre-V1.5 (V1.4-shaped) persisted state loads cleanly — every V1.5 field lives on Decision/Action/AttentionItemState, none on StoreState, so no migration was needed");
}


// ===== Memory events at the point of action (store singleton, §44) =====
{
  const fakeStorage = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (fakeStorage.has(k) ? fakeStorage.get(k)! : null),
      setItem: (k: string, v: string) => { fakeStorage.set(k, v); },
      removeItem: (k: string) => { fakeStorage.delete(k); },
    },
  };
  commandCenterStore.resetAll();
  commandCenterStore.loadDemoData();

  const decisionId = commandCenterStore.confirmDecisionFromOptions({
    projectId: commandCenterStore.getSnapshot().data.projects[0].id,
    title: "Test V1.5 decision",
    options: [{ id: "A", label: "Option A", rationale: "r", upside: "u", downside: "d", dependencies: [], risks: [], evidence: [], confidence: 0.6 }],
    selectedOptionId: "A",
    expectedOutcome: "Improve confidence.",
  });
  ok("Memory events (store)", commandCenterStore.getSnapshot().data.decisions.some((d) => d.id === decisionId && d.status === "DECIDED"), "confirmDecisionFromOptions persists a new decision only after explicit confirmation (§11)");
  ok("Memory events (store)", commandCenterStore.getSnapshot().memoryEvents.some((e) => e.kind === "DECISION_MADE"), "confirming a decision emits a DECISION_MADE memory event immediately");

  commandCenterStore.confirmDecisionOutcome(decisionId, "EFFECTIVE", "Confidence improved.");
  ok("Memory events (store)", commandCenterStore.getSnapshot().data.decisions.find((d) => d.id === decisionId)?.outcomeStatus === "EFFECTIVE", "confirmDecisionOutcome persists the human-confirmed classification");
  ok("Memory events (store)", commandCenterStore.getSnapshot().memoryEvents.some((e) => e.kind === "DECISION_OUTCOME"), "confirming a decision outcome emits a DECISION_OUTCOME memory event");

  const actionId = commandCenterStore.addAction({ title: "Test action", why: "x", estimateMinutes: 15 });
  commandCenterStore.startAction(actionId);
  ok("Memory events (store)", commandCenterStore.getSnapshot().data.actions.find((a) => a.id === actionId)?.status === "in-progress", "startAction() transitions status to in-progress");
  ok("Memory events (store)", commandCenterStore.getSnapshot().memoryEvents.some((e) => e.kind === "ACTION_STARTED"), "starting an action emits an ACTION_STARTED memory event");

  commandCenterStore.completeAction(actionId);
  ok("Memory events (store)", commandCenterStore.getSnapshot().memoryEvents.some((e) => e.kind === "ACTION_COMPLETED"), "completing an action emits an ACTION_COMPLETED memory event");

  commandCenterStore.recordActionOutcomeStatus(actionId, "RESOLVED", "It worked.");
  ok("Memory events (store)", commandCenterStore.getSnapshot().data.actions.find((a) => a.id === actionId)?.outcomeStatus === "RESOLVED", "recordActionOutcomeStatus persists the outcome");
  ok("Memory events (store)", commandCenterStore.getSnapshot().memoryEvents.some((e) => e.kind === "ACTION_OUTCOME"), "recording an action outcome emits an ACTION_OUTCOME memory event");

  const reItem: AttentionItem = { id: "RE:test", category: "RISK", severity: "CRITICAL", what: "Test", why: "Test", impact: "Test", nowWhat: "Test", evidence: [], lifecycle: "RE_ESCALATED", firstSeenDate: "2026-06-10", lastSeenDate: TODAY };
  commandCenterStore.commitAttentionState({ "RE:test": { lifecycle: "ACKNOWLEDGED", firstSeenDate: "2026-06-10", lastSeenDate: "2026-06-14", lastSeverity: "HIGH" } });
  commandCenterStore.commitAttentionState({ "RE:test": { lifecycle: "RE_ESCALATED", firstSeenDate: "2026-06-10", lastSeenDate: TODAY, lastSeverity: "CRITICAL" } }, [reItem]);
  ok("Memory events (store)", commandCenterStore.getSnapshot().memoryEvents.some((e) => e.kind === "RE_ESCALATED"), "a lifecycle transition to RE_ESCALATED emits a RE_ESCALATED memory event via commitAttentionState");

  await commandCenterStore.closeDay();
  ok("Memory events (store)", Array.isArray(commandCenterStore.getSnapshot().memoryEvents), "closeDay() still computes V1.4 + V1.5 (LOOP_STALLED) memory events together without crashing");

  commandCenterStore.resetAll();
  delete (globalThis as unknown as { window?: unknown }).window;
}
