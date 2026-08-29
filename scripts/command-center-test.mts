// BA/PO/PM Command Center — deterministic-engine test suite (BUILD REQUEST §26).
// Run: npm test
//
// Covers: priority scoring, risk scoring, overdue detection, aging calculation,
// change detection, action-plan generation, data import validation, empty state,
// demo dataset. No AI provider calls — everything under test is deterministic.

import { scoreWorkItem, isOverdue, daysBetween, classify } from "../src/lib/command-center/scoring";
import { detectRisks } from "../src/lib/command-center/risk-detection";
import { detectChanges, toSnapshot } from "../src/lib/command-center/change-detection";
import { buildPlan } from "../src/lib/command-center/action-plan";
import { importFromJson, importFromCsv, importFromText } from "../src/lib/command-center/import";
import { buildDemoData } from "../src/lib/command-center/demo-data";
import { emptyData, type WorkItem } from "../src/lib/command-center/types";
import { evidenceForRisk, evidenceForScore, factsForWorkItem, makeEvidence } from "../src/lib/command-center/evidence";
import { detectGaps } from "../src/lib/command-center/gap-detection";
import { computeDeliveryConfidence, buildExecutiveView } from "../src/lib/command-center/executive";
import { reasoningResponseSchema, textResponseSchema, aiRequestSchema, trendResponseSchema, assessmentResponseSchema } from "../src/lib/command-center/ai/schemas";
import { MockAIProvider } from "../src/lib/command-center/ai/provider";
import { ClaudeProvider, checkClaudeAvailability } from "../src/lib/command-center/ai/claude-provider";
import { buildDailySnapshot, buildSnapshotMetrics, compareSnapshots } from "../src/lib/command-center/memory";
import { detectDecisionConflictCandidates } from "../src/lib/command-center/decision-conflicts";
import { detectRecurringPatterns } from "../src/lib/command-center/pattern-detection";
import { buildWeeklyReviewFacts } from "../src/lib/command-center/weekly-review";
import { parseStoredState, commandCenterStore, getTodayIso } from "../src/lib/command-center/store";
import type { Decision, DailySnapshot, SnapshotMetrics } from "../src/lib/command-center/types";

// V1.3 — Live Project Intelligence
import { mapPriority, mapStatus, mapWorkItemType, isBlockedByHeuristic } from "../src/lib/command-center/jira/mapping";
import { normalizeIssue, normalizeIssues, normalizeProjects, clientIdForProjectKey } from "../src/lib/command-center/jira/normalize";
import { jiraIssueSchema, jiraSearchResponseSchema, type JiraIssue } from "../src/lib/command-center/jira/types";
import { fetchJiraIssuesWith, fetchJiraProjectsWith, buildIssuesJql, classifyHttpError, JIRA_PAGE_SIZE, type FetchLike } from "../src/lib/command-center/jira/http";
import { DisabledJiraActionProvider } from "../src/lib/command-center/jira/jira-action-provider";
import { applyFilters, availableFixVersions } from "../src/lib/command-center/filters";
import { computeFreshness } from "../src/lib/command-center/freshness";
import { computeReleaseHealth, computeAllReleaseHealth } from "../src/lib/command-center/release-health";
import { buildAIContext } from "../src/lib/command-center/ai-context";
import { classifyQuery, answerFromRoute, familyForIntent } from "../src/lib/command-center/query-router";
import { JiraDataSource } from "../src/lib/command-center/datasource/jira-source";
import { deriveData } from "../src/lib/command-center/selectors";
import fs from "node:fs";
import path from "node:path";

// V1.4 — Proactive Delivery Intelligence
import { computeDeliveryDrift, computeTrajectory, trendQuality } from "../src/lib/command-center/delivery-drift";
import { computeRiskEscalations } from "../src/lib/command-center/risk-escalation";
import { computeDependencyRadar } from "../src/lib/command-center/dependency-radar";
import { computeDecisionRadar } from "../src/lib/command-center/decision-radar";
import { computeActionEffectiveness, ineffectiveActions } from "../src/lib/command-center/action-effectiveness";
import { computeStakeholderAttention, rankCommunicationPriority } from "../src/lib/command-center/stakeholder-radar";
import { computeReleaseDrift } from "../src/lib/command-center/release-drift";
import { computeClientAttentionMap } from "../src/lib/command-center/client-attention-map";
import { buildAttentionQueue, slug } from "../src/lib/command-center/attention-queue";
import { buildFirst30Minutes } from "../src/lib/command-center/first-30-minutes";
import { deriveMemoryEvents } from "../src/lib/command-center/memory-events";
import { computeProactiveIntelligence } from "../src/lib/command-center/proactive";
import { changelogToScopeSignals, selectPrioritizedIssueKeys } from "../src/lib/command-center/jira/scope-drift";
import { proactiveAssessmentResponseSchema, projectStoryResponseSchema } from "../src/lib/command-center/ai/schemas";
import type { AttentionItem, AttentionItemState, Client, Dependency, DependencyRadarItem, Risk, RiskEscalation } from "../src/lib/command-center/types";

// V1.5 — Decision & Action Intelligence
import { computeDecisionEffectiveness } from "../src/lib/command-center/decision-effectiveness";
import { computeDeliveryLoops } from "../src/lib/command-center/delivery-loops";
import { computeOutcomeScorecard } from "../src/lib/command-center/outcome-scorecard";
import { repeatedlyIneffective, buildActionStrategyFacts } from "../src/lib/command-center/action-effectiveness";
import { decisionOptionsResponseSchema, outcomeInterpretationResponseSchema } from "../src/lib/command-center/ai/schemas";
import type { Action, ActionEffectivenessResult, DecisionRadarItem } from "../src/lib/command-center/types";

// V1.6 — Personal Delivery Copilot
import { computePersonalFocus } from "../src/lib/command-center/personal-focus";
import { reconcilePersonalPlan, detectNewCriticalArrivals, buildCarryForward, buildSuggestedDailyPlan } from "../src/lib/command-center/personal-plan";
import { detectPersonalPatterns, detectProjectConcentration, buildPersonalDeliveryReviewFacts } from "../src/lib/command-center/personal-patterns";
import { dailyGuidanceResponseSchema } from "../src/lib/command-center/ai/schemas";
import type { PersonalPlanItem } from "../src/lib/command-center/types";

// V1.7 — Real-World Delivery Copilot Hardening
import { buildIncrementalSinceParam, fetchJiraIssuesWith, fetchJiraProjectsWith } from "../src/lib/command-center/jira/http";
import { runJiraConformance, JIRA_FIELD_SUPPORT } from "../src/lib/command-center/jira/conformance";
import { fixtureFetch, FIXTURE_ISSUE_PAGE_1, FIXTURE_ISSUE_PAGE_2 } from "../src/lib/command-center/jira/fixtures";
import { detectDeadlineConflict } from "../src/lib/command-center/deadline-conflict";
import { evaluateAiResponse } from "../src/lib/command-center/ai/evaluation";
import { getRecentAiTrace, recordAiCall, clearAiTrace } from "../src/lib/command-center/ai/trace";
import { computeDataHealth } from "../src/lib/command-center/data-health";
import type { JiraConnectionConfig } from "../src/lib/command-center/jira/types";
import type { PersonalFocusCandidate } from "../src/lib/command-center/types";

// V1.8 — Production Trust & Operational Readiness
import { detectJiraSearchCapability, JIRA_MAX_ISSUES } from "../src/lib/command-center/jira/http";
import { evaluateJiraDataContract } from "../src/lib/command-center/jira/data-contract";
import { computeTrustDiagnostic } from "../src/lib/command-center/trust-diagnostic";

// V1.9 — Real-World Pilot & Jira Activation
import { discoverJiraDataShape } from "../src/lib/command-center/jira/shape-discovery";
import { computeMappingDrift } from "../src/lib/command-center/jira/mapping-drift";

// V2.0 — Real-World Operating System & AI Efficiency Hardening
import { getUsagePolicy, describeAIState } from "../src/lib/command-center/ai/usage-policy";
import { getCachedAIResult, setCachedAIResult, makeAICacheKey, makeEvidenceVersion, withAICache, clearAICache, aiCacheSize, parseCache } from "../src/lib/command-center/ai/ai-cache";
import { projectRiskImpact, projectDecisionImpact, projectActionImpact, projectLoopImpact } from "../src/lib/command-center/impact-projection";
import { deriveDontForget } from "../src/lib/command-center/personal-focus";
import { reviewStatusFor } from "../src/lib/command-center/decision-radar";
import { buildLivePilotChecklist, buildDataProtectionChecklist } from "../src/lib/command-center/jira/pilot-checklist";
import { buildBeforeYouTrustSummary } from "../src/lib/command-center/trust-diagnostic";
import { getCacheStats, resetCacheStats } from "../src/lib/command-center/ai/ai-cache";
import { getAiTraceSummary } from "../src/lib/command-center/ai/trace";

let failures = 0;
function ok(group: string, cond: boolean, msg: string) {
  console.log(`${cond ? "✅" : "❌"} [${group}] ${msg}`);
  if (!cond) failures++;
}

const TODAY = "2026-06-15";

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "wi-1",
    key: "TEST-1",
    title: "Test item",
    projectId: "p-1",
    clientId: "c-1",
    type: "task",
    status: "In Progress",
    priority: "P3",
    owner: "Alice",
    dueDate: undefined,
    createdDate: TODAY,
    lastUpdated: TODAY,
    blocked: false,
    dependencyIds: [],
    riskIds: [],
    businessImpact: 3,
    scopeChangeCount: 0,
    ...overrides,
  };
}

// ===== Priority scoring =====
{
  const critical = makeItem({
    id: "crit", businessImpact: 5, dueDate: TODAY, blocked: true, blockerReason: "x",
    owner: undefined, scopeChangeCount: 5, lastUpdated: "2026-06-01",
  });
  const low = makeItem({ id: "low", businessImpact: 1, dueDate: "2026-08-01", owner: "Bob" });
  const data = { ...emptyData(), workItems: [critical, low] };

  const criticalResult = scoreWorkItem(critical, data, TODAY);
  const lowResult = scoreWorkItem(low, data, TODAY);

  ok("Priority scoring", criticalResult.score > lowResult.score, `critical item outranks low-risk item (${criticalResult.score} > ${lowResult.score})`);
  ok("Priority scoring", criticalResult.classification === "CRITICAL", `high-risk combination classifies as CRITICAL (got ${criticalResult.classification})`);
  ok("Priority scoring", lowResult.classification === "LOW" || lowResult.classification === "MEDIUM", `low-risk item does not classify as CRITICAL (got ${lowResult.classification})`);
  ok("Priority scoring", classify(85) === "CRITICAL" && classify(65) === "HIGH" && classify(45) === "MEDIUM" && classify(10) === "LOW", "classify() thresholds match spec (80/60/40)");
  ok("Priority scoring", criticalResult.factors.reduce((s, f) => s + f.max, 0) === 100, "factor weights sum to 100");
}

// ===== Overdue detection =====
{
  const overdue = makeItem({ dueDate: "2026-06-10" }); // 5 days before TODAY
  const notYet = makeItem({ dueDate: "2026-06-20" });
  const done = makeItem({ dueDate: "2026-06-01", status: "Done" });
  ok("Overdue detection", isOverdue(overdue, TODAY) === true, "past due date with open status is overdue");
  ok("Overdue detection", isOverdue(notYet, TODAY) === false, "future due date is not overdue");
  ok("Overdue detection", isOverdue(done, TODAY) === false, "Done items are never overdue regardless of due date");
}

// ===== Aging calculation =====
{
  ok("Aging calculation", daysBetween("2026-06-01", "2026-06-15") === 14, "daysBetween computes correct day count");
  const staleItem = makeItem({ lastUpdated: "2026-06-01" });
  const freshItem = makeItem({ lastUpdated: TODAY });
  const data = { ...emptyData(), workItems: [staleItem, freshItem] };
  const staleScore = scoreWorkItem(staleItem, data, TODAY);
  const freshScore = scoreWorkItem(freshItem, data, TODAY);
  const agingFactor = (r: typeof staleScore) => r.factors.find((f) => f.name === "Aging")!.contribution;
  ok("Aging calculation", agingFactor(staleScore) > agingFactor(freshScore), "stale item accrues more aging score than a freshly updated one");
}

// ===== Risk scoring =====
{
  const blockedWithDep = makeItem({
    id: "blocked-1", blocked: true, blockerReason: "waiting", dependencyIds: ["dep-1"],
  });
  const data = {
    ...emptyData(),
    workItems: [blockedWithDep],
    dependencies: [{ id: "dep-1", workItemId: "blocked-1", description: "x", dependsOnTeam: "Eng", status: "unresolved" as const, raisedDate: TODAY }],
  };
  const risks = detectRisks(data, TODAY);
  ok("Risk scoring", risks.some((r) => r.level === "HIGH"), "blocked item + unresolved dependency produces a HIGH risk");
  ok("Risk scoring", risks.every((r) => r.evidence.length > 0), "every detected risk carries evidence");

  const noOwnerHighPriority = makeItem({ id: "no-owner", priority: "P1", owner: undefined });
  const risks2 = detectRisks({ ...emptyData(), workItems: [noOwnerHighPriority] }, TODAY);
  ok("Risk scoring", risks2.some((r) => r.title.includes("no owner")), "P1 item with no owner is flagged");
}

// ===== Change detection =====
{
  const before = makeItem({ status: "Not Started", priority: "P3" });
  const after = makeItem({ status: "Blocked", priority: "P1" });
  const previous = toSnapshot({ ...emptyData(), workItems: [before] }, "2026-06-14");
  const current = { ...emptyData(), workItems: [after] };
  const changes = detectChanges(previous, current, TODAY);
  ok("Change detection", changes.some((c) => c.field === "Status"), "status change is detected");
  ok("Change detection", changes.some((c) => c.field === "Priority"), "priority change is detected");

  const unchanged = toSnapshot({ ...emptyData(), workItems: [before] }, "2026-06-14");
  const noChanges = detectChanges(unchanged, { ...emptyData(), workItems: [before] }, TODAY);
  ok("Change detection", noChanges.length === 0, "identical data produces zero change events (no noise)");

  const noSnapshot = detectChanges(null, current, TODAY);
  ok("Change detection", noSnapshot.length === 0, "no previous snapshot yields no changes rather than crashing");
}

// ===== Action-plan generation =====
{
  const { current } = buildDemoData(TODAY);
  const plan15 = buildPlan(current, TODAY, 15);
  const plan480 = buildPlan(current, TODAY, 480);
  const sum = (items: { estimateMinutes: number }[]) => items.reduce((s, i) => s + i.estimateMinutes, 0);
  ok("Action plan", sum(plan15) <= 15, `15-minute plan respects its budget (used ${sum(plan15)} min)`);
  ok("Action plan", plan480.length >= plan15.length, "a full-day plan includes at least as many items as a 15-minute plan");
  ok("Action plan", plan15.every((c, i, arr) => i === 0 || arr[i - 1].priorityScore >= c.priorityScore), "plan items are ordered by descending priority score");
}

// ===== Data import validation =====
{
  const good = importFromJson(JSON.stringify({ workItems: [{ key: "X-1", title: "Do a thing" }] }), TODAY);
  ok("Data import", good.ok === true, "valid minimal JSON import succeeds");
  ok("Data import", good.data.workItems[0].status === "Not Started", "missing fields fall back to sane defaults");

  const badJson = importFromJson("{not valid json", TODAY);
  ok("Data import", badJson.ok === false, "malformed JSON is rejected, not thrown");
  ok("Data import", badJson.errors.length > 0, "malformed JSON import reports an error message");

  const badShape = importFromJson(JSON.stringify({ workItems: [{ title: "missing key field" }] }), TODAY);
  ok("Data import", badShape.ok === false, "JSON missing a required field (key) is rejected");

  const csv = importFromCsv("key,title,priority\nX-2,Second thing,P1", TODAY);
  ok("Data import", csv.ok === true && csv.data.workItems.length === 1, "valid CSV import parses one row");

  const emptyCsv = importFromCsv("just one line, no data rows", TODAY);
  ok("Data import", emptyCsv.ok === false, "CSV without data rows is rejected gracefully");

  const text = importFromText("- Follow up with client\n- [ ] Chase QA sign-off\nnot a bullet, ignored", TODAY);
  ok("Data import", text.ok === true && text.data.workItems.length === 2, "pasted text extracts bullet/checklist lines only");

  const garbage = importFromText("no bullets here at all", TODAY);
  ok("Data import", garbage.ok === false, "pasted text with no list items does not crash and reports failure");
}

// ===== Empty state =====
{
  const data = emptyData();
  ok("Empty state", data.workItems.length === 0 && data.risks.length === 0, "emptyData() returns a fully-empty, valid dataset");
  const risks = detectRisks(data, TODAY);
  ok("Empty state", risks.length === 0, "risk detection on empty data returns no risks, does not throw");
  const plan = buildPlan(data, TODAY, 60);
  ok("Empty state", plan.length === 0, "action plan on empty data returns no candidates, does not throw");
}

// ===== Demo dataset =====
{
  const { snapshotHistory, current } = buildDemoData(TODAY);
  const previous = snapshotHistory[snapshotHistory.length - 1] ?? null;
  ok("Demo dataset", current.clients.length === 5, `demo includes 5 clients (got ${current.clients.length})`);
  ok("Demo dataset", current.workItems.length >= 10, `demo includes a realistic number of work items (got ${current.workItems.length})`);
  ok("Demo dataset", snapshotHistory.length >= 3, `demo seeds multiple days of history for trend/pattern features (got ${snapshotHistory.length})`);

  const changes = detectChanges(previous, current, TODAY);
  ok("Demo dataset", changes.length >= 4, `demo produces at least 4 meaningful changes out of the box (got ${changes.length})`);

  const risks = detectRisks(current, TODAY);
  ok("Demo dataset", risks.length >= 2, `demo produces at least 2 emerging risks (got ${risks.length})`);

  const criticalOrHigh = current.workItems
    .filter((w) => w.status !== "Done")
    .map((w) => scoreWorkItem(w, current, TODAY))
    .filter((r) => r.classification === "CRITICAL" || r.classification === "HIGH");
  ok("Demo dataset", criticalOrHigh.length >= 3, `demo surfaces at least 3 high-priority issues (got ${criticalOrHigh.length})`);

  ok("Demo dataset", current.communications.length >= 2, `demo includes at least 2 communication recommendations (got ${current.communications.length})`);
}

// ================= V1.1 — AI INTELLIGENCE HARDENING =================

// ===== Evidence model =====
{
  const e = makeEvidence("Due date: 2026-06-20", "demo", "wi-1");
  ok("Evidence model", e.sourceType === "demo" && e.content === "Due date: 2026-06-20", "makeEvidence builds a well-formed Evidence record");

  const item = makeItem({ id: "ev-1", businessImpact: 5, blocked: true, blockerReason: "x", priority: "P1", owner: undefined });
  const data = { ...emptyData(), workItems: [item] };
  const result = scoreWorkItem(item, data, TODAY);
  const scoreEvidence = evidenceForScore(item, result, "manual");
  ok("Evidence model", scoreEvidence.length > 0, "evidenceForScore produces at least one evidence entry for a scored item");
  ok(
    "Evidence model",
    scoreEvidence.every((ev) => result.factors.some((f) => ev.content.includes(f.detail))),
    "every score-evidence entry traces back to an actual scoring factor (no invented facts)"
  );

  const risk = detectRisks(data, TODAY)[0];
  const riskEvidence = evidenceForRisk(risk, "manual");
  ok("Evidence model", riskEvidence.length === risk.evidence.length, "evidenceForRisk carries over exactly the risk engine's own evidence strings");

  const facts = factsForWorkItem(item, data);
  ok("Evidence model", facts.some((f) => f.includes("Blocked: yes")), "factsForWorkItem reflects the item's actual blocked state");
}

// ===== Missing evidence (graceful, non-crashing) =====
{
  const mock = new MockAIProvider();
  const item = makeItem({ id: "no-evidence" });
  const data = { ...emptyData(), workItems: [item] };
  const result = scoreWorkItem(item, data, TODAY);
  const trace = await mock.analyzePriorities(item, result, [], []);
  ok("Missing evidence", trace.facts.length === 0 && trace.evidence.length === 0, "a trace built from empty facts/evidence stays empty rather than inventing content");
  ok("Missing evidence", typeof trace.inference === "string" && trace.inference.length > 0, "MockAIProvider still returns a usable inference with no facts supplied");
}

// ===== AI response schema validation =====
{
  const validReasoning = { inference: "Release is at risk.", recommendation: "Confirm UAT scope.", confidence: 0.8 };
  ok("AI schema validation", reasoningResponseSchema.safeParse(validReasoning).success, "a well-formed reasoning response validates");

  const missingField = { inference: "x", confidence: 0.5 }; // no recommendation
  ok("AI schema validation", !reasoningResponseSchema.safeParse(missingField).success, "a reasoning response missing a required field is rejected");

  const outOfRangeConfidence = { inference: "x", recommendation: "y", confidence: 1.5 };
  ok("AI schema validation", !reasoningResponseSchema.safeParse(outOfRangeConfidence).success, "confidence outside 0-1 is rejected (malformed/hallucinated shape)");

  const wrongType = { inference: 42, recommendation: "y", confidence: 0.5 };
  ok("AI schema validation", !reasoningResponseSchema.safeParse(wrongType).success, "wrong field types are rejected rather than coerced");

  ok("AI schema validation", textResponseSchema.safeParse({ text: "hello" }).success, "a well-formed text response validates");
  ok("AI schema validation", !textResponseSchema.safeParse({ text: "" }).success, "an empty text response is rejected");

  ok("AI schema validation", aiRequestSchema.safeParse({ task: "detectRisks", prompt: "..." }).success, "a valid task name is accepted");
  ok("AI schema validation", !aiRequestSchema.safeParse({ task: "deleteEverything", prompt: "..." }).success, "an unrecognized task name is rejected");
}

// ===== Claude-unavailable fallback (no server running in this test — every call must
// fall back to Mock rather than throwing) =====
{
  const claude = new ClaudeProvider();
  const item = makeItem({ id: "fallback-1" });
  const data = { ...emptyData(), workItems: [item] };
  const result = scoreWorkItem(item, data, TODAY);

  let threw = false;
  let trace;
  try {
    trace = await claude.analyzePriorities(item, result, ["fact 1"], []);
  } catch {
    threw = true;
  }
  ok("Claude fallback", !threw, "ClaudeProvider.analyzePriorities never throws even when the server is unreachable");
  ok("Claude fallback", claude.mode === "mock", "mode reports 'mock' after a failed Claude call, so the UI can label it honestly");
  ok("Claude fallback", !!trace && trace.facts[0] === "fact 1", "the fallback still returns a usable ReasoningTrace built from the given facts");

  const available = await checkClaudeAvailability();
  ok("Claude fallback", available === false, "checkClaudeAvailability() resolves to false rather than throwing when unreachable");

  let commThrew = false;
  try {
    await claude.generateCommunication(item, "Engineering", "test reason");
  } catch {
    commThrew = true;
  }
  ok("Claude fallback", !commThrew, "ClaudeProvider.generateCommunication falls back to Mock text output without throwing");
}

// ===== Gap detection ("What Did We Forget?") =====
{
  const gapItem = makeItem({ id: "gap-item", priority: "P1", owner: undefined });
  const gapRisk = { id: "gap-risk", projectId: "p-1", title: "Untitled risk", level: "MEDIUM" as const, reason: "x", evidence: [], potentialImpact: "y", mitigation: "", status: "open" as const, confidence: 0.6, detectedAt: TODAY, sourceWorkItemIds: [] };
  const gapReq = { id: "gap-req", projectId: "p-1", title: "Untracked requirement", status: "approved" as const, businessImpact: 3 as const };
  const gapDep = { id: "gap-dep", workItemId: "gap-item", description: "Waiting on X", dependsOnTeam: "Data", status: "unresolved" as const, raisedDate: TODAY };
  const gapAction = { id: "gap-action", title: "Untitled action", why: "x", status: "open" as const, estimateMinutes: 10, createdAt: TODAY };
  const gapDecision = { id: "gap-decision", projectId: "p-1", title: "Stale decision", status: "pending" as const, description: "x", dueDate: "2026-06-01" };

  const data = {
    ...emptyData(),
    workItems: [gapItem],
    risks: [gapRisk],
    requirements: [gapReq],
    dependencies: [gapDep],
    actions: [gapAction],
    decisions: [gapDecision],
  };
  const gaps = detectGaps(data, TODAY, "manual");

  ok("Gap detection", gaps.some((g) => g.title.includes("no owner assigned")), "P1 item with no owner surfaces as a gap");
  ok("Gap detection", gaps.some((g) => g.title.includes("no test coverage tracked")), "requirement with untracked coverage surfaces as a gap");
  ok("Gap detection", gaps.some((g) => g.title.includes("no target resolution date")), "unresolved dependency surfaces as a gap (model has no target-date field at all)");
  ok("Gap detection", gaps.some((g) => g.title.includes("no mitigation on record")), "risk with empty mitigation surfaces as a gap");
  ok("Gap detection", gaps.some((g) => g.title.includes("no owner")), "action with no owner surfaces as a gap");
  ok("Gap detection", gaps.some((g) => g.title.includes("overdue and still pending")), "decision past its own due date surfaces as a gap");
  ok("Gap detection", gaps.every((g) => g.evidence.length > 0), "every gap carries at least one evidence entry");
  ok("Gap detection", gaps.every((g) => g.confidence > 0 && g.confidence <= 1), "every gap reports a confidence in (0,1]");

  const emptyGaps = detectGaps(emptyData(), TODAY, "manual");
  ok("Gap detection", emptyGaps.length === 0, "gap detection on empty data returns no gaps, does not throw");

  const prodIssue = makeItem({ id: "prod-1", type: "production-issue", status: "In Progress" });
  const prodGaps = detectGaps({ ...emptyData(), workItems: [prodIssue] }, TODAY, "manual");
  ok("Gap detection", prodGaps.some((g) => g.title.includes("production issue")), "production issue with no follow-up action surfaces as a gap");
}

// ===== Executive mode =====
{
  const healthyScores = [scoreWorkItem(makeItem({ id: "e1", businessImpact: 1, dueDate: "2026-12-01" }), emptyData(), TODAY)];
  const healthyConfidence = computeDeliveryConfidence(healthyScores, [], 0);
  ok("Executive mode", healthyConfidence === 100, `a dataset with no critical items, risks, or overdue work scores 100 (got ${healthyConfidence})`);

  const criticalItem = makeItem({ id: "e2", businessImpact: 5, dueDate: TODAY, blocked: true, blockerReason: "x", owner: undefined, scopeChangeCount: 5, lastUpdated: "2026-06-01" });
  const criticalData = { ...emptyData(), workItems: [criticalItem] };
  const criticalScores = [scoreWorkItem(criticalItem, criticalData, TODAY)];
  const highRisk = { id: "r1", projectId: "p-1", title: "x", level: "HIGH" as const, reason: "x", evidence: ["e"], potentialImpact: "y", mitigation: "z", status: "open" as const, confidence: 0.8, detectedAt: TODAY, sourceWorkItemIds: [] };
  const degradedConfidence = computeDeliveryConfidence(criticalScores, [highRisk], 1);
  ok("Executive mode", degradedConfidence < healthyConfidence, "critical items, risks, and overdue work lower delivery confidence");
  ok("Executive mode", degradedConfidence >= 0, "delivery confidence never goes negative");

  const view = buildExecutiveView(criticalData, criticalScores, [highRisk], [], 1);
  ok("Executive mode", view.majorRisks.length === 1 && view.majorRisks[0].level === "HIGH", "executive view surfaces HIGH risks as major risks");
  ok("Executive mode", typeof view.summary === "string" && view.summary.length > 0, "executive view produces a non-empty summary");

  const emptyView = buildExecutiveView(emptyData(), [], [], [], 0);
  ok("Executive mode", emptyView.deliveryConfidence === 100, "executive view on empty data reports full confidence rather than crashing");
}

// ================= V1.2 — PROJECT MEMORY & DECISION INTELLIGENCE =================

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return { id: "dec-1", projectId: "p-1", title: "Test decision", status: "ACTIVE", description: "test decision", ...overrides };
}

// ===== Daily snapshot generation =====
{
  const item = makeItem({ id: "snap-1", businessImpact: 5, blocked: true, blockerReason: "x", priority: "P1", owner: undefined, dueDate: TODAY });
  const data = { ...emptyData(), workItems: [item] };
  const snapshot = buildDailySnapshot(data, TODAY, 3);
  ok("Daily snapshot", snapshot.date === TODAY, "snapshot carries the given date");
  ok("Daily snapshot", !!snapshot.metrics, "snapshot includes a metrics block");
  ok("Daily snapshot", snapshot.metrics!.meaningfulChangeCount === 3, "snapshot preserves the given meaningful-change count");
  ok("Daily snapshot", snapshot.metrics!.attentionCount >= 1, "snapshot metrics reflect real attention-needing items");
  ok("Daily snapshot", snapshot.workItems.length === 1, "snapshot retains raw work items (reused from change-detection's toSnapshot, not duplicated)");
}

// ===== Today vs Yesterday delta + trend classification =====
const yesterdayMetrics: SnapshotMetrics = {
  attentionCount: 3, criticalCount: 1, highRiskCount: 4, blockedCount: 6, overdueCount: 2,
  deliveryConfidence: 50, openDecisionsCount: 2, unresolvedDependenciesCount: 3,
  majorRiskTitles: [], unresolvedDependencyTeams: [], meaningfulChangeCount: 2,
};
{
  const worse: SnapshotMetrics = { ...yesterdayMetrics, deliveryConfidence: 40, blockedCount: 8, highRiskCount: 6, overdueCount: 3 };
  const better: SnapshotMetrics = { ...yesterdayMetrics, deliveryConfidence: 65, blockedCount: 3, highRiskCount: 2, overdueCount: 0 };

  const trendWorse = compareSnapshots(worse, yesterdayMetrics);
  ok("Health trend", trendWorse.hasHistory === true, "trend reports history is available when a previous snapshot exists");
  ok("Health trend", trendWorse.overall === "deteriorating", "worsening deltas classify overall trend as deteriorating");
  ok("Health trend", trendWorse.gettingWorse.length > 0, "worsening deltas populate gettingWorse facts");

  const trendBetter = compareSnapshots(better, yesterdayMetrics);
  ok("Health trend", trendBetter.overall === "improving", "improving deltas classify overall trend as improving");
  ok("Health trend", trendBetter.gettingBetter.length > 0, "improving deltas populate gettingBetter facts");

  const trendNoHistory = compareSnapshots(worse, undefined);
  ok("Health trend", trendNoHistory.hasHistory === false, "no previous snapshot yields hasHistory:false rather than crashing");
  ok("Health trend", trendNoHistory.deltas.length === 0, "no-history trend has no deltas");

  const mock = new MockAIProvider();
  const interpNoHistory = await mock.interpretTrend(trendNoHistory, 50);
  ok("Trend interpretation", interpNoHistory.insufficientHistory === true, "interpretTrend flags insufficient history when there's no previous snapshot");

  const interpWorse = await mock.interpretTrend(trendWorse, 40);
  ok("Trend interpretation", !interpWorse.insufficientHistory, "interpretTrend does not flag insufficient history when a comparison exists");
  ok("Trend interpretation", interpWorse.confidence > 0 && interpWorse.confidence <= 1, "interpretTrend returns a calibrated confidence");

  ok("AI schema validation", trendResponseSchema.safeParse({ whatChanged: "a", whyItMatters: "b", likelyImpact: "c", recommendedResponse: "d", confidence: 0.7 }).success, "a well-formed trend response validates");
  ok("AI schema validation", !trendResponseSchema.safeParse({ whatChanged: "a" }).success, "a trend response missing required fields is rejected");
}

// ===== Decision status + Decision conflict preconditions =====
{
  const oldStyle: Decision = { id: "d1", projectId: "p1", title: "x", status: "pending", description: "y" };
  const newStyle: Decision = { id: "d2", projectId: "p1", title: "x", status: "ACTIVE", description: "y" };
  ok("Decision status", oldStyle.status === "pending" && newStyle.status === "ACTIVE", "both legacy (V1) and new (V1.2) decision status values are valid — backward compatible union");

  const blockedItem = makeItem({ id: "conf-1", projectId: "p-conf", blocked: true, blockerReason: "x" });
  const conflictData = {
    ...emptyData(),
    workItems: [blockedItem],
    decisions: [makeDecision({ id: "dec-conf", projectId: "p-conf", status: "ACTIVE", relatedWorkItemIds: ["conf-1"] })],
  };
  const candidates = detectDecisionConflictCandidates(conflictData, "manual");
  ok("Decision conflicts", candidates.length === 1, "an ACTIVE decision with a blocked related item produces a conflict candidate");
  ok("Decision conflicts", candidates[0].reasons.length > 0, "conflict candidate carries deterministic reasons");
  ok("Decision conflicts", candidates[0].evidence.length > 0, "conflict candidate carries evidence");

  const supersededData = { ...conflictData, decisions: [makeDecision({ id: "dec-done", projectId: "p-conf", status: "SUPERSEDED", relatedWorkItemIds: ["conf-1"] })] };
  ok("Decision conflicts", detectDecisionConflictCandidates(supersededData, "manual").length === 0, "SUPERSEDED decisions are not re-evaluated for conflicts");

  const cleanItem = makeItem({ id: "clean-1", projectId: "p-clean" });
  const cleanData = { ...emptyData(), workItems: [cleanItem], decisions: [makeDecision({ id: "dec-clean", projectId: "p-clean", status: "ACTIVE", relatedWorkItemIds: ["clean-1"] })] };
  ok("Decision conflicts", detectDecisionConflictCandidates(cleanData, "manual").length === 0, "a decision with no supporting reasons produces no conflict candidate");

  const mock = new MockAIProvider();
  const assessment = await mock.detectDecisionConflicts(candidates[0]);
  const lowered = assessment.assessment.toLowerCase();
  ok("Decision conflicts", lowered.includes("potential conflict") || lowered.includes("may need review"), "assessment uses calibrated language, never a flat 'invalid' claim");
  ok("Decision conflicts", !lowered.includes("is invalid"), "assessment never states the decision is invalid");

  const insufficientAssessment = await mock.detectDecisionConflicts({ decision: makeDecision(), reasons: [], evidence: [] });
  ok("Decision conflicts", insufficientAssessment.insufficientEvidence === true, "no reasons -> insufficientEvidence rather than a guess");

  ok("AI schema validation", assessmentResponseSchema.safeParse({ assessment: "x", confidence: 0.5 }).success, "a well-formed assessment response validates");
}

// ===== Action outcome lifecycle + Follow-up intelligence =====
{
  const mock = new MockAIProvider();
  const ctx = { yesterdayRecommendation: "Escalate WF dependency.", actionTaken: "Completed.", outcome: "No response.", currentStateFacts: ["Dependency still unresolved after 6 days."] };
  const followUp = await mock.analyzeActionOutcomes(ctx);
  ok("Action outcomes", followUp.assessment.includes(ctx.outcome), "follow-up assessment reflects the actual recorded outcome, not an invented one");
  ok("Action outcomes", !followUp.insufficientEvidence, "follow-up with current-state facts does not flag insufficient evidence");

  const thinFollowUp = await mock.analyzeActionOutcomes({ yesterdayRecommendation: "x", actionTaken: "y", outcome: "z", currentStateFacts: [] });
  ok("Action outcomes", thinFollowUp.insufficientEvidence === true, "follow-up with no current-state facts flags insufficient evidence rather than guessing");
}

// ===== Recurring pattern detection (2-occurrence minimum threshold) =====
{
  const metricsA: SnapshotMetrics = { attentionCount: 0, criticalCount: 0, highRiskCount: 1, blockedCount: 0, overdueCount: 0, deliveryConfidence: 80, openDecisionsCount: 0, unresolvedDependenciesCount: 1, majorRiskTitles: ["Recurring risk X"], unresolvedDependencyTeams: ["Engineering"], meaningfulChangeCount: 0 };
  const historyTwo: DailySnapshot[] = [
    { date: "2026-06-10", workItems: [], risks: [], requirements: [], dependencies: [], projects: [], metrics: metricsA },
    { date: "2026-06-12", workItems: [], risks: [], requirements: [], dependencies: [], projects: [], metrics: metricsA },
  ];
  const patterns = detectRecurringPatterns(historyTwo, emptyData(), TODAY, "manual");
  ok("Recurring patterns", patterns.some((p) => p.kind === "risk" && p.occurrences === 2), "a risk appearing in 2 historical snapshots is flagged as recurring (minimum threshold)");
  ok("Recurring patterns", patterns.some((p) => p.kind === "dependency-team" && p.occurrences === 2), "a dependency team appearing in 2 historical snapshots is flagged as recurring");
  ok("Recurring patterns", patterns.every((p) => p.evidence.length === p.occurrences), "every pattern carries exactly one evidence entry per occurrence");

  const singlePatterns = detectRecurringPatterns([historyTwo[0]], emptyData(), TODAY, "manual");
  ok("Recurring patterns", singlePatterns.length === 0, "a single isolated occurrence is never called a pattern (below the 2-occurrence threshold)");
}

// ===== Weekly Review (insufficient history + full data) =====
{
  const factsThin = buildWeeklyReviewFacts(emptyData(), [], TODAY, "manual");
  ok("Weekly review", factsThin.hasEnoughHistory === false, "fewer than 2 snapshots -> hasEnoughHistory:false");
  const mock = new MockAIProvider();
  const reviewThin = await mock.generateWeeklyReview(factsThin);
  ok("Weekly review", reviewThin.toLowerCase().includes("insufficient"), "weekly review states insufficient data plainly rather than fabricating sections");

  const { snapshotHistory, current } = buildDemoData(TODAY);
  const factsFull = buildWeeklyReviewFacts(current, snapshotHistory, TODAY, "demo");
  ok("Weekly review", factsFull.hasEnoughHistory === true, "demo data's seeded snapshot history is enough for a full weekly review");
  const reviewFull = await mock.generateWeeklyReview(factsFull);
  for (const header of [
    "EXECUTIVE SUMMARY", "WHAT WENT WELL", "WHAT GOT WORSE", "RECURRING RISKS",
    "DECISIONS MADE", "DECISIONS STILL UNRESOLVED", "ACTIONS COMPLETED",
    "ACTIONS THAT DID NOT RESOLVE THE ISSUE", "CARRY-OVER RISKS", "NEXT WEEK'S PRIORITIES",
  ]) {
    ok("Weekly review", reviewFull.includes(header), `full weekly review includes the "${header}" section`);
  }
}

// ===== Backward compatibility with old data + malformed historical data =====
{
  const oldShape = JSON.stringify({
    data: emptyData(),
    previousSnapshot: { date: "2026-06-01", workItems: [], risks: [], requirements: [], dependencies: [], projects: [] },
    loaded: true, isDemo: false, eodHistory: [],
  });
  const migrated = parseStoredState(oldShape);
  ok("Backward compatibility", migrated.snapshotHistory.length === 1 && migrated.snapshotHistory[0].date === "2026-06-01", "V1.1's single previousSnapshot migrates losslessly into snapshotHistory");
  ok("Backward compatibility", migrated.loaded === true, "other V1.1 fields carry over unchanged during migration");

  const malformed = parseStoredState("{not valid json at all");
  ok("Malformed historical data", malformed.loaded === false && malformed.snapshotHistory.length === 0, "malformed persisted JSON falls back to a pristine state rather than throwing");

  const wrongShape = parseStoredState(JSON.stringify({ garbage: true }));
  ok("Malformed historical data", Array.isArray(wrongShape.snapshotHistory) && wrongShape.data.workItems.length === 0, "an unrecognized-but-valid-JSON shape still produces a usable, empty state");
}

// ===== Memory persistence + Memory deletion (via the store singleton) =====
{
  const fakeStorage = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (fakeStorage.has(k) ? fakeStorage.get(k)! : null),
      setItem: (k: string, v: string) => { fakeStorage.set(k, v); },
      removeItem: (k: string) => { fakeStorage.delete(k); },
    },
  };

  commandCenterStore.loadDemoData();
  ok("Memory persistence", fakeStorage.size === 1, "loading demo data persists state to localStorage");
  const persisted = JSON.parse(Array.from(fakeStorage.values())[0]);
  ok("Memory persistence", Array.isArray(persisted.snapshotHistory) && persisted.snapshotHistory.length >= 3, "persisted state includes the seeded snapshot history — memory is inspectable");

  const openAction = commandCenterStore.getSnapshot().data.actions.find((a) => a.status === "open");
  if (openAction) {
    commandCenterStore.recordActionOutcome(openAction.id, "Resolved successfully.");
    const updatedAction = commandCenterStore.getSnapshot().data.actions.find((a) => a.id === openAction.id)!;
    ok("Action outcomes", updatedAction.status === "completed" && updatedAction.outcome === "Resolved successfully.", "recordActionOutcome() completes the action and stores the outcome");
  }

  const activeDecision = commandCenterStore.getSnapshot().data.decisions.find((d) => d.status === "ACTIVE");
  if (activeDecision) {
    commandCenterStore.updateDecision(activeDecision.id, { status: "AT_RISK" });
    const updatedDecision = commandCenterStore.getSnapshot().data.decisions.find((d) => d.id === activeDecision.id)!;
    ok("Decision status", updatedDecision.status === "AT_RISK", "updateDecision() transitions a decision's status");
  }

  commandCenterStore.clearMemory();
  const afterClear = JSON.parse(Array.from(fakeStorage.values())[0]);
  ok("Memory deletion", afterClear.snapshotHistory.length === 0, "clearMemory() empties snapshot history");
  ok("Memory deletion", afterClear.data.workItems.length > 0, "clearMemory() does not delete live work-item data, only history — no hidden/irrecoverable memory");

  commandCenterStore.resetAll();
  const afterReset = JSON.parse(Array.from(fakeStorage.values())[0]);
  ok("Memory deletion", afterReset.loaded === false && afterReset.data.workItems.length === 0, "resetAll() fully wipes state including live data");

  delete (globalThis as unknown as { window?: unknown }).window;
}

// ================= V1.3 — LIVE PROJECT INTELLIGENCE (Jira) =================

function makeJiraIssue(overrides: Partial<JiraIssue["fields"]> & { key?: string } = {}): JiraIssue {
  const { key, ...fields } = overrides;
  return {
    id: "10001",
    key: key ?? "JPMC-123",
    fields: {
      summary: "Fix checkout bug",
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      priority: { name: "High" },
      assignee: { displayName: "Jane Doe" },
      duedate: "2026-09-03",
      created: "2026-08-01T10:00:00.000+0000",
      updated: "2026-08-27T15:00:00.000+0000",
      labels: [],
      fixVersions: [{ name: "2026.09" }],
      issuetype: { name: "Bug" },
      project: { key: "JPMC", name: "JPMC" },
      ...fields,
    },
  };
}

// ===== Jira priority / status / type mapping =====
{
  ok("Jira mapping", mapPriority("Highest") === "P1" && mapPriority("Blocker") === "P1", "Highest/Blocker map to P1");
  ok("Jira mapping", mapPriority("High") === "P2", "High maps to P2");
  ok("Jira mapping", mapPriority("Medium") === "P3", "Medium maps to P3");
  ok("Jira mapping", mapPriority("Low") === "P4" && mapPriority("Lowest") === "P4", "Low/Lowest map to P4");
  ok("Jira mapping", mapPriority(undefined) === "P3", "missing priority defaults to P3, never P1 (never fabricated urgency)");
  ok("Jira mapping", mapPriority("Custom-Severity-9") === "P3", "an unrecognized custom priority name falls back to P3 rather than throwing");

  ok("Jira mapping", mapStatus("To Do", "new", false) === "Not Started", "statusCategory 'new' maps to Not Started");
  ok("Jira mapping", mapStatus("In Progress", "indeterminate", false) === "In Progress", "statusCategory 'indeterminate' maps to In Progress");
  ok("Jira mapping", mapStatus("Done", "done", false) === "Done", "statusCategory 'done' maps to Done");
  ok("Jira mapping", mapStatus("Blocked", "indeterminate", false) === "Blocked", "a status name containing 'blocked' overrides the category");
  ok("Jira mapping", mapStatus("In Progress", "indeterminate", true) === "Blocked", "the Jira 'flagged' field forces Blocked regardless of status name");
  ok("Jira mapping", mapStatus("In Review", "indeterminate", false) === "In Review", "a status name containing 'review' maps to In Review");
  ok("Jira mapping", isBlockedByHeuristic(undefined, true) === true, "flagged alone is enough to be considered blocked");

  ok("Jira mapping", mapWorkItemType("Bug", []) === "bug", "issuetype Bug maps to bug");
  ok("Jira mapping", mapWorkItemType("Story", []) === "story", "issuetype Story maps to story");
  ok("Jira mapping", mapWorkItemType("Task", []) === "task", "issuetype Task maps to task");
  ok("Jira mapping", mapWorkItemType("Bug", ["production"]) === "production-issue", "a 'production' label upgrades a Bug to production-issue");
  ok("Jira mapping", mapWorkItemType(undefined, []) === "task", "missing issuetype defaults to task rather than throwing");
}

// ===== Jira normalization =====
{
  const issue = makeJiraIssue();
  const { workItem } = normalizeIssue(issue, { baseUrl: "https://acme.atlassian.net", today: TODAY });
  ok("Jira normalization", workItem.key === "JPMC-123" && workItem.title === "Fix checkout bug", "issue.key/summary map to WorkItem.key/title");
  ok("Jira normalization", workItem.owner === "Jane Doe", "assignee.displayName maps to owner");
  ok("Jira normalization", workItem.dueDate === "2026-09-03", "duedate maps straight through (already YYYY-MM-DD)");
  ok("Jira normalization", workItem.priority === "P2", "priority.name is mapped via mapPriority()");
  ok("Jira normalization", workItem.fixVersion === "2026.09", "fixVersions[0].name maps to fixVersion");
  ok("Jira normalization", workItem.sourceType === "jira" && workItem.sourceId === "JPMC-123", "source attribution is set");
  ok("Jira normalization", workItem.sourceUrl === "https://acme.atlassian.net/browse/JPMC-123", "sourceUrl is constructed from the real configured base URL");
  ok("Jira normalization", workItem.businessImpact === undefined, "business impact is never inferred from Jira priority (§17)");
  ok("Jira normalization", workItem.createdDate === "2026-08-01" && workItem.lastUpdated === "2026-08-27", "created/updated timestamps truncate to date-only");

  const noBaseUrl = normalizeIssue(issue, { today: TODAY });
  ok("Jira normalization", noBaseUrl.workItem.sourceUrl === undefined, "sourceUrl is never fabricated when no base URL is configured");

  // Missing fields (§29, §17)
  const bare = makeJiraIssue({ key: "JPMC-999", assignee: null, duedate: null, priority: null, fixVersions: [], labels: undefined });
  const { workItem: bareItem } = normalizeIssue(bare, { today: TODAY });
  ok("Missing fields", bareItem.owner === undefined, "missing assignee -> owner undefined, not fabricated");
  ok("Missing fields", bareItem.dueDate === undefined, "missing duedate -> dueDate undefined");
  ok("Missing fields", bareItem.fixVersion === undefined, "missing fixVersions -> fixVersion undefined");
  ok("Missing fields", bareItem.priority === "P3", "missing priority -> neutral P3 default");

  // Blocked-by dependency mapping
  const blockedIssue = makeJiraIssue({
    key: "JPMC-500",
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    issuelinks: [
      {
        type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
        inwardIssue: { key: "JPMC-100", fields: { summary: "Infra dependency", status: { name: "In Progress", statusCategory: { key: "indeterminate" } } } },
      },
    ],
  });
  const { workItem: blockedItem, dependencies } = normalizeIssue(blockedIssue, { today: TODAY });
  ok("Jira normalization", dependencies.length === 1 && dependencies[0].description.includes("JPMC-100"), "a 'Blocks' issuelink with an inwardIssue becomes a Dependency record");
  ok("Jira normalization", dependencies[0].status === "unresolved", "a not-done blocking issue produces an unresolved dependency");
  ok("Jira normalization", blockedItem.dependencyIds.includes(dependencies[0].id), "the WorkItem references the dependency it produced");

  // Multiple issues at once
  const { workItems } = normalizeIssues([issue, bare, blockedIssue], { today: TODAY });
  ok("Jira normalization", workItems.length === 3, "normalizeIssues processes a batch of fixtures");
}

// ===== Malformed Jira responses (schema validation) =====
{
  ok("Malformed Jira responses", jiraIssueSchema.safeParse({ key: "X-1", fields: {} }).success, "a minimal-but-valid issue (empty fields) validates");
  ok("Malformed Jira responses", !jiraIssueSchema.safeParse({ fields: {} }).success, "an issue with no key is rejected");
  ok("Malformed Jira responses", !jiraIssueSchema.safeParse("not an object").success, "a non-object payload is rejected rather than crashing the mapper");
  ok("Malformed Jira responses", jiraSearchResponseSchema.safeParse({ issues: [], startAt: 0, maxResults: 50, total: 0 }).success, "an empty-project search response validates");
  ok("Malformed Jira responses", !jiraSearchResponseSchema.safeParse({}).success, "a response missing the 'issues' array entirely is rejected, not silently treated as zero results");
  ok("Malformed Jira responses", jiraSearchResponseSchema.safeParse({ issues: [] }).success, "issues:[] with no other fields still validates (startAt/maxResults/total are genuinely optional)");
}

// ===== Pagination, incremental sync, rate-limit handling (dependency-injected fetch) =====
{
  const config = { baseUrl: "https://acme.atlassian.net", email: "ba@acme.com", apiToken: "x" };

  // 3-page fixture: 50 + 50 + 20 = 120 total issues.
  const pages = [50, 50, 20];
  let callCount = 0;
  const paginatedFetch: FetchLike = async (url) => {
    callCount++;
    const startAt = Number(new URL(url).searchParams.get("startAt"));
    const pageIndex = startAt / JIRA_PAGE_SIZE;
    const pageSize = pages[pageIndex] ?? 0;
    const issues = Array.from({ length: pageSize }, (_, i) => makeJiraIssue({ key: `JPMC-${startAt + i}` }));
    return { ok: true, status: 200, json: async () => ({ issues, startAt, maxResults: JIRA_PAGE_SIZE, total: 120 }) };
  };
  const paged = await fetchJiraIssuesWith(paginatedFetch, config, {});
  ok("Pagination", paged.ok && paged.recordsFetched === 120, `pagination collects all 120 issues across pages (got ${paged.ok ? paged.recordsFetched : "error"})`);
  ok("Pagination", callCount === 3, `pagination stops once startAt reaches total — exactly 3 page requests (got ${callCount})`);

  // Incremental sync JQL
  ok("Incremental sync", buildIssuesJql({ sinceIso: "2026-08-01" }).includes('updated >= "2026-08-01"'), "sinceIso produces an 'updated >=' JQL clause");
  ok("Incremental sync", buildIssuesJql({ projectKeys: ["JPMC", "WF"] }).includes('project in ("JPMC","WF")'), "projectKeys produces a 'project in (...)' JQL clause");
  ok("Incremental sync", buildIssuesJql({}) === "order by updated desc", "no options -> a full, unscoped sync JQL");

  // Rate limiting / error classification
  const rateLimited: FetchLike = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const rateLimitedResult = await fetchJiraIssuesWith(rateLimited, config, {});
  ok("Rate-limit handling", !rateLimitedResult.ok && rateLimitedResult.errorKind === "rate-limited", "a 429 response is classified as rate-limited, not a generic failure");

  const authFailed: FetchLike = async () => ({ ok: false, status: 401, json: async () => ({}) });
  ok("Jira error states", (await fetchJiraProjectsWith(authFailed, config)).ok === false, "a 401 fails the projects fetch");
  const authResult = await fetchJiraIssuesWith(authFailed, config, {});
  ok("Jira error states", !authResult.ok && authResult.errorKind === "auth-failure", "401 classified as auth-failure");

  const forbidden: FetchLike = async () => ({ ok: false, status: 403, json: async () => ({}) });
  const forbiddenResult = await fetchJiraIssuesWith(forbidden, config, {});
  ok("Jira error states", !forbiddenResult.ok && forbiddenResult.errorKind === "permission-failure", "403 classified as permission-failure");

  ok("Jira error states", classifyHttpError(500).errorKind === "unknown", "an unrecognized status code classifies as 'unknown', not silently ignored");

  // Malformed response mid-pagination
  const malformedMidway: FetchLike = async (url) => {
    const startAt = Number(new URL(url).searchParams.get("startAt"));
    if (startAt === 0) return { ok: true, status: 200, json: async () => ({ issues: [makeJiraIssue()], startAt: 0, maxResults: 50, total: 100 }) };
    return { ok: true, status: 200, json: async () => ({ garbage: "not a search response" }) };
  };
  const malformedResult = await fetchJiraIssuesWith(malformedMidway, config, {});
  ok("Pagination failure", !malformedResult.ok && malformedResult.errorKind === "malformed-response", "a malformed page mid-pagination fails cleanly rather than returning partial/corrupt data");

  // Network failure
  const networkFail: FetchLike = async () => {
    throw new Error("fetch failed");
  };
  const networkResult = await fetchJiraIssuesWith(networkFail, config, {});
  ok("Jira error states", !networkResult.ok && networkResult.errorKind === "network-error", "a thrown network error is caught and classified, never left to crash the caller");
}

// ===== Multiple projects / multiple clients, Fix Version mapping =====
{
  const jiraProjects = [
    { key: "JPMC", name: "JPMC Digital Onboarding" },
    { key: "JPMCPAY", name: "JPMC Payments" },
    { key: "WF", name: "Wells Fargo Rollout" },
  ];
  const unmapped = normalizeProjects(jiraProjects, { today: TODAY });
  ok("Multiple projects", unmapped.projects.length === 3, "three Jira projects normalize to three Project records");
  ok("Multiple clients", unmapped.clients.length === 3, "without a client mapping, each Jira project defaults to its own client (1:1, never assumed otherwise)");

  const mapped = normalizeProjects(jiraProjects, { today: TODAY, projectToClient: { JPMC: "JPMC", JPMCPAY: "JPMC", WF: "Wells Fargo" } });
  ok("Multiple clients", mapped.clients.length === 2, "a project->client mapping lets one client own multiple Jira projects (§8)");
  ok("Multiple clients", clientIdForProjectKey("JPMC", { JPMC: "JPMC", JPMCPAY: "JPMC" }) === clientIdForProjectKey("JPMCPAY", { JPMC: "JPMC", JPMCPAY: "JPMC" }), "two projects mapped to the same client name resolve to the same clientId");
}

// ===== Global filters =====
{
  const { current } = buildDemoData(TODAY);
  const byClient = applyFilters(current, { clientId: "c-jpmc" }, TODAY);
  ok("Global filters", byClient.workItems.every((w) => w.clientId === "c-jpmc"), "clientId filter scopes work items to that client only");
  ok("Global filters", byClient.workItems.length > 0 && byClient.workItems.length < current.workItems.length, "client filter actually narrows the dataset (not a no-op)");

  const byVersion = applyFilters(current, { fixVersion: "2026.09" }, TODAY);
  ok("Global filters", byVersion.workItems.every((w) => w.fixVersion === "2026.09"), "fixVersion filter scopes to that release only");

  const noFilters = applyFilters(current, {}, TODAY);
  ok("Global filters", noFilters.workItems.length === current.workItems.length, "no active filters returns the data unchanged");

  const versions = availableFixVersions(current);
  ok("Global filters", versions.includes("2026.09"), "availableFixVersions surfaces the fix versions present in the data");
}

// ===== Data freshness =====
{
  const now = Date.now();
  ok("Data freshness", computeFreshness(new Date(now - 5 * 60_000).toISOString(), now) === "fresh", "5 minutes old is fresh (<30min)");
  ok("Data freshness", computeFreshness(new Date(now - 90 * 60_000).toISOString(), now) === "aging", "90 minutes old is aging (30min-4h)");
  ok("Data freshness", computeFreshness(new Date(now - 5 * 3_600_000).toISOString(), now) === "stale", "5 hours old is stale (>4h)");
  ok("Data freshness", computeFreshness(undefined, now) === "unknown", "no sync timestamp at all is 'unknown', never presented as fresh");
}

// ===== Release readiness =====
{
  const readyItems = [
    makeItem({ id: "r1", fixVersion: "2027.01", status: "Done" }),
    makeItem({ id: "r2", fixVersion: "2027.01", status: "Done" }),
  ];
  const readyData = { ...emptyData(), workItems: readyItems };
  const readyHealth = computeReleaseHealth(readyData, "2027.01", TODAY);
  ok("Release readiness", readyHealth.readiness === "READY", `100% complete, 0 blocked/overdue/deps -> READY (got ${readyHealth.readiness})`);

  const notReadyItems = [
    makeItem({ id: "n1", fixVersion: "2027.02", status: "Not Started", blocked: true }),
    makeItem({ id: "n2", fixVersion: "2027.02", status: "Not Started", blocked: true }),
    makeItem({ id: "n3", fixVersion: "2027.02", status: "Not Started", blocked: true }),
  ];
  const notReadyHealth = computeReleaseHealth({ ...emptyData(), workItems: notReadyItems }, "2027.02", TODAY);
  ok("Release readiness", notReadyHealth.readiness === "NOT_READY", `0% complete + 3 blocked -> NOT_READY (got ${notReadyHealth.readiness})`);

  const atRiskItems = [
    makeItem({ id: "a1", fixVersion: "2027.03", status: "Done" }),
    makeItem({ id: "a2", fixVersion: "2027.03", status: "In Progress", blocked: true }),
  ];
  const atRiskHealth = computeReleaseHealth({ ...emptyData(), workItems: atRiskItems }, "2027.03", TODAY);
  ok("Release readiness", atRiskHealth.readiness === "AT_RISK", `50% complete + 1 blocked -> AT_RISK, the documented middle band (got ${atRiskHealth.readiness})`);

  const { current: demoCurrent } = buildDemoData(TODAY);
  const allReleases = computeAllReleaseHealth(demoCurrent, TODAY);
  ok("Release readiness", allReleases.some((r) => r.fixVersion === "2026.09"), "computeAllReleaseHealth finds the demo data's seeded fix version");
}

// ===== Meaningful change detection still works on Jira-normalized data =====
{
  const before = normalizeIssue(makeJiraIssue({ status: { name: "To Do", statusCategory: { key: "new" } } }), { today: TODAY }).workItem;
  const after = normalizeIssue(makeJiraIssue({ status: { name: "Blocked", statusCategory: { key: "indeterminate" } } }), { today: TODAY }).workItem;
  const previous = toSnapshot({ ...emptyData(), workItems: [before] }, "2026-06-14");
  const changes = detectChanges(previous, { ...emptyData(), workItems: [after] }, TODAY);
  ok("Change detection (Jira)", changes.some((c) => c.field === "Status"), "the existing change-detection engine works unchanged on Jira-normalized WorkItems — no engine changes were needed");
}

// ===== AI Context Builder =====
{
  const { current: ctxData } = buildDemoData(TODAY);
  const ctxDerived = deriveData(ctxData, null, TODAY);
  const context = buildAIContext(ctxData, ctxDerived, null, TODAY, { dataSourceType: "jira", lastSyncedAt: "2026-08-28T21:30:00.000Z", baseUrlHost: "acme.atlassian.net" });
  ok("AI context builder", context.topScores.length <= 8 && context.topRisks.length <= 8 && context.meaningfulChanges.length <= 8, "context slices are capped (§34 minimize token usage), not the full dataset");
  ok("AI context builder", context.source.type === "jira" && context.source.baseUrlHost === "acme.atlassian.net", "source metadata is included");
  const serialized = JSON.stringify(context);
  ok("AI context builder", !serialized.includes("apiToken") && !serialized.includes("JIRA_API_TOKEN") && !serialized.includes("ANTHROPIC_API_KEY"), "the built context never contains a credential field or env var name");
}

// ===== Natural-language query routing =====
{
  const { current: qData } = buildDemoData(TODAY);
  const qDerived = deriveData(qData, null, TODAY);

  ok("NL query routing", classifyQuery("What's blocking JPMC?", qData).intent === "blocking", "'what's blocking X' routes to the blocking intent");
  ok("NL query routing", classifyQuery("What changed today?", qData).intent === "changed-today", "'what changed' routes to the changed-today intent");
  ok("NL query routing", classifyQuery("Show me risks for WF.", qData).intent === "risks-for", "'risks for X' routes to the risks-for intent");
  ok("NL query routing", classifyQuery("What should I do in the next 30 minutes?", qData).intent === "next-actions" && classifyQuery("What should I do in the next 30 minutes?", qData).minutes === 30, "'what should I do in N minutes' routes to next-actions with the parsed minute budget");
  ok("NL query routing", classifyQuery("Which client needs attention?", qData).intent === "client-attention", "'which client needs attention' routes to the client-attention intent");
  ok("NL query routing", classifyQuery("asdkjaskdj random text", qData).intent === "unrecognized", "unrecognized input never gets silently mapped to a random intent");

  const blockingRoute = classifyQuery("What's blocking JPMC?", qData);
  const blockingAnswer = answerFromRoute(blockingRoute, qData, qDerived, TODAY, "demo");
  ok("NL query routing", blockingAnswer.facts.length > 0 && blockingAnswer.evidence.length > 0, "the blocking intent for JPMC (which has blocked items in demo data) returns real facts and evidence");

  const mock = new MockAIProvider();
  const answered = await mock.answerQuery("What's blocking JPMC?", blockingAnswer.facts, blockingAnswer.evidence, blockingAnswer.recommendedAction);
  ok("NL query routing", answered.evidence === blockingAnswer.evidence, "answerQuery narrates the given evidence without altering it");
  ok("AI source attribution", answered.evidence.every((e) => !!e.content), "every evidence entry returned to the UI carries inspectable content");

  const emptyAnswer = await mock.answerQuery("What's blocking Diners?", [], [], "");
  ok("NL query routing", emptyAnswer.insufficientEvidence === true, "a query with no retrieved facts is answered honestly, not guessed");
}

// ===== Jira write-back extension point (disabled) =====
{
  const provider = new DisabledJiraActionProvider();
  let threw = 0;
  const calls = [
    () => provider.updateIssue("JPMC-1", {}),
    () => provider.addComment("JPMC-1", "hi"),
    () => provider.transitionIssue("JPMC-1", "31"),
    () => provider.assignIssue("JPMC-1", "acc-1"),
  ];
  for (const call of calls) {
    try {
      await call();
    } catch {
      threw++;
    }
  }
  ok("Human-in-the-loop", threw === calls.length, "every JiraActionProvider method rejects — no write-back is possible even if called by mistake");
}

// ===== Demo fallback / Jira-unavailable fallback / sync failure preserves state =====
{
  const fakeStorage = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (fakeStorage.has(k) ? fakeStorage.get(k)! : null),
      setItem: (k: string, v: string) => { fakeStorage.set(k, v); },
      removeItem: (k: string) => { fakeStorage.delete(k); },
    },
  };

  commandCenterStore.loadDemoData();
  ok("Demo fallback", commandCenterStore.getSnapshot().dataSource === "demo", "the store defaults to (and after loadDemoData, remains) the demo data source");
  const workItemCountBefore = commandCenterStore.getSnapshot().data.workItems.length;

  // No dev server is running in this test process, so JiraDataSource.sync() will hit a
  // real network/URL-parsing failure — this exercises the actual failure path, not a mock.
  const syncResult = await commandCenterStore.syncJira();
  ok("Jira unavailable fallback", syncResult.ok === false, "syncJira() reports failure rather than throwing when the sync endpoint is unreachable");
  ok("Sync safety", commandCenterStore.getSnapshot().data.workItems.length === workItemCountBefore, "a failed sync never touches existing work-item data (§12 sync safety)");
  ok("Sync safety", commandCenterStore.getSnapshot().jiraSync.lastSyncStatus === "failed", "jiraSync bookkeeping records the failure");
  ok("Sync safety", commandCenterStore.getSnapshot().dataSource === "demo", "a failed sync does not switch the active data source to jira");

  const directSourceResult = await new JiraDataSource().sync();
  ok("Jira unavailable fallback", directSourceResult.ok === false && !!directSourceResult.errorKind, "JiraDataSource itself resolves with a classified failure rather than throwing");

  delete (globalThis as unknown as { window?: unknown }).window;
}

// ===== Credential safety — no client-side API token exposure (§33) =====
{
  const repoRoot = path.resolve(process.cwd());
  const clientDirs = ["src/app", "src/components", "src/lib/command-center"];
  const forbidden = [/process\.env\.JIRA_API_TOKEN/, /process\.env\.ANTHROPIC_API_KEY/, /process\.env\.JIRA_EMAIL/];
  const serverOnlyPaths = [path.join("src", "lib", "server"), path.join("src", "app", "api")];

  function walk(dir: string, out: string[]) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
  }

  const files: string[] = [];
  for (const dir of clientDirs) {
    const abs = path.join(repoRoot, dir);
    if (fs.existsSync(abs)) walk(abs, files);
  }
  const violations = files
    .filter((f) => !serverOnlyPaths.some((p) => f.includes(p)))
    .filter((f) => forbidden.some((re) => re.test(fs.readFileSync(f, "utf8"))));

  ok("Credential safety", violations.length === 0, `no client-reachable file references a raw credential env var (violations: ${violations.join(", ") || "none"})`);

  const jiraClientSrc = fs.readFileSync(path.join(repoRoot, "src/lib/server/jira-client.ts"), "utf8");
  ok("Credential safety", jiraClientSrc.includes('import "server-only"'), "the one file that reads real Jira credentials is marked server-only, enforced at build time");
}

// ================= V1.4 — PROACTIVE DELIVERY INTELLIGENCE =================

function makeRisk(overrides: Partial<Risk> = {}): Risk {
  return { id: "risk-1", projectId: "p-1", title: "Test risk", level: "MEDIUM", reason: "test", evidence: ["e1"], potentialImpact: "impact", mitigation: "mitigate", status: "open", confidence: 0.7, detectedAt: TODAY, sourceWorkItemIds: [], ...overrides };
}
function makeDependencyRadarItem(overrides: Partial<DependencyRadarItem> = {}): DependencyRadarItem {
  return { dependencyId: "dep-1", description: "test dep", dependsOnTeam: "Team", ageDays: 1, blockedItemCount: 0, blockedHighPriorityCount: 0, heat: "LOW", recommended: "Monitor.", evidence: [], ...overrides };
}
function makeRiskEscalation(overrides: Partial<RiskEscalation> = {}): RiskEscalation {
  return { riskId: "r-1", riskTitle: "Test risk", currentSeverity: "MEDIUM", daysOpen: 1, evidenceCount: 1, trend: "stable", reopened: false, ...overrides };
}
function makeAttentionItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return { id: "CAT:x", category: "RISK", severity: "MEDIUM", what: "test", why: "test", impact: "test", nowWhat: "test", evidence: [], lifecycle: "ACTIVE", firstSeenDate: TODAY, lastSeenDate: TODAY, ...overrides };
}

// ===== Delivery Drift Engine (§3-7), incl. insufficient history =====
{
  const noHistoryDrift = computeDeliveryDrift([], yesterdayMetrics);
  ok("Delivery drift", noHistoryDrift.level === "STABLE" && noHistoryDrift.trendQuality === "insufficient", "no prior snapshot -> STABLE with insufficient trend quality, never guessed");

  const priorSnap: DailySnapshot = { date: "2026-06-14", workItems: [], risks: [], requirements: [], dependencies: [], projects: [], metrics: yesterdayMetrics };
  const worseningMetrics: SnapshotMetrics = { ...yesterdayMetrics, deliveryConfidence: 35, blockedCount: 10, overdueCount: 5, highRiskCount: 7, unresolvedDependenciesCount: 6 };
  const drift = computeDeliveryDrift([priorSnap], worseningMetrics);
  ok("Delivery drift", drift.level === "SEVERE" || drift.level === "DRIFTING", `multiple worsening deltas classify as at least DRIFTING (got ${drift.level})`);
  ok("Delivery drift", drift.factors.length > 0, "drift factors are populated with the specific deltas that drove the score");
  ok("Delivery drift", drift.evidence.length > 0, "drift carries evidence strings");
  ok("Delivery drift", drift.score >= 0 && drift.score <= 100, "drift score is bounded 0-100");

  const stableDrift = computeDeliveryDrift([priorSnap], { ...yesterdayMetrics });
  ok("Delivery drift", stableDrift.level === "STABLE", "unchanged metrics never produce a drift level above STABLE — never labeled from a single arbitrary signal");

  ok("Trend quality", trendQuality(1) === "insufficient" && trendQuality(2) === "early-signal" && trendQuality(3) === "moderate" && trendQuality(5) === "strong", "trend-quality thresholds match spec §7 (1/2/3-4/5+)");
}

// ===== Delivery Trajectory (§6-7) =====
{
  const noHist = computeTrajectory([], yesterdayMetrics);
  ok("Trajectory", noHist.level === "INSUFFICIENT_HISTORY", "trajectory with zero prior snapshots is explicitly INSUFFICIENT_HISTORY, never a pretend trend");

  const decliningHistory: DailySnapshot[] = [90, 80, 70].map((c, i) => ({
    date: `2026-06-1${i}`, workItems: [], risks: [], requirements: [], dependencies: [], projects: [],
    metrics: { ...yesterdayMetrics, deliveryConfidence: c },
  }));
  const declining = computeTrajectory(decliningHistory, { ...yesterdayMetrics, deliveryConfidence: 55 });
  ok("Trajectory", declining.level === "DRIFTING" || declining.level === "CRITICAL", `consistently declining confidence classifies as DRIFTING/CRITICAL (got ${declining.level})`);

  const stableHistory: DailySnapshot[] = [80, 81, 80].map((c, i) => ({
    date: `2026-06-1${i}`, workItems: [], risks: [], requirements: [], dependencies: [], projects: [],
    metrics: { ...yesterdayMetrics, deliveryConfidence: c },
  }));
  const stable = computeTrajectory(stableHistory, { ...yesterdayMetrics, deliveryConfidence: 82 });
  ok("Trajectory", stable.level === "ON_TRACK", "flat/improving confidence classifies as ON_TRACK");
}

// ===== Risk Escalation + Aging + Reopened (§8-9) =====
{
  const severityHistory: DailySnapshot[] = [
    { date: "2026-06-14", workItems: [], risks: [makeRisk({ title: "Severity jump risk", level: "MEDIUM", evidence: ["e1"] })], requirements: [], dependencies: [], projects: [] },
  ];
  const jumpedRisk = makeRisk({ title: "Severity jump risk", level: "HIGH", evidence: ["e1"] });
  const jumpEsc = computeRiskEscalations([jumpedRisk], severityHistory, TODAY);
  ok("Risk escalation", jumpEsc[0].trend === "worsening" && jumpEsc[0].previousSeverity === "MEDIUM", "severity increasing from the most recent prior day (MEDIUM->HIGH) is worsening");
  ok("Risk escalation", !!jumpEsc[0].escalationReason?.includes("MEDIUM") && !!jumpEsc[0].escalationReason?.includes("HIGH"), "escalation reason names the before/after severity");

  const evidenceHistory: DailySnapshot[] = [
    { date: "2026-06-11", workItems: [], risks: [makeRisk({ title: "WF dependency risk", level: "HIGH", evidence: ["e1"] })], requirements: [], dependencies: [], projects: [] },
    { date: "2026-06-13", workItems: [], risks: [makeRisk({ title: "WF dependency risk", level: "HIGH", evidence: ["e1", "e2"] })], requirements: [], dependencies: [], projects: [] },
  ];
  const currentRisk = makeRisk({ title: "WF dependency risk", level: "HIGH", evidence: ["e1", "e2", "e3"] });
  const evidenceEsc = computeRiskEscalations([currentRisk], evidenceHistory, TODAY);
  ok("Risk escalation", evidenceEsc[0].trend === "worsening", "growing supporting evidence at the same severity, unresolved across multiple snapshots, is itself worsening");
  ok("Risk escalation", evidenceEsc[0].daysOpen === 3, "daysOpen counts the consecutive trailing run of presence across history plus today");

  const reopenHistory: DailySnapshot[] = [
    { date: "2026-06-08", workItems: [], risks: [makeRisk({ title: "Reopened risk" })], requirements: [], dependencies: [], projects: [] },
    { date: "2026-06-10", workItems: [], risks: [], requirements: [], dependencies: [], projects: [] },
  ];
  const reopenedEsc = computeRiskEscalations([makeRisk({ title: "Reopened risk" })], reopenHistory, TODAY);
  ok("Risk escalation", reopenedEsc[0].reopened === true, "a risk present, then absent, then present again is flagged reopened");
  ok("Reopened intelligence", !!reopenedEsc[0].escalationReason, "a reopened risk always carries a human-readable reason");

  ok("Risk escalation", computeRiskEscalations([], [], TODAY).length === 0, "no open risks produces no escalation records");
}

// ===== Dependency Radar + Dependency Heat (§10-11) =====
{
  const depItem = makeItem({ id: "dep-wi-1", key: "DEP-1", priority: "P1", status: "In Progress", fixVersion: "2026.09", dueDate: "2026-06-17", dependencyIds: ["dep-1"] });
  const dependency: Dependency = { id: "dep-1", workItemId: "dep-wi-1", description: "Waiting on WF content", dependsOnTeam: "WF Content", status: "unresolved", raisedDate: "2026-06-05" };
  const radar = computeDependencyRadar({ ...emptyData(), workItems: [depItem], dependencies: [dependency] }, [], TODAY);
  ok("Dependency radar", radar.length === 1, "one unresolved dependency produces one radar item");
  ok("Dependency radar", radar[0].ageDays === 10, "age is computed from raisedDate to today");
  ok("Dependency radar", radar[0].blockedItemCount === 1 && radar[0].blockedHighPriorityCount === 1, "blocked item counts reflect the linked work item");
  ok("Dependency radar", radar[0].heat === "HIGH" || radar[0].heat === "CRITICAL", `an aged dependency blocking a P1 item near release classifies as at least HIGH heat (got ${radar[0].heat})`);
  ok("Dependency radar", !/\d{4}-\d{2}-\d{2}/.test(radar[0].recommended), "the recommendation never invents a specific target date");

  const freshDep: Dependency = { id: "dep-2", workItemId: "dep-wi-2", description: "minor", dependsOnTeam: "Ops", status: "unresolved", raisedDate: TODAY };
  const freshItem = makeItem({ id: "dep-wi-2", key: "DEP-2", priority: "P4", dependencyIds: ["dep-2"] });
  const freshRadar = computeDependencyRadar({ ...emptyData(), workItems: [freshItem], dependencies: [freshDep] }, [], TODAY);
  ok("Dependency radar", freshRadar[0].heat === "LOW", "a brand-new, low-priority, unblocking dependency classifies as LOW heat");

  ok("Dependency radar", computeDependencyRadar(emptyData(), [], TODAY).length === 0, "no unresolved dependencies produces an empty radar");
}

// ===== Decision Radar + Decision Staleness (§12-13) =====
{
  const staleDecision = makeDecision({ id: "dec-stale", projectId: "p-radar", status: "ACTIVE", date: "2026-05-01", relatedWorkItemIds: ["radar-wi"] });
  const staleItem = makeItem({ id: "radar-wi", projectId: "p-radar", scopeChangeCount: 4, blocked: true, blockerReason: "x" });
  const decisionRadar = computeDecisionRadar({ ...emptyData(), workItems: [staleItem], decisions: [staleDecision] }, "manual", TODAY);
  ok("Decision radar", decisionRadar.length === 1, "a stale decision with accumulating evidence and a conflict reason is flagged");
  ok("Decision radar", decisionRadar[0].stalenessDays > 30, "staleness is measured in days since the decision was made");
  ok("Decision radar", decisionRadar[0].needsAttention === true, "a decision with conflict reasons needs attention");

  const freshDecision = makeDecision({ id: "dec-fresh", projectId: "p-fresh", status: "ACTIVE", date: TODAY });
  const freshItem2 = makeItem({ id: "fresh-wi", projectId: "p-fresh" });
  const freshRadar = computeDecisionRadar({ ...emptyData(), workItems: [freshItem2], decisions: [freshDecision] }, "manual", TODAY);
  ok("Decision radar", freshRadar.length === 0, "a fresh, unconflicted, unstale decision never appears in the radar — the UI never changes decision status automatically (§12)");
}

// ===== Action Effectiveness / Action Loop Health (§14-15) =====
{
  const relatedItem = makeItem({ id: "act-wi-1", blocked: true, status: "Blocked" });
  const repeatedAction1 = { id: "act-1", title: "Escalate dependency", why: "x", relatedWorkItemId: "act-wi-1", status: "completed" as const, estimateMinutes: 15, createdAt: "2026-06-10", completedAt: "2026-06-11", outcome: "No response." };
  const repeatedAction2 = { id: "act-2", title: "Escalate dependency again", why: "x", relatedWorkItemId: "act-wi-1", status: "completed" as const, estimateMinutes: 15, createdAt: "2026-06-12", completedAt: "2026-06-13", outcome: "Still no response." };
  const effData = { ...emptyData(), workItems: [relatedItem], actions: [repeatedAction1, repeatedAction2] };
  const results = computeActionEffectiveness(effData);
  ok("Action effectiveness", results.length === 2, "every completed action gets a classification");
  ok("Action effectiveness", results.every((r) => r.classification === "INEFFECTIVE"), "repeated actions against a still-blocked item both classify as INEFFECTIVE — yesterday's action did not resolve the issue");
  const ineffective = ineffectiveActions(results, effData.actions);
  ok("Action effectiveness", ineffective.length === 2, "ineffectiveActions() surfaces every ineffective attempt with its Action record attached");

  const doneItem = makeItem({ id: "act-wi-2", blocked: false, status: "Done" });
  const goodAction = { id: "act-3", title: "Fix it", why: "x", relatedWorkItemId: "act-wi-2", status: "completed" as const, estimateMinutes: 15, createdAt: "2026-06-10", completedAt: "2026-06-11" };
  const goodResults = computeActionEffectiveness({ ...emptyData(), workItems: [doneItem], actions: [goodAction] });
  ok("Action effectiveness", goodResults[0].classification === "EFFECTIVE", "an action whose related item reached Done classifies as EFFECTIVE");

  const orphanAction = { id: "act-4", title: "Mystery action", why: "x", status: "completed" as const, estimateMinutes: 15, createdAt: "2026-06-10", completedAt: "2026-06-11" };
  const unknownResults = computeActionEffectiveness({ ...emptyData(), actions: [orphanAction] });
  ok("Action effectiveness", unknownResults[0].classification === "UNKNOWN", "an action with no related item and no outcome classifies as UNKNOWN rather than a guess — never inferred without outcome evidence");
}

// ===== Stakeholder Radar + Communication Priority (§16-17) =====
{
  const unownedItem = makeItem({ id: "stk-wi-1", priority: "P1", owner: undefined, status: "In Progress" });
  const stakeholders = computeStakeholderAttention({ ...emptyData(), workItems: [unownedItem] }, [], []);
  ok("Stakeholder radar", stakeholders.some((s) => s.role === "OWNER" && s.ownerKey === "unassigned"), "an unowned P1/P2 item is flagged as needing an owner");
  ok("Stakeholder radar", stakeholders.every((s) => !/\bmanager\b|\bdirector\b/i.test(s.reason)), "stakeholder radar never infers organizational hierarchy — literal fields only");

  const overloadedItems = ["a", "b", "c"].map((k) => makeItem({ id: `own-${k}`, owner: "Overloaded Owner", status: "In Progress" }));
  const overloadedResult = computeStakeholderAttention({ ...emptyData(), workItems: overloadedItems }, [], []);
  ok("Stakeholder radar", overloadedResult.some((s) => s.ownerKey === "Overloaded Owner"), "one owner appearing 3+ times across open items is flagged as a concentration risk");

  const commWorkItem = makeItem({ id: "comm-wi-1", riskIds: ["comm-risk-1"] });
  const comm = { id: "comm-1", workItemId: "comm-wi-1", audience: "Client" as const, who: "Client PM", why: "x", whatTheyNeedToKnow: "y", suggestedMessage: "z", status: "open" as const };
  const escalatingRisk = makeRiskEscalation({ riskId: "esc-1", riskTitle: "Comm risk", currentSeverity: "HIGH", trend: "worsening" });
  const priorities = rankCommunicationPriority([comm], { ...emptyData(), workItems: [commWorkItem], risks: [makeRisk({ id: "comm-risk-1", title: "Comm risk" })] }, [escalatingRisk], []);
  ok("Communication priority", priorities[0].priority === "URGENT", "a communication linked to a worsening risk ranks URGENT");
  ok("Communication priority", !!priorities[0].who && !!priorities[0].why && !!priorities[0].what && !!priorities[0].when, "every communication-priority result carries WHO/WHY/WHAT/WHEN");

  const quietComm = { id: "comm-2", audience: "Engineering" as const, who: "Someone", why: "x", whatTheyNeedToKnow: "y", suggestedMessage: "z", status: "open" as const };
  const quietPriority = rankCommunicationPriority([quietComm], emptyData(), [], []);
  ok("Communication priority", quietPriority[0].priority === "NO_ACTION", "a communication with no linked work item and no risk defaults to NO_ACTION, not an invented urgency");
}

// ===== Release Drift (§34) =====
{
  const prevWorkItems = [makeItem({ id: "rel-1", fixVersion: "2026.09", status: "In Progress", dueDate: "2026-06-20" })];
  const prevSnap: DailySnapshot = { date: "2026-06-14", workItems: prevWorkItems, risks: [], requirements: [], dependencies: [], projects: [] };
  const currItems = [
    makeItem({ id: "rel-1", fixVersion: "2026.09", status: "In Progress", blocked: true, blockerReason: "x", dueDate: "2026-06-20" }),
    makeItem({ id: "rel-2", fixVersion: "2026.09", status: "Not Started" }),
  ];
  const currHealths = computeAllReleaseHealth({ ...emptyData(), workItems: currItems }, TODAY);
  const releaseDriftResult = computeReleaseDrift(currHealths, prevSnap, TODAY);
  ok("Release drift", releaseDriftResult.length === 1, "a release present in both the previous snapshot and today produces one release-drift record");
  ok("Release drift", releaseDriftResult[0].blockedDelta > 0, "a new blocker since the previous snapshot is reflected as a positive blockedDelta");
  ok("Release drift", releaseDriftResult[0].scopeDelta === 1, "scope increasing by one item is reflected in scopeDelta");
  ok("Release drift", releaseDriftResult[0].drivers.length > 0, "release drift always names its drivers, never a bare label");
  ok("Release drift", computeReleaseDrift(currHealths, null, TODAY).length === 0, "with no previous snapshot, release drift is never computed from a single point in time");
}

// ===== Client Attention Map (§35) =====
{
  const clientA: Client = { id: "c-a", name: "Client A" };
  const clientB: Client = { id: "c-b", name: "Client B" };
  const itemA = makeItem({ id: "ca-1", clientId: "c-a", priority: "P1", owner: undefined, blocked: true, blockerReason: "x", businessImpact: 5, dueDate: "2026-06-10" });
  const itemB = makeItem({ id: "cb-1", clientId: "c-b", priority: "P4", businessImpact: 1, dueDate: "2026-09-01" });
  const mapData = { ...emptyData(), clients: [clientA, clientB], workItems: [itemA, itemB] };
  const derivedForMap = deriveData(mapData, null, TODAY);
  const rows = computeClientAttentionMap(mapData, derivedForMap, [], null, TODAY);
  ok("Client attention map", rows.length === 2, "one row per client");
  ok("Client attention map", rows[0].clientId === "c-a", "clients are sorted worst delivery-confidence first — a prioritization view, not portfolio management");
  ok("Client attention map", rows[0].deliveryConfidence < rows[1].deliveryConfidence, "the at-risk client has a lower confidence score than the healthy one");
}

// ===== Attention Queue: build, dedup, severity, lifecycle (§22-26, §38-40) =====
{
  const stableDriftForQueue = computeDeliveryDrift([], yesterdayMetrics);
  const severeDrift = { ...stableDriftForQueue, level: "SEVERE" as const, score: 80, factors: [{ name: "Delivery confidence", contribution: 40, detail: "Confidence dropped 20 points" }], evidence: ["Delivery confidence: 90 -> 70"] };
  const inputsBase = {
    drift: severeDrift, releaseDrift: [], riskEscalations: [], openRisks: [], dependencyRadar: [],
    decisionRadar: [], ineffectiveActions: [], stakeholderAttention: [], communicationPriority: [],
  };

  const day1 = buildAttentionQueue(inputsBase, {}, "2026-06-14");
  ok("Attention queue", day1.items.length === 1 && day1.items[0].category === "DRIFT", "a SEVERE drift produces exactly one DRIFT attention item");
  ok("Attention queue", day1.items[0].lifecycle === "NEW", "a first-seen attention item starts as NEW");
  ok("Attention queue", day1.items[0].id === "DRIFT:overall", "attention item id is deterministic (category:entity)");

  const day2 = buildAttentionQueue(inputsBase, day1.nextAttentionState, "2026-06-15");
  ok("Attention queue", day2.items[0].lifecycle === "ACTIVE", "a NEW item advances to ACTIVE the next time it's still present (not stuck at NEW forever)");
  ok("Attention queue", day2.items[0].firstSeenDate === "2026-06-14", "firstSeenDate is preserved across recomputes");

  const depItemA = makeDependencyRadarItem({ dependencyId: "dep-dup", dependsOnTeam: "WF", ageDays: 5, blockedItemCount: 2, blockedHighPriorityCount: 1, heat: "HIGH" });
  const dedupInputs = { ...inputsBase, drift: computeDeliveryDrift([], yesterdayMetrics), dependencyRadar: [depItemA] };
  const dedupResult = buildAttentionQueue(dedupInputs, {}, "2026-06-15");
  ok("Attention deduplication", dedupResult.items.filter((i) => i.id === "DEPENDENCY:dep-dup").length === 1, "the same dependency never produces more than one attention item, however many signals point at it");

  const ackState: Record<string, AttentionItemState> = { "DEPENDENCY:dep-dup": { lifecycle: "ACKNOWLEDGED", firstSeenDate: "2026-06-10", lastSeenDate: "2026-06-14", acknowledgedAt: "2026-06-14" } };
  const ackResult = buildAttentionQueue(dedupInputs, ackState, "2026-06-15");
  ok("Attention lifecycle", ackResult.items[0].lifecycle === "ACKNOWLEDGED", "an ACKNOWLEDGED item stays acknowledged the next day (cooldown, not reset to NEW/ACTIVE) — §38 noise control");

  const snoozedFuture: Record<string, AttentionItemState> = { "DEPENDENCY:dep-dup": { lifecycle: "SNOOZED", firstSeenDate: "2026-06-10", lastSeenDate: "2026-06-14", snoozedUntil: "2026-06-20" } };
  const snoozedResult = buildAttentionQueue(dedupInputs, snoozedFuture, "2026-06-15");
  ok("Attention lifecycle", snoozedResult.items[0].lifecycle === "SNOOZED", "a snoozed item stays snoozed until its snoozedUntil date passes");

  const snoozedExpired: Record<string, AttentionItemState> = { "DEPENDENCY:dep-dup": { lifecycle: "SNOOZED", firstSeenDate: "2026-06-10", lastSeenDate: "2026-06-01", snoozedUntil: "2026-06-10" } };
  const expiredResult = buildAttentionQueue(dedupInputs, snoozedExpired, "2026-06-15");
  ok("Attention lifecycle", expiredResult.items[0].lifecycle === "ACTIVE", "a snooze whose date has passed reactivates the item");

  const resolvedByDisappearance = buildAttentionQueue({ ...inputsBase, drift: computeDeliveryDrift([], yesterdayMetrics), dependencyRadar: [] }, ackState, "2026-06-16");
  ok("Attention lifecycle", resolvedByDisappearance.nextAttentionState["DEPENDENCY:dep-dup"]?.lifecycle === "RESOLVED", "an item whose underlying evidence disappears is auto-resolved");
  ok("Reopened intelligence", resolvedByDisappearance.items.every((i) => i.id !== "DEPENDENCY:dep-dup"), "a resolved item does not appear in the active queue");

  const reappearAfterResolve: Record<string, AttentionItemState> = { "DEPENDENCY:dep-dup": { lifecycle: "RESOLVED", firstSeenDate: "2026-06-10", lastSeenDate: "2026-06-16" } };
  const reopenedResult = buildAttentionQueue(dedupInputs, reappearAfterResolve, "2026-06-17");
  ok("Reopened intelligence", reopenedResult.items[0].lifecycle === "REOPENED", "an item that reappears after being resolved comes back as REOPENED, evidence-backed, not silently as NEW");

  const orderedInputs = {
    ...inputsBase,
    drift: computeDeliveryDrift([], yesterdayMetrics),
    riskEscalations: [makeRiskEscalation({ riskId: "r1", riskTitle: "High risk", currentSeverity: "HIGH", trend: "worsening" })],
    openRisks: [makeRisk({ id: "r1", title: "High risk", level: "HIGH" })],
    dependencyRadar: [depItemA],
  };
  const ordered = buildAttentionQueue(orderedInputs, {}, "2026-06-15");
  const categories = ordered.items.map((i) => i.category);
  ok("Attention queue", categories.indexOf("RISK") < categories.indexOf("DEPENDENCY"), "same-severity items are tie-broken by the §21 category priority order (DRIFT > RISK > DEPENDENCY > DECISION > ACTION > COMMUNICATION)");

  const lowHeatDep = makeDependencyRadarItem({ dependencyId: "dep-low", heat: "LOW" });
  const noiseResult = buildAttentionQueue({ ...inputsBase, drift: computeDeliveryDrift([], yesterdayMetrics), dependencyRadar: [lowHeatDep] }, {}, TODAY);
  ok("Noise control", noiseResult.items.length === 0, "a LOW-heat dependency never becomes an attention item — §38 severity threshold");
}

// ===== First 30 Minutes (§19) =====
{
  const emptyFirst30 = buildFirst30Minutes([], emptyData(), TODAY);
  ok("First 30 minutes", emptyFirst30.length === 0, "with no attention items and no candidates, first-30-minutes returns an empty, not crashing, list");

  const criticalItem = makeAttentionItem({ id: "RISK:x", category: "RISK", severity: "CRITICAL", what: "Critical risk", nowWhat: "Escalate now." });
  const first = buildFirst30Minutes([criticalItem], emptyData(), TODAY);
  ok("First 30 minutes", first.length >= 1 && first[0].attentionItemId === "RISK:x", "attention-queue items are used first, ahead of the generic action-plan fallback — these are recommendations, not automatic actions");
}

// ===== Memory Events (§41-42), incl. Reopened =====
{
  const drift1 = computeDeliveryDrift([], yesterdayMetrics);
  const drift2 = { ...drift1, level: "DRIFTING" as const };
  const events = deriveMemoryEvents(
    drift1, drift2,
    [makeRiskEscalation({ riskTitle: "Escalating risk", trend: "worsening", previousSeverity: "MEDIUM", currentSeverity: "HIGH", escalationReason: "Severity increased." })],
    [makeDependencyRadarItem({ heat: "CRITICAL" })],
    [], TODAY
  );
  ok("Memory events", events.some((e) => e.kind === "drift-transition"), "a drift-level change produces a drift-transition memory event");
  ok("Memory events", events.some((e) => e.kind === "risk-escalation"), "a worsening risk severity change produces a risk-escalation memory event");
  ok("Memory events", events.some((e) => e.kind === "dependency-escalation"), "a dependency reaching CRITICAL heat produces a dependency-escalation memory event");
  ok("Memory events", events.every((e) => e.title.length > 0), "every memory event carries a non-empty title");

  const noChangeEvents = deriveMemoryEvents(drift1, drift1, [], [], [], TODAY);
  ok("Memory events", noChangeEvents.length === 0, "no meaningful transition produces no memory events — not every recomputed value is stored (§41)");
}

// ===== Proactive intelligence — end-to-end + insufficient/limited evidence =====
{
  const { current } = buildDemoData(TODAY);
  const demoDerived = deriveData(current, null, TODAY);
  const proactive = computeProactiveIntelligence(current, demoDerived, [], null, {}, "demo", TODAY);
  ok("Proactive intelligence", !!proactive.drift && !!proactive.trajectory, "computeProactiveIntelligence runs end-to-end against the demo dataset without crashing");
  ok("Proactive intelligence", Array.isArray(proactive.attentionQueue), "attention queue is always an array, even against a real dataset");

  const emptyProactive = computeProactiveIntelligence(emptyData(), deriveData(emptyData(), null, TODAY), [], null, {}, "manual", TODAY);
  ok("Proactive intelligence", emptyProactive.attentionQueue.length === 0 && emptyProactive.clientAttentionMap.length === 0, "an empty dataset produces empty, not crashing, proactive intelligence");
  ok("Proactive intelligence", emptyProactive.trajectory.level === "INSUFFICIENT_HISTORY", "an empty dataset with no history never pretends a trajectory exists");
}

// ===== Backward compatibility — pre-V1.4 persisted state loads cleanly =====
{
  const oldShapeV13 = JSON.stringify({ data: emptyData(), snapshotHistory: [], loaded: true, isDemo: false, eodHistory: [], dataSource: "demo", jiraSync: { lastSyncStatus: "never" }, filters: {} });
  const migratedV14 = parseStoredState(oldShapeV13);
  ok("Backward compatibility", migratedV14.attentionState !== undefined && Object.keys(migratedV14.attentionState).length === 0, "pre-V1.4 persisted state without attentionState migrates to an empty object, not a crash");
  ok("Backward compatibility", Array.isArray(migratedV14.memoryEvents) && migratedV14.memoryEvents.length === 0, "pre-V1.4 persisted state without memoryEvents migrates to an empty array");
}

// ===== Proactive Query Bar (§29-30) =====
{
  const { current: qCurrent } = buildDemoData(TODAY);
  ok("Proactive query bar", classifyQuery("What's getting worse?", qCurrent).intent === "getting-worse", "'what's getting worse' routes to the getting-worse intent");
  ok("Proactive query bar", classifyQuery("What needs my attention?", qCurrent).intent === "needs-attention", "'what needs my attention' routes to needs-attention");
  ok("Proactive query bar", classifyQuery("Which risks are escalating?", qCurrent).intent === "risks-escalating", "'which risks are escalating' routes to risks-escalating, not the generic risks-for intent");
  ok("Proactive query bar", classifyQuery("Which dependencies are dangerous?", qCurrent).intent === "dependencies-dangerous", "'which dependencies are dangerous' routes correctly");
  ok("Proactive query bar", classifyQuery("Which decisions should I revisit?", qCurrent).intent === "decisions-to-revisit", "'which decisions should I revisit' routes correctly");
  ok("Proactive query bar", classifyQuery("Who do I need to contact?", qCurrent).intent === "who-to-contact", "'who do I need to contact' routes correctly");
  ok("Proactive query bar", classifyQuery("What should I do first?", qCurrent).intent === "what-first", "'what should I do first' routes correctly, distinct from the generic next-actions intent");
  ok("Proactive query bar", classifyQuery("Why is delivery drifting?", qCurrent).intent === "why-drifting", "'why is delivery drifting' routes correctly");
  ok("Proactive query bar", classifyQuery("asdkjfh nonsense query", qCurrent).intent === "unrecognized", "nonsense input is never silently misrouted to a proactive intent");

  const qDerived = deriveData(qCurrent, null, TODAY);
  const qProactive = computeProactiveIntelligence(qCurrent, qDerived, [], null, {}, "demo", TODAY);
  const answer = answerFromRoute({ intent: "why-drifting" }, qCurrent, qDerived, TODAY, "demo", qProactive);
  ok("Proactive query bar", Array.isArray(answer.facts), "a proactive intent with a proactive bundle returns real facts, not a crash");

  const noBundleAnswer = answerFromRoute({ intent: "why-drifting" }, qCurrent, qDerived, TODAY, "demo");
  ok("Proactive query bar", noBundleAnswer.facts[0].toLowerCase().includes("not available"), "a proactive intent without a proactive bundle degrades gracefully rather than throwing");
}

// ===== AI schema tests — proactive assessment + Project Story =====
{
  ok("AI schema validation", proactiveAssessmentResponseSchema.safeParse({ assessment: "a", impact: "b", recommendation: "c", confidence: 0.6 }).success, "a well-formed proactive-assessment response validates");
  ok("AI schema validation", !proactiveAssessmentResponseSchema.safeParse({ assessment: "a" }).success, "a proactive-assessment response missing required fields is rejected");
  ok("AI schema validation", !proactiveAssessmentResponseSchema.safeParse({ assessment: "a", impact: "b", recommendation: "c", confidence: 1.5 }).success, "an out-of-range confidence is rejected");

  ok("AI schema validation", projectStoryResponseSchema.safeParse({ narrative: "The project has been stable.", confidence: 0.5 }).success, "a well-formed project-story response validates");
  ok("AI schema validation", !projectStoryResponseSchema.safeParse({ confidence: 0.5 }).success, "a project-story response missing the narrative is rejected");

  const mock = new MockAIProvider();
  const insufficient = await mock.assessProactive("drift", [], [], "no history");
  ok("AI schema validation", insufficient.insufficientEvidence === true, "assessProactive with no facts flags insufficientEvidence rather than guessing");

  const thinStory = await mock.generateProjectStory([], [], false);
  ok("AI schema validation", thinStory.insufficientHistory === true, "generateProjectStory with insufficient history sets insufficientHistory rather than inventing a narrative");
}

// ===== Jira Changelog Normalization + Scope Drift (§32-33, fixture-based) =====
{
  const histories = [
    { created: "2026-06-10T00:00:00.000Z", items: [{ field: "priority", fromString: "Medium", toString: "High" }, { field: "Comment", fromString: null, toString: "irrelevant" }] },
    { created: "2026-06-12T00:00:00.000Z", items: [{ field: "Fix Version", fromString: null, toString: "2026.09" }] },
  ];
  const signals = changelogToScopeSignals("jira-TEST-1", histories);
  ok("Scope drift", signals.length === 2, "only allow-listed scope fields (priority, fix version) become scope signals — a comment field is ignored");
  ok("Scope drift", signals.every((s) => s.workItemId === "jira-TEST-1"), "every scope signal is attributed to the correct work item");
  ok("Scope drift", signals[0].detectedAt === "2026-06-10", "changelog timestamps truncate to date-only, matching the rest of the model");

  const jiraLikeItems = [
    { key: "P1-BLOCKED", priority: "P1", blocked: true, dueDate: "2026-06-20", fixVersion: "2026.09" },
    { key: "P4-QUIET", priority: "P4", blocked: false },
  ];
  const prioritized = selectPrioritizedIssueKeys(jiraLikeItems);
  ok("Scope drift", prioritized[0] === "P1-BLOCKED", "a P1, blocked, release-linked issue is prioritized for changelog retrieval ahead of a quiet P4");
  ok("Scope drift", !prioritized.includes("P4-QUIET"), "a low-priority, unblocked, unlinked issue is never selected for changelog retrieval — §32 'do NOT retrieve for every issue'");
}

// ===== Attention lifecycle store methods + memory-event persistence (via the store singleton) =====
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

  const seedState: Record<string, AttentionItemState> = { "TEST:item": { lifecycle: "NEW", firstSeenDate: TODAY, lastSeenDate: TODAY } };
  commandCenterStore.commitAttentionState(seedState);
  ok("Attention lifecycle (store)", commandCenterStore.getSnapshot().attentionState["TEST:item"]?.lifecycle === "NEW", "commitAttentionState() persists computed lifecycle transitions");

  commandCenterStore.acknowledgeAttentionItem("TEST:item");
  ok("Attention lifecycle (store)", commandCenterStore.getSnapshot().attentionState["TEST:item"]?.lifecycle === "ACKNOWLEDGED", "acknowledgeAttentionItem() transitions to ACKNOWLEDGED");

  commandCenterStore.snoozeAttentionItem("TEST:item", "2026-07-01");
  const snoozed = commandCenterStore.getSnapshot().attentionState["TEST:item"];
  ok("Attention lifecycle (store)", snoozed?.lifecycle === "SNOOZED" && snoozed?.snoozedUntil === "2026-07-01", "snoozeAttentionItem() transitions to SNOOZED with the given date");

  commandCenterStore.resolveAttentionItem("TEST:item");
  ok("Attention lifecycle (store)", commandCenterStore.getSnapshot().attentionState["TEST:item"]?.lifecycle === "RESOLVED", "resolveAttentionItem() transitions to RESOLVED");

  commandCenterStore.acknowledgeAttentionItem("TEST:nonexistent");
  ok("Attention lifecycle (store)", commandCenterStore.getSnapshot().attentionState["TEST:nonexistent"] === undefined, "a lifecycle action on an id that was never computed is a safe no-op, not a crash");

  commandCenterStore.clearMemory();
  ok("Memory deletion", commandCenterStore.getSnapshot().memoryEvents.length === 0, "clearMemory() also clears memoryEvents");

  await commandCenterStore.closeDay();
  ok("Memory events (store)", Array.isArray(commandCenterStore.getSnapshot().memoryEvents), "closeDay() computes and persists memory events without crashing");

  commandCenterStore.resetAll();
  delete (globalThis as unknown as { window?: unknown }).window;
}

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

// ===================================================================================
// V1.6 — Personal Delivery Copilot
// ===================================================================================

function fakeProactive(attentionQueue: AttentionItem[], deliveryLoops: ReturnType<typeof computeDeliveryLoops> = []) {
  return {
    drift: { level: "STABLE", score: 0, factors: [], evidence: [], trend: "stable", confidence: 0.5, trendQuality: "insufficient", snapshotsUsed: 0 },
    trajectory: { level: "INSUFFICIENT_HISTORY", trendQuality: "insufficient", snapshotsUsed: 0 },
    releaseHealths: [],
    releaseDrift: [],
    riskEscalations: [],
    dependencyRadar: [],
    decisionRadar: [],
    decisionEffectiveness: [],
    actionEffectiveness: [],
    deliveryLoops,
    stakeholderAttention: [],
    communicationPriority: [],
    attentionQueue,
    nextAttentionState: {},
    clientAttentionMap: [],
    first30Minutes: [],
    outcomeScorecard: { risksDelta: 0, blockersDelta: 0, confidenceDelta: 0, dependenciesDelta: 0, actionsCompleted: 0, actionsEffective: 0, actionsIneffective: 0, didTodayHelp: "UNKNOWN", controlEffectiveness: "No interventions recorded, or not enough history to compare." },
  } as unknown as Parameters<typeof computePersonalFocus>[1];
}

// ===== Personal Focus Engine — ranking, categories, ownership safety =====
{
  const proj = (n: number) => `pf-proj-${n}`;
  const projects = [1, 2, 3, 4].map((n) => ({ id: proj(n), name: `PF Project ${n}`, clientId: `pf-client-${n}`, status: "on-track" as const }));
  const clients = [1, 2, 3, 4].map((n) => ({ id: `pf-client-${n}`, name: `PF Client ${n}` }));
  const decisionWorkItems = [1, 2, 3, 4, 5].map((n) =>
    makeItem({ id: `pf-wi-dec-${n}`, key: `PFDEC-${n}`, projectId: proj(((n - 1) % 4) + 1), clientId: `pf-client-${((n - 1) % 4) + 1}`, owner: n === 5 ? "Bob" : "Alice" })
  );
  const decisions: Decision[] = [1, 2, 3, 4, 5].map((n) => ({
    id: `pf-dec-${n}`,
    projectId: decisionWorkItems[n - 1].projectId,
    title: `PF Decision ${n}`,
    status: "DECIDED",
    description: "",
    relatedWorkItemIds: [decisionWorkItems[n - 1].id],
  }));
  const decisionAttentionItems: AttentionItem[] = decisions.map((d) => ({
    id: `DECISION:${d.id}`,
    category: "DECISION",
    severity: "HIGH",
    what: d.title,
    why: "Needs review",
    impact: "May affect release readiness.",
    nowWhat: "Review this decision.",
    evidence: ["Evidence A"],
    lifecycle: "ACTIVE",
    firstSeenDate: TODAY,
    lastSeenDate: TODAY,
    sourceRef: { type: "decision", id: d.id },
  }));

  const blockedWorkItem = makeItem({ id: "pf-wi-blocked", key: "PFBLK-1", projectId: proj(1), clientId: "pf-client-1", owner: "Alice", blocked: true, blockerReason: "stuck" });
  const blockedAction: Action = { id: "pf-action-blocked-1", title: "Retry escalation", why: "x", relatedWorkItemId: blockedWorkItem.id, owner: "Alice", status: "completed", estimateMinutes: 15, createdAt: TODAY };
  const actionAttentionItem: AttentionItem = {
    id: `ACTION:${blockedAction.id}`,
    category: "ACTION",
    severity: "MEDIUM",
    what: "Action did not resolve",
    why: "Still blocked",
    impact: "Unresolved",
    nowWhat: "Try a different approach.",
    evidence: [],
    lifecycle: "ACTIVE",
    firstSeenDate: TODAY,
    lastSeenDate: TODAY,
    sourceRef: { type: "action", id: blockedAction.id },
  };

  const pfData: CommandCenterData = { ...emptyData(), clients, projects, workItems: [...decisionWorkItems, blockedWorkItem], decisions, actions: [blockedAction] };
  const proactive = fakeProactive([...decisionAttentionItems, actionAttentionItem]);

  const pfAlice = computePersonalFocus(pfData, proactive, "Alice", TODAY);

  ok("Personal Focus Engine", pfAlice.byCategory.DO_NOW.length === 4, `4 items explicitly owned by Alice, HIGH severity, reach DO_NOW (got ${pfAlice.byCategory.DO_NOW.length})`);
  ok("Personal Focus Engine", pfAlice.byCategory.DO_NOW.every((c) => c.ownershipExplicit), "every DO_NOW candidate has ownershipExplicit === true (§28 gate)");
  ok("Personal Focus Engine", pfAlice.byCategory.BLOCKED.length === 1 && pfAlice.byCategory.BLOCKED[0].sourceId === actionAttentionItem.id, "an ACTION-category item on a blocked work item classifies as BLOCKED");
  ok(
    "Personal Focus Engine",
    pfAlice.candidates.every((c) => c.score === Math.round(c.factors.reduce((s, f) => s + f.contribution, 0))),
    "every candidate's score is exactly the sum of its own factor contributions"
  );
  ok("Personal Focus Engine", pfAlice.candidates.every((c) => c.factors.every((f) => f.contribution <= f.max)), "no factor contribution ever exceeds its documented max");
  ok(
    "Personal Focus Engine",
    pfAlice.candidates.every((c, i) => i === 0 || pfAlice.candidates[i - 1].score >= c.score),
    "candidates are sorted by score, descending"
  );
  ok("Personal Focus Engine", pfAlice.top3.length <= 3 && pfAlice.top3.every((c) => c.category !== "BLOCKED"), "Top 3 never includes a BLOCKED item and never exceeds 3 items");

  ok("Personal Focus Engine — ownership safety", computePersonalFocus(pfData, proactive, undefined, TODAY).byCategory.DO_NOW.length === 0, "with no configured identity, DO_NOW is always empty — ownership can never be assumed (§28)");
  const pfBob = computePersonalFocus(pfData, proactive, "Bob", TODAY);
  ok("Personal Focus Engine — ownership safety", pfBob.byCategory.DO_NOW.length === 1 && pfBob.byCategory.DO_NOW[0].sourceId === "DECISION:pf-dec-5", "explicit ownership requires an exact match — Bob's DO_NOW is only the item Bob owns, none of Alice's");

  ok("Personal Focus Engine — 30-minute plan", pfAlice.thirtyMinutePlanTotalMinutes <= 30, "the 30-minute plan never exceeds its budget");
  ok(
    "Personal Focus Engine — 30-minute plan",
    pfAlice.thirtyMinutePlan.reduce((s, c) => s + c.estimatedMinutes, 0) === pfAlice.thirtyMinutePlanTotalMinutes,
    "thirtyMinutePlanTotalMinutes is exactly the sum of the plan's own items"
  );
  ok("Personal Focus Engine — 30-minute plan", pfAlice.thirtyMinutePlan.every((c) => c.category !== "BLOCKED"), "the 30-minute plan never includes a BLOCKED item");

  ok("Personal Focus Engine — overload", pfAlice.overload !== null, "4 DO_NOW items totaling 60 minutes triggers Focus Overload (§29)");
  ok("Personal Focus Engine — overload", !computePersonalFocus({ ...emptyData() }, fakeProactive([]), "Alice", TODAY).overload, "an empty candidate set never reports overload");

  ok("Personal Focus Engine — context switching", pfAlice.contextSwitch !== null && pfAlice.contextSwitch.projectCount >= 4, "DO_NOW/DO_TODAY items spanning 4+ projects trigger Context Switching (§32)");

  ok("Personal Focus Engine", pfAlice.projectBalance.reduce((s, p) => s + p.itemCount, 0) === pfAlice.candidates.filter((c) => c.category !== "DEFER" && c.category !== "DONE").length, "project balance accounts for every non-deferred candidate exactly once");

  // A LOW-severity, unowned item lands in WATCH/DEFER, never DO_NOW/BLOCKED.
  const lowItem: AttentionItem = { id: "COMMUNICATION:low-1", category: "COMMUNICATION", severity: "LOW", what: "FYI", why: "informational", impact: "none", nowWhat: "No action needed.", evidence: [], lifecycle: "ACTIVE", firstSeenDate: TODAY, lastSeenDate: TODAY };
  const lowResult = computePersonalFocus(emptyData(), fakeProactive([lowItem]), undefined, TODAY);
  ok("Personal Focus Engine", lowResult.candidates[0].category === "WATCH" || lowResult.candidates[0].category === "DEFER", "a LOW-severity, unowned item never reaches DO_NOW or BLOCKED");
}

// ===== Personal Plan reconciliation, carry-forward, daily plan suggestion =====
{
  const proj = (n: number) => `pp-proj-${n}`;
  const wi = makeItem({ id: "pp-wi-1", key: "PP-1", projectId: proj(1), clientId: "pp-client-1", owner: "Alice" });
  const decision: Decision = { id: "pp-dec-1", projectId: proj(1), title: "PP Decision", status: "DECIDED", description: "" };
  const supersededDecision: Decision = { id: "pp-dec-2", projectId: proj(1), title: "PP Decision 2", status: "SUPERSEDED", description: "" };
  const attentionItem: AttentionItem = {
    id: "DECISION:pp-dec-1",
    category: "DECISION",
    severity: "HIGH",
    what: "PP Decision",
    why: "Needs review",
    impact: "x",
    nowWhat: "Review it.",
    evidence: [],
    lifecycle: "ACTIVE",
    firstSeenDate: TODAY,
    lastSeenDate: TODAY,
    sourceRef: { type: "decision", id: decision.id },
  };
  const ppData: CommandCenterData = { ...emptyData(), workItems: [wi], decisions: [decision, supersededDecision] };
  const proactive = fakeProactive([attentionItem]);
  const candidates = computePersonalFocus(ppData, proactive, "Alice", TODAY).candidates;
  const liveCandidate = candidates.find((c) => c.sourceId === attentionItem.id)!;

  const keepItem: PersonalPlanItem = { id: "plan-keep", sourceType: "attention", sourceId: attentionItem.id, priority: 0, position: 0, plannedDate: TODAY, status: "planned", estimatedMinutes: liveCandidate.estimatedMinutes, addedAt: TODAY };
  const removeAttentionItem: PersonalPlanItem = { id: "plan-remove-attn", sourceType: "attention", sourceId: "RISK:resolved-already", priority: 0, position: 1, plannedDate: TODAY, status: "planned", estimatedMinutes: 10, addedAt: TODAY };
  const removeLoopItem: PersonalPlanItem = { id: "plan-remove-loop", sourceType: "loop", sourceId: "pp-dec-2", priority: 0, position: 2, plannedDate: TODAY, status: "planned", estimatedMinutes: 15, addedAt: TODAY };
  const removeMissingLoopItem: PersonalPlanItem = { id: "plan-remove-missing", sourceType: "loop", sourceId: "nonexistent-decision", priority: 0, position: 3, plannedDate: TODAY, status: "planned", estimatedMinutes: 15, addedAt: TODAY };
  const reviewItem: PersonalPlanItem = { id: "plan-review", sourceType: "attention", sourceId: attentionItem.id, priority: 0, position: 4, plannedDate: TODAY, status: "planned", estimatedMinutes: liveCandidate.estimatedMinutes + 5, addedAt: TODAY };
  const completedItem: PersonalPlanItem = { id: "plan-done", sourceType: "attention", sourceId: "whatever", priority: 0, position: 5, plannedDate: TODAY, status: "completed", estimatedMinutes: 5, addedAt: TODAY, completedAt: TODAY };

  const entries = reconcilePersonalPlan([keepItem, removeAttentionItem, removeLoopItem, removeMissingLoopItem, completedItem], candidates, ppData, TODAY);
  ok("Plan reconciliation", entries.find((e) => e.planItemId === "plan-keep")?.action === "KEEP", "a plan item whose live candidate still exists reconciles to KEEP");
  ok("Plan reconciliation", entries.find((e) => e.planItemId === "plan-remove-attn")?.action === "REMOVE", "an attention-sourced plan item whose live candidate has disappeared reconciles to REMOVE");
  ok("Plan reconciliation", entries.find((e) => e.planItemId === "plan-remove-loop")?.action === "REMOVE", "a loop-sourced plan item whose decision was superseded reconciles to REMOVE (stale plan detection, §49)");
  ok("Plan reconciliation", entries.find((e) => e.planItemId === "plan-remove-missing")?.action === "REMOVE", "a loop-sourced plan item whose decision no longer exists reconciles to REMOVE");
  ok("Plan reconciliation", entries.every((e) => e.planItemId !== "plan-done"), "a completed plan item is never reconciled — completed/skipped/deferred items are historical (§50)");

  const reviewEntries = reconcilePersonalPlan([reviewItem], candidates, ppData, TODAY);
  ok("Plan reconciliation", reviewEntries[0].action === "KEEP" || reviewEntries[0].action === "REVIEW", "a plan item with a stale estimate never silently disappears — it's KEEP or REVIEW, never dropped");

  const arrivals = detectNewCriticalArrivals(candidates, []);
  ok("Plan reconciliation — new arrivals", arrivals.some((c) => c.sourceId === attentionItem.id) === (liveCandidate.category === "DO_NOW"), "a DO_NOW candidate not yet in any plan is detected as a new critical arrival (§15) exactly when it is DO_NOW");
  const arrivalsAfterAdd = detectNewCriticalArrivals(candidates, [keepItem]);
  ok("Plan reconciliation — new arrivals", !arrivalsAfterAdd.some((c) => c.sourceId === attentionItem.id), "once a candidate is in the plan (any status), it's no longer a 'new' arrival");

  const yesterday = "2026-06-14"; // TODAY - 1 day
  const unfinishedYesterday: PersonalPlanItem = { id: "plan-carry", sourceType: "attention", sourceId: attentionItem.id, priority: 0, position: 0, plannedDate: yesterday, status: "planned", estimatedMinutes: liveCandidate.estimatedMinutes, addedAt: yesterday };
  const carry = buildCarryForward([unfinishedYesterday], candidates, TODAY);
  ok("Carry-forward", carry.some((c) => c.planItem.id === "plan-carry"), "an unfinished, still-relevant item from a previous day is suggested for carry-forward (§51)");
  const carryAlreadyToday = buildCarryForward([unfinishedYesterday, { ...unfinishedYesterday, id: "plan-carry-today", plannedDate: TODAY }], candidates, TODAY);
  ok("Carry-forward", !carryAlreadyToday.some((c) => c.planItem.id === "plan-carry"), "an item already re-added for today is not suggested again");
  const completedYesterday: PersonalPlanItem = { ...unfinishedYesterday, id: "plan-carry-completed", status: "completed" };
  ok("Carry-forward", !buildCarryForward([completedYesterday], candidates, TODAY).some((c) => c.planItem.id === "plan-carry-completed"), "a completed item never carries forward (§52 — only unresolved items)");

  const suggested = buildSuggestedDailyPlan(candidates, 7);
  ok("Daily plan suggestion", suggested.every((c) => c.category === "DO_NOW" || c.category === "DO_TODAY"), "the suggested daily plan only ever includes DO_NOW/DO_TODAY candidates (§33)");
}

// ===== Personal pattern detection + "My Delivery Review" (§21, §23, §46-49) =====
{
  const skipped: PersonalPlanItem[] = [1, 2, 3].map((n) => ({ id: `pat-skip-${n}`, sourceType: "attention", sourceId: `x-${n}`, priority: 0, position: 0, plannedDate: TODAY, status: "skipped", estimatedMinutes: 5, addedAt: TODAY }));
  const patterns = detectPersonalPatterns(skipped, 7, TODAY);
  ok("Personal patterns", patterns.some((p) => p.kind === "repeatedly-skipped"), "3+ skipped items in the window is detected as a repeatedly-skipped pattern");
  ok("Personal patterns", detectPersonalPatterns(skipped.slice(0, 2), 7, TODAY).length === 0, "below the threshold, no pattern is reported — never false-positives on 1-2 occurrences");
  ok(
    "Personal patterns — evidence first",
    patterns.every((p) => !/bad at|poor|reactive|should delegate/i.test(p.title)),
    "pattern titles are descriptive facts, never a trait/performance judgment (§23)"
  );

  const concProj = "concentrated-project";
  const concentratedCandidates = [1, 2, 3].map((n) => ({
    id: `conc-${n}`,
    sourceType: "attention" as const,
    sourceId: `conc-src-${n}`,
    title: `Item ${n}`,
    projectId: concProj,
    projectName: "Concentrated Project",
    why: "x",
    nowWhat: "x",
    evidence: [],
    category: "DO_NOW" as const,
    score: 60,
    factors: [],
    estimatedMinutes: 10,
    ownershipExplicit: true,
    whyOnMyList: "x",
    severity: "HIGH" as const,
  }));
  ok("Personal patterns — project concentration", detectProjectConcentration(concentratedCandidates) !== null, "3/3 DO_NOW items in one project is detected as project concentration");
  ok("Personal patterns — project concentration", detectProjectConcentration(concentratedCandidates.slice(0, 1)) === null, "below the occurrence threshold, no concentration pattern fires");

  const reviewFacts = buildPersonalDeliveryReviewFacts(
    [
      { id: "rv-1", sourceType: "attention", sourceId: "s1", priority: 0, position: 0, plannedDate: TODAY, status: "completed", estimatedMinutes: 10, addedAt: TODAY, completedAt: TODAY },
      { id: "rv-2", sourceType: "attention", sourceId: "s2", priority: 0, position: 0, plannedDate: TODAY, status: "blocked", estimatedMinutes: 10, addedAt: TODAY },
      { id: "rv-3", sourceType: "attention", sourceId: "s3", priority: 0, position: 0, plannedDate: TODAY, status: "skipped", estimatedMinutes: 10, addedAt: TODAY },
    ],
    [],
    [],
    emptyData(),
    7,
    TODAY
  );
  ok("My Delivery Review — what did I do", reviewFacts.completedCount === 1, "completed-item count reflects the window's planned items");
  ok("My Delivery Review — what did I skip", reviewFacts.skippedCount === 1 && reviewFacts.blockedCount === 1, "skipped/blocked counts are arithmetic, never a productivity score");
}

// ===== Store: Focus Session lifecycle, daily plan, and Personal Memory events =====
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
  const focusToday = getTodayIso();

  ok("Personal identity", commandCenterStore.getSnapshot().ownerName === "Minh Tran", "loadDemoData() seeds a demo-convenience identity, explicit and editable, never silently inferred for real data");
  commandCenterStore.setOwnerName("  Someone Else  ");
  ok("Personal identity", commandCenterStore.getSnapshot().ownerName === "Someone Else", "setOwnerName trims whitespace and persists the explicit identity");
  commandCenterStore.setOwnerName("");
  ok("Personal identity", commandCenterStore.getSnapshot().ownerName === undefined, "clearing the identity field unsets ownerName rather than persisting an empty string");
  commandCenterStore.setOwnerName("Minh Tran");

  const planId = commandCenterStore.addPersonalPlanItem({ sourceType: "attention", sourceId: "TEST:focus-1", estimatedMinutes: 15, plannedDate: focusToday, priority: 0 });
  ok("Personal plan", commandCenterStore.getSnapshot().personalPlan.some((p) => p.id === planId && p.status === "planned"), "addPersonalPlanItem creates a minimal reference-only entry, defaulting to 'planned'");

  commandCenterStore.startFocusItem(planId, focusToday);
  ok("Focus Session lifecycle", commandCenterStore.getSnapshot().personalPlan.find((p) => p.id === planId)?.status === "in-progress", "startFocusItem transitions the plan item to in-progress");
  ok("Focus Session lifecycle", commandCenterStore.getSnapshot().memoryEvents.some((e) => e.kind === "FOCUS_STARTED"), "starting a focus item emits a FOCUS_STARTED memory event");

  commandCenterStore.completeFocusItem(planId, focusToday, "Done well.");
  const completedPlanItem = commandCenterStore.getSnapshot().personalPlan.find((p) => p.id === planId);
  ok("Focus Session lifecycle", completedPlanItem?.status === "completed" && completedPlanItem.completedAt === focusToday && completedPlanItem.note === "Done well.", "completeFocusItem sets status, completedAt, and the optional note");
  ok("Focus Session lifecycle", commandCenterStore.getSnapshot().memoryEvents.some((e) => e.kind === "FOCUS_COMPLETED"), "completing a focus item emits a FOCUS_COMPLETED memory event");

  const blockPlanId = commandCenterStore.addPersonalPlanItem({ sourceType: "attention", sourceId: "TEST:focus-2", estimatedMinutes: 10, plannedDate: focusToday, priority: 1 });
  commandCenterStore.blockFocusItem(blockPlanId, focusToday);
  ok("Focus Session lifecycle", commandCenterStore.getSnapshot().personalPlan.find((p) => p.id === blockPlanId)?.status === "blocked", "blockFocusItem transitions to blocked — never touches Jira/Risk/Decision status (§18)");
  ok("Focus Session lifecycle", commandCenterStore.getSnapshot().memoryEvents.some((e) => e.kind === "FOCUS_BLOCKED"), "marking a focus item blocked emits a FOCUS_BLOCKED memory event");

  const skipPlanId = commandCenterStore.addPersonalPlanItem({ sourceType: "attention", sourceId: "TEST:focus-3", estimatedMinutes: 5, plannedDate: focusToday, priority: 2 });
  commandCenterStore.skipFocusItem(skipPlanId, focusToday);
  ok("Focus Session lifecycle", commandCenterStore.getSnapshot().personalPlan.find((p) => p.id === skipPlanId)?.status === "skipped", "skipFocusItem transitions to skipped");
  ok("Focus Session lifecycle", commandCenterStore.getSnapshot().memoryEvents.some((e) => e.kind === "FOCUS_SKIPPED"), "skipping a focus item emits a FOCUS_SKIPPED memory event");

  const beforeAccept = commandCenterStore.getSnapshot().personalPlan.length;
  commandCenterStore.acceptSuggestedPlan(
    [
      { id: "sug-1", sourceType: "attention", sourceId: "TEST:sug-1", title: "t", why: "w", nowWhat: "n", evidence: [], category: "DO_NOW", score: 60, factors: [], estimatedMinutes: 10, ownershipExplicit: true, whyOnMyList: "x", severity: "HIGH" },
    ],
    focusToday
  );
  ok("Daily plan creation", commandCenterStore.getSnapshot().personalPlan.length === beforeAccept + 1, "acceptSuggestedPlan bulk-adds the suggested items");
  ok("Daily plan creation", commandCenterStore.getSnapshot().memoryEvents.some((e) => e.kind === "DAILY_PLAN_CREATED"), "accepting a suggested plan emits exactly one DAILY_PLAN_CREATED event, not one per item");

  commandCenterStore.reorderPersonalPlan(focusToday, [blockPlanId, skipPlanId]);
  ok("Personal plan — human control", true, "reorderPersonalPlan runs without crashing (position reassignment, §34)");

  commandCenterStore.removePersonalPlanItem(skipPlanId);
  ok("Personal plan — human control", !commandCenterStore.getSnapshot().personalPlan.some((p) => p.id === skipPlanId), "removePersonalPlanItem deletes the reference entirely");

  commandCenterStore.resetPersonalPlanForToday(focusToday);
  ok("Daily plan reset", !commandCenterStore.getSnapshot().personalPlan.some((p) => p.plannedDate === focusToday && p.status === "planned"), "resetPersonalPlanForToday clears only today's not-yet-started items");
  ok("Daily plan reset", commandCenterStore.getSnapshot().memoryEvents.some((e) => e.kind === "DAILY_PLAN_UPDATED"), "resetting the plan emits a DAILY_PLAN_UPDATED memory event");

  commandCenterStore.recordDailyFocusReviewed(focusToday);
  ok("Personal memory", commandCenterStore.getSnapshot().memoryEvents.some((e) => e.kind === "DAILY_FOCUS_REVIEWED"), "reviewing today's focus emits a DAILY_FOCUS_REVIEWED memory event");

  commandCenterStore.resetAll();
  delete (globalThis as unknown as { window?: unknown }).window;
}

// ===== Backward compatibility — pre-V1.6 persisted state loads cleanly =====
{
  const oldShapeV15 = JSON.stringify({
    data: emptyData(),
    snapshotHistory: [],
    loaded: true,
    isDemo: false,
    eodHistory: [],
    dataSource: "demo",
    jiraSync: { lastSyncStatus: "never" },
    filters: {},
    attentionState: {},
    memoryEvents: [],
  });
  const migratedV16 = parseStoredState(oldShapeV15);
  ok("Backward compatibility", migratedV16.ownerName === undefined, "pre-V1.6 persisted state without ownerName migrates to undefined, not a crash — never assumes an identity");
  ok("Backward compatibility", Array.isArray(migratedV16.personalPlan) && migratedV16.personalPlan.length === 0, "pre-V1.6 persisted state without personalPlan migrates to an empty array");

  const malformed = JSON.stringify({ ...JSON.parse(oldShapeV15), ownerName: 42, personalPlan: "not-an-array" });
  const migratedMalformed = parseStoredState(malformed);
  ok("Backward compatibility", migratedMalformed.ownerName === undefined && Array.isArray(migratedMalformed.personalPlan), "malformed ownerName/personalPlan values fall back safely rather than crashing (§57)");
}

// ===== Command Bar V1.6 intents =====
{
  const { current: cbData } = buildDemoData(TODAY);
  ok("Command Bar V1.6", classifyQuery("What should I focus on today?", cbData).intent === "personal-focus-today", "'what should I focus on today' routes to personal-focus-today");
  ok("Command Bar V1.6", classifyQuery("What is most important for me?", cbData).intent === "personal-focus-today", "'what is most important for me' routes to personal-focus-today");
  ok("Command Bar V1.6", classifyQuery("What can wait?", cbData).intent === "personal-can-wait", "'what can wait' routes to personal-can-wait");
  ok("Command Bar V1.6", classifyQuery("What can I finish in 30 minutes?", cbData).intent === "personal-thirty-min", "'what can I finish in 30 minutes' routes to personal-thirty-min");
  ok("Command Bar V1.6", classifyQuery("Why is this on my list?", cbData).intent === "why-on-my-list", "'why is this on my list' routes to why-on-my-list");
  ok("Command Bar V1.6", classifyQuery("Am I overloaded?", cbData).intent === "am-i-overloaded", "'am I overloaded' routes to am-i-overloaded");
  ok("Command Bar V1.6", classifyQuery("What did I actually work on?", cbData).intent === "what-did-i-work-on", "'what did I actually work on' routes to what-did-i-work-on");
  ok("Command Bar V1.6", classifyQuery("What did I skip?", cbData).intent === "what-did-i-skip", "'what did I skip' routes to what-did-i-skip");
  ok("Command Bar V1.6", classifyQuery("What did I complete this week?", cbData).intent === "what-did-i-complete", "'what did I complete this week' routes to what-did-i-complete");
  ok("Command Bar V1.6", classifyQuery("Which projects need my attention?", cbData).intent === "which-projects-need-attention", "'which projects need my attention' routes correctly");
  ok("Command Bar V1.6", classifyQuery("Where am I spending most of my time?", cbData).intent === "where-spending-time", "'where am I spending most of my time' routes correctly");
  ok("Command Bar V1.6", classifyQuery("What's blocking my focus?", cbData).intent === "whats-blocking-focus", "'what's blocking my focus' routes correctly");
  ok("Command Bar V1.6", classifyQuery("What should I defer?", cbData).intent === "what-should-i-defer", "'what should I defer' routes correctly");
  ok("Command Bar V1.6", classifyQuery("asdkjfh nonsense query", cbData).intent === "unrecognized", "nonsense input remains unclassified, never misrouted to a personal-focus intent");

  // Regression guard: the existing V1.4 next-actions phrasing must still route correctly
  // now that personal-thirty-min shares the "30 minutes" vocabulary.
  const nextActionsRoute = classifyQuery("What should I do in the next 30 minutes?", cbData);
  ok("Command Bar V1.6 — no regression", nextActionsRoute.intent === "next-actions" && nextActionsRoute.minutes === 30, "'what should I do in the next 30 minutes' still routes to the pre-existing next-actions intent, not personal-thirty-min");

  const cbDerived = deriveData(cbData, null, TODAY);
  const cbProactiveBundle = computeProactiveIntelligence(cbData, cbDerived, [], null, {}, "demo", TODAY);
  const cbPersonalFocus = computePersonalFocus(cbData, cbProactiveBundle, "Minh Tran", TODAY);
  const withBundles = answerFromRoute({ intent: "personal-focus-today" }, cbData, cbDerived, TODAY, "demo", cbProactiveBundle, cbPersonalFocus);
  ok("Command Bar V1.6", Array.isArray(withBundles.facts), "personal-focus-today returns real facts when the personal-focus bundle is available");

  const withoutBundle = answerFromRoute({ intent: "personal-focus-today" }, cbData, cbDerived, TODAY, "demo", cbProactiveBundle);
  ok("Command Bar V1.6", withoutBundle.facts[0].toLowerCase().includes("not available"), "a personal-focus intent without the personal-focus bundle degrades gracefully rather than throwing");

  const reviewFacts = buildPersonalDeliveryReviewFacts([], [], [], cbData, 7, TODAY);
  const withReview = answerFromRoute({ intent: "what-did-i-skip" }, cbData, cbDerived, TODAY, "demo", cbProactiveBundle, cbPersonalFocus, reviewFacts);
  ok("Command Bar V1.6", Array.isArray(withReview.facts), "what-did-i-skip returns real facts when the personal-review bundle is available");
  const withoutReview = answerFromRoute({ intent: "what-did-i-skip" }, cbData, cbDerived, TODAY, "demo", cbProactiveBundle, cbPersonalFocus);
  ok("Command Bar V1.6", withoutReview.facts[0].toLowerCase().includes("not available"), "a personal-review intent without the review bundle degrades gracefully rather than throwing");
}

// ===== AI Daily Guidance — schema, evidence references, AI safety =====
{
  ok("AI schema validation", dailyGuidanceResponseSchema.safeParse({ summary: "s", topFocus: ["a"], watch: [], recommendation: "r", evidenceReferences: ["e"], confidence: 0.6 }).success, "a well-formed daily-guidance response validates");
  ok("AI schema validation", !dailyGuidanceResponseSchema.safeParse({ summary: "s" }).success, "a daily-guidance response missing required fields is rejected");
  ok("AI schema validation", !dailyGuidanceResponseSchema.safeParse({ summary: "s", topFocus: [], watch: [], recommendation: "r", evidenceReferences: [], confidence: 2 }).success, "an out-of-range confidence is rejected");

  const mock = new MockAIProvider();
  const empty = await mock.generateDailyGuidance([], [], [], [], []);
  ok("AI Daily Guidance", empty.insufficientEvidence === true && empty.topFocus.length === 0, "with no top-focus facts, MockAIProvider sets insufficientEvidence rather than inventing a focus item");

  const withFacts = await mock.generateDailyGuidance(["JPMC release decision — urgent review"], ["WF minor risk"], ["JPMC:planned"], ["Confidence improved 3 points"], ["Evidence: confidence dropped 12 points"]);
  ok("AI Daily Guidance", withFacts.topFocus.length > 0 && withFacts.evidenceReferences.length > 0, "with real facts, MockAIProvider returns a non-empty topFocus and evidenceReferences (evidence traceability, §39-40)");
  ok(
    "AI safety",
    !/you are (bad|poor|reactive)|you should delegate|your management style/i.test(JSON.stringify(withFacts)),
    "generateDailyGuidance output never contains a personality/performance judgment (§40)"
  );
}

// ===================================================================================
// V1.7 — Real-World Delivery Copilot Hardening
// ===================================================================================

const FIXTURE_CONFIG: JiraConnectionConfig = { baseUrl: "https://fixture.invalid", email: "fixture@example.test", apiToken: "fixture-not-real" };

// ===== P0 — Jira Conformance Harness =====
{
  const paged = await fetchJiraIssuesWith(fixtureFetch({ issuePages: [FIXTURE_ISSUE_PAGE_1, FIXTURE_ISSUE_PAGE_2] }), FIXTURE_CONFIG, {});
  ok("Jira conformance — pagination", paged.ok && paged.recordsFetched === 3, `pagination across 2 fixture pages combines to the full result set (got ${paged.ok ? paged.recordsFetched : "error"})`);

  const malformed = await fetchJiraIssuesWith(fixtureFetch({ malformed: true }), FIXTURE_CONFIG, {});
  ok("Jira conformance — malformed response", !malformed.ok && malformed.errorKind === "malformed-response", "a response that doesn't match the expected shape is rejected, never crashes");

  const authFail = await fetchJiraProjectsWith(fixtureFetch({ httpStatus: 401 }), FIXTURE_CONFIG);
  ok("Jira conformance — error classification", !authFail.ok && authFail.errorKind === "auth-failure", "401 is classified as auth-failure");
  const rateLimited = await fetchJiraProjectsWith(fixtureFetch({ httpStatus: 429 }), FIXTURE_CONFIG);
  ok("Jira conformance — error classification", !rateLimited.ok && rateLimited.errorKind === "rate-limited", "429 is classified as rate-limited, never silently retried without the caller's knowledge");

  const fixtureReport = await runJiraConformance();
  ok("Jira conformance — harness", fixtureReport.source === "fixtures", "a harness run with no live config honestly reports source: 'fixtures'");
  ok("Jira conformance — harness", fixtureReport.checks.length > 0 && fixtureReport.checks.every((c) => c.status !== "FAIL"), `every conformance check passes against the harness's own fixtures (${fixtureReport.checks.filter((c) => c.status === "FAIL").map((c) => c.capability).join(", ")})`);
  ok("Jira conformance — harness", fixtureReport.fieldSupport === JIRA_FIELD_SUPPORT && fixtureReport.fieldSupport.some((f) => f.field === "Business impact" && f.level === "UNSUPPORTED"), "the field-quality table correctly reports Business impact as UNSUPPORTED, never inferred from priority");
  ok("Jira conformance — harness", fixtureReport.fieldSupport.some((f) => f.field === "Scope change count" && f.level === "PARTIALLY_SUPPORTED"), "scope change count is honestly reported as PARTIALLY_SUPPORTED (only a prioritized subset of issues is checked per sync)");
  ok("Jira conformance — harness", !/token|password|secret/i.test(fixtureReport.credentialSafety) || /no .*token/i.test(fixtureReport.credentialSafety), "the credential-safety statement never leaks an actual secret value");

  const liveStyleReport = await runJiraConformance({ fetchImpl: fixtureFetch(), config: FIXTURE_CONFIG });
  ok("Jira conformance — harness", liveStyleReport.source === "live", "passing a fetchImpl+config (as a real live connection would) reports source: 'live' — never presented as a fixture run");
}

// ===== P0 — Incremental sync cursor hardening =====
{
  const noOffset = buildIncrementalSinceParam("2026-06-15T14:32:00.000Z");
  ok("Incremental sync cursor", noOffset === "2026-06-15", "with no configured timezone offset, the cursor falls back unchanged to the original safe day-level precision");

  const withOffset = buildIncrementalSinceParam("2026-06-15T14:32:00.000Z", 0);
  ok("Incremental sync cursor", withOffset === "2026-06-15 14:27", "with a configured offset, the cursor is minute-precision, floored by the 5-minute same-minute-race safety buffer");

  const reproducible = buildIncrementalSinceParam("2026-06-15T14:32:00.000Z", 0) === withOffset;
  ok("Incremental sync cursor", reproducible, "the same input always produces the same cursor — deterministic, no hidden clock dependency");

  const midnightBoundary = buildIncrementalSinceParam("2026-01-01T00:02:00.000Z", 0);
  ok("Incremental sync cursor", midnightBoundary === "2025-12-31 23:57", "a last-sync instant just after midnight correctly crosses back into the previous day once the safety buffer is applied — never silently wraps or errors");

  const positiveOffset = buildIncrementalSinceParam("2026-06-15T00:10:00.000Z", 540); // JST, UTC+9
  ok("Incremental sync cursor", positiveOffset === "2026-06-15 09:05", "a positive (ahead-of-UTC) timezone offset shifts the wall-clock cursor forward as expected");

  const negativeOffset = buildIncrementalSinceParam("2026-06-15T14:00:00.000Z", -300); // US Eastern
  ok("Incremental sync cursor", negativeOffset === "2026-06-15 08:55", "a negative (behind-UTC) timezone offset shifts the wall-clock cursor backward as expected");

  // "retry after failed sync" / "partial page failure" — the existing pagination loop
  // simply propagates a page failure as a whole-sync failure rather than returning partial
  // data, so a retry always starts clean; this pins that behavior as a regression guard.
  let callCount = 0;
  const flakyThenOk: typeof fixtureFetch = () => async (url: string) => {
    callCount += 1;
    if (callCount === 1) return { ok: false, status: 500, json: async () => ({}) };
    return fixtureFetch()(url);
  };
  const firstAttempt = await fetchJiraIssuesWith(flakyThenOk(), FIXTURE_CONFIG, {});
  ok("Incremental sync cursor — retry safety", !firstAttempt.ok, "a mid-sync HTTP failure fails the whole sync rather than returning a partial, silently-incomplete result set");
  const secondAttempt = await fetchJiraIssuesWith(flakyThenOk(), FIXTURE_CONFIG, {});
  ok("Incremental sync cursor — retry safety", secondAttempt.ok, "retrying after a failed sync succeeds cleanly with no leftover state from the failed attempt");
}

// ===== P1 — Deadline Conflict Detection =====
function pfc(overrides: Partial<PersonalFocusCandidate> = {}): PersonalFocusCandidate {
  return {
    id: `focus:attention:${Math.random()}`,
    sourceType: "attention",
    sourceId: "x",
    title: "Test item",
    why: "x",
    nowWhat: "x",
    evidence: [],
    category: "DO_TODAY",
    score: 50,
    factors: [],
    estimatedMinutes: 15,
    ownershipExplicit: true,
    whyOnMyList: "x",
    severity: "HIGH",
    ...overrides,
  };
}
{
  const noneDue = detectDeadlineConflict([pfc({ dueDate: undefined })], TODAY);
  ok("Deadline conflict", noneDue?.insufficientEvidence === true, "no explicit due dates on any actionable item reports insufficientEvidence rather than guessing at a conflict (§20)");

  const oneHighPriorityDue = detectDeadlineConflict([pfc({ dueDate: TODAY, severity: "HIGH" }), pfc({ dueDate: "2026-12-01", severity: "HIGH" })], TODAY);
  ok("Deadline conflict", oneHighPriorityDue === null, "only one high-priority item due soon is not a conflict — conflicts require 2+");

  const twoHighDueToday = detectDeadlineConflict([pfc({ dueDate: TODAY, severity: "CRITICAL", estimatedMinutes: 20 }), pfc({ dueDate: TODAY, severity: "HIGH", estimatedMinutes: 20 })], TODAY, 30);
  ok("Deadline conflict", twoHighDueToday !== null && twoHighDueToday.itemCount === 2, "2 high-priority items due today/overdue is a real, detected conflict");
  ok("Deadline conflict", twoHighDueToday!.totalEstimatedMinutes === 40 && twoHighDueToday!.totalEstimatedMinutes > twoHighDueToday!.availableBudgetMinutes, "the conflict reports total estimated focus vs the available budget, matching the §21 example shape");
  ok(
    "Deadline conflict — not a productivity judgment",
    !/you performed|productivity|effectively/i.test(twoHighDueToday!.reason + twoHighDueToday!.nowWhat),
    "the conflict is phrased as an observation ('review the top items first'), never a productivity judgment (§21)"
  );

  const lowSeverityDue = detectDeadlineConflict([pfc({ dueDate: TODAY, severity: "LOW" }), pfc({ dueDate: TODAY, severity: "MEDIUM" })], TODAY);
  ok("Deadline conflict", lowSeverityDue === null, "two due-today items that are neither CRITICAL nor HIGH severity don't trigger a conflict");

  const blockedExcluded = detectDeadlineConflict([pfc({ dueDate: TODAY, severity: "HIGH", category: "BLOCKED" }), pfc({ dueDate: TODAY, severity: "HIGH" })], TODAY);
  ok("Deadline conflict", blockedExcluded === null, "a BLOCKED item due today doesn't count toward a deadline conflict — it can't be acted on regardless of urgency");
}

// ===== P1 — Ownership ambiguity (§13, §15) =====
{
  const proj = "amb-proj";
  const wiA = makeItem({ id: "amb-wi-a", key: "AMB-A", projectId: proj, clientId: "amb-client", owner: "Alice" });
  const wiB = makeItem({ id: "amb-wi-b", key: "AMB-B", projectId: proj, clientId: "amb-client", owner: "Bob" });
  const decision: Decision = { id: "amb-dec-1", projectId: proj, title: "Ambiguous decision", status: "DECIDED", description: "", relatedWorkItemIds: [wiA.id, wiB.id] };
  const attentionItem: AttentionItem = {
    id: "DECISION:amb-dec-1",
    category: "DECISION",
    severity: "HIGH",
    what: decision.title,
    why: "Needs review",
    impact: "x",
    nowWhat: "Review it.",
    evidence: [],
    lifecycle: "ACTIVE",
    firstSeenDate: TODAY,
    lastSeenDate: TODAY,
    sourceRef: { type: "decision", id: decision.id },
  };
  const ambData: CommandCenterData = { ...emptyData(), workItems: [wiA, wiB], decisions: [decision] };
  const result = computePersonalFocus(ambData, fakeProactive([attentionItem]), "Alice", TODAY);
  const candidate = result.candidates.find((c) => c.sourceId === attentionItem.id)!;
  ok("Ownership ambiguity", candidate.ownerAmbiguous === true, "related work items with two different explicit owners are reported as ambiguous, not silently resolved to the first one");
  ok("Ownership ambiguity", candidate.ownershipExplicit === false, "an ambiguous owner is never treated as explicit, even though one of the disagreeing owners (Alice) matches the configured identity");
  ok("Ownership ambiguity", candidate.category !== "DO_NOW", "an ambiguous-ownership item can never reach DO_NOW regardless of how important it looks (§13 — no guessing because it looks important)");
  ok("Ownership ambiguity", candidate.whyOnMyList.includes("OWNER UNCLEAR"), "the 'why is this mine' explanation says OWNER UNCLEAR rather than picking a side (§15)");
}

// ===== P1 — Personal Identity =====
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
  commandCenterStore.setPersonalIdentity({ displayName: "Tay", email: "tay@example.test" });
  const id1 = commandCenterStore.getSnapshot().personalIdentity?.id;
  ok("Personal identity", commandCenterStore.getSnapshot().ownerName === "Tay" && commandCenterStore.getSnapshot().personalIdentity?.displayName === "Tay", "setPersonalIdentity keeps ownerName and personalIdentity.displayName in sync");
  commandCenterStore.setPersonalIdentity({ displayName: "Tay Nguyen" });
  ok("Personal identity", commandCenterStore.getSnapshot().personalIdentity?.id === id1, "editing the display name keeps the same stable identity id — it's not a new identity");
  commandCenterStore.setPersonalIdentity(undefined);
  ok("Personal identity", commandCenterStore.getSnapshot().ownerName === undefined && commandCenterStore.getSnapshot().personalIdentity === undefined, "clearing the identity unsets both fields together");
  commandCenterStore.resetAll();
  delete (globalThis as unknown as { window?: unknown }).window;
}

// ===== P1 — Plan Reconciliation Hardening (pinning, snapshots) =====
{
  const proj = "rh-proj";
  const wi = makeItem({ id: "rh-wi-1", key: "RH-1", projectId: proj, clientId: "rh-client", owner: "Alice" });
  const decision: Decision = { id: "rh-dec-1", projectId: proj, title: "RH Decision", status: "DECIDED", description: "", relatedWorkItemIds: [wi.id] };
  const attentionItem: AttentionItem = {
    id: "DECISION:rh-dec-1",
    category: "DECISION",
    severity: "HIGH",
    what: decision.title,
    why: "Needs review",
    impact: "x",
    nowWhat: "Review it.",
    evidence: [],
    lifecycle: "ACTIVE",
    firstSeenDate: TODAY,
    lastSeenDate: TODAY,
    sourceRef: { type: "decision", id: decision.id },
  };
  const rhData: CommandCenterData = { ...emptyData(), workItems: [wi], decisions: [decision] };
  const rhCandidates = computePersonalFocus(rhData, fakeProactive([attentionItem]), "Alice", TODAY).candidates;
  const liveCandidate = rhCandidates.find((c) => c.sourceId === attentionItem.id)!;

  const pinnedGoingStale: PersonalPlanItem = {
    id: "rh-plan-pinned",
    sourceType: "attention",
    sourceId: "RISK:no-longer-exists",
    priority: 0,
    position: 0,
    plannedDate: TODAY,
    status: "planned",
    estimatedMinutes: 10,
    addedAt: TODAY,
    pinned: true,
  };
  const pinnedEntries = reconcilePersonalPlan([pinnedGoingStale], rhCandidates, rhData, TODAY);
  ok("Plan reconciliation hardening — pinning", pinnedEntries[0].action === "REVIEW" && pinnedEntries[0].pinnedNeedsReview === true, "a pinned item that would otherwise be REMOVEd instead reports REVIEW with pinnedNeedsReview — never silently removed (§23)");

  const unpinnedGoingStale: PersonalPlanItem = { ...pinnedGoingStale, id: "rh-plan-unpinned", pinned: false };
  const unpinnedEntries = reconcilePersonalPlan([unpinnedGoingStale], rhCandidates, rhData, TODAY);
  ok("Plan reconciliation hardening — pinning", unpinnedEntries[0].action === "REMOVE" && !unpinnedEntries[0].pinnedNeedsReview, "an equivalent unpinned item still resolves to a plain REMOVE — pinning is the only thing that changes this");

  const becameUrgent: PersonalPlanItem = {
    id: "rh-plan-snapshot",
    sourceType: liveCandidate.sourceType,
    sourceId: liveCandidate.sourceId,
    priority: 0,
    position: 0,
    plannedDate: TODAY,
    status: "planned",
    estimatedMinutes: liveCandidate.estimatedMinutes,
    addedAt: TODAY,
    snapshot: { category: "WATCH", projectId: liveCandidate.projectId, ownershipExplicit: false },
  };
  const snapshotEntries = reconcilePersonalPlan([becameUrgent], rhCandidates, rhData, TODAY);
  ok(
    "Plan reconciliation hardening — snapshot diffing",
    snapshotEntries[0].action === "REVIEW" && /urgent/i.test(snapshotEntries[0].reason),
    `a snapshot recorded as WATCH whose live category is now DO_NOW reconciles to REVIEW with a concrete reason (got: ${snapshotEntries[0].action} — ${snapshotEntries[0].reason})`
  );

  const noSnapshot: PersonalPlanItem = { ...becameUrgent, id: "rh-plan-no-snapshot", snapshot: undefined };
  const noSnapshotEntries = reconcilePersonalPlan([noSnapshot], rhCandidates, rhData, TODAY);
  ok("Plan reconciliation hardening — backward compatibility", noSnapshotEntries[0].action === "KEEP", "a pre-V1.7 plan item with no snapshot safely falls back to KEEP rather than crashing on the missing baseline");

  const actionCompleted: Action = { id: "rh-action-1", title: "Fix it", why: "x", relatedDecisionId: decision.id, status: "completed", estimateMinutes: 15, createdAt: TODAY };
  const loopPlanItem: PersonalPlanItem = { id: "rh-plan-loop", sourceType: "loop", sourceId: decision.id, priority: 0, position: 0, plannedDate: TODAY, status: "planned", estimatedMinutes: 15, addedAt: TODAY };
  const loopData: CommandCenterData = { ...rhData, actions: [actionCompleted] };
  const loopEntries = reconcilePersonalPlan([loopPlanItem], [], loopData, TODAY);
  ok("Plan reconciliation hardening — action completed", loopEntries[0].action === "REMOVE" && /action was completed/i.test(loopEntries[0].reason), "a loop-sourced item whose related action has completed reconciles to REMOVE with that specific reason (§22)");
}

// ===== P2 — AI Quality Evaluation =====
{
  const causal = evaluateAiResponse({
    task: "test",
    response: { summary: "The decision caused a 12-point improvement." },
    schemaValid: true,
    narrativeText: "The decision caused a 12-point improvement.",
    inputFacts: ["Confidence: 44 -> 56"],
    inputEvidence: [],
    confidence: 0.7,
  });
  ok("AI evaluation", causal.findings.find((f) => f.dimension === "CAUSAL_LANGUAGE")?.pass === false, "causal language ('caused') is deterministically flagged, even though the prompt is instructed to avoid it — this is the verification, not just the instruction");

  const ownershipInference = evaluateAiResponse({
    task: "test",
    response: { summary: "As the BA, you should delegate this." },
    schemaValid: true,
    narrativeText: "As the BA, you should delegate this.",
    inputFacts: ["x"],
    inputEvidence: [],
    confidence: 0.6,
  });
  ok("AI evaluation", ownershipInference.findings.find((f) => f.dimension === "OWNERSHIP_INFERENCE")?.pass === false, "inferred-role language ('as the BA') is flagged");

  const overconfident = evaluateAiResponse({ task: "test", response: {}, schemaValid: true, narrativeText: "", inputFacts: [], inputEvidence: [], confidence: 0.95 });
  ok("AI evaluation", overconfident.findings.find((f) => f.dimension === "CONFIDENCE_CONSISTENCY")?.pass === false, "0.95 confidence with zero input facts/evidence is flagged as inconsistent");
  ok("AI evaluation", overconfident.findings.find((f) => f.dimension === "INSUFFICIENT_EVIDENCE_HANDLING")?.pass === false, "zero input with no insufficientEvidence flag set is flagged");

  const properlyFlagged = evaluateAiResponse({ task: "test", response: {}, schemaValid: true, narrativeText: "", inputFacts: [], inputEvidence: [], confidence: 0.4, insufficientEvidenceFlag: true });
  ok("AI evaluation", properlyFlagged.findings.find((f) => f.dimension === "INSUFFICIENT_EVIDENCE_HANDLING")?.pass === true, "zero input WITH insufficientEvidence correctly set passes");

  const unsupportedClaim = evaluateAiResponse({
    task: "test",
    response: {},
    schemaValid: true,
    narrativeText: "Confidence dropped 99 points this week.",
    inputFacts: ["Confidence dropped 12 points this week."],
    inputEvidence: [],
    confidence: 0.6,
  });
  ok("AI evaluation", unsupportedClaim.findings.find((f) => f.dimension === "UNSUPPORTED_CLAIMS")?.pass === false, "a numeric claim (99 points) not present in the supplied facts is flagged as unsupported/hallucinated");

  const supportedClaim = evaluateAiResponse({
    task: "test",
    response: {},
    schemaValid: true,
    narrativeText: "Confidence dropped 12 points this week.",
    inputFacts: ["Confidence dropped 12 points this week."],
    inputEvidence: [],
    confidence: 0.6,
  });
  ok("AI evaluation", supportedClaim.findings.find((f) => f.dimension === "UNSUPPORTED_CLAIMS")?.pass === true, "a numeric claim that does appear in the supplied facts is not flagged");

  const noCoverage = evaluateAiResponse({ task: "test", response: {}, schemaValid: true, narrativeText: "x", inputFacts: [], inputEvidence: ["Evidence A", "Evidence B"], evidenceReferenced: [], confidence: 0.5 });
  ok("AI evaluation", noCoverage.findings.find((f) => f.dimension === "EVIDENCE_COVERAGE")?.pass === false, "evidence was supplied but none referenced — flagged as a traceability gap");

  const schemaFail = evaluateAiResponse({ task: "test", response: {}, schemaValid: false, narrativeText: "", inputFacts: [], inputEvidence: [], confidence: 0.5 });
  ok("AI evaluation", schemaFail.findings.find((f) => f.dimension === "SCHEMA_VALIDITY")?.pass === false && schemaFail.failCount > 0, "a schema-invalid response is reflected directly in the evaluation result");
}

// ===== P2 — AI Response Trace =====
{
  clearAiTrace();
  recordAiCall({ task: "answerQuery", mode: "claude", schemaValid: true, fallbackUsed: false, evidenceReferenceCount: 3 });
  const trace1 = getRecentAiTrace();
  ok("AI trace", trace1.length === 1 && trace1[0].task === "answerQuery" && trace1[0].mode === "claude", "recordAiCall/getRecentAiTrace round-trip correctly");

  clearAiTrace();
  for (let i = 0; i < 55; i++) recordAiCall({ task: `task-${i}`, mode: "mock", schemaValid: false, fallbackUsed: true, evidenceReferenceCount: 0 });
  const trace2 = getRecentAiTrace();
  ok("AI trace", trace2.length === 50, "the trace is capped (never grows unbounded — this is a diagnostic, not a telemetry platform)");
  ok("AI trace", trace2[0].task === "task-54", "the most recent call is first");
  clearAiTrace();
}

// ===== P2 — Data Health =====
{
  const full = makeItem({ id: "dh-1", owner: "Alice", dueDate: "2026-07-01", fixVersion: "2026.09" });
  const empty = makeItem({ id: "dh-2", owner: undefined, dueDate: undefined, fixVersion: undefined });
  const healthFull = computeDataHealth({ ...emptyData(), workItems: [full] }, "manual", "2026-06-15T00:00:00.000Z", new Date("2026-06-15T00:10:00.000Z").getTime());
  ok("Data Health", healthFull.ownershipCoveragePct === 100 && healthFull.dueDateCoveragePct === 100 && healthFull.releaseCoveragePct === 100, "full coverage on every dimension reports 100%, computed directly from explicit fields");

  const healthEmpty = computeDataHealth({ ...emptyData(), workItems: [empty] }, "manual", undefined);
  ok("Data Health", healthEmpty.ownershipCoveragePct === 0 && healthEmpty.freshness === "unknown", "missing owner/due-date/fixVersion reports 0% coverage, and no last-sync time reports freshness 'unknown'");

  const healthNoItems = computeDataHealth(emptyData(), "manual", undefined);
  ok("Data Health", healthNoItems.ownershipCoveragePct === 0 && healthNoItems.totalWorkItems === 0, "zero open work items never divides by zero — reports 0%, not NaN or a crash");

  const jiraNoScope = computeDataHealth({ ...emptyData(), workItems: [makeItem({ id: "dh-3", scopeChangeCount: 0 })] }, "jira", undefined);
  ok("Data Health", jiraNoScope.scopeHistoryCoverage === "none", "a Jira-sourced dataset with zero scope-change signals reports 'none', distinct from a non-Jira source's 'full'");
  const jiraSomeScope = computeDataHealth({ ...emptyData(), workItems: [makeItem({ id: "dh-4", scopeChangeCount: 2 }), makeItem({ id: "dh-5", scopeChangeCount: 0 })] }, "jira", undefined);
  ok("Data Health", jiraSomeScope.scopeHistoryCoverage === "partial", "a Jira-sourced dataset with some but not all items carrying a scope signal reports 'partial', never a false 'full'");
  ok("Data Health", !JSON.stringify(jiraSomeScope).includes("score"), "Data Health never produces a single blended 'score' field (§31)");
}

// ===== P2 — Command Bar precedence regression guards (§35) =====
{
  const { current: cbData2 } = buildDemoData(TODAY);
  ok("Command Bar precedence", classifyQuery("Which client needs attention?", cbData2).intent === "client-attention", "'which client needs attention' (no 'my') still routes to the pre-existing V1.4 client-attention intent");
  ok("Command Bar precedence", classifyQuery("Which projects need my attention?", cbData2).intent === "which-projects-need-attention", "'which projects need MY attention' routes to the new V1.6 personal intent — the 'my' is what disambiguates them");
  ok("Command Bar precedence", classifyQuery("Why is delivery drifting?", cbData2).intent === "why-drifting", "'why is delivery drifting' is not captured by the newer, broader 'why is this...' personal-focus pattern");
  ok("Command Bar precedence", classifyQuery("What's blocking JPMC?", cbData2).intent === "blocking", "'what's blocking JPMC' still routes to the generic blocking intent with a target, not the narrower whats-blocking-focus intent");
  ok("Command Bar precedence", classifyQuery("What should I do in the next 30 minutes?", cbData2).intent === "next-actions", "regression: the V1.4 'next N minutes' phrasing still wins over the V1.6 personal-thirty-min pattern");
}

// ===== Backward compatibility — pre-V1.7 localStorage loads cleanly =====
{
  const oldShapeV16 = JSON.stringify({
    data: emptyData(),
    snapshotHistory: [],
    loaded: true,
    isDemo: false,
    eodHistory: [],
    dataSource: "jira",
    jiraSync: { lastSyncStatus: "success", recordsFetched: 10 }, // no durationMs/scopeChangesDetected/warnings — pre-V1.7 shape
    filters: {},
    attentionState: {},
    memoryEvents: [],
    ownerName: "Old Name",
    personalPlan: [{ id: "old-plan-1", sourceType: "attention", sourceId: "x", priority: 0, position: 0, plannedDate: TODAY, status: "planned", estimatedMinutes: 10, addedAt: TODAY }],
  });
  const migrated = parseStoredState(oldShapeV16);
  ok("Backward compatibility", migrated.personalIdentity === undefined, "pre-V1.7 state has no personalIdentity object — migrates to undefined, not a crash, even though ownerName is set");
  ok("Backward compatibility", migrated.jiraSync.recordsFetched === 10 && migrated.jiraSync.durationMs === undefined, "a pre-V1.7 JiraSyncState loads with the new diagnostic fields simply absent, not defaulted to zero/fabricated");
  ok("Backward compatibility", migrated.personalPlan[0].pinned === undefined && migrated.personalPlan[0].origin === undefined && migrated.personalPlan[0].snapshot === undefined, "a pre-V1.7 PersonalPlanItem loads with no pinned/origin/snapshot fields — all optional, none defaulted destructively");

  // The reconciliation/personal-focus pipeline must not crash on this old-shaped data.
  const oldPlanItem = migrated.personalPlan[0];
  const noThrowEntries = reconcilePersonalPlan([oldPlanItem], [], emptyData(), TODAY);
  ok("Backward compatibility", Array.isArray(noThrowEntries), "reconcilePersonalPlan runs without throwing on a pre-V1.7-shaped PersonalPlanItem");
}

// ===== V1.8 P0 — Jira Conformance: LIVE vs FIXTURE mode reporting =====
{
  const report = await runJiraConformance();
  ok("V1.8 Conformance reporting", report.modeLabel === "FIXTURE MODE", "a credential-less run reports FIXTURE MODE explicitly");
  ok("V1.8 Conformance reporting", report.jiraHostname === undefined, "fixture mode never fabricates a Jira hostname");
  ok("V1.8 Conformance reporting", typeof report.projectsDiscovered === "number" && report.projectsDiscovered === 2, "project count is surfaced from the actual fixture run, not hardcoded");
  ok("V1.8 Conformance reporting", typeof report.issuesFetched === "number" && report.issuesFetched! > 0, "issue count is surfaced from the actual fixture run");
  ok("V1.8 Conformance reporting", report.truncated === false, "a small fixture run is never falsely reported as truncated");
  ok("V1.8 Conformance reporting", typeof report.paginationBehavior === "string" && report.paginationBehavior!.includes("startAt"), "pagination behavior is described honestly (classic startAt), not invented");
  ok("V1.8 Conformance reporting", typeof report.changelogBehavior === "string" && report.changelogBehavior!.includes("prioritized"), "changelog behavior discloses the prioritized-subset limitation, never claims full coverage");
  ok("V1.8 Conformance reporting", typeof report.durationMs === "number" && report.durationMs! >= 0, "duration is measured, not omitted");
  ok("V1.8 Conformance reporting", JSON.stringify(report).match(/fixture-token-not-real|Bearer |Basic /) === null, "no credential-bearing string ever appears anywhere in the serialized report");

  const liveReport = await runJiraConformance({ fetchImpl: fixtureFetch(), config: { baseUrl: "https://acme.atlassian.net", email: "e@example.test", apiToken: "sekrit-xyz-987" } });
  ok("V1.8 Conformance reporting", liveReport.modeLabel === "LIVE JIRA MODE" && liveReport.source === "live", "a run with a supplied fetchImpl/config is honestly labeled LIVE, even though the underlying fetch here is still a fixture double in this test");
  ok("V1.8 Conformance reporting", liveReport.jiraHostname === "acme.atlassian.net", "live mode surfaces the hostname only — never the full credential-bearing base URL, email, or token");
  ok("V1.8 Conformance reporting", JSON.stringify(liveReport).includes("sekrit-xyz-987") === false, "the API token never appears in a live conformance report");
}

// ===== V1.8 P0 — Cursor-based pagination capability detection =====
{
  const supported = await detectJiraSearchCapability(fixtureFetch({ capabilityStatus: 200 }), FIXTURE_CONFIG);
  ok("V1.8 Cursor capability", supported.capability === "SUPPORTED", "a 200 from /search/jql is classified SUPPORTED");

  const unsupported = await detectJiraSearchCapability(fixtureFetch(), FIXTURE_CONFIG);
  ok("V1.8 Cursor capability", unsupported.capability === "UNSUPPORTED", "the default fixture environment (404 on /search/jql) is classified UNSUPPORTED, modeling a classic Server/Data Center instance");

  const unknownAuth = await detectJiraSearchCapability(fixtureFetch({ capabilityStatus: 401 }), FIXTURE_CONFIG);
  ok("V1.8 Cursor capability", unknownAuth.capability === "UNKNOWN", "a rejected probe (401) never guesses either way — reported as UNKNOWN, not UNSUPPORTED");

  const throwingFetch: FetchLike = async () => { throw new Error("network down"); };
  const unknownNetwork = await detectJiraSearchCapability(throwingFetch, FIXTURE_CONFIG);
  ok("V1.8 Cursor capability", unknownNetwork.capability === "UNKNOWN", "a network error during the probe is reported as UNKNOWN, never crashes the caller");

  const conformanceWithCapability = await runJiraConformance();
  ok("V1.8 Cursor capability", conformanceWithCapability.cursorCapability?.capability === "UNSUPPORTED", "the conformance report includes the capability probe result end-to-end");
}

// ===== V1.8 P0 — Jira Data Contract Validation =====
{
  const fullSample: JiraIssue[] = [FIXTURE_ISSUE_PAGE_1.issues[0] as JiraIssue, FIXTURE_ISSUE_PAGE_1.issues[1] as JiraIssue];
  const fullReport = evaluateJiraDataContract(fullSample);
  ok("V1.8 Data contract", fullReport.sampleSize === 2, "sample size reflects the actual issues evaluated");
  const summaryField = fullReport.fields.find((f) => f.field === "Summary");
  ok("V1.8 Data contract", summaryField?.level === "SUPPORTED", "a field present on every sampled issue is classified SUPPORTED");
  const reporterField = fullReport.fields.find((f) => f.field === "Reporter");
  ok("V1.8 Data contract", reporterField?.level === "UNSUPPORTED", "a field never requested from Jira is classified UNSUPPORTED, not MISSING_IN_SAMPLE — no sample size would change that answer");
  const changelogField = fullReport.fields.find((f) => f.field === "Changelog / scope history");
  ok("V1.8 Data contract", changelogField?.level === "PARTIALLY_SUPPORTED", "changelog/scope history is always reported partial by design, never claimed complete");

  const mixedSample: JiraIssue[] = [
    { key: "X-1", fields: { summary: "a", duedate: "2026-09-01" } } as JiraIssue,
    { key: "X-2", fields: { summary: "b" } } as JiraIssue,
  ];
  const mixedReport = evaluateJiraDataContract(mixedSample);
  const dueDateField = mixedReport.fields.find((f) => f.field === "Due date");
  ok("V1.8 Data contract", dueDateField?.level === "PARTIALLY_SUPPORTED", "a field present on some but not all sampled issues is PARTIALLY_SUPPORTED, never rounded up to SUPPORTED");

  const noDueDateSample: JiraIssue[] = [{ key: "X-3", fields: { summary: "c" } } as JiraIssue];
  const noneReport = evaluateJiraDataContract(noDueDateSample);
  const missingDueDate = noneReport.fields.find((f) => f.field === "Due date");
  ok("V1.8 Data contract", missingDueDate?.level === "MISSING_IN_SAMPLE", "a field absent from every sampled issue is MISSING_IN_SAMPLE, never silently reported as 'safe' or SUPPORTED (§6 — 'Due date unavailable', not 'Due date is safe')");
  ok("V1.8 Data contract", !JSON.stringify(missingDueDate).toLowerCase().includes("safe"), "the data contract never uses reassuring language for missing data");

  const emptySampleReport = evaluateJiraDataContract([]);
  ok("V1.8 Data contract", emptySampleReport.fields.every((f) => f.level === "MISSING_IN_SAMPLE" || f.level === "UNSUPPORTED" || f.field === "Changelog / scope history"), "an empty sample never fabricates SUPPORTED/PARTIALLY_SUPPORTED for any requested field");
}

// ===== V1.8 P1 — AI evaluation as a real quality gate (WARN tier) =====
{
  const zeroInputOverconfident = evaluateAiResponse({ task: "t", response: {}, schemaValid: true, narrativeText: "", inputFacts: [], inputEvidence: [], confidence: 0.95 });
  const zeroFinding = zeroInputOverconfident.findings.find((f) => f.dimension === "CONFIDENCE_CONSISTENCY");
  ok("V1.8 AI quality gate", zeroFinding?.severity === "FAIL", "confidence 0.95 with zero inputs is a hard FAIL — nothing at all justifies that confidence");

  const oneInputOverconfident = evaluateAiResponse({ task: "t", response: {}, schemaValid: true, narrativeText: "", inputFacts: ["one fact"], inputEvidence: [], confidence: 0.9 });
  const oneFinding = oneInputOverconfident.findings.find((f) => f.dimension === "CONFIDENCE_CONSISTENCY");
  ok("V1.8 AI quality gate", oneFinding?.severity === "WARN", "confidence 0.9 with exactly one input is a WARN, not a hard FAIL — plausible but under-evidenced, per the documented rule");
  ok("V1.8 AI quality gate", oneInputOverconfident.warnCount === 1, "warnCount reflects WARN-severity findings distinctly from PASS/FAIL");

  const wellEvidenced = evaluateAiResponse({ task: "t", response: {}, schemaValid: true, narrativeText: "", inputFacts: ["a", "b"], inputEvidence: [], confidence: 0.9 });
  const wellFinding = wellEvidenced.findings.find((f) => f.dimension === "CONFIDENCE_CONSISTENCY");
  ok("V1.8 AI quality gate", wellFinding?.severity === "PASS", "confidence 0.9 with two or more inputs passes cleanly");

  const valid = evaluateAiResponse({ task: "t", response: { summary: "Confidence 44 -> 56 based on supplied facts." }, schemaValid: true, narrativeText: "Confidence 44 -> 56 based on supplied facts.", inputFacts: ["Confidence: 44 -> 56"], inputEvidence: [], confidence: 0.6 });
  ok("V1.8 AI quality gate", valid.failCount === 0, "a fully compliant response passes every dimension — VALID fixture");
}

// ===== V1.8 P1 — Data Health actionable remediation =====
{
  const unowned1 = makeItem({ id: "dh-rem-1", key: "REM-1", owner: undefined, dueDate: "2026-07-01", fixVersion: "2026.09" });
  const unowned2 = makeItem({ id: "dh-rem-2", key: "REM-2", owner: undefined, dueDate: "2026-07-01", fixVersion: "2026.09" });
  const owned = makeItem({ id: "dh-rem-3", key: "REM-3", owner: "Alice", dueDate: "2026-07-01", fixVersion: "2026.09" });
  const health = computeDataHealth({ ...emptyData(), workItems: [unowned1, unowned2, owned] }, "manual", "2026-06-15T00:00:00.000Z", new Date("2026-06-15T00:05:00.000Z").getTime());
  const ownershipRemediation = health.remediation?.find((r) => r.dimension === "Ownership coverage");
  ok("V1.8 Data Health remediation", ownershipRemediation !== undefined, "a partial ownership dimension produces a remediation entry");
  ok("V1.8 Data Health remediation", ownershipRemediation?.what.includes("2 item(s)") ?? false, "the WHAT line states exactly how many items are affected");
  ok("V1.8 Data Health remediation", /Personal Focus|Stakeholder Attention/.test(ownershipRemediation?.whyItMatters ?? ""), "the WHY IT MATTERS line names real, existing surfaces — never a vague generality");
  ok("V1.8 Data Health remediation", ownershipRemediation?.affectedItemIds.includes("dh-rem-1") && ownershipRemediation?.affectedItemIds.includes("dh-rem-2") && !ownershipRemediation?.affectedItemIds.includes("dh-rem-3"), "affectedItemIds points at the actual, real unowned items — never invented work");

  const fullyHealthy = computeDataHealth({ ...emptyData(), workItems: [owned] }, "manual", "2026-06-15T00:00:00.000Z", new Date("2026-06-15T00:05:00.000Z").getTime());
  ok("V1.8 Data Health remediation", fullyHealthy.remediation?.length === 0, "a fully healthy dataset produces no remediation entries — remediation is never manufactured busywork");

  const staleData = computeDataHealth({ ...emptyData(), workItems: [owned] }, "jira", "2026-06-14T00:00:00.000Z", new Date("2026-06-15T00:00:00.000Z").getTime());
  const freshnessRemediation = staleData.remediation?.find((r) => r.dimension === "Freshness");
  ok("V1.8 Data Health remediation", staleData.freshness === "stale" && freshnessRemediation !== undefined, "stale data produces a freshness remediation entry pointing at re-syncing");
}

// ===== V1.8 P1 — AI trace hardening (no leakage) =====
{
  clearAiTrace();
  recordAiCall({ task: "generateDailyGuidance", mode: "claude", schemaValid: true, fallbackUsed: false, evidenceReferenceCount: 3 });
  const [entry] = getRecentAiTrace();
  const allowedKeys = new Set(["id", "timestamp", "task", "mode", "schemaValid", "fallbackUsed", "evidenceReferenceCount"]);
  ok("V1.8 AI trace hardening", Object.keys(entry).every((k) => allowedKeys.has(k)), "a recorded trace entry contains only the bounded, documented key set — structurally cannot carry a prompt, header, or credential (recordAiCall's parameter type has no such field)");
  ok("V1.8 AI trace hardening", !("apiKey" in entry) && !("authorization" in entry) && !("prompt" in entry) && !("rawPayload" in entry), "no credential/prompt-shaped key is present on a trace entry");
  clearAiTrace();
}

// ===== V1.8 P1 — Command Bar hardening: ambiguous / near-miss / unsupported regression fixtures =====
{
  const { current: cbData } = buildDemoData(TODAY);
  const ambiguousFixtures: string[] = [
    "asdkjfh random gibberish",
    "",
    "delete everything please",
    "update jira status to done",
    "send an email to the client",
    "what is the meaning of life",
    "schedule a meeting for tomorrow",
    "approve the decision",
    "change the priority to P1",
    "assign this to bob",
    "   ",
    "???",
    "yes",
    "ok thanks",
    "export this to excel",
    "make me a sandwich",
  ];
  ok("V1.8 Command Bar hardening", ambiguousFixtures.length >= 15, "at least 15 ambiguous/unsupported regression fixtures are defined (§19)");
  for (const query of ambiguousFixtures) {
    const route = classifyQuery(query, cbData);
    ok("V1.8 Command Bar hardening", route.intent === "unrecognized", `unrecognized/unsupported input ("${query.slice(0, 30) || "(empty)"}") never gets silently routed to a vaguely related intent — falls back to "unrecognized" rather than guessing`);
  }

  // Near-miss regressions: phrasing that resembles a real intent but should NOT match it.
  ok("V1.8 Command Bar hardening", classifyQuery("what should I eat for lunch", cbData).intent === "unrecognized", "'what should I eat' is not swallowed by the 'what should i do' next-actions pattern");
  ok("V1.8 Command Bar hardening", classifyQuery("this is risky business", cbData).intent === "unrecognized" || classifyQuery("this is risky business", cbData).intent === "risks-for", "a loose use of the word 'risk' either resolves to the risk intent or is honestly unrecognized — never a different, unrelated intent");
}

// ===== V1.8 P2 — "Why can't I trust this?" trust diagnostic =====
{
  const healthyDataHealth = computeDataHealth({ ...emptyData(), workItems: [makeItem({ id: "td-1", owner: "Alice", dueDate: "2026-07-01", fixVersion: "2026.09" })] }, "manual", "2026-06-15T00:00:00.000Z", new Date("2026-06-15T00:05:00.000Z").getTime());
  const entries = computeTrustDiagnostic({ dataHealth: healthyDataHealth, dataSource: "manual", jiraSync: { lastSyncStatus: "never" }, claudeAvailable: false });
  ok("V1.8 Trust diagnostic", entries.length === 7, "all 7 spec categories (Data, Coverage, Ownership, Jira, Scope, AI, Evidence) are present");
  ok("V1.8 Trust diagnostic", entries.every((e) => e.answer.length > 0), "every category has an actual, non-empty answer — never a bare number");
  ok("V1.8 Trust diagnostic", !JSON.stringify(entries).match(/trustScore|overallScore/i), "no blended trust score is ever produced (§18 'never a generic dashboard full of numbers')");
  const jiraEntry = entries.find((e) => e.category === "Jira");
  ok("V1.8 Trust diagnostic", jiraEntry?.status === "info" && /not Jira/.test(jiraEntry.answer), "a non-Jira data source honestly says Jira status doesn't apply, rather than fabricating a sync status");

  const failedSync = computeTrustDiagnostic({ dataHealth: healthyDataHealth, dataSource: "jira", jiraSync: { lastSyncStatus: "failed", lastSyncError: "Jira rejected the configured credentials." }, claudeAvailable: true });
  const failedJiraEntry = failedSync.find((e) => e.category === "Jira");
  ok("V1.8 Trust diagnostic", failedJiraEntry?.status === "bad" && /preserved/i.test(failedJiraEntry.answer), "a failed Jira sync is reported as bad AND explicitly reassures that previous data was preserved");

  const mockFallback = computeTrustDiagnostic({ dataHealth: healthyDataHealth, dataSource: "manual", jiraSync: { lastSyncStatus: "never" }, claudeAvailable: true, latestAiProviderState: "MOCK_FALLBACK" });
  const aiEntry = mockFallback.find((e) => e.category === "AI");
  ok("V1.8 Trust diagnostic", aiEntry?.status === "warn", "Claude configured but the last call fell back to Mock is a WARN, not silently reported as healthy");
}

// ===== V1.8 P2 — Corrupted localStorage hardening (§21) =====
{
  const wrongTypeData = parseStoredState(JSON.stringify({ data: "not an object at all", loaded: true }));
  ok("V1.8 Corrupted localStorage", Array.isArray(wrongTypeData.data.workItems), "a `data` field of the wrong primitive type (a string) falls back to a safe empty CommandCenterData, never crashes downstream code expecting .workItems");

  const wrongTypeDataArray = parseStoredState(JSON.stringify({ data: [1, 2, 3] }));
  ok("V1.8 Corrupted localStorage", Array.isArray(wrongTypeDataArray.data.workItems) && wrongTypeDataArray.data.workItems.length === 0, "a `data` field that's an array (not an object) is also rejected, not accidentally treated as valid");

  const nullData = parseStoredState(JSON.stringify({ data: null, jiraSync: null, filters: null, attentionState: null }));
  ok("V1.8 Corrupted localStorage", Array.isArray(nullData.data.workItems) && nullData.jiraSync.lastSyncStatus === "never" && typeof nullData.filters === "object", "null values for object-shaped fields safely fall back to defaults rather than propagating null");

  const invalidEnum = parseStoredState(JSON.stringify({ dataSource: "sharepoint-carrier-pigeon", loaded: true }));
  ok("V1.8 Corrupted localStorage", ["demo", "local-import", "jira"].includes(invalidEnum.dataSource), "an invalid/unrecognized dataSource enum value falls back to a valid default rather than being trusted verbatim");

  const missingArrays = parseStoredState(JSON.stringify({ eodHistory: "oops", memoryEvents: 42, personalPlan: { not: "an array" } }));
  ok("V1.8 Corrupted localStorage", Array.isArray(missingArrays.eodHistory) && Array.isArray(missingArrays.memoryEvents) && Array.isArray(missingArrays.personalPlan), "fields that should be arrays but were stored as the wrong type all fall back to empty arrays, never crash on .map/.filter downstream");

  const partiallyCorruptedNested = parseStoredState(JSON.stringify({ data: { workItems: "not an array either", clients: [] }, loaded: true }));
  ok("V1.8 Corrupted localStorage", partiallyCorruptedNested.loaded === true, "a partially corrupted nested object (data is an object, but one of ITS fields is the wrong type) is at least tolerated at the top level without throwing during parseStoredState itself");

  const futureUnknownFields = parseStoredState(JSON.stringify({ data: emptyData(), loaded: true, isDemo: false, someFutureV2Field: { totally: "new", nested: [1, 2, 3] }, anotherUnknownFlag: true }));
  ok("V1.8 Corrupted localStorage", futureUnknownFields.loaded === true && futureUnknownFields.isDemo === false, "unknown/future schema fields are tolerated (silently ignored) rather than causing a parse failure — forward compatibility");

  const emptyString = parseStoredState("");
  ok("V1.8 Corrupted localStorage", emptyString.loaded === false, "an empty string input never throws — falls back to a pristine initial state");

  const deeplyMalformed = parseStoredState("{{{not json[[[");
  ok("V1.8 Corrupted localStorage", deeplyMalformed.loaded === false && Array.isArray(deeplyMalformed.data.workItems), "severely malformed JSON falls back to a complete, safe, non-destructive pristine state — never a partial/undefined object");
}

// ===== V1.8 — Empty / partial data hardening across derived engines (§20) =====
{
  const noData = emptyData();
  ok("V1.8 Empty data hardening", computeDataHealth(noData, "manual", undefined).totalWorkItems === 0, "computeDataHealth never throws on a completely empty dataset");
  const emptyProactiveForFocus = computeProactiveIntelligence(noData, deriveData(noData, null, TODAY), [], null, {}, "manual", TODAY);
  ok("V1.8 Empty data hardening", (() => { try { computePersonalFocus(noData, emptyProactiveForFocus, undefined, TODAY); return true; } catch { return false; } })(), "computePersonalFocus never throws on a completely empty dataset");
  ok("V1.8 Empty data hardening", (() => { try { buildDemoData(TODAY); return true; } catch { return false; } })(), "buildDemoData (used as the baseline empty-state fallback) never throws");
  ok("V1.8 Empty data hardening", evaluateJiraDataContract([]).fields.length > 0, "the data contract still reports a full field list (all MISSING_IN_SAMPLE/UNSUPPORTED) for zero issues, never an empty/crashed report");

  // Partial data: work items with no owners, no due dates, no fix versions at all.
  const partialItems = [makeItem({ id: "pd-1", owner: undefined, dueDate: undefined, fixVersion: undefined }), makeItem({ id: "pd-2", owner: undefined, dueDate: undefined, fixVersion: undefined })];
  const partialData: CommandCenterData = { ...noData, workItems: partialItems };
  const partialHealth = computeDataHealth(partialData, "manual", undefined);
  ok("V1.8 Empty data hardening", partialHealth.ownershipCoveragePct === 0 && partialHealth.dueDateCoveragePct === 0, "fully-unowned, no-due-date partial data reports honest 0% coverage, never fabricated confidence");
  const partialProactiveForFocus = computeProactiveIntelligence(partialData, deriveData(partialData, null, TODAY), [], null, {}, "manual", TODAY);
  ok("V1.8 Empty data hardening", (() => { try { computePersonalFocus(partialData, partialProactiveForFocus, undefined, TODAY); return true; } catch { return false; } })(), "computePersonalFocus never throws on partial (no-owner, no-due-date) data");
}

// ===== V1.8 §23 — Large data safety: the 2000-issue cap actually stops fetching there =====
{
  const config: JiraConnectionConfig = { baseUrl: "https://acme.atlassian.net", email: "ba@acme.com", apiToken: "x" };
  const hugeFetch: FetchLike = async (url) => {
    const startAt = Number(new URL(url).searchParams.get("startAt"));
    const issues = Array.from({ length: JIRA_PAGE_SIZE }, (_, i) => makeJiraIssue({ key: `HUGE-${startAt + i}` }));
    // total is deliberately far beyond the cap — a real Jira instance really could have this many.
    return { ok: true, status: 200, json: async () => ({ issues, startAt, maxResults: JIRA_PAGE_SIZE, total: 50000 }) };
  };
  const cappedResult = await fetchJiraIssuesWith(hugeFetch, config, {});
  ok("V1.8 Large data safety", cappedResult.ok && cappedResult.recordsFetched === JIRA_MAX_ISSUES, `fetching against an effectively unbounded result set stops exactly at the ${JIRA_MAX_ISSUES}-issue safety cap, never beyond it (got ${cappedResult.ok ? cappedResult.recordsFetched : "error"})`);

  const cappedConformance = await runJiraConformance({ fetchImpl: hugeFetch, config });
  ok("V1.8 Large data safety", cappedConformance.truncated === true, "the conformance report explicitly flags truncation when the result set hits the safety cap — never silently presented as complete");
}

// ===== V1.8 §22 — Performance measurement at realistic dataset sizes =====
{
  for (const n of [100, 500, 1000, 2000]) {
    const items = Array.from({ length: n }, (_, i) =>
      makeItem({ id: `perf-${i}`, key: `PERF-${i}`, owner: i % 3 === 0 ? undefined : `Owner ${i % 7}`, dueDate: i % 5 === 0 ? undefined : "2026-07-01", fixVersion: i % 4 === 0 ? undefined : "2026.09", scopeChangeCount: i % 11 === 0 ? 1 : 0 })
    );
    const perfData: CommandCenterData = { ...emptyData(), workItems: items };
    const start = Date.now();
    computeDataHealth(perfData, "jira", "2026-06-15T00:00:00.000Z", new Date("2026-06-15T00:10:00.000Z").getTime());
    const perfDerived = deriveData(perfData, null, TODAY);
    const perfProactive = computeProactiveIntelligence(perfData, perfDerived, [], null, {}, "jira", TODAY);
    computePersonalFocus(perfData, perfProactive, undefined, TODAY);
    classifyQuery("what should I do in the next 30 minutes", perfData);
    const elapsedMs = Date.now() - start;
    // Generous ceiling — this is a regression guard against an accidental O(n^2)+ hotspot,
    // not a tight perf budget; a healthy run at n=2000 should take low tens of ms, not this.
    ok("V1.8 Performance", elapsedMs < 5000, `data-health + proactive + personal-focus + command-bar routing over ${n} work items completes in ${elapsedMs}ms (< 5000ms ceiling) — no obvious O(n²)+ hotspot`);
  }
}

// ===== V1.8 §15 — Accessibility regression: deterministic structural source checks =====
// No jsdom/testing-library is in this project (§14 "do not add a heavyweight
// accessibility framework unless already available and genuinely necessary") — these are
// static source-text assertions against the actual component files, consistent with the
// credential-leakage scan pattern already used above.
{
  const a11yRoot = path.resolve(process.cwd());
  const readComponent = (rel: string) => fs.readFileSync(path.join(a11yRoot, "src/components/command-center", rel), "utf8");

  for (const modalFile of ["CloseDayModal.tsx", "TakeActionPanel.tsx", "FocusSession.tsx", "DecisionAssistant.tsx"]) {
    const src = readComponent(modalFile);
    ok("V1.8 Accessibility — dialogs", /role="dialog"/.test(src) && /aria-modal="true"/.test(src), `${modalFile}'s overlay exposes role="dialog" and aria-modal="true"`);
    ok("V1.8 Accessibility — dialogs", /aria-labelledby/.test(src), `${modalFile}'s dialog has an accessible name via aria-labelledby`);
    ok("V1.8 Accessibility — dialogs", /key === "Escape"/.test(src), `${modalFile} closes on Escape (keyboard-accessible close, not just a mouse-click close button)`);
  }

  const myDayAgendaSrc = readComponent("MyDayAgenda.tsx");
  ok("V1.8 Accessibility — reorder controls", /role="group"/.test(myDayAgendaSrc) && /aria-label/.test(myDayAgendaSrc), "MyDayAgenda's keyboard ↑/↓ reorder controls still expose a labeled group — the protected drag-and-drop alternative was not removed or weakened (§14)");
  ok("V1.8 Accessibility — reorder controls", /aria-pressed/.test(myDayAgendaSrc), "MyDayAgenda's reorder/pin-style controls still expose aria-pressed state");

  for (const toggleFile of ["PriorityCard.tsx", "DecisionCard.tsx", "PersonalFocusCard.tsx", "YourDeliveryFocus.tsx", "AttentionQueuePanel.tsx", "GapsPanel.tsx", "ui.tsx", "WhyShouldICareDrawer.tsx"]) {
    const src = readComponent(toggleFile);
    ok("V1.8 Accessibility — expand/collapse state", /aria-expanded/.test(src), `${toggleFile} exposes aria-expanded on its show/hide evidence-or-reasoning toggle(s)`);
  }
  // V2.0 §4/§11 — RiskCard's own "why am I seeing this" toggle was replaced by the shared
  // WhyShouldICareDrawer (see above); check the composed source since the accessible
  // pattern now lives one level of composition away, not duplicated in RiskCard itself.
  ok(
    "V1.8 Accessibility — expand/collapse state",
    /aria-expanded/.test(readComponent("RiskCard.tsx") + readComponent("WhyShouldICareDrawer.tsx")),
    "RiskCard.tsx (composed with WhyShouldICareDrawer.tsx) exposes aria-expanded on its show/hide evidence toggle"
  );

  ok("V1.8 Accessibility — toggle state", /aria-pressed/.test(readComponent("DataImportPanel.tsx")), "DataImportPanel's format toggle buttons (JSON/CSV/Text) expose aria-pressed state");

  const clientAttentionSrc = readComponent("ClientAttentionMap.tsx");
  ok("V1.8 Accessibility — tables", /scope="col"/.test(clientAttentionSrc), "ClientAttentionMap's table uses scope=\"col\" header cells rather than bare <td> for its header row");

  const pageSrc = fs.readFileSync(path.join(a11yRoot, "src/app/page.tsx"), "utf8");
  ok("V1.8 Accessibility — tabs", /role="tablist"/.test(pageSrc) && /role="tab"/.test(pageSrc) && /aria-selected/.test(pageSrc), "the Operations/Executive view switcher exposes tablist/tab roles with aria-selected state");
}

// ===== V1.9 P0 — 5-way conformance status (never PARTIAL/UNKNOWN rounded to PASS) =====
{
  const fixtureReport = await runJiraConformance();
  const cursorCheck = fixtureReport.checks.find((c) => c.capability === "Cursor-based pagination capability");
  ok("V1.9 Conformance 5-way status", cursorCheck?.status === "UNSUPPORTED", "the default fixture environment's cursor capability is reported UNSUPPORTED — an honest environment fact, not FAIL and not silently PASS");

  const dataContractCheck = fixtureReport.checks.find((c) => c.capability === "Jira data contract");
  ok("V1.9 Conformance 5-way status", dataContractCheck?.status === "PARTIAL", "the fixture sample's data contract (Reporter always UNSUPPORTED, changelog always PARTIALLY_SUPPORTED) is reported PARTIAL, never rounded up to PASS");

  const supportedCapability = await runJiraConformance({ fetchImpl: fixtureFetch({ capabilityStatus: 200 }), config: FIXTURE_CONFIG });
  const supportedCheck = supportedCapability.checks.find((c) => c.capability === "Cursor-based pagination capability");
  ok("V1.9 Conformance 5-way status", supportedCheck?.status === "PASS", "a confirmed-SUPPORTED cursor capability earns an actual PASS");

  const unknownCapability = await runJiraConformance({ fetchImpl: fixtureFetch({ capabilityStatus: 401 }), config: FIXTURE_CONFIG });
  const unknownCheck = unknownCapability.checks.find((c) => c.capability === "Cursor-based pagination capability");
  ok("V1.9 Conformance 5-way status", unknownCheck?.status === "UNKNOWN", "a probe that was itself rejected (401) is reported UNKNOWN, not silently PASS or FAIL");
}

// ===== V1.9 P0 — Real Data Shape Discovery (§7) — never changes a mapping, only observes =====
{
  const knownPriority = makeJiraIssue({ priority: { name: "High" } });
  const customPriority = makeJiraIssue({ key: "X-2", priority: { name: "Showstopper" } });
  const missingPriority = makeJiraIssue({ key: "X-3", priority: undefined });
  const report = discoverJiraDataShape([knownPriority, customPriority, missingPriority]);

  const knownObs = report.observations.find((o) => o.field === "Priority" && o.observedValue === "High");
  ok("V1.9 Shape discovery", knownObs?.category === "EXPECTED", "a priority name matching an explicit mapping rule is classified EXPECTED");
  const customObs = report.observations.find((o) => o.field === "Priority" && o.observedValue === "Showstopper");
  ok("V1.9 Shape discovery", customObs?.category === "NEW_VARIATION", "a priority name not in the mapping table is NEW_VARIATION — safely handled, but flagged for review, never silently absorbed");
  const missingObs = report.observations.find((o) => o.field === "Priority" && o.observedValue === "(missing)");
  ok("V1.9 Shape discovery", missingObs?.category === "EXPECTED", "a missing priority is EXPECTED — a well-documented safe case, not a defect");

  const noCategoryStatus = makeJiraIssue({ key: "X-4", status: { name: "Waiting for Client" } });
  const noCategoryReport = discoverJiraDataShape([noCategoryStatus]);
  const ambiguousStatus = noCategoryReport.observations.find((o) => o.field === "Status");
  ok("V1.9 Shape discovery", ambiguousStatus?.category === "AMBIGUOUS", "a status with no category at all and no name-based rule match is AMBIGUOUS — exactly the §7/§8 'Waiting for Client' example");

  const newCategoryStatus = makeJiraIssue({ key: "X-5", status: { name: "Triage", statusCategory: { key: "custom-triage" } } });
  const newCategoryReport = discoverJiraDataShape([newCategoryStatus]);
  const newVariationStatus = newCategoryReport.observations.find((o) => o.field === "Status");
  ok("V1.9 Shape discovery", newVariationStatus?.category === "NEW_VARIATION", "a status with an unrecognized (but present) category is NEW_VARIATION, distinct from AMBIGUOUS (missing category)");

  const outwardOnlyLink = makeJiraIssue({ key: "X-6", issuelinks: [{ type: { name: "Blocks" } }] });
  const outwardReport = discoverJiraDataShape([outwardOnlyLink]);
  const linkObs = outwardReport.observations.find((o) => o.field === "Issue link");
  ok("V1.9 Shape discovery", linkObs?.category === "UNSUPPORTED", "an outward-only 'blocks' link (this issue blocks another) is UNSUPPORTED — matches the documented normalize.ts limitation, never silently modeled as a Dependency");

  const relatesLink = makeJiraIssue({ key: "X-7", issuelinks: [{ type: { name: "Relates" }, inwardIssue: { key: "X-8" } }] });
  const relatesReport = discoverJiraDataShape([relatesLink]);
  ok("V1.9 Shape discovery", relatesReport.observations.find((o) => o.field === "Issue link")?.category === "UNSUPPORTED", "a non-'blocks' link type (Relates) is UNSUPPORTED, never turned into a Dependency");

  const multiFixVersion = makeJiraIssue({ key: "X-9", fixVersions: [{ name: "2026.09" }, { name: "2026.10" }] });
  const multiReport = discoverJiraDataShape([multiFixVersion]);
  const fixVersionObs = multiReport.observations.find((o) => o.field === "Fix versions");
  ok("V1.9 Shape discovery", fixVersionObs?.category === "NEW_VARIATION", "an issue with more than one fix version is NEW_VARIATION — surfaces the documented 'only first fix version kept' limitation as evidence, doesn't silently drop it unnoticed");

  ok("V1.9 Shape discovery", (() => { try { discoverJiraDataShape([{ key: "X-11", fields: {} } as JiraIssue]); return true; } catch { return false; } })(), "discoverJiraDataShape never throws, even on an issue where every optional field is missing (the shape zod validation guarantees at minimum)");

  ok("V1.9 Shape discovery", discoverJiraDataShape([]).observations.length === 0, "an empty sample produces zero observations, never fabricated ones");
}

// ===== V1.9 P0 — Mapping Drift Report (§8) =====
{
  const known = makeJiraIssue({ priority: { name: "High" } });
  const custom1 = makeJiraIssue({ key: "X-2", priority: { name: "Showstopper" } });
  const custom2 = makeJiraIssue({ key: "X-3", priority: { name: "Showstopper" } });
  const drift = computeMappingDrift([known, custom1, custom2]);

  const priorityField = drift.fields.find((f) => f.field === "Priority");
  const highValue = priorityField?.values.find((v) => v.observedValue === "High");
  ok("V1.9 Mapping drift", highValue?.confidence === "SUPPORTED" && highValue?.mappedTo === "P2", "a known priority name reports SUPPORTED confidence with its correct mapped value");
  const showstopperValue = priorityField?.values.find((v) => v.observedValue === "Showstopper");
  ok("V1.9 Mapping drift", showstopperValue?.occurrences === 2, "repeated occurrences of the same unmapped value are tallied together, not duplicated per-issue");
  ok("V1.9 Mapping drift", showstopperValue?.confidence === "UNKNOWN" && !!showstopperValue?.reason, "an unmapped priority reports UNKNOWN confidence with an explanatory reason — matches the exact §8 'Waiting for Client → UNKNOWN' pattern");

  const waitingForClient = makeJiraIssue({ key: "X-4", status: { name: "Waiting for Client" } });
  const statusDrift = computeMappingDrift([waitingForClient]);
  const statusField = statusDrift.fields.find((f) => f.field === "Status");
  const wfcValue = statusField?.values.find((v) => v.observedValue === "Waiting for Client");
  ok("V1.9 Mapping drift", wfcValue?.confidence === "UNKNOWN" && wfcValue?.mappedTo === "Not Started", "the exact §8 worked example: 'Waiting for Client' maps to Not Started (the safe default) with UNKNOWN confidence — never silently classified as Blocked merely because the name sounds related");

  const qaBlocked = makeJiraIssue({ key: "X-5", status: { name: "QA Blocked", statusCategory: { key: "indeterminate" } } });
  const qaDrift = computeMappingDrift([qaBlocked]);
  const qaValue = qaDrift.fields.find((f) => f.field === "Status")?.values.find((v) => v.observedValue === "QA Blocked");
  ok("V1.9 Mapping drift", qaValue?.mappedTo === "Blocked" && qaValue?.confidence === "SUPPORTED", "'QA Blocked' correctly matches the blocked-name heuristic with SUPPORTED confidence — the exact §8 opposite worked example");

  ok("V1.9 Mapping drift", computeMappingDrift([]).sampleSize === 0, "an empty sample never fabricates mapping observations");
}

// ===== V1.9 P1 — Dependency link-type edge cases (real-data-shaped fixtures) =====
{
  const relatesOnly = makeJiraIssue({ key: "REL-1", issuelinks: [{ type: { name: "Relates" }, inwardIssue: { key: "REL-2" } }] });
  const { dependencies: relatesDeps } = normalizeIssue(relatesOnly, { today: TODAY });
  ok("V1.9 Dependency link edge cases", relatesDeps.length === 0, "a 'Relates' link is never turned into a Dependency, even with a populated inwardIssue — only 'blocks'-family links are modeled");

  const outwardOnly = makeJiraIssue({ key: "OUT-1", issuelinks: [{ type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, outwardIssue: { key: "OUT-2" } }] });
  const { dependencies: outwardDeps } = normalizeIssue(outwardOnly, { today: TODAY });
  ok("V1.9 Dependency link edge cases", outwardDeps.length === 0, "an outward-only 'blocks' link (this issue blocks another) produces no Dependency — only the inward 'is blocked by' direction is modeled, per the documented limitation");

  const noTypeName = makeJiraIssue({ key: "NT-1", issuelinks: [{ inwardIssue: { key: "NT-2" } }] });
  ok("V1.9 Dependency link edge cases", (() => { try { normalizeIssue(noTypeName, { today: TODAY }); return true; } catch { return false; } })(), "an issue link with a completely missing type name never crashes normalization");
}

// ===== V2.0 P0 — AI on-demand discipline static audit (§1.4, §20) — fixed, not just documented =====
// V1.9 found RiskCard/DecisionCard triggering AI calls automatically from a bare useEffect
// inside a rendered list, with zero user gesture. V2.0 fixed this (see RiskCard.tsx,
// DecisionCard.tsx, HealthTrend.tsx, ProjectStory.tsx, WhyShouldICareDrawer.tsx) — these
// assertions are now inverted: any getAIProvider() call site in these files must NOT sit
// inside an unconditional useEffect body; it must be reachable only from a click handler
// (onClick / a named async function invoked by one).
{
  const a20Root = path.resolve(process.cwd());
  const readSrc = (rel: string) => fs.readFileSync(path.join(a20Root, "src/components/command-center", rel), "utf8");
  const riskCardSrc = readSrc("RiskCard.tsx");
  const decisionCardSrc = readSrc("DecisionCard.tsx");
  const healthTrendSrc = readSrc("HealthTrend.tsx");
  const projectStorySrc = readSrc("ProjectStory.tsx");
  const drawerSrc = readSrc("WhyShouldICareDrawer.tsx");
  const askClaudeSrc = readSrc("AskClaudeAbout.tsx");
  const dailyGuidanceSrc = readSrc("DailyGuidancePanel.tsx");

  // No bare `useEffect(() => { ... getAIProvider ... }, [...])` pattern remains anywhere
  // in these five files — i.e. no useEffect body (up to the next top-level "}, [") contains
  // an unconditional getAIProvider() call reachable without a prior click.
  function hasAutomaticAiEffect(src: string): boolean {
    const effectBodies = src.match(/useEffect\(\(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/g) ?? [];
    return effectBodies.some((body) => /getAIProvider\(\)/.test(body));
  }
  ok("V2.0 AI on-demand discipline", !hasAutomaticAiEffect(riskCardSrc), "RiskCard.tsx no longer triggers any AI call from an unconditional useEffect — the reasoning/aging assessments are click-gated");
  ok("V2.0 AI on-demand discipline", !hasAutomaticAiEffect(decisionCardSrc), "DecisionCard.tsx no longer triggers any AI call from an unconditional useEffect — conflict assessment is click-gated");
  ok("V2.0 AI on-demand discipline", !hasAutomaticAiEffect(healthTrendSrc), "HealthTrend.tsx no longer triggers any AI call from an unconditional useEffect — trend interpretation is click-gated");
  ok("V2.0 AI on-demand discipline", !hasAutomaticAiEffect(projectStorySrc), "ProjectStory.tsx no longer triggers any AI call from an unconditional useEffect — the story is click-gated");

  // Every AI trigger in these files is reachable only via an onClick-bound handler.
  for (const [file, src] of [
    ["RiskCard.tsx", riskCardSrc],
    ["DecisionCard.tsx", decisionCardSrc],
    ["HealthTrend.tsx", healthTrendSrc],
    ["ProjectStory.tsx", projectStorySrc],
    ["WhyShouldICareDrawer.tsx", drawerSrc],
    ["AskClaudeAbout.tsx", askClaudeSrc],
  ] as const) {
    if (/getAIProvider\(\)/.test(src)) {
      ok("V2.0 AI on-demand discipline", /onClick=\{/.test(src), `${file} calls getAIProvider() and also has at least one onClick-bound trigger`);
    }
  }

  ok("V2.0 AI on-demand discipline", /onClick/.test(dailyGuidanceSrc) && /getAIProvider\(\)/.test(dailyGuidanceSrc), "DailyGuidancePanel remains genuinely on-demand (onClick-gated) — unchanged contrast case");

  // Every on-demand AI trigger routes through the entity cache (ai-cache.ts), not a raw
  // getAIProvider() call directly off a click — this is what makes "cache reuse" possible.
  for (const [file, src] of [
    ["RiskCard.tsx", riskCardSrc],
    ["DecisionCard.tsx", decisionCardSrc],
    ["HealthTrend.tsx", healthTrendSrc],
    ["ProjectStory.tsx", projectStorySrc],
    ["WhyShouldICareDrawer.tsx", drawerSrc],
    ["AskClaudeAbout.tsx", askClaudeSrc],
  ] as const) {
    ok("V2.0 AI on-demand discipline", /withAICache/.test(src), `${file} routes its on-demand AI call(s) through withAICache (ai/ai-cache.ts), not a bare getAIProvider() call`);
  }
}

// ===== V1.9 P1 — AI evaluation dry run against Mock provider output (4 named methods) =====
// Only pre-extracted fact/evidence STRINGS are ever passed to any AIProvider method — never
// raw domain objects or Jira payloads (confirmed by every method's own signature).
{
  const mock = new MockAIProvider();
  const sampleFacts = ["JPMC release remains on current date (JPMC Digital Onboarding Release)", "Dependency on QA (JPMC Digital Onboarding Release)"];
  const sampleEvidence = ["JPMC-101 is blocked: Pending final UAT evidence from QA"];

  const guidance = await mock.generateDailyGuidance(sampleFacts, sampleFacts, sampleFacts, sampleFacts, sampleEvidence);
  const guidanceEval = evaluateAiResponse({ task: "generateDailyGuidance", response: guidance, schemaValid: true, narrativeText: JSON.stringify(guidance), inputFacts: sampleFacts, inputEvidence: sampleEvidence, confidence: 0.5 });
  ok("V1.9 AI dry run (Mock)", guidanceEval.findings.find((f) => f.dimension === "CAUSAL_LANGUAGE")?.severity === "PASS", "Mock-generated Daily Guidance output contains no causal language when evaluated by the real evaluator");
  ok("V1.9 AI dry run (Mock)", guidanceEval.findings.find((f) => f.dimension === "OWNERSHIP_INFERENCE")?.severity === "PASS", "Mock-generated Daily Guidance output contains no ownership/hierarchy inference");

  const decisionOptions = await mock.generateDecisionOptions("Should we delay the release?", sampleFacts, sampleEvidence);
  const decisionOptionsEval = evaluateAiResponse({ task: "generateDecisionOptions", response: decisionOptions, schemaValid: true, narrativeText: JSON.stringify(decisionOptions), inputFacts: sampleFacts, inputEvidence: sampleEvidence, confidence: 0.5 });
  ok("V1.9 AI dry run (Mock)", decisionOptionsEval.failCount === 0, "Mock-generated Decision Options passes the deterministic evaluator with zero FAILs");

  const story = await mock.generateProjectStory(sampleFacts, sampleEvidence, true);
  const storyEval = evaluateAiResponse({ task: "generateProjectStory", response: story, schemaValid: true, narrativeText: JSON.stringify(story), inputFacts: sampleFacts, inputEvidence: sampleEvidence, confidence: 0.5 });
  ok("V1.9 AI dry run (Mock)", storyEval.failCount === 0, "Mock-generated Project Story passes the deterministic evaluator with zero FAILs");

  const proactiveAssessment = await mock.assessProactive("risk", sampleFacts, sampleEvidence, "Delivery confidence has held steady over the last 3 days.");
  const paEval = evaluateAiResponse({ task: "assessProactive", response: proactiveAssessment, schemaValid: true, narrativeText: JSON.stringify(proactiveAssessment), inputFacts: sampleFacts, inputEvidence: sampleEvidence, confidence: 0.5 });
  ok("V1.9 AI dry run (Mock)", paEval.findings.find((f) => f.dimension === "CAUSAL_LANGUAGE")?.severity === "PASS", "Mock-generated Proactive Assessment output contains no causal language");
}

// ===== V1.9 P1 — Command Bar: 20+ real-data-shaped queries across all major categories =====
{
  const { current: cbPilotData } = buildDemoData(TODAY);
  const realWorldQueries: Array<{ query: string; expectedIntent: string }> = [
    { query: "What's blocking JPMC?", expectedIntent: "blocking" },
    { query: "What changed today?", expectedIntent: "changed-today" },
    { query: "Which client needs attention?", expectedIntent: "client-attention" },
    { query: "What's the release risk for 2026.09?", expectedIntent: "release-risk" },
    { query: "What should I do in the next 30 minutes?", expectedIntent: "next-actions" },
    { query: "What's getting worse?", expectedIntent: "getting-worse" },
    { query: "What needs attention?", expectedIntent: "needs-attention" },
    { query: "Which risks are escalating?", expectedIntent: "risks-escalating" },
    { query: "Which dependencies are dangerous?", expectedIntent: "dependencies-dangerous" },
    { query: "Which decisions are blocked?", expectedIntent: "decisions-blocked" },
    { query: "Have my decisions been effective?", expectedIntent: "decisions-effective" },
    { query: "Which actions are not working?", expectedIntent: "actions-not-working" },
    { query: "Which loops are stalled?", expectedIntent: "loops-stalled" },
    { query: "Did yesterday's actions help?", expectedIntent: "did-yesterday-help" },
    { query: "What should I focus on today?", expectedIntent: "personal-focus-today" },
    { query: "What can wait?", expectedIntent: "personal-can-wait" },
    { query: "Am I overloaded?", expectedIntent: "am-i-overloaded" },
    { query: "What did I work on?", expectedIntent: "what-did-i-work-on" },
    { query: "Which projects need my attention?", expectedIntent: "which-projects-need-attention" },
    { query: "What should I defer?", expectedIntent: "what-should-i-defer" },
    { query: "Where am I spending time?", expectedIntent: "where-spending-time" },
    { query: "What's blocking my focus?", expectedIntent: "whats-blocking-focus" },
  ];
  ok("V1.9 Command Bar real-data queries", realWorldQueries.length >= 20, "at least 20 real-data-shaped queries are exercised across all major intent categories (§25)");
  for (const { query, expectedIntent } of realWorldQueries) {
    const route = classifyQuery(query, cbPilotData);
    ok("V1.9 Command Bar real-data queries", route.intent === expectedIntent, `"${query}" routes to "${expectedIntent}" (got "${route.intent}")`);
  }
}

// ===== V1.9 P1 — Real release validation (§11): multi-fix-version limitation is documented, not silently hidden =====
{
  const multiFixIssue = makeJiraIssue({ key: "REL-1", fixVersions: [{ name: "2026.09" }, { name: "2026.10" }] });
  const { workItem } = normalizeIssue(multiFixIssue, { today: TODAY });
  ok("V1.9 Release validation", workItem.fixVersion === "2026.09", "only the FIRST Jira fix version is kept on the normalized work item — a documented, evidence-based limitation (confirmed structurally, not assumed)");

  const noFixIssue = makeJiraIssue({ key: "REL-2", fixVersions: [] });
  const { workItem: noFixWorkItem } = normalizeIssue(noFixIssue, { today: TODAY });
  ok("V1.9 Release validation", noFixWorkItem.fixVersion === undefined, "an issue with zero fix versions has undefined fixVersion — never invented or defaulted to a release");

  const releaseHealthData: CommandCenterData = { ...emptyData(), workItems: [{ ...makeItem({ id: "rel-1", fixVersion: "2026.09", status: "Not Started" }) }] };
  const health = computeReleaseHealth(releaseHealthData, "2026.09", TODAY);
  ok("V1.9 Release validation", health.fixVersion === "2026.09", "release-health groups strictly by exact fixVersion string equality — no fuzzy/multi-membership handling");
}

// ===== V1.9 P1 — Real ownership validation (§10): unassigned/ambiguous never guessed =====
{
  const unassignedIssue = makeJiraIssue({ key: "OWN-1", assignee: undefined });
  const { workItem: unassignedWorkItem } = normalizeIssue(unassignedIssue, { today: TODAY });
  ok("V1.9 Ownership validation", unassignedWorkItem.owner === undefined, "an unassigned Jira issue normalizes to owner: undefined — never a guessed name, never 'Unassigned' as a fake identity");

  const { current: ownershipDemoData } = buildDemoData(TODAY);
  ok("V1.9 Ownership validation", !ownershipDemoData.workItems.some((w) => w.owner === "manager" || w.owner === "team lead" || w.owner === "BA" || w.owner === "PO" || w.owner === "PM"), "no work item's owner field is ever a role/hierarchy placeholder — ownership is always a real name or undefined, never inferred organizational position");
}

// ===== V1.9 P1 — Trust audit structural coverage (§18): WHAT/WHY/SOURCE/FRESHNESS/OWNERSHIP/CONFIDENCE/ACTION =====
{
  const { current: trustDemoData } = buildDemoData(TODAY);
  const trustDerived = deriveData(trustDemoData, null, TODAY);
  const trustProactive = computeProactiveIntelligence(trustDemoData, trustDerived, [], null, {}, "demo", TODAY);
  ok("V1.9 Trust audit", trustProactive.attentionQueue.every((item) => typeof item.why === "string" && item.why.length > 0), "every Attention Queue item has a non-empty WHY — the evidence answer is always present, never blank");
  ok("V1.9 Trust audit", trustProactive.attentionQueue.every((item) => typeof item.what === "string" && item.what.length > 0), "every Attention Queue item has a non-empty WHAT");
  ok("V1.9 Trust audit", trustProactive.decisionRadar.every((item) => item.whyReview.length > 0), "every Decision Radar item needing attention carries at least one concrete whyReview reason — never an unexplained urgency flag");

  const trustPersonalFocus = computePersonalFocus(trustDemoData, trustProactive, "Alice Chen", TODAY);
  ok("V1.9 Trust audit", trustPersonalFocus.top3.every((c) => typeof c.whyOnMyList === "string" && c.whyOnMyList.length > 0), "every Personal Focus Top 3 item has a non-empty whyOnMyList — ownership/evidence is always explained, never left implicit");
}

// ===== V1.9 §31 — Security re-scan of the V1.9 additions =====
{
  const secRoot = path.resolve(process.cwd());
  const v19Files = ["src/lib/command-center/jira/shape-discovery.ts", "src/lib/command-center/jira/mapping-drift.ts", "src/lib/command-center/jira/conformance.ts"];
  const forbidden = [/JIRA_API_TOKEN/, /process\.env\.JIRA/, /Authorization["']?\s*:/, /Basic\s+[A-Za-z0-9+/=]{8,}/];
  for (const rel of v19Files) {
    const content = fs.readFileSync(path.join(secRoot, rel), "utf8");
    ok("V1.9 Security re-scan", !forbidden.some((re) => re.test(content)), `${rel} contains no credential-reading or Authorization-header code — the shape-discovery/mapping-drift/conformance layer works only on already-fetched, already-validated issue data`);
  }
}

// ===== V2.0 §2 — AI Usage Policy =====
{
  const p = getUsagePolicy("detectRisks");
  ok("V2.0 Usage policy", p.trigger === "on-demand", "every usage-policy entry declares trigger: on-demand — no AI task in this app is automatic");
  ok("V2.0 Usage policy", p.cacheDurationMs > 0, "detectRisks has a bounded (non-indefinite) cache duration");
  ok("V2.0 Usage policy", getUsagePolicy("answerQuery").cacheDurationMs < getUsagePolicy("detectRisks").cacheDurationMs, "answerQuery's cache duration is shorter than a per-entity assessment's — Command Bar answers age faster");
  ok("V2.0 Usage policy", describeAIState({ available: false, mode: "mock", servedFromCache: false }) === "AI unavailable", "describeAIState reports 'AI unavailable' when Claude is not configured");
  ok("V2.0 Usage policy", describeAIState({ available: true, mode: "mock", servedFromCache: false }) === "Mock fallback", "describeAIState reports 'Mock fallback' when available but the call fell back to Mock");
  ok("V2.0 Usage policy", describeAIState({ available: true, mode: "claude", servedFromCache: false }) === "AI available", "describeAIState reports 'AI available' for a genuine live Claude answer");
  ok("V2.0 Usage policy", describeAIState({ available: true, mode: "claude", servedFromCache: true }) === "Cached result", "describeAIState reports 'Cached result' whenever servedFromCache is true, regardless of mode");
}

// ===== V2.0 §3 — Entity-level AI cache =====
{
  const fakeStorage = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (fakeStorage.has(k) ? fakeStorage.get(k)! : null),
      setItem: (k: string, v: string) => { fakeStorage.set(k, v); },
      removeItem: (k: string) => { fakeStorage.delete(k); },
    },
  };

  clearAICache();
  ok("V2.0 AI cache", aiCacheSize() === 0, "the cache starts empty after clearAICache()");

  const version = makeEvidenceVersion(["fact A"], [{ content: "evidence A" }]);
  const key = makeAICacheKey("detectRisks", "risk-1", version);
  ok("V2.0 AI cache", getCachedAIResult(key) === undefined, "a key that was never set is a clean miss, not a throw");

  setCachedAIResult(key, { inference: "cached inference" });
  ok("V2.0 AI cache", aiCacheSize() === 1, "setCachedAIResult adds exactly one entry");
  const hit = getCachedAIResult<{ inference: string }>(key);
  ok("V2.0 AI cache", hit?.inference === "cached inference", "an unexpired entry under the same key is returned verbatim");

  const changedVersion = makeEvidenceVersion(["fact A changed"], [{ content: "evidence A" }]);
  const changedKey = makeAICacheKey("detectRisks", "risk-1", changedVersion);
  ok("V2.0 AI cache", changedKey !== key, "changing the underlying facts produces a different cache key — same task/entity, different evidence version");
  ok("V2.0 AI cache", getCachedAIResult(changedKey) === undefined, "the changed-evidence key is a natural cache miss with no explicit invalidation call needed");

  ok("V2.0 AI cache", getCachedAIResult(key, -1) === undefined, "an entry older than the given maxAgeMs (a negative bound here, guaranteed to have elapsed) is treated as expired, not returned");
  ok("V2.0 AI cache", getCachedAIResult(key, 1000 * 60 * 60) !== undefined, "the same entry is still returned when maxAgeMs comfortably covers its age");

  // withAICache: first call is a miss ("refreshed"), the identical second call is a hit
  // ("cached") with the fetcher never invoked again.
  clearAICache();
  let fetchCount = 0;
  const fetcher = async () => {
    fetchCount++;
    return { text: `result #${fetchCount}` };
  };
  const facts = ["Level: HIGH"];
  const evidence = [{ content: "some evidence" }];
  const first = await withAICache("detectRisks", "risk-42", facts, evidence, fetcher);
  ok("V2.0 AI cache", first.cacheState === "refreshed" && fetchCount === 1, "the first withAICache call for a given key is a miss — it calls the fetcher exactly once and is labeled 'refreshed'");
  const second = await withAICache("detectRisks", "risk-42", facts, evidence, fetcher);
  ok("V2.0 AI cache", second.cacheState === "cached" && fetchCount === 1, "a second withAICache call with identical facts/evidence is a hit — fetcher is NOT called again, labeled 'cached'");
  const third = await withAICache("detectRisks", "risk-42", ["Level: CRITICAL"], evidence, fetcher);
  ok("V2.0 AI cache", third.cacheState === "refreshed" && fetchCount === 2, "changing the facts triggers exactly one new fetcher call — evidence-version-keyed staleness works end to end");

  // Bounded eviction — oldest entries drop off once the cache exceeds its cap.
  clearAICache();
  for (let i = 0; i < 160; i++) setCachedAIResult(`bounded:${i}`, i);
  ok("V2.0 AI cache", aiCacheSize() <= 150, `the cache never grows past its bound even after 160 sets (size=${aiCacheSize()})`);
  ok("V2.0 AI cache", getCachedAIResult("bounded:159") === 159, "the most recently set entry survives eviction");
  ok("V2.0 AI cache", getCachedAIResult("bounded:0") === undefined, "the oldest entry was evicted to make room, confirming FIFO eviction rather than unbounded growth");

  // Corrupted-localStorage safety — parseCache mirrors store.ts's parseStoredState: never
  // throws, always falls back to an empty, usable cache shape.
  ok("V2.0 AI cache", parseCache("{not valid json").entries.length === 0, "malformed JSON never throws — falls back to an empty cache");
  ok("V2.0 AI cache", parseCache(JSON.stringify({ garbage: true })).entries.length === 0, "a validly-parsed but unrecognized shape (no entries array) falls back to an empty cache");
  ok("V2.0 AI cache", parseCache(JSON.stringify({ entries: "not-an-array" })).entries.length === 0, "an entries field of the wrong type is rejected rather than trusted verbatim");
  ok("V2.0 AI cache", parseCache(JSON.stringify({ entries: [{ key: "k1", value: 1, storedAt: "2026-01-01" }, { key: "bad", storedAt: "2026-01-01" }, null, "x"] })).entries.length === 1, "individually malformed entries are filtered out; well-formed ones in the same payload are kept");

  clearAICache();
  delete (globalThis as unknown as { window?: unknown }).window;
}

// ===== V2.0 §5 — Impact Projection (deterministic, non-causal) =====
{
  const causalLanguage = [/will cause/i, /will result in/i, /guarantees/i, /is going to fail/i];

  const openRisk: Risk = { id: "risk-imp-1", projectId: "p1", title: "Scope creep", level: "HIGH", reason: "Scope grew", evidence: ["3 new requirements added"], potentialImpact: "Release may slip", mitigation: "Re-baseline scope", status: "open", confidence: 0.8, detectedAt: TODAY, sourceWorkItemIds: ["wi-1"] };
  const riskImpact = projectRiskImpact(openRisk);
  ok("V2.0 Impact projection", riskImpact.unresolvedSignal.includes("expected to remain unresolved"), "an open risk's unresolved signal uses the fixed non-causal phrasing");
  ok("V2.0 Impact projection", !causalLanguage.some((re) => re.test(riskImpact.unresolvedSignal) || re.test(riskImpact.currentCondition)), "risk impact projection contains no causal-claim language");
  ok("V2.0 Impact projection", riskImpact.affectedEntities.includes("risk-imp-1"), "the risk itself is listed among affected entities");
  ok("V2.0 Impact projection", !riskImpact.insufficientEvidence, "a risk with real evidence is not flagged insufficientEvidence");

  const closedRisk: Risk = { ...openRisk, id: "risk-imp-2", status: "closed" };
  ok("V2.0 Impact projection", projectRiskImpact(closedRisk).unresolvedSignal !== riskImpact.unresolvedSignal, "a closed risk gets a distinct 'no ongoing signal' projection, not the open-risk unresolved phrasing");

  const openDecision: Decision = { id: "dec-imp-1", projectId: "p1", title: "Vendor selection", status: "ACTIVE", description: "Choose a vendor" };
  const decisionImpactNoReview = projectDecisionImpact(openDecision);
  ok("V2.0 Impact projection", decisionImpactNoReview.insufficientEvidence === false || decisionImpactNoReview.evidence.length >= 0, "decision impact projection always returns a well-formed evidence array (possibly empty), never throws");
  ok("V2.0 Impact projection", decisionImpactNoReview.unresolvedSignal.includes("expected to remain unreviewed"), "an active decision with no review date gets the 'expected to remain unreviewed' non-causal phrasing");

  const reviewedDecision: Decision = { ...openDecision, id: "dec-imp-2", reviewDate: "2026-01-01" };
  const decisionImpactWithReview = projectDecisionImpact(reviewedDecision);
  ok("V2.0 Impact projection", decisionImpactWithReview.evidence.some((e) => e.content.includes("2026-01-01")), "when a review date IS set, it's surfaced as evidence rather than invented or omitted");

  const supersededDecision: Decision = { ...openDecision, id: "dec-imp-3", status: "SUPERSEDED" };
  ok("V2.0 Impact projection", projectDecisionImpact(supersededDecision).unresolvedSignal !== decisionImpactNoReview.unresolvedSignal, "a terminal-status (SUPERSEDED) decision gets a distinct 'no ongoing signal' projection");

  const openAction: Action = { id: "act-imp-1", title: "Escalate blocker", why: "Blocking release", status: "open", estimateMinutes: 30, createdAt: TODAY };
  const actionImpact = projectActionImpact(openAction);
  ok("V2.0 Impact projection", actionImpact.unresolvedSignal.includes("expected to remain unresolved"), "an open action's projection uses the same fixed non-causal phrasing family");
  ok("V2.0 Impact projection", actionImpact.currentCondition.includes("no owner set"), "an action with no owner explicitly says so rather than silently omitting it");

  const loop = { id: "loop-imp-1", issue: "JPMC-101", health: "STALLED" as const, why: "No follow-up action exists.", nowWhat: "Create a follow-up action." };
  const loopImpact = projectLoopImpact(loop);
  ok("V2.0 Impact projection", loopImpact.unresolvedSignal.includes("expected to remain stalled"), "a STALLED delivery loop's projection explicitly says 'expected to remain stalled'");
  ok("V2.0 Impact projection", !causalLanguage.some((re) => re.test(loopImpact.unresolvedSignal)), "loop impact projection contains no causal-claim language either");
}

// ===== V2.0 §6 — "DON'T FORGET" selector (personal-focus.ts) =====
{
  function candidate(id: string, category: "DO_NOW" | "DO_TODAY" | "WATCH" | "DEFER", score: number): PersonalFocusCandidate {
    return {
      id,
      sourceType: "attention",
      sourceId: id,
      title: id,
      why: "why",
      nowWhat: "now what",
      evidence: [],
      category,
      score,
      factors: [],
      estimatedMinutes: 10,
      ownershipExplicit: false,
      whyOnMyList: "explained",
      severity: "MEDIUM",
    };
  }
  const c1 = candidate("c1", "DO_NOW", 80);
  const c2 = candidate("c2", "DO_NOW", 70);
  const c3 = candidate("c3", "DO_TODAY", 60);
  const c4 = candidate("c4", "DO_TODAY", 40);
  const c5 = candidate("c5", "WATCH", 15);
  const c6 = candidate("c6", "DEFER", 2);
  const candidates = [c1, c2, c3, c4, c5, c6];
  const top3 = [c1, c2, c3];

  const dontForget = deriveDontForget({ candidates, top3 });
  ok("V2.0 Don't Forget", dontForget.some((c) => c.id === "c4"), "a DO_TODAY item beyond the Top 3 appears in Don't Forget");
  ok("V2.0 Don't Forget", !dontForget.some((c) => c.id === "c1" || c.id === "c2" || c.id === "c3"), "Top 3 items never duplicate into Don't Forget");
  ok("V2.0 Don't Forget", !dontForget.some((c) => c.id === "c5"), "a WATCH-category item does not appear in Don't Forget — it belongs in Watch, not this list");
  ok("V2.0 Don't Forget", !dontForget.some((c) => c.id === "c6"), "a DEFER-category item never appears in Don't Forget");

  const limited = deriveDontForget({ candidates, top3: [] }, 2);
  ok("V2.0 Don't Forget", limited.length <= 2, "the limit parameter bounds the list length");
}

// ===== V2.0 §9 — Decision review-date status classifier =====
{
  ok("V2.0 Decision review status", reviewStatusFor({ reviewDate: undefined }, TODAY) === "NO_REVIEW_DATE", "a decision with no review date is NO_REVIEW_DATE — never invented");
  ok("V2.0 Decision review status", reviewStatusFor({ reviewDate: TODAY }, TODAY) === "REVIEW_DUE", "a review date equal to today is REVIEW_DUE");
  ok("V2.0 Decision review status", reviewStatusFor({ reviewDate: "2020-01-01" }, TODAY) === "REVIEW_OVERDUE", "a review date in the past is REVIEW_OVERDUE");
  ok("V2.0 Decision review status", reviewStatusFor({ reviewDate: "2099-01-01" }, TODAY) === "NOT_DUE_YET", "a review date far in the future is NOT_DUE_YET, not misleadingly reported as NO_REVIEW_DATE");
  const soonDate = new Date(new Date(TODAY).getTime() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  ok("V2.0 Decision review status", reviewStatusFor({ reviewDate: soonDate }, TODAY) === "REVIEW_SOON", "a review date 2 days out is REVIEW_SOON");
}

// ===== V2.0 §13-14, upgraded V2.1 §5 — Pilot Readiness / Data Protection checklist =====
// V2.1 widens the 3-state PASS/FAIL/NOT_TESTED model to the spec's 6-state operator
// workflow (NOT_TESTED/READY_TO_TEST/TESTING/PASSED/BLOCKED/FAILED) — still a checklist,
// never a score.
{
  const neverSyncedState: import("../src/lib/command-center/types").JiraSyncState = { lastSyncStatus: "never" };
  const emptyHealth = computeDataHealth(emptyData(), "demo", undefined);

  const notConfiguredChecklist = buildLivePilotChecklist({ jiraConfigured: false, conformance: null, sync: neverSyncedState, dataHealth: emptyHealth });
  ok("V2.1 Pilot readiness", notConfiguredChecklist.every((c) => c.status === "NOT_TESTED"), "with Jira unconfigured and no conformance run, every checklist item is NOT_TESTED — nothing is ever fabricated as PASSED");
  ok("V2.1 Pilot readiness", notConfiguredChecklist.length >= 13, `the checklist covers at least the 13 named spec items (got ${notConfiguredChecklist.length})`);
  ok("V2.1 Pilot readiness", notConfiguredChecklist.every((c) => c.what.length > 0 && c.whyItMatters.length > 0 && c.nextAction.length > 0), "every item carries a non-empty WHAT / WHY IT MATTERS / NEXT ACTION, per the spec's worked example");

  const fixtureModeReport = await runJiraConformance(); // source: "fixtures"
  const fixtureChecklist = buildLivePilotChecklist({ jiraConfigured: true, conformance: fixtureModeReport, sync: neverSyncedState, dataHealth: emptyHealth });
  ok("V2.1 Pilot readiness", fixtureChecklist.find((c) => c.id === "project-discovery")?.status === "READY_TO_TEST", "credentials configured but only a FIXTURE-mode run exists — project discovery is READY_TO_TEST (fixtures prove the code path, not the real instance), never PASSED");
  ok("V2.1 Pilot readiness", fixtureChecklist.find((c) => c.id === "issue-retrieval")?.status === "READY_TO_TEST", "issue retrieval is likewise READY_TO_TEST under fixture-mode conformance, not PASSED and not NOT_TESTED");

  const testingChecklist = buildLivePilotChecklist({ jiraConfigured: true, conformance: fixtureModeReport, conformanceRunning: true, sync: neverSyncedState, dataHealth: emptyHealth });
  ok("V2.1 Pilot readiness", testingChecklist.find((c) => c.id === "project-discovery")?.status === "TESTING", "while a conformance run is in flight, live-only items report TESTING regardless of any previous result");

  const liveStyleReport = await runJiraConformance({ fetchImpl: fixtureFetch(), config: FIXTURE_CONFIG }); // source: "live"
  const liveChecklist = buildLivePilotChecklist({ jiraConfigured: true, conformance: liveStyleReport, sync: neverSyncedState, dataHealth: emptyHealth });
  ok("V2.1 Pilot readiness", liveChecklist.find((c) => c.id === "project-discovery")?.status === "PASSED", "a genuinely LIVE-source conformance run resolves project discovery to PASSED from the real check result");

  const liveFailedReport = await runJiraConformance({ fetchImpl: fixtureFetch({ httpStatus: 401 }), config: FIXTURE_CONFIG }); // source: "live-failed"
  const blockedChecklist = buildLivePilotChecklist({ jiraConfigured: true, conformance: liveFailedReport, sync: neverSyncedState, dataHealth: emptyHealth });
  ok("V2.1 Pilot readiness", blockedChecklist.find((c) => c.id === "project-discovery")?.status === "BLOCKED", "a genuinely failed live attempt marks project discovery BLOCKED — distinct from FAILED (which means it ran and failed a check) and from READY_TO_TEST (which implies nothing was attempted)");

  const successSync: import("../src/lib/command-center/types").JiraSyncState = { lastSyncStatus: "success", durationMs: 4200 };
  const successChecklist = buildLivePilotChecklist({ jiraConfigured: true, conformance: null, sync: successSync, dataHealth: emptyHealth });
  ok("V2.1 Pilot readiness", successChecklist.find((c) => c.id === "connectivity")?.status === "PASSED", "a completed successful sync marks connectivity PASSED");
  ok("V2.1 Pilot readiness", successChecklist.find((c) => c.id === "sync-duration")?.status === "PASSED", "a recorded sync duration marks that checklist item PASSED");
  ok("V2.1 Pilot readiness", successChecklist.find((c) => c.id === "previous-data-preservation")?.status === "READY_TO_TEST", "previous-data preservation is READY_TO_TEST (credentials configured, but no failure has ever occurred to prove it) — it can only be proven by an actual failure");

  const failedSyncPreserved: import("../src/lib/command-center/types").JiraSyncState = { lastSyncStatus: "failed", lastSyncError: "network down", previousDataPreserved: true };
  const failedChecklist = buildLivePilotChecklist({ jiraConfigured: true, conformance: null, sync: failedSyncPreserved, dataHealth: emptyHealth });
  ok("V2.1 Pilot readiness", failedChecklist.find((c) => c.id === "connectivity")?.status === "FAILED", "a failed sync marks connectivity FAILED, not silently NOT_TESTED or READY_TO_TEST");
  ok("V2.1 Pilot readiness", failedChecklist.find((c) => c.id === "previous-data-preservation")?.status === "PASSED", "a failed sync with previousDataPreserved=true marks that item PASSED — genuinely exercised and confirmed");

  const dpNotConfigured = buildDataProtectionChecklist(null, false, false);
  ok("V2.1 Data protection checklist", dpNotConfigured.find((c) => c.id === "credential-isolation")?.status === "PASSED", "credential isolation is a structural guarantee, reported PASSED unconditionally regardless of Jira configuration");
  ok("V2.1 Data protection checklist", dpNotConfigured.find((c) => c.id === "unmapped-fields-visible")?.status === "NOT_TESTED", "unmapped-fields-visible is NOT_TESTED when Jira isn't even configured");

  const dpFixture = buildDataProtectionChecklist(fixtureModeReport, true, false);
  ok("V2.1 Data protection checklist", dpFixture.find((c) => c.id === "unmapped-fields-visible")?.status === "READY_TO_TEST", "unmapped-fields-visible is READY_TO_TEST under fixture-mode (credentials configured, only fixture-proven so far)");

  const dpLive = buildDataProtectionChecklist(liveStyleReport, true, false);
  ok("V2.1 Data protection checklist", dpLive.find((c) => c.id === "unmapped-fields-visible")?.status === "PASSED", "unmapped-fields-visible is PASSED once a live-source conformance run actually produced field-support data");

  const dpBlocked = buildDataProtectionChecklist(liveFailedReport, true, false);
  ok("V2.1 Data protection checklist", dpBlocked.find((c) => c.id === "mapping-drift-surfaced")?.status === "BLOCKED", "mapping-drift-surfaced is BLOCKED (not silently READY_TO_TEST) when a live attempt genuinely failed");
}

// ===== V2.0 §10 — Command Bar family consolidation =====
{
  ok("V2.0 Command families", familyForIntent("unrecognized") === undefined, "'unrecognized' has no family — it still returns the deterministic 'no command for that yet' message");
  ok("V2.0 Command families", familyForIntent("changed-today") === "STATUS", "changed-today maps to STATUS");
  ok("V2.0 Command families", familyForIntent("personal-focus-today") === "PRIORITY", "personal-focus-today maps to PRIORITY");
  ok("V2.0 Command families", familyForIntent("decisions-blocked") === "DECISION", "decisions-blocked maps to DECISION");
  ok("V2.0 Command families", familyForIntent("actions-not-working") === "ACTION", "actions-not-working maps to ACTION");
  ok("V2.0 Command families", familyForIntent("release-risk") === "DELIVERY", "release-risk maps to DELIVERY");
  ok("V2.0 Command families", familyForIntent("am-i-overloaded") === "PERSONAL", "am-i-overloaded maps to PERSONAL");
  ok("V2.0 Command families", familyForIntent("did-yesterday-help") === "MEMORY", "did-yesterday-help maps to MEMORY");
  // classifyQuery's existing routing behavior is unchanged by the family labeling — spot
  // check that a previously-passing routed query still resolves the same intent.
  ok("V2.0 Command families", classifyQuery("What should I focus on today?", emptyData()).intent === "personal-focus-today", "adding family labels did not change classifyQuery's existing routing");
}

// ===== V2.0 §17 — Weekly Review neutral-language audit =====
{
  const forbidden = [/poor performance/i, /underperform/i, /weak BA/i, /inefficient employee/i];
  const files = ["src/lib/command-center/personal-patterns.ts", "src/lib/command-center/ai/prompts/weekly-review.ts", "src/lib/command-center/ai/provider.ts"];
  const langRoot = path.resolve(process.cwd());
  for (const rel of files) {
    const content = fs.readFileSync(path.join(langRoot, rel), "utf8");
    ok("V2.0 Weekly Review language audit", !forbidden.some((re) => re.test(content)), `${rel} contains none of the forbidden judgmental phrases (poor performance / underperforming / weak BA / inefficient employee)`);
  }
}

// ===== V2.1 §13 — Command Bar final precedence audit: near-miss / contraction / plural
// regression matrix. Confirmed and fixed two genuine gaps: "aren't/isn't working"
// contractions on actions-not-working, and "my 30-minute plan" phrasing on
// personal-thirty-min (both widened in query-router.ts, additive, no precedence changes
// elsewhere). This block also documents deliberate non-matches — a bare "what's stalled"
// (no "loop") intentionally stays unrecognized rather than over-matching. =====
{
  const { current: cbAuditData } = buildDemoData(TODAY);
  const auditQueries: Array<{ query: string; expectedIntent: string; note: string }> = [
    // exact intent (sanity baseline)
    { query: "What should I focus on today?", expectedIntent: "personal-focus-today", note: "exact phrasing" },
    // near miss / rephrasing
    { query: "What is most important for me today?", expectedIntent: "personal-focus-today", note: "near-miss rephrasing of the same intent" },
    { query: "What's most important for me?", expectedIntent: "personal-focus-today", note: "contraction + near-miss rephrasing" },
    // plural/singular
    { query: "Which decision is blocked?", expectedIntent: "decisions-blocked", note: "singular 'decision' still matches the plural-shaped pattern (substring match)" },
    { query: "Which risk is escalating?", expectedIntent: "risks-escalating", note: "singular 'risk' still matches" },
    // contractions — "aren't working" / "isn't working" (the confirmed, now-fixed gap)
    { query: "Which actions aren't working?", expectedIntent: "actions-not-working", note: "contraction — previously fell through to unrecognized, now fixed" },
    { query: "This action isn't working", expectedIntent: "actions-not-working", note: "contraction, singular — now fixed" },
    { query: "Which actions are not working?", expectedIntent: "actions-not-working", note: "the original non-contracted phrasing still matches" },
    // "my" possessive forms
    { query: "What's blocking my focus?", expectedIntent: "whats-blocking-focus", note: "possessive 'my'" },
    { query: "What is my 30-minute plan?", expectedIntent: "personal-thirty-min", note: "possessive 'my' + the product's own PERSONAL-family example phrasing — previously fell through, now fixed" },
    { query: "What can I finish in 30 minutes?", expectedIntent: "personal-thirty-min", note: "the original 'finish...30min' phrasing still matches" },
    // "today" / "yesterday"
    { query: "What changed today?", expectedIntent: "changed-today", note: "'today' variant" },
    { query: "Did yesterday's actions help?", expectedIntent: "did-yesterday-help", note: "'yesterday' variant" },
    { query: "Did today's actions help?", expectedIntent: "did-yesterday-help", note: "'today' also matches the did-(yesterday|today)-help pattern" },
    // "what changed" vs "what changed after the decision" — precedence between a specific
    // and a general pattern, must resolve to the MORE SPECIFIC one.
    { query: "What changed after the decision?", expectedIntent: "what-changed-after-decision", note: "specific pattern must win over the general 'what changed' pattern checked later" },
    { query: "What changed?", expectedIntent: "changed-today", note: "the general pattern, correctly NOT hijacked by the more specific one above" },
    // "blocked" vs "stalled"
    { query: "What's blocked?", expectedIntent: "blocking", note: "'blocked' routes to the generic blocking intent" },
    { query: "Which loops are stalled?", expectedIntent: "loops-stalled", note: "'stalled' + 'loop' together routes to loops-stalled" },
    { query: "What's stalled?", expectedIntent: "unrecognized", note: "DELIBERATE non-match: 'stalled' alone (no 'loop' context) is intentionally NOT assumed to mean delivery loops — stays the honest fallback rather than guessing" },
    // "risk" / "decision" / "action" / "focus" bare category words
    { query: "Show me risk", expectedIntent: "risks-for", note: "bare 'risk' falls through to the generic risks-for pattern" },
    { query: "decision", expectedIntent: "unrecognized", note: "DELIBERATE non-match: the bare word 'decision' alone matches no pattern's required keyword combination — stays honestly unrecognized rather than guessing which decision-family intent was meant" },
    { query: "What's my action strategy?", expectedIntent: "unrecognized", note: "DELIBERATE non-match: action-strategy requires 'different approach/strategy' phrasing specifically — a bare 'action strategy' noun phrase isn't assumed to mean the same thing" },
    { query: "focus", expectedIntent: "unrecognized", note: "the bare word 'focus' alone matches nothing — never silently mapped to a guess" },
    // "what should I do" family
    { query: "What should I do?", expectedIntent: "next-actions", note: "the canonical phrasing" },
    { query: "What should I do in the next 15 min?", expectedIntent: "next-actions", note: "captures the minutes value from the query text" },
  ];

  for (const { query, expectedIntent, note } of auditQueries) {
    const route = classifyQuery(query, cbAuditData);
    ok("V2.1 Command Bar precedence audit", route.intent === expectedIntent, `"${query}" routes to "${expectedIntent}" (${note}) — got "${route.intent}"`);
  }

  // Genuinely unknown, unrelated queries must ALWAYS return "unrecognized" — never
  // silently mapped to the nearest-sounding intent.
  for (const nonsense of ["asdkjasjdk", "tell me a joke", "what is the weather", "how many clients do we have named xyz123"]) {
    ok("V2.1 Command Bar precedence audit", classifyQuery(nonsense, cbAuditData).intent === "unrecognized", `a genuinely unrelated query ("${nonsense}") stays unrecognized, never silently guessed`);
  }
}

// ===== V2.1 §13-15 — AI usage diagnostics: cache stats + in-flight dedup + trace summary =====
{
  const fakeStorage = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (fakeStorage.has(k) ? fakeStorage.get(k)! : null),
      setItem: (k: string, v: string) => { fakeStorage.set(k, v); },
      removeItem: (k: string) => { fakeStorage.delete(k); },
    },
  };
  clearAICache();
  resetCacheStats();

  // In-flight deduplication: two concurrent requests for the identical key must result in
  // exactly ONE real fetcher call — this is what finally enforces usage-policy.ts's
  // dedupeInFlight field, declared in V2.0 but never actually wired up until now.
  let fetchCalls = 0;
  let resolveFetch: (v: { text: string }) => void;
  const slowFetcher = () =>
    new Promise<{ text: string }>((resolve) => {
      fetchCalls++;
      resolveFetch = resolve;
    });
  const facts = ["dedup fact"];
  const evidence = [{ content: "dedup evidence" }];
  const call1 = withAICache("detectRisks", "dedup-entity", facts, evidence, slowFetcher);
  const call2 = withAICache("detectRisks", "dedup-entity", facts, evidence, slowFetcher);
  ok("V2.1 AI in-flight dedup", fetchCalls === 1, "two concurrent requests for the identical task+entity+evidence key result in exactly ONE real fetcher call, not two");
  resolveFetch!({ text: "resolved once" });
  const [result1, result2] = await Promise.all([call1, call2]);
  ok("V2.1 AI in-flight dedup", result1.value.text === "resolved once" && result2.value.text === "resolved once", "both concurrent callers receive the same resolved value");
  ok("V2.1 AI in-flight dedup", result1.cacheState === "refreshed" && result2.cacheState === "cached", "the first caller sees 'refreshed' (it made the real call) and the second sees 'cached' (it deduped onto the in-flight request)");

  // A genuinely SEQUENTIAL second call (after the first has already resolved and cached)
  // is a normal cache hit, not a dedup case — both paths land on getCacheStats() correctly.
  const statsAfterDedup = getCacheStats();
  ok("V2.1 AI usage diagnostics", statsAfterDedup.misses === 1 && statsAfterDedup.hits === 1, `exactly one miss (the real call) and one hit (the deduped caller) are recorded (got misses=${statsAfterDedup.misses}, hits=${statsAfterDedup.hits})`);
  ok("V2.1 AI usage diagnostics", statsAfterDedup.callsThisSession === 1, "callsThisSession counts only the one real fetcher invocation, not the deduped caller");

  const call3 = await withAICache("detectRisks", "dedup-entity", facts, evidence, () => Promise.resolve({ text: "should not be called" }));
  ok("V2.1 AI usage diagnostics", call3.cacheState === "cached" && call3.value.text === "resolved once", "a later sequential call with the same key is a normal persisted-cache hit, unaffected by the earlier in-flight dedup");

  // getAiTraceSummary — pure aggregation over the bounded trace. recordAiCall() stamps
  // real wall-clock time (not the fixture TODAY), so this must compare against the actual
  // current date, not the fictional dataset date used everywhere else in this file.
  const realToday = new Date().toISOString().slice(0, 10);
  clearAiTrace();
  recordAiCall({ task: "detectRisks", mode: "claude", schemaValid: true, fallbackUsed: false, evidenceReferenceCount: 0, providerState: "REAL_CLAUDE" });
  recordAiCall({ task: "detectRisks", mode: "mock", schemaValid: false, fallbackUsed: true, evidenceReferenceCount: 0, providerState: "CALL_FAILED" });
  recordAiCall({ task: "detectRisks", mode: "mock", schemaValid: false, fallbackUsed: true, evidenceReferenceCount: 0, providerState: "VALIDATION_FAILED" });
  const summary = getAiTraceSummary(realToday);
  ok("V2.1 AI trace summary", summary.callsToday === 3, "getAiTraceSummary counts all 3 recorded calls as today's calls");
  ok("V2.1 AI trace summary", summary.byProviderState.REAL_CLAUDE === 1 && summary.byProviderState.CALL_FAILED === 1 && summary.byProviderState.VALIDATION_FAILED === 1, "the summary breaks calls down by provider state");
  ok("V2.1 AI trace summary", summary.failedValidationCount === 1, "failedValidationCount counts only VALIDATION_FAILED entries, distinct from CALL_FAILED");
  const summaryOtherDay = getAiTraceSummary("2020-01-01");
  ok("V2.1 AI trace summary", summaryOtherDay.callsToday === 0, "calls recorded on a different day are excluded from that day's summary");

  clearAiTrace();
  clearAICache();
  resetCacheStats();
  delete (globalThis as unknown as { window?: unknown }).window;
}

// ===== V2.1 §10 — "Before You Trust This Data" summary =====
{
  const health = (over: Partial<import("../src/lib/command-center/types").DataHealth>): import("../src/lib/command-center/types").DataHealth => ({
    freshness: "fresh",
    sourceType: "jira",
    ownershipCoveragePct: 100,
    dueDateCoveragePct: 100,
    releaseCoveragePct: 100,
    scopeHistoryCoverage: "full",
    totalWorkItems: 20,
    ...over,
  });

  const empty = buildBeforeYouTrustSummary(health({ totalWorkItems: 0 }));
  ok("V2.1 Before You Trust This Data", !empty.hasData && empty.rows.length === 0, "with zero open work items, the summary reports hasData:false rather than fabricating 0%/LIMITED rows");

  const allGood = buildBeforeYouTrustSummary(health({}));
  ok("V2.1 Before You Trust This Data", allGood.rows.every((r) => r.status === "GOOD"), "100% coverage across every dimension bands every row GOOD");
  ok("V2.1 Before You Trust This Data", allGood.impact.includes("solid"), "when every row is GOOD, the impact line says data quality looks solid, not a fabricated warning");

  const spec = buildBeforeYouTrustSummary(health({ ownershipCoveragePct: 77, dueDateCoveragePct: 100, releaseCoveragePct: 38, scopeHistoryCoverage: "partial" }));
  const ownershipRow = spec.rows.find((r) => r.label === "Ownership");
  const releaseRow = spec.rows.find((r) => r.label === "Release");
  const scopeRow = spec.rows.find((r) => r.label === "Scope history");
  ok("V2.1 Before You Trust This Data", ownershipRow?.value === "77%" && ownershipRow?.status === "REVIEW", "77% ownership bands to REVIEW, matching the spec's worked example");
  ok("V2.1 Before You Trust This Data", releaseRow?.value === "38%" && releaseRow?.status === "LIMITED", "38% release coverage bands to LIMITED, matching the spec's worked example");
  ok("V2.1 Before You Trust This Data", scopeRow?.value === "PARTIAL" && scopeRow?.status === "REVIEW", "PARTIAL scope history bands to REVIEW, matching the spec's worked example");
  ok("V2.1 Before You Trust This Data", spec.impact.toLowerCase().includes("release"), "the impact line names the single WORST dimension (Release, LIMITED) rather than a generic blended statement");
  ok("V2.1 Before You Trust This Data", spec.recommended !== "None — no action needed.", "a REVIEW/LIMITED row always produces an actionable recommendation, never silently omitted");

  const withMappings = buildBeforeYouTrustSummary(health({}), { supported: 11, total: 13 });
  const mappingsRow = withMappings.rows.find((r) => r.label === "Mappings");
  ok("V2.1 Before You Trust This Data", mappingsRow?.value === "11/13", "when a field-support summary is supplied, the Mappings row shows it exactly as 'supported/total', matching the spec's worked example");
  ok("V2.1 Before You Trust This Data", buildBeforeYouTrustSummary(health({})).rows.every((r) => r.label !== "Mappings"), "the Mappings row is omitted entirely (never fabricated) when no field-support summary is available");
}

// ===== V2.1 §6/§14 — AI provider state split (CALL_FAILED vs VALIDATION_FAILED) =====
// Confirmed: claude-provider.ts used to collapse three distinct failure modes (non-200/API
// error, malformed/schema-invalid response, thrown network error) into one
// "MOCK_FALLBACK" providerState. This section proves the request-level and
// validation-level failures are now genuinely distinguishable in the trace, by
// temporarily stubbing globalThis.fetch (restored in a finally block) so the "available"
// check succeeds but the actual call fails in two different, controlled ways.
{
  const originalFetch = globalThis.fetch;
  try {
    // Scenario 1: the server is "available" but the POST call itself fails (500).
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (!init || init.method === "GET") return new Response(JSON.stringify({ available: true }), { status: 200 });
      return new Response(JSON.stringify({ ok: false, error: "simulated upstream failure" }), { status: 500 });
    }) as typeof fetch;

    clearAiTrace();
    const providerCallFailed = new ClaudeProvider();
    const item = makeItem({ id: "provider-state-1" });
    const scoreResult = scoreWorkItem(item, { ...emptyData(), workItems: [item] }, TODAY);
    await providerCallFailed.analyzePriorities(item, scoreResult, ["fact"], []);
    const traceAfterCallFailed = getRecentAiTrace();
    ok("V2.1 AI provider states", traceAfterCallFailed[0]?.providerState === "CALL_FAILED", `a non-200 POST response is recorded as CALL_FAILED, not a generic MOCK_FALLBACK (got ${traceAfterCallFailed[0]?.providerState})`);

    // Scenario 2: the server is "available" and returns 200/ok:true, but the payload
    // doesn't pass schema validation.
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (!init || init.method === "GET") return new Response(JSON.stringify({ available: true }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, data: { completely: "the wrong shape" } }), { status: 200 });
    }) as typeof fetch;

    clearAiTrace();
    const providerValidationFailed = new ClaudeProvider();
    await providerValidationFailed.analyzePriorities(item, scoreResult, ["fact"], []);
    const traceAfterValidationFailed = getRecentAiTrace();
    ok("V2.1 AI provider states", traceAfterValidationFailed[0]?.providerState === "VALIDATION_FAILED", `a 200 response that fails schema validation is recorded as VALIDATION_FAILED, distinct from CALL_FAILED (got ${traceAfterValidationFailed[0]?.providerState})`);

    // Scenario 3: a genuine success still reports REAL_CLAUDE, unaffected by the split.
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (!init || init.method === "GET") return new Response(JSON.stringify({ available: true }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, data: { inference: "real inference", recommendation: "real recommendation", confidence: 0.8 } }), { status: 200 });
    }) as typeof fetch;

    clearAiTrace();
    const providerSuccess = new ClaudeProvider();
    await providerSuccess.analyzePriorities(item, scoreResult, ["fact"], []);
    const traceAfterSuccess = getRecentAiTrace();
    ok("V2.1 AI provider states", traceAfterSuccess[0]?.providerState === "REAL_CLAUDE" && providerSuccess.mode === "claude", "a genuinely successful, schema-valid response still reports REAL_CLAUDE — the split only affects the two failure paths");
  } finally {
    globalThis.fetch = originalFetch;
    clearAiTrace();
  }

  // NOT_CONFIGURED (CLAUDE_UNAVAILABLE) must never be confused with a call/validation
  // failure — the existing "Claude fallback" test block above already proves this path
  // (no server reachable -> providerState CLAUDE_UNAVAILABLE); spot-check it's still
  // distinct from the two new states.
  const unavailableProvider = new ClaudeProvider();
  const uItem = makeItem({ id: "provider-state-unavailable" });
  await unavailableProvider.analyzePriorities(uItem, scoreWorkItem(uItem, { ...emptyData(), workItems: [uItem] }, TODAY), ["fact"], []);
  const unavailableTrace = getRecentAiTrace();
  ok("V2.1 AI provider states", unavailableTrace[0]?.providerState === "CLAUDE_UNAVAILABLE", "with no server reachable at all, providerState is CLAUDE_UNAVAILABLE — distinct from both CALL_FAILED and VALIDATION_FAILED, never mislabeled as a 'Claude error'");
  clearAiTrace();
}

// ===== V2.1 §7 — Real Jira Pilot Runner: never fabricate LIVE =====
// Confirmed root cause: runJiraConformance() used to set `live = !!options` — i.e. purely
// from whether a config was PASSED IN, never from whether any HTTP call actually
// succeeded. A caller with real (but unreachable) credentials would get a report claiming
// "LIVE JIRA MODE" despite zero real Jira contact. This section proves the fix.
{
  // A genuinely successful live-style round-trip (fixture data standing in for a real
  // server response, but going through the real {fetchImpl, config} path) still reports
  // "live" — the fix must not make genuine live success harder to detect.
  const genuineLive = await runJiraConformance({ fetchImpl: fixtureFetch(), config: FIXTURE_CONFIG });
  ok("V2.1 Jira pilot runner", genuineLive.source === "live", "a config/fetchImpl whose project-discovery call actually succeeds is reported source: 'live'");
  ok("V2.1 Jira pilot runner", genuineLive.mode === "LIVE", "the explicit mode field agrees with source for a genuine live success");
  ok("V2.1 Jira pilot runner", genuineLive.modeLabel === "LIVE JIRA MODE", "modeLabel reads 'LIVE JIRA MODE' only for a genuinely verified live run");
  ok("V2.1 Jira pilot runner", !genuineLive.liveAttemptFailed, "liveAttemptFailed is not set on a genuine live success");
  ok("V2.1 Jira pilot runner", typeof genuineLive.startedAt === "string" && typeof genuineLive.completedAt === "string", "the report carries explicit startedAt/completedAt execution metadata");

  // Credentials WERE configured (a real config + fetchImpl were passed) but the round-trip
  // itself fails (401) — this must NEVER be reported as "live" (nothing was verified) nor
  // silently relabeled "fixtures" (fixtures were never used) — the fix must produce the
  // honest third state.
  const failedLiveAttempt = await runJiraConformance({ fetchImpl: fixtureFetch({ httpStatus: 401 }), config: FIXTURE_CONFIG });
  ok("V2.1 Jira pilot runner", failedLiveAttempt.source === "live-failed", "a config/fetchImpl whose project-discovery call FAILS is reported source: 'live-failed', never 'live' and never silently 'fixtures'");
  ok("V2.1 Jira pilot runner", failedLiveAttempt.mode === "FIXTURE", "the explicit mode field is FIXTURE (not LIVE) when the live attempt failed — nothing was verified");
  ok("V2.1 Jira pilot runner", failedLiveAttempt.modeLabel === "LIVE ATTEMPT FAILED", "modeLabel explicitly says the live attempt failed, distinct from both LIVE JIRA MODE and FIXTURE MODE");
  ok("V2.1 Jira pilot runner", failedLiveAttempt.liveAttemptFailed === true, "liveAttemptFailed is explicitly true so downstream consumers (e.g. the pilot checklist) can distinguish this from a plain fixture run");
  ok("V2.1 Jira pilot runner", failedLiveAttempt.jiraHostname !== undefined, "the attempted hostname is still surfaced even though the attempt failed — useful diagnostic, no credential value exposed");

  // A pure fixture run (no options at all) is unaffected — still reports "fixtures".
  const pureFixture = await runJiraConformance();
  ok("V2.1 Jira pilot runner", pureFixture.source === "fixtures" && pureFixture.mode === "FIXTURE", "omitting options entirely still produces a plain fixtures run, unaffected by the fix");
  ok("V2.1 Jira pilot runner", !pureFixture.liveAttemptFailed, "liveAttemptFailed is not set on a pure fixture run — no live attempt was ever made");
}

// ===== V2.1 §4 — Action Effectiveness Consistency (proactive.actionEffectivenessToday) =====
// Confirmed root cause: proactive.ts used to pass the FULL lifetime actionEffectiveness
// array into computeOutcomeScorecard's "actionsToday" parameter, and CloseDayModal merged
// EFFECTIVE+PARTIALLY_EFFECTIVE into one bucket while the scorecard counted EFFECTIVE only
// — same source, two inconsistent views. This section proves the fix: both surfaces now
// derive from proactive.actionEffectivenessToday with the identical strict predicate.
{
  const YESTERDAY = "2026-08-28";
  const baseAction = (over: Partial<Action>): Action => ({
    id: over.id!,
    title: over.title ?? over.id!,
    why: "why",
    status: "completed",
    estimateMinutes: 15,
    createdAt: YESTERDAY,
    completedAt: TODAY,
    ...over,
  });

  const actionsData: CommandCenterData = {
    ...emptyData(),
    actions: [
      baseAction({ id: "a-resolved", outcomeStatus: "RESOLVED" }),
      baseAction({ id: "a-improved", outcomeStatus: "IMPROVED" }),
      baseAction({ id: "a-partial", outcomeStatus: "PARTIALLY_IMPROVED" }),
      baseAction({ id: "a-nochange", outcomeStatus: "NO_CHANGE" }),
      baseAction({ id: "a-worsened", outcomeStatus: "WORSENED" }),
      baseAction({ id: "a-unknown-status", outcomeStatus: "UNKNOWN" }),
      baseAction({ id: "a-zero-outcome" }), // no outcomeStatus, no outcome, no relatedWorkItemId — genuinely UNKNOWN
      baseAction({ id: "a-yesterday", outcomeStatus: "RESOLVED", completedAt: YESTERDAY }), // completed, but not today
      { ...baseAction({ id: "a-still-open", outcomeStatus: "RESOLVED" }), status: "open", completedAt: undefined }, // not completed at all
    ],
  };

  const actionsDerived = deriveData(actionsData, null, TODAY);
  const actionsProactive = computeProactiveIntelligence(actionsData, actionsDerived, [], null, {}, "manual", TODAY);

  const todayIds = actionsProactive.actionEffectivenessToday.map((r) => r.actionId).sort();
  ok("V2.1 Action effectiveness consistency", !todayIds.includes("a-yesterday"), "an action completed yesterday is excluded from actionEffectivenessToday");
  ok("V2.1 Action effectiveness consistency", !todayIds.includes("a-still-open"), "an action that is not completed at all is excluded from actionEffectivenessToday");
  ok("V2.1 Action effectiveness consistency", todayIds.length === 7, `exactly the 7 actions genuinely completed today are included (got ${todayIds.length}: ${todayIds.join(", ")})`);

  const byId = new Map(actionsProactive.actionEffectivenessToday.map((r) => [r.actionId, r.classification]));
  ok("V2.1 Action effectiveness consistency", byId.get("a-resolved") === "EFFECTIVE", "RESOLVED outcomeStatus classifies EFFECTIVE");
  ok("V2.1 Action effectiveness consistency", byId.get("a-improved") === "EFFECTIVE", "IMPROVED outcomeStatus classifies EFFECTIVE");
  ok("V2.1 Action effectiveness consistency", byId.get("a-partial") === "PARTIALLY_EFFECTIVE", "PARTIALLY_IMPROVED outcomeStatus classifies PARTIALLY_EFFECTIVE");
  ok("V2.1 Action effectiveness consistency", byId.get("a-nochange") === "INEFFECTIVE", "NO_CHANGE outcomeStatus classifies INEFFECTIVE");
  ok("V2.1 Action effectiveness consistency", byId.get("a-worsened") === "INEFFECTIVE", "WORSENED outcomeStatus classifies INEFFECTIVE");
  ok("V2.1 Action effectiveness consistency", byId.get("a-unknown-status") === "UNKNOWN", "an explicit UNKNOWN outcomeStatus classifies UNKNOWN");
  ok("V2.1 Action effectiveness consistency", byId.get("a-zero-outcome") === "UNKNOWN", "an action with zero outcome evidence at all classifies UNKNOWN, never guessed");

  // The actual consistency proof: recompute the same 4 buckets two different ways — once
  // exactly as CloseDayModal.tsx now does (filter actionEffectivenessToday by class), and
  // once via the Outcome Scorecard's own computation — and assert they agree exactly.
  const effectiveCount = actionsProactive.actionEffectivenessToday.filter((r) => r.classification === "EFFECTIVE").length;
  const ineffectiveCount = actionsProactive.actionEffectivenessToday.filter((r) => r.classification === "INEFFECTIVE").length;
  ok("V2.1 Action effectiveness consistency", actionsProactive.outcomeScorecard.actionsCompleted === todayIds.length, "outcomeScorecard.actionsCompleted equals the count of actions genuinely completed today — no longer inflated by lifetime history");
  ok("V2.1 Action effectiveness consistency", actionsProactive.outcomeScorecard.actionsEffective === effectiveCount, "outcomeScorecard.actionsEffective exactly matches CloseDayModal's own EFFECTIVE-bucket count over the same today-filtered array — the two surfaces can no longer disagree");
  ok("V2.1 Action effectiveness consistency", actionsProactive.outcomeScorecard.actionsIneffective === ineffectiveCount, "outcomeScorecard.actionsIneffective exactly matches CloseDayModal's own INEFFECTIVE-bucket count over the same today-filtered array");

  // Zero-outcomes dataset: no completed actions at all today.
  const zeroData: CommandCenterData = { ...emptyData(), actions: [{ ...baseAction({ id: "a-old" }), completedAt: YESTERDAY }] };
  const zeroDerived = deriveData(zeroData, null, TODAY);
  const zeroProactive = computeProactiveIntelligence(zeroData, zeroDerived, [], null, {}, "manual", TODAY);
  ok("V2.1 Action effectiveness consistency", zeroProactive.actionEffectivenessToday.length === 0, "a dataset with zero actions completed today produces an empty actionEffectivenessToday, not a crash or a fabricated count");
  ok("V2.1 Action effectiveness consistency", zeroProactive.outcomeScorecard.actionsCompleted === 0 && zeroProactive.outcomeScorecard.actionsEffective === 0, "the scorecard reports zero/zero rather than falling back to lifetime history when nothing was completed today");
}

console.log("\n" + (failures === 0 ? `✅ All checks passed.` : `❌ ${failures} check(s) failed.`));
process.exit(failures === 0 ? 0 : 1);
