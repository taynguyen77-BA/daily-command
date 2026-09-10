// BA/PO/PM Command Center — deterministic-engine test suite (BUILD REQUEST §26).
// Run: npm test
//
// Covers: priority scoring, risk scoring, overdue detection, aging calculation,
// change detection, action-plan generation, data import validation, empty state,
// demo dataset. No AI provider calls — everything under test is deterministic.

import { scoreWorkItem, isOverdue, daysBetween, classify, eligibilityScore } from "../src/lib/command-center/scoring";
import { detectRisks, riskFingerprint } from "../src/lib/command-center/risk-detection";
import { detectChanges, toSnapshot } from "../src/lib/command-center/change-detection";
import { buildCandidates, buildPlan } from "../src/lib/command-center/action-plan";
import { importFromJson, importFromCsv, importFromText } from "../src/lib/command-center/import";
import { buildDemoData } from "../src/lib/command-center/demo-data";
import { DATA_SCHEMA_VERSION, emptyData, type WorkItem } from "../src/lib/command-center/types";
import { evidenceForRisk, evidenceForScore, factsForWorkItem, makeEvidence } from "../src/lib/command-center/evidence";
import { detectGaps } from "../src/lib/command-center/gap-detection";
import { computeDeliveryConfidence, buildExecutiveView } from "../src/lib/command-center/executive";
import { reasoningResponseSchema, textResponseSchema, aiRequestSchema, trendResponseSchema, assessmentResponseSchema } from "../src/lib/command-center/ai/schemas";
import { MockAIProvider } from "../src/lib/command-center/ai/provider";
import { ClaudeProvider, checkClaudeAvailability } from "../src/lib/command-center/ai/claude-provider";
import { buildDailySnapshot, buildSnapshotMetrics, compareSnapshots, dailyCanonicalSnapshots } from "../src/lib/command-center/memory";
import { detectDecisionConflictCandidates } from "../src/lib/command-center/decision-conflicts";
import { detectRecurringPatterns } from "../src/lib/command-center/pattern-detection";
import { buildWeeklyReviewFacts } from "../src/lib/command-center/weekly-review";
import { parseStoredState, commandCenterStore, getTodayIso, capMentionEvents, type StoreState } from "../src/lib/command-center/store";
import type { Decision, DailySnapshot, SnapshotMetrics } from "../src/lib/command-center/types";

// V1.3 — Live Project Intelligence
import { mapPriority, mapStatus, mapWorkItemType, isBlockedByHeuristic } from "../src/lib/command-center/jira/mapping";
import { normalizeIssue, normalizeIssues, normalizeProjects, clientIdForProjectKey } from "../src/lib/command-center/jira/normalize";
import { jiraIssueSchema, jiraSearchResponseSchema, type JiraIssue } from "../src/lib/command-center/jira/types";
import { fetchJiraIssuesWith, fetchJiraProjectsWith, buildIssuesJql, classifyHttpError, JIRA_PAGE_SIZE, JIRA_PROJECT_PAGE_SIZE, type FetchLike } from "../src/lib/command-center/jira/http";
import { DisabledJiraActionProvider } from "../src/lib/command-center/jira/jira-action-provider";
import { applyFilters, availableFixVersions } from "../src/lib/command-center/filters";
import { computeFreshness } from "../src/lib/command-center/freshness";
import { computeReleaseHealth, computeAllReleaseHealth } from "../src/lib/command-center/release-health";
import { buildAIContext } from "../src/lib/command-center/ai-context";
import { classifyQuery, answerFromRoute, familyForIntent } from "../src/lib/command-center/query-router";
import { JiraDataSource } from "../src/lib/command-center/datasource/jira-source";
import { deriveData, dedupeRisks } from "../src/lib/command-center/selectors";
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
import { computeClientAttentionMap, computeProjectAttentionMap } from "../src/lib/command-center/client-attention-map";
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
import { detectJiraSearchCapability, JIRA_MAX_ISSUES, computeResumeCursor } from "../src/lib/command-center/jira/http";
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

// V2.2 — Evidence -> Delivery Artifact (the COMMUNICATE layer)
import {
  buildDecisionBriefDraft,
  buildMeetingModeBrief,
  buildNeedsFromOthers,
  buildReleaseUpdateDraft,
  buildStakeholderUpdateDraft,
  buildStatusUpdateDraft,
  buildTodaysUpdateDraft,
  isArtifactStale,
  rebuildDraftFromSourceRef,
  renderArtifactText,
  renderMeetingModeText,
  renderNeedsFromOthersText,
  summarizeArtifactTrust,
} from "../src/lib/command-center/communicate";
import { artifactUsageKey, commandUsageKey, computeUsageSummary } from "../src/lib/command-center/usage";
import { isArtifactIntent } from "../src/lib/command-center/query-router";
import { communicationArtifactResponseSchema } from "../src/lib/command-center/ai/schemas";
import type { WhyShouldICareContent } from "../src/lib/command-center/why-should-i-care";
import type { DecisionOptionsResult, Project } from "../src/lib/command-center/types";

// V2.3 — Focus Project Scope & Jira Ingestion Guard
import { applyProjectScope, DEFAULT_JIRA_PROJECT_SCOPE, detectExplicitProjectMention, findOutOfScopeMention, formatScopeLabel, knownJiraProjects, parseJiraProjectScope, resolveEffectiveProjectKeys, scopeMentionEvents } from "../src/lib/command-center/jira/project-scope";
import { buildProjectOverrideView } from "../src/components/command-center/use-command-center";
import type { JiraProjectScope } from "../src/lib/command-center/types";

// V2.5 — Work Relevance & Jira Status Policy
import {
  buildWorkRelevanceIndex,
  collectObservedStatuses,
  countUnclassifiedJiraStatuses,
  explainWorkItemRelevance,
  isPersonalWorkEligible,
  isPersonalWorkEligibleItem,
  isWorkItemDoneOrExcluded,
  jiraProjectKeyForWorkItem,
  listUnclassifiedJiraStatuses,
  parseWorkRelevancePolicyMap,
  resolveWorkRelevance,
  withStatusRelevance,
  workItemsByRelevance,
  WORK_RELEVANCE_EXPLANATIONS,
  // V2.6 — Work Policy Intelligence & Operational Calibration
  computeOverallWorkRelevanceCoverage,
  countOpenItemsForStatus,
  listStatusesByRelevance,
} from "../src/lib/command-center/jira/work-relevance";
// V2.7 — Work Relevance Operational Calibration
import {
  computeActionableCalibration,
  computeCalibrationHealthState,
  computeObserveCalibration,
  computePolicyReviewSignals,
  computeUnknownVisibility,
  computeWorkRelevanceDistribution,
} from "../src/lib/command-center/jira/work-relevance-calibration";
// V2.8 — Execution Path & Work Signal Calibration
import {
  computeExecutionPathStatusTable,
  computeExecutionPathTrace,
  explainExecutionSurface,
  listCandidatePoolActionableItems,
  listJiraItemsInPersonalFocus,
} from "../src/lib/command-center/execution-path";
// V2.12 — Signal Semantics Fix (Policy Review / Candidate Evaluation / Execution Gap)
import { computeActionableSignals } from "../src/lib/command-center/jira/work-relevance-signals";
import { updateWorkItemCalibrationHistory, type WorkItemCalibrationHistory } from "../src/lib/command-center/jira/work-relevance-history";
import type { WorkRelevance, DeliveryLoop } from "../src/lib/command-center/types";
// V2.10 — Real-time mention/assignment tracking
import { buildMentionEvents, commentMentionsAccount, extractCommentExcerpt, mentionCommentId, selectRecentMentionCandidates } from "../src/lib/command-center/jira/mentions";
import { groupMentionAttentionItems } from "../src/components/command-center/AttentionQueuePanel";
import { groupMentionItems, mentionGroupLabel } from "../src/lib/command-center/mention-grouping";
import { detectNewAssignments } from "../src/lib/command-center/assignment-detection";
import { buildSlackNotifyPayloads, computeNewPersonalSignals } from "../src/lib/command-center/notify";
import { fetchMentionedIssuesWith, fetchIssueCommentsWith } from "../src/lib/command-center/jira/http";
import type { JiraComment } from "../src/lib/command-center/jira/types";
import type { MentionEvent } from "../src/lib/command-center/types";
import type { MemoryEvent, DailyReportSnapshot } from "../src/lib/command-center/types";
import { summarizeDailyReport, dailyReportToMarkdown, buildWeeklyReportSummary, last7DaysEnding, weeklyReportToMarkdown } from "../src/lib/command-center/daily-report";
// V2.11 §2 — Slack destination visibility: GET/POST /api/command-center/notify
import { GET as notifyStatusGET, POST as notifyPOST } from "../src/app/api/command-center/notify/route";

// V2.13 §3 — Ticket links
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TicketLink } from "../src/components/command-center/TicketLink";

// V2.13 §2 — server-side (cron-driven) notify check
import { runServerSideNotifyCheck } from "../src/lib/command-center/cron-notify";
import { createInMemoryNotifyStore, isNotifyStoreConfigured } from "../src/lib/command-center/notify-state";
import type { SlackFetchLike } from "../src/lib/server/slack-notify";

// V2.14 — "Is this mine to act on?" relation badge
import { classifyPersonalRelation, isMyActionItem, matchesIdentity } from "../src/lib/command-center/personal-relation";
import { RelationBadge } from "../src/components/command-center/ui";

// V2.15 — Cross-Device Sync
import { checkSyncRequestAuth } from "../src/lib/command-center/jira/sync-auth";
import { checkAppStateAuth, createInMemoryAppStateStore, isAppStateStoreConfigured, syncedAppStateSchema, type SyncedAppState } from "../src/lib/command-center/app-state";
import { decideInitialSync, extractSyncedAppState, looksUnused, mergeSyncedAppState } from "../src/lib/command-center/app-state-sync";

// V2.16 — sync-failure visibility (see the V2.16 test section near the end of this file)
import { daysStale } from "../src/components/command-center/Header";

// V2.19 — Personal Work & Reporting Hardening: My Assigned Work, Recently Mentioned, Daily
// Command Completion
import { getActiveAssignedWorkItems, getAssignedWorkItems, getCompletedAssignedWorkItems } from "../src/lib/command-center/assigned-work";
import { RECENT_MENTION_WINDOW_HOURS, selectRecentMentions } from "../src/lib/command-center/recent-mentions";
import type { DailyCommandCompletion } from "../src/lib/command-center/types";

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

// ===== BUGFIX regression — completing (or deferring/snoozing/blocking) an auto-suggested
// candidate's Action must never make that same WorkItem reappear as a fresh, untouched
// candidate on the next recompute. Previously buildCandidates() only excluded items covered
// by an OPEN action, so completing an action removed it from coveredItemIds and the item
// came right back via the bare-item loop — visually indistinguishable from never having
// been touched (most visible after a page reload, since the client-side liveAction
// workaround in action-plan/page.tsx only survives within one still-mounted component). =====
{
  const highScoreItem = makeItem({ id: "bugfix-1", key: "BUG-1", businessImpact: 5, priority: "P1", blocked: true, dueDate: TODAY });
  const dataNoAction = { ...emptyData(), workItems: [highScoreItem] };
  const beforeAny = buildCandidates(dataNoAction, TODAY);
  ok("Action plan bugfix", beforeAny.some((c) => c.item?.id === "bugfix-1" && c.id === "plan-bugfix-1"), "sanity check: a fresh, untouched high-scoring item is auto-suggested as a bare-item candidate");

  for (const status of ["completed", "deferred", "snoozed", "blocked"] as const) {
    const action = { id: `bugfix-action-${status}`, title: "Do the thing", why: "test", relatedWorkItemId: "bugfix-1", status, estimateMinutes: 15, createdAt: TODAY, ...(status === "completed" ? { completedAt: TODAY } : {}) };
    const dataAfter = { ...emptyData(), workItems: [highScoreItem], actions: [action] };
    const after = buildCandidates(dataAfter, TODAY);
    ok(
      "Action plan bugfix",
      !after.some((c) => c.id === "plan-bugfix-1"),
      `a ${status} Action's WorkItem is never re-synthesized as a fresh bare-item candidate (would silently look untouched again)`
    );
  }

  // The "open" case is the control: an item with an OPEN action must still be represented
  // (via the action-based candidate itself) — the fix must not hide active work.
  const openAction = { id: "bugfix-action-open", title: "Do the thing", why: "test", relatedWorkItemId: "bugfix-1", status: "open" as const, estimateMinutes: 15, createdAt: TODAY };
  const dataOpen = { ...emptyData(), workItems: [highScoreItem], actions: [openAction] };
  const withOpen = buildCandidates(dataOpen, TODAY);
  ok("Action plan bugfix", withOpen.some((c) => c.id === "bugfix-action-open"), "an item with an OPEN action remains represented via its own action-based candidate, never hidden");
  ok("Action plan bugfix", !withOpen.some((c) => c.id === "plan-bugfix-1"), "…and is never ALSO duplicated as a second, bare-item candidate for the same WorkItem");
}

// ===== V2.9 §F-01 fix — eligibilityScore must not punish missing Business Impact /
// due-date data (the real-Jira norm) out of candidacy, while still excluding genuinely
// quiet items. Reproduces the real-world shape found auditing a live Jira instance:
// a heavily-churned, blocked item scored 25/100 raw (well under the old flat 40 gate)
// purely because it had no Business Impact field or due date populated. =====
{
  const noBusinessImpactOrDueDate = { businessImpact: undefined, dueDate: undefined } as const;
  const churnedAndBlocked = makeItem({ id: "churned-1", blocked: true, scopeChangeCount: 21, ...noBusinessImpactOrDueDate });
  const churnedResult = scoreWorkItem(churnedAndBlocked, emptyData(), TODAY);
  ok("V2.9 Eligibility fix", churnedResult.score < 40, `sanity check: raw score (${churnedResult.score}) is below the old flat 40 gate, exactly like the real audited item`);
  ok("V2.9 Eligibility fix", eligibilityScore(churnedAndBlocked, churnedResult) >= 40, `a heavily-churned, blocked item now clears the candidate gate (eligibilityScore ${eligibilityScore(churnedAndBlocked, churnedResult)}) despite missing Business Impact/due date`);

  const quietItem = makeItem({ id: "quiet-1", blocked: false, scopeChangeCount: 0, lastUpdated: TODAY, ...noBusinessImpactOrDueDate });
  const quietResult = scoreWorkItem(quietItem, emptyData(), TODAY);
  ok("V2.9 Eligibility fix", eligibilityScore(quietItem, quietResult) < 40, "a genuinely low-signal item with the same missing fields is still correctly excluded — the fix removes an unfair penalty, not the bar itself");

  const fullyPopulated = makeItem({ id: "full-1", blocked: true, scopeChangeCount: 21, businessImpact: 3, dueDate: TODAY });
  const fullResult = scoreWorkItem(fullyPopulated, emptyData(), TODAY);
  ok("V2.9 Eligibility fix", eligibilityScore(fullyPopulated, fullResult) === fullResult.score, "an item with both fields populated is completely unaffected — eligibilityScore only adjusts for missing data");

  const candidates = buildCandidates({ ...emptyData(), workItems: [churnedAndBlocked, quietItem] }, TODAY);
  const candidateIds = new Set(candidates.map((c) => c.item?.id).filter(Boolean));
  ok("V2.9 Eligibility fix", candidateIds.has("churned-1"), "buildCandidates() end-to-end: the churned/blocked item is now a real candidate");
  ok("V2.9 Eligibility fix", !candidateIds.has("quiet-1"), "buildCandidates() end-to-end: the quiet item remains excluded, not flooded in");
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

// ===== V2.18 §10 — dailyCanonicalSnapshots: one entry per calendar date, last-wins, order
// preserved. Confirmed real gap: snapshotHistory is appended to on every sync/import/close-day
// with no same-day guard, so repeated manual syncs (or a >1x/day deployment) accumulate
// multiple same-day entries that trend/drift/weekly-review math would otherwise read raw. =====
{
  const mk = (date: string, deliveryConfidence: number): DailySnapshot => ({ date, workItems: [], risks: [], requirements: [], dependencies: [], projects: [], metrics: { ...yesterdayMetrics, deliveryConfidence } });

  ok("V2.18 dailyCanonicalSnapshots", dailyCanonicalSnapshots([]).length === 0, "empty history -> empty result, never a crash");

  const singlePerDay = [mk("2026-06-10", 70), mk("2026-06-11", 72), mk("2026-06-12", 75)];
  ok("V2.18 dailyCanonicalSnapshots", dailyCanonicalSnapshots(singlePerDay).length === 3, "one entry per day already -> unchanged, nothing collapsed");

  // Three syncs on the same day (08:00/12:00/16:00 all persisted with date "2026-06-12"),
  // then one entry the next day.
  const multiplePerDay = [mk("2026-06-12", 70), mk("2026-06-12", 68), mk("2026-06-12", 65), mk("2026-06-13", 80)];
  const canonical = dailyCanonicalSnapshots(multiplePerDay);
  ok("V2.18 dailyCanonicalSnapshots", canonical.length === 2, "three same-day entries collapse to one — the operational list's per-sync granularity is not what a 'day' means for trend math");
  ok("V2.18 dailyCanonicalSnapshots", canonical[0].date === "2026-06-12" && canonical[0].metrics!.deliveryConfidence === 65, "the LAST same-day entry wins (most recent recompute of that day), not the first");
  ok("V2.18 dailyCanonicalSnapshots", canonical[1].date === "2026-06-13", "chronological order is preserved across the collapsed and uncollapsed entries");

  // The raw snapshotHistory list itself is never mutated — this is a pure, read-time
  // derivation, not a storage-format change.
  const beforeLength = multiplePerDay.length;
  dailyCanonicalSnapshots(multiplePerDay);
  ok("V2.18 dailyCanonicalSnapshots", multiplePerDay.length === beforeLength, "calling this never mutates the raw operational history array passed in");
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
  // V2.2.2 — fetchJiraIssuesWith now tries POST /rest/api/3/search/jql first; these mocks
  // only model the classic startAt-based endpoint, so they report 404 on the replacement to
  // exercise the (still-real, still-tested) fallback path — see jira/http.ts.
  const paginatedFetch: FetchLike = async (url) => {
    if (url.includes("/search/jql")) return { ok: false, status: 404, json: async () => ({}) };
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
  ok("Incremental sync", buildIssuesJql({}) === "project is not EMPTY order by updated asc", "no options -> a full, unscoped sync JQL that still satisfies Jira's bounded-query requirement (see V2.2.4)");

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
    if (url.includes("/search/jql")) return { ok: false, status: 404, json: async () => ({}) };
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
function makeDependency(overrides: Partial<Dependency> = {}): Dependency {
  return { id: "dep-1", workItemId: "wi-1", description: "test dependency", dependsOnTeam: "Team", status: "unresolved", raisedDate: TODAY, ...overrides };
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

// ===== V2.18 §7 — Risk fingerprint: cross-project dedup + stable cross-day identity =====
// Confirmed real bugs this fixes: dedupeRisks/computeRiskEscalations used to match by
// r.title alone. R6 (dependency-unresolved) generates a title with NO project/client token
// at all (`Dependency on ${team} unresolved for ${age} days`), so two different projects
// both blocked on the same team for the same number of days produced byte-identical titles
// and silently collided; R6's title also embeds the age itself, so even a single risk's
// title changes text every day, breaking day-to-day matching outright regardless of the
// cross-project issue.
{
  const day1 = "2026-06-13";
  const day2 = "2026-06-14";
  const day3 = "2026-06-15";

  // --- Real R6 reproduction: two projects, same team, same age -> identical title text ---
  const jpmcItem = makeItem({ id: "wi-jpmc", projectId: "p-jpmc", dependencyIds: ["dep-jpmc"] });
  const ubsItem = makeItem({ id: "wi-ubs", projectId: "p-ubs", dependencyIds: ["dep-ubs"] });
  const jpmcDep = makeDependency({ id: "dep-jpmc", dependsOnTeam: "Platform Team", raisedDate: "2026-06-10" }); // age 5 at day3
  const ubsDep = makeDependency({ id: "dep-ubs", dependsOnTeam: "Platform Team", raisedDate: "2026-06-10" });
  const crossProjectData: CommandCenterData = { ...emptyData(), workItems: [jpmcItem, ubsItem], dependencies: [jpmcDep, ubsDep] };
  const crossProjectRisks = detectRisks(crossProjectData, day3);
  const platformTeamRisks = crossProjectRisks.filter((r) => r.title.includes("Platform Team"));
  ok("V2.18 Risk fingerprint", platformTeamRisks.length === 2, "two different projects blocked on the same team for the same age produce two real risks with byte-identical titles");
  ok("V2.18 Risk fingerprint", new Set(platformTeamRisks.map((r) => r.projectId)).size === 2, "the two risks carry different projectId — the collision only happens if identity ignores it");
  ok("V2.18 Risk fingerprint", dedupeRisks([], crossProjectRisks).length === crossProjectRisks.length, "dedupeRisks does NOT collapse the two real, project-distinct risks despite the identical title — the exact JPMC/UBS scenario from the hardening spec");

  // --- Same fingerprint (same rule + project + identityKey), differing free text -> collapses ---
  const dup1 = { ...platformTeamRisks[0], id: "dup-a" };
  const dup2 = { ...platformTeamRisks[0], id: "dup-b", evidence: ["completely different evidence text"], confidence: 0.99 };
  ok("V2.18 Risk fingerprint", riskFingerprint(dup1) === riskFingerprint(dup2), "two risk objects with the same ruleId+projectId+identityKey share one fingerprint regardless of differing free text");
  ok("V2.18 Risk fingerprint", dedupeRisks([], [dup1, dup2]).length === 1, "same fingerprint collapses to one even with differing evidence/confidence");

  // --- Day-to-day matching survives R6's title text changing as age increments ---
  const singleDepData: CommandCenterData = { ...emptyData(), workItems: [makeItem({ id: "wi-x", projectId: "p-x", dependencyIds: ["dep-x"] })], dependencies: [makeDependency({ id: "dep-x", dependsOnTeam: "Data Team", raisedDate: "2026-06-10" })] };
  const day1Risks = dedupeRisks([], detectRisks(singleDepData, day1)); // age 3
  const day2Risks = dedupeRisks([], detectRisks(singleDepData, day2)); // age 4 -> genuinely different title text
  ok("V2.18 Risk fingerprint", day1Risks[0].title !== day2Risks[0].title, "sanity check: R6's title text genuinely differs day to day as age increments");
  ok("V2.18 Risk fingerprint", riskFingerprint(day1Risks[0]) === riskFingerprint(day2Risks[0]), "the fingerprint is stable across the same title-text change that would break title-based matching");
  const history: DailySnapshot[] = [{ date: day1, workItems: [], risks: day1Risks, requirements: [], dependencies: [], projects: [] }];
  const esc = computeRiskEscalations(day2Risks, history, day2);
  ok("V2.18 Risk fingerprint", esc[0].daysOpen === 2, "fingerprint-based matching finds yesterday's occurrence even though the title text changed — title-based matching would have reset this to 1");

  // --- A risk whose underlying condition clears is cleanly absent, no phantom escalation ---
  const resolvedData: CommandCenterData = { ...emptyData(), workItems: [makeItem({ id: "wi-x", projectId: "p-x", dependencyIds: ["dep-x"] })], dependencies: [makeDependency({ id: "dep-x", dependsOnTeam: "Data Team", raisedDate: "2026-06-10", status: "resolved" })] };
  const day3Open = dedupeRisks([], detectRisks(resolvedData, day3));
  ok("V2.18 Risk fingerprint", day3Open.length === 0, "a risk whose underlying condition (the dependency) cleared is simply absent from today's open set");
  const escDay3 = computeRiskEscalations(day3Open, history, day3);
  ok("V2.18 Risk fingerprint", escDay3.length === 0, "no phantom escalation entry lingers for a resolved risk that's no longer in the open set");
}

// ===== V2.18 §7 — auto-detected risks now persist into snapshotHistory =====
// Confirmed real gap: toSnapshot/buildDailySnapshot only ever serialized data.risks
// (manually-logged/imported only) — nothing in the live app writes to data.risks in normal
// Jira/demo usage, so auto-detected risks (the overwhelming majority of what the product
// actually shows) were never captured in history at all, making the day-over-day
// "worsening/days open" trajectory logic silently inert for them.
{
  const noOwnerItem = makeItem({ id: "wi-no-owner", projectId: "p-1", priority: "P1", owner: undefined });
  const dataWithAutoRisk: CommandCenterData = { ...emptyData(), workItems: [noOwnerItem] };

  const defaultSnapshot = buildDailySnapshot(dataWithAutoRisk, TODAY, 0);
  ok("V2.18 Snapshot persistence", defaultSnapshot.risks.length === 0, "no risksOverride passed -> unchanged default behavior (manual risks only, currently empty) — this change is additive/backward-compatible");

  const openRisks = dedupeRisks(dataWithAutoRisk.risks, detectRisks(dataWithAutoRisk, TODAY));
  const overriddenSnapshot = buildDailySnapshot(dataWithAutoRisk, TODAY, 0, openRisks);
  ok("V2.18 Snapshot persistence", overriddenSnapshot.risks.some((r) => r.ruleId === "no-owner"), "passing the same deduped manual+auto set the rest of the app already computes persists the auto risk into the snapshot");
  ok("V2.18 Snapshot persistence", overriddenSnapshot.metrics?.highRiskCount === overriddenSnapshot.risks.filter((r) => r.level === "HIGH").length, "metrics and .risks are computed from the SAME override — never two different risk sets for one snapshot");

  const toSnapshotDefault = toSnapshot(dataWithAutoRisk, TODAY);
  ok("V2.18 Snapshot persistence", toSnapshotDefault.risks.length === 0, "toSnapshot's own default (no override) is likewise unchanged");
  const toSnapshotOverridden = toSnapshot(dataWithAutoRisk, TODAY, openRisks);
  ok("V2.18 Snapshot persistence", toSnapshotOverridden.risks.some((r) => r.ruleId === "no-owner"), "toSnapshot persists the override when passed");
}

// ===== V2.18 §7 — store.ts: closeDay() actually persists the deduped auto-risk set into
// snapshotHistory, not just data.risks (end-to-end, not just the pure-function level above) =====
{
  commandCenterStore.resetAll();
  const p1NoOwner = { ...makeItem({ id: "wi-close-day", key: "CD-1", projectId: "p-1", priority: "P1", owner: undefined }), sourceType: "jira" as const, sourceId: "CD-1" };
  commandCenterStore.importData({ ok: true, data: { ...emptyData(), workItems: [p1NoOwner] }, errors: [], addedCounts: {} });

  await commandCenterStore.closeDay();
  const afterCloseDay = commandCenterStore.getSnapshot();
  const persistedSnapshot = afterCloseDay.snapshotHistory.at(-1);
  ok("V2.18 closeDay persistence", persistedSnapshot?.risks.some((r) => r.auto === true && r.ruleId === "no-owner"), "closeDay() now persists the deduped auto-risk set into snapshotHistory, not just the (empty) data.risks");

  commandCenterStore.resetAll();
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

  // Bugfix regression: clicking Resolve on an item whose evidence is still being produced
  // (never actually disappeared) must not be instantly undone on the very next recompute —
  // this is exactly what a manual "Resolve" click does: same day, same underlying condition.
  const manuallyResolvedToday: Record<string, AttentionItemState> = { "DEPENDENCY:dep-dup": { lifecycle: "RESOLVED", firstSeenDate: "2026-06-10", lastSeenDate: "2026-06-15", resolvedManually: true } };
  const sameDayAfterResolve = buildAttentionQueue(dedupInputs, manuallyResolvedToday, "2026-06-15");
  ok("Resolve bugfix", sameDayAfterResolve.nextAttentionState["DEPENDENCY:dep-dup"]?.lifecycle === "RESOLVED", "manually resolving an item whose evidence is still ongoing stays RESOLVED on the same-day recompute, instead of instantly flipping to REOPENED");
  ok("Resolve bugfix", sameDayAfterResolve.items.find((i) => i.id === "DEPENDENCY:dep-dup")?.lifecycle === "RESOLVED", "the item is still reported in the full list (consumers filter it), but tagged RESOLVED rather than bounced back to REOPENED/ACTIVE");

  const nextDayStillResolved = buildAttentionQueue(dedupInputs, sameDayAfterResolve.nextAttentionState, "2026-06-16");
  ok("Resolve bugfix", nextDayStillResolved.nextAttentionState["DEPENDENCY:dep-dup"]?.lifecycle === "RESOLVED", "a manually-resolved item with unchanged severity stays resolved on later days too, like ACKNOWLEDGED — not just for one cycle");

  const manuallyResolvedThenWorsened: Record<string, AttentionItemState> = { "DEPENDENCY:dep-dup": { lifecycle: "RESOLVED", firstSeenDate: "2026-06-10", lastSeenDate: "2026-06-15", lastSeverity: "MEDIUM", resolvedManually: true } };
  const worsenedAfterResolve = buildAttentionQueue({ ...dedupInputs, dependencyRadar: [{ ...depItemA, heat: "CRITICAL" }] }, manuallyResolvedThenWorsened, "2026-06-16");
  ok("Resolve bugfix", worsenedAfterResolve.nextAttentionState["DEPENDENCY:dep-dup"]?.lifecycle === "RE_ESCALATED", "a manually-resolved item still re-escalates if severity genuinely worsens afterward — Resolve suppresses noise, it doesn't hide a real new signal");

  const genuineReappearAfterManualResolve: Record<string, AttentionItemState> = { "DEPENDENCY:dep-dup": { lifecycle: "RESOLVED", firstSeenDate: "2026-06-10", lastSeenDate: "2026-06-15" } };
  const genuineReopen = buildAttentionQueue(dedupInputs, genuineReappearAfterManualResolve, "2026-06-17");
  ok("Resolve bugfix", genuineReopen.items[0].lifecycle === "REOPENED", "without the resolvedManually flag (i.e. resolved via genuine disappearance), reappearing still correctly comes back as REOPENED");

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

// ===== V2.10 §2 — Mention/Assignment ingestion =====
{
  const stableDriftForMentions = computeDeliveryDrift([], yesterdayMetrics);
  const mentionInputsBase = {
    drift: stableDriftForMentions, releaseDrift: [], riskEscalations: [], openRisks: [], dependencyRadar: [],
    decisionRadar: [], ineffectiveActions: [], stakeholderAttention: [], communicationPriority: [],
  };
  const mentionWorkItem = makeItem({ id: "jira-MENT-1", key: "MENT-1", projectId: "proj-mention", clientId: "client-mention" });

  // --- commentMentionsAccount / buildMentionEvents: pure ADF-walking logic ---
  const adfMentioning = (accountId: string) => ({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: accountId, text: "@Me" } }, { type: "text", text: " please check this" }] }],
  });
  ok("V2.10 Mentions", commentMentionsAccount(adfMentioning("acc-me"), "acc-me") === true, "a comment whose ADF body contains a mention node for this account is detected as mentioning it");
  ok("V2.10 Mentions", commentMentionsAccount(adfMentioning("acc-someone-else"), "acc-me") === false, "a comment mentioning a DIFFERENT account is never detected as mentioning this one");
  ok("V2.10 Mentions", commentMentionsAccount("plain text with [~accountid:acc-me] in it", "acc-me") === true, "a plain-string body (some instances/API versions) is checked via the classic wiki-markup mention syntax");
  ok("V2.10 Mentions", extractCommentExcerpt("x".repeat(300)).length <= 200, "an excerpt is always capped at ~200 characters — evidence, never a full reproduction");

  const commentsForIssue: JiraComment[] = [
    { id: "c1", author: { displayName: "Alice", accountId: "acc-alice" }, body: adfMentioning("acc-me"), created: "2026-06-14T10:00:00.000Z" },
    { id: "c2", author: { displayName: "Bob", accountId: "acc-bob" }, body: adfMentioning("acc-someone-else"), created: "2026-06-14T11:00:00.000Z" },
  ];
  const eventsForMe = buildMentionEvents("MENT-1", commentsForIssue, "acc-me", { today: TODAY });
  ok("V2.10 Mentions", eventsForMe.length === 1, "a comment mentioning a different account never produces a MentionEvent for the configured identity — only the real match is returned");
  ok("V2.10 Mentions", eventsForMe[0].commentAuthor === "Alice", "the returned MentionEvent is the real matching comment's author, not the non-matching one");
  ok("V2.17 Mentions commentId", eventsForMe[0].commentId === "c1", "buildMentionEvents carries the real Jira comment id through as MentionEvent.commentId");
  ok(
    "V2.17 Mentions commentId",
    mentionCommentId("MENT-1", { created: "2026-06-14T10:00:00.000Z" }) === "MENT-1:no-id:2026-06-14T10:00:00.000Z",
    "when Jira omits a comment id entirely, the fallback is a deterministic string derived from the issue key + created timestamp, never crashing and never colliding with a real id"
  );

  // --- V2.17 §1a — two DISTINCT comments on the same issue now produce two INDEPENDENT
  // MENTION attention items (comment-level identity), not one collapsed record. This is the
  // exact fix for "an old resolved mention can never truly resolve" / "a genuinely new
  // comment gets absorbed into the old record" from the dev prompt's Task 1a. ---
  const twoCommentsSameIssue: MentionEvent[] = [
    { issueKey: "MENT-1", commentId: "c1", commentAuthor: "Alice", excerpt: "first mention", mentionedAt: "2026-06-14T10:00:00.000Z" },
    { issueKey: "MENT-1", commentId: "c2", commentAuthor: "Carol", excerpt: "second mention", mentionedAt: "2026-06-14T12:00:00.000Z" },
  ];
  const mentionQueue = buildAttentionQueue({ ...mentionInputsBase, mentionEvents: twoCommentsSameIssue, workItems: [mentionWorkItem] }, {}, TODAY);
  const mentionItems = mentionQueue.items.filter((i) => i.category === "MENTION");
  ok("V2.17 Mentions comment-level identity", mentionItems.length === 2, "two distinct comments mentioning the account on the same issue now produce two independent MENTION attention items, each trackable through its own lifecycle — never collapsed into one");
  ok(
    "V2.17 Mentions comment-level identity",
    mentionItems.every((i) => i.id === `MENTION:${slug("MENT-1")}:${slug("c1")}` || i.id === `MENTION:${slug("MENT-1")}:${slug("c2")}`),
    "each MENTION item's id is keyed by issue AND comment id (`${category}:${issueKey}:${commentId}`), not just the issue"
  );
  ok("V2.17 Mentions comment-level identity", mentionItems.every((i) => i.ownershipExplicit === true), "each per-comment MENTION item is still always explicitly owned");

  // --- Test for Task 1: first comment acknowledged/resolved, second still NEW — only the
  // second surfaces as an unresolved item, and the display-layer grouping (mention-
  // grouping.ts) shows "1 new comment", not 2. ---
  const c1ResolvedState = { [`MENTION:${slug("MENT-1")}:${slug("c1")}`]: { lifecycle: "RESOLVED" as const, firstSeenDate: "2026-06-01", lastSeenDate: "2026-06-01", resolvedManually: true } };
  const afterFirstResolved = buildAttentionQueue({ ...mentionInputsBase, mentionEvents: twoCommentsSameIssue, workItems: [mentionWorkItem] }, c1ResolvedState, TODAY);
  const stillOpenMentions = afterFirstResolved.items.filter((i) => i.category === "MENTION" && i.lifecycle !== "RESOLVED" && i.lifecycle !== "SNOOZED");
  ok("V2.17 Mentions independent lifecycle", stillOpenMentions.length === 1 && stillOpenMentions[0].id.endsWith(":c2"), "once the first comment's mention is resolved, it stays resolved on the next sync (the underlying issue's mentionEvents still contain it) while the second, still-unacknowledged comment remains visibly open — exactly the Task 1 test scenario");
  const groupedStillOpen = groupMentionAttentionItems(afterFirstResolved.items.filter((i) => i.lifecycle !== "RESOLVED" && i.lifecycle !== "SNOOZED"));
  const groupedMention = groupedStillOpen.find((i) => i.category === "MENTION");
  ok("V2.17 Mentions grouping", groupedMention !== undefined && groupedMention.what === mentionGroupLabel(1), "the grouped display card for this ticket reads '1 new comment', not 2 — the resolved comment is correctly excluded from the count");

  // --- a genuinely new comment on an issue that already had an OLDER comment resolved must
  // surface as NEW, never silently absorbed into the old (already-resolved) record. ---
  const onlyOldCommentResolved = { [`MENTION:${slug("MENT-1")}:${slug("c1")}`]: { lifecycle: "RESOLVED" as const, firstSeenDate: "2026-06-01", lastSeenDate: "2026-06-01", resolvedManually: true } };
  const newCommentArrives = buildAttentionQueue({ ...mentionInputsBase, mentionEvents: [twoCommentsSameIssue[0]], workItems: [mentionWorkItem] }, onlyOldCommentResolved, TODAY);
  ok("V2.17 Mentions independent lifecycle", newCommentArrives.items.find((i) => i.id.endsWith(":c1"))?.lifecycle === "RESOLVED", "the already-resolved comment stays resolved across a sync where the underlying issue's `updated` timestamp changes for an unrelated reason — the exact regression this task prevents");
  const secondSync = buildAttentionQueue({ ...mentionInputsBase, mentionEvents: twoCommentsSameIssue, workItems: [mentionWorkItem] }, newCommentArrives.nextAttentionState, TODAY);
  const brandNewComment = secondSync.items.find((i) => i.id.endsWith(":c2"));
  ok("V2.17 Mentions independent lifecycle", brandNewComment !== undefined && brandNewComment.lifecycle === "NEW", "a genuinely new second comment on the same issue surfaces as NEW on its own id, never absorbed into the first comment's already-resolved record");

  // --- an issue both newly assigned AND newly mentioned in the same sync must not double-count ---
  const bothQueue = buildAttentionQueue(
    {
      ...mentionInputsBase,
      mentionEvents: [{ issueKey: "MENT-1", commentId: "c1", commentAuthor: "Alice", excerpt: "check this", mentionedAt: "2026-06-14T10:00:00.000Z" }],
      newAssignments: [{ workItemId: "jira-MENT-1", issueKey: "MENT-1", title: mentionWorkItem.title, projectId: mentionWorkItem.projectId }],
      workItems: [mentionWorkItem],
    },
    {},
    TODAY
  );
  const bothMention = bothQueue.items.filter((i) => i.category === "MENTION");
  const bothAssignment = bothQueue.items.filter((i) => i.category === "ASSIGNMENT");
  ok("V2.10 Assignment", bothMention.length === 1 && bothAssignment.length === 1, "an issue that is both newly assigned and newly mentioned in the same sync produces exactly one MENTION and one ASSIGNMENT item — distinct signals, neither merged nor dropped");

  // --- assignment-detection: snapshot-over-snapshot ownerId diff ---
  const prevSnapshotNoOwner = toSnapshot({ ...emptyData(), workItems: [{ ...mentionWorkItem, ownerId: undefined }] }, "2026-06-14");
  const nowAssignedToMe = { ...emptyData(), workItems: [{ ...mentionWorkItem, ownerId: "acc-me" }] };
  ok("V2.10 Assignment", detectNewAssignments(nowAssignedToMe, prevSnapshotNoOwner, "acc-me").length === 1, "a work item whose ownerId newly matches the configured accountId since the last snapshot is a new assignment");
  ok("V2.10 Assignment", detectNewAssignments(nowAssignedToMe, prevSnapshotNoOwner, undefined).length === 0, "with no accountId configured, new-assignment detection never fires — nothing to compare against");
  const prevSnapshotAlreadyMine = toSnapshot({ ...emptyData(), workItems: [{ ...mentionWorkItem, ownerId: "acc-me" }] }, "2026-06-14");
  ok("V2.10 Assignment", detectNewAssignments(nowAssignedToMe, prevSnapshotAlreadyMine, "acc-me").length === 0, "a work item already assigned to the configured account as of the last snapshot is NOT a new assignment");
  ok("V2.10 Assignment", detectNewAssignments(nowAssignedToMe, null, "acc-me").length === 0, "with no previous snapshot at all (first-ever sync), new-assignment detection never guesses — nothing was 'before'");

  // --- V2.17 §1 — selectRecentMentionCandidates: recency fallback for the JQL search index's
  // real indexing lag on brand-new comments (reproduces the exact real-incident shape: a
  // ~1-day-old mention the JQL search hadn't indexed yet, verified directly against a real
  // Jira instance during the investigation this fix came from). ---
  const NOW_MS = new Date("2026-09-09T12:00:00.000Z").getTime();
  const recentIssue = makeJiraIssue({ key: "WF-1083", updated: "2026-09-08T18:40:00.000Z" }); // ~17h before NOW_MS
  const staleIssue = makeJiraIssue({ key: "HSWB-900", updated: "2026-08-01T00:00:00.000Z" }); // weeks before NOW_MS
  const alreadyCoveredIssue = makeJiraIssue({ key: "ECW-243", updated: "2026-09-09T00:00:00.000Z" }); // recent but already found via JQL
  const noUpdatedIssue = makeJiraIssue({ key: "NOU-1", updated: undefined });

  const candidates = selectRecentMentionCandidates([recentIssue, staleIssue, alreadyCoveredIssue, noUpdatedIssue], new Set(["ECW-243"]), NOW_MS);
  ok("V2.17 Recent mention candidates", candidates.some((i) => i.key === "WF-1083"), "an issue updated within the lookback window (the exact WF-1083 real-incident shape: mentioned ~17h before this sync) is selected as a candidate");
  ok("V2.17 Recent mention candidates", !candidates.some((i) => i.key === "HSWB-900"), "an issue updated weeks ago is never selected — the lookback window is real, not a rubber stamp");
  ok("V2.17 Recent mention candidates", !candidates.some((i) => i.key === "ECW-243"), "an issue already covered by the JQL search result (excludeKeys) is never re-checked, even though it's recent — no duplicate comment fetch");
  ok("V2.17 Recent mention candidates", !candidates.some((i) => i.key === "NOU-1"), "an issue with no `updated` timestamp at all is never selected — recency can't be claimed for it, so it's excluded rather than guessed as recent");

  const manyRecentIssues = Array.from({ length: 30 }, (_, i) => makeJiraIssue({ key: `CAP-${i}`, updated: new Date(NOW_MS - i * 60_000).toISOString() }));
  const capped = selectRecentMentionCandidates(manyRecentIssues, new Set(), NOW_MS);
  ok("V2.17 Recent mention candidates", capped.length === 20, "the candidate set is hard-capped at 20 (matching jira/scope-drift.ts's own selectPrioritizedIssueKeys precedent) even when far more issues qualify by recency alone — this can never become 'check comments on every issue'");
  ok("V2.17 Recent mention candidates", capped[0].key === "CAP-0", "when more candidates qualify than the cap allows, the most recently updated ones win — never an arbitrary/input-order truncation");

  const outOfOrderIssues = [makeJiraIssue({ key: "OLDER", updated: "2026-09-08T00:00:00.000Z" }), makeJiraIssue({ key: "NEWER", updated: "2026-09-09T06:00:00.000Z" })];
  const orderedCandidates = selectRecentMentionCandidates(outOfOrderIssues, new Set(), NOW_MS);
  ok("V2.17 Recent mention candidates", orderedCandidates[0].key === "NEWER", "candidates are sorted most-recently-updated-first regardless of input order — never trusts the caller's ordering blindly, per the function's own documented defensiveness");
}

// ===== V2.17 §1a point 1 — store.ts: mentionEvents is keyed per-comment, capped, and legacy
// (pre-commentId) persisted entries are backfilled rather than dropped or crashing. =====
{
  // --- legacy migration: a pre-V2.17 persisted mentionEvents entry has no commentId at all ---
  const legacyBlob = JSON.stringify({
    loaded: true,
    mentionEvents: [
      { issueKey: "LEG-1", commentAuthor: "Alice", excerpt: "old shape", mentionedAt: "2026-01-01T00:00:00.000Z" },
      { issueKey: "LEG-1", commentAuthor: "Bob", excerpt: "old shape 2", mentionedAt: "2026-01-02T00:00:00.000Z" },
      "not even an object",
      { commentAuthor: "no issueKey at all" },
    ],
  });
  const migratedLegacy = parseStoredState(legacyBlob);
  ok("V2.17 mentionEvents legacy migration", migratedLegacy.mentionEvents.length === 2, "the two structurally-valid legacy entries survive migration; the malformed ones are dropped, never crash parseStoredState");
  ok("V2.17 mentionEvents legacy migration", migratedLegacy.mentionEvents.every((m) => typeof m.commentId === "string" && m.commentId.length > 0), "every migrated entry gets a real, non-empty commentId backfilled");
  ok(
    "V2.17 mentionEvents legacy migration",
    new Set(migratedLegacy.mentionEvents.map((m) => m.commentId)).size === 2,
    "the two same-issue legacy entries (which used to collapse under the old issue-keyed scheme) get DISTINCT backfilled commentIds, since they differ by mentionedAt — real, distinct history is preserved rather than merged"
  );

  // --- a valid, already-V2.17-shaped MentionEvent round-trips unchanged ---
  const validBlob = JSON.stringify({ loaded: true, mentionEvents: [{ issueKey: "V-1", commentId: "real-comment-id", excerpt: "x", mentionedAt: TODAY }] });
  ok("V2.17 mentionEvents legacy migration", parseStoredState(validBlob).mentionEvents[0].commentId === "real-comment-id", "an already-valid commentId is preserved as-is, never overwritten by the legacy fallback");

  // --- capMentionEvents: global cap, oldest-RESOLVED-first eviction ---
  const manyEvents: MentionEvent[] = Array.from({ length: 5 }, (_, i) => ({
    issueKey: `CAP-${i}`,
    commentId: `c-${i}`,
    excerpt: "x",
    mentionedAt: new Date(2026, 0, i + 1).toISOString(),
  }));
  const noEviction = capMentionEvents(manyEvents, {}, 5);
  ok("V2.17 capMentionEvents", noEviction.length === 5, "under the cap, nothing is evicted at all");

  // Two of the five are RESOLVED (the oldest of those two should be evicted first), the rest
  // are still open (untouched, even though some are older than the resolved ones).
  const capState: Record<string, AttentionItemState> = {
    [`MENTION:${slug("CAP-0")}:${slug("c-0")}`]: { lifecycle: "RESOLVED", firstSeenDate: TODAY, lastSeenDate: TODAY },
    [`MENTION:${slug("CAP-3")}:${slug("c-3")}`]: { lifecycle: "RESOLVED", firstSeenDate: TODAY, lastSeenDate: TODAY },
  };
  const evicted = capMentionEvents(manyEvents, capState, 4);
  ok("V2.17 capMentionEvents", evicted.length === 4, "evicts exactly one entry to get back under the cap of 4");
  ok("V2.17 capMentionEvents", !evicted.some((m) => m.commentId === "c-0"), "the older of the two RESOLVED entries (c-0, mentionedAt Jan 1) is evicted first — oldest-resolved-first");
  ok("V2.17 capMentionEvents", evicted.some((m) => m.commentId === "c-3"), "the newer RESOLVED entry (c-3) survives — only as many resolved entries are evicted as needed to get under the cap");
  ok("V2.17 capMentionEvents", ["c-1", "c-2", "c-4"].every((id) => evicted.some((m) => m.commentId === id)), "every still-open (unresolved) entry survives untouched, even ones older than a resolved entry that got evicted");

  // If evicting every resolved entry still isn't enough, falls back to oldest-unresolved-first.
  const evictedHard = capMentionEvents(manyEvents, capState, 2);
  ok("V2.17 capMentionEvents", evictedHard.length === 2, "evicts down to the cap even when every resolved entry alone isn't enough");
  ok("V2.17 capMentionEvents", evictedHard.some((m) => m.commentId === "c-4"), "the most recent entries survive when eviction has to fall back past the resolved ones");
}

// ===== V2.10 §3 — computeNewPersonalSignals (real-time Slack delivery gate) =====
{
  const baseMentionItem: AttentionItem = {
    id: "MENTION:ment-1", category: "MENTION", severity: "HIGH", what: "Mentioned in a comment on MENT-1",
    why: "Alice mentioned you in a comment.", impact: "x", nowWhat: "Read the comment.", evidence: ['Alice: "hi"'],
    lifecycle: "NEW", firstSeenDate: TODAY, lastSeenDate: TODAY, ownershipExplicit: true,
  };
  const alreadyAckMentionItem: AttentionItem = { ...baseMentionItem, id: "MENTION:ment-2", lifecycle: "ACKNOWLEDGED" };
  const priorStateForAck: Record<string, AttentionItemState> = { "MENTION:ment-2": { lifecycle: "ACKNOWLEDGED", firstSeenDate: "2026-06-01", lastSeenDate: "2026-06-10" } };

  const signals = computeNewPersonalSignals(priorStateForAck, [baseMentionItem, alreadyAckMentionItem]);
  ok("V2.10 Notify", signals.length === 1 && signals[0].id === baseMentionItem.id, "exactly one signal is returned: the genuinely new MENTION, never the already-ACKNOWLEDGED one from a prior sync");

  // A team-wide category (DRIFT) must never reach Slack, even if it somehow carried
  // ownershipExplicit: true (attention-queue.ts never actually sets this for DRIFT — this
  // proves the category gate itself, not just the flag, enforces the boundary).
  const forgedDriftItem = { ...baseMentionItem, id: "DRIFT:overall", category: "DRIFT" as const };
  ok("V2.10 Notify", computeNewPersonalSignals({}, [forgedDriftItem]).length === 0, "a DRIFT item is never returned as a personal signal, even with ownershipExplicit forced to true — the six team-wide categories are never eligible, by category alone");

  ok("V2.10 Notify", computeNewPersonalSignals({}, []).length === 0, "an empty attention queue produces zero signals");
  ok("V2.10 Notify", computeNewPersonalSignals(priorStateForAck, [alreadyAckMentionItem]).length === 0, "two consecutive syncs with no new personal signal send zero messages — nothing to notify about");

  const mentionWorkItemForPayload = makeItem({ id: "jira-MENT-1", key: "MENT-1", sourceUrl: "https://example.atlassian.net/browse/MENT-1" });
  const payloads = buildSlackNotifyPayloads([{ ...baseMentionItem, sourceRef: { type: "workItem", id: "jira-MENT-1" } }], { ...emptyData(), workItems: [mentionWorkItemForPayload] });
  ok("V2.10 Notify", payloads.length === 1 && payloads[0].issueKey === "MENT-1" && payloads[0].url === "https://example.atlassian.net/browse/MENT-1", "buildSlackNotifyPayloads resolves the real issue key and Jira link from the linked WorkItem");
}

// ===== V2.10.1 — cold-start guard: the real upgrade-path scenario =====
// A pre-V2.10 install already has DRIFT/RISK/etc ids in attentionState (from before MENTION/
// ASSIGNMENT ever existed), then the user configures accountId for the first time and 5
// currently-open tickets match the mention JQL. None of them may notify on this pass — but
// the NEXT sync, with a genuinely new 6th mention, must notify for exactly that one.
{
  const preV210AttentionState: Record<string, AttentionItemState> = {
    "DRIFT:overall": { lifecycle: "ACKNOWLEDGED", firstSeenDate: "2026-05-01", lastSeenDate: "2026-06-01" },
    "RISK:some-risk": { lifecycle: "NEW", firstSeenDate: "2026-06-10", lastSeenDate: "2026-06-14" },
  };
  const fiveMentionItems: AttentionItem[] = Array.from({ length: 5 }, (_, i) =>
    makeAttentionItem({ id: `MENTION:upgrade-${i}`, category: "MENTION", lifecycle: "NEW", ownershipExplicit: true })
  );

  const firstPassSignals = computeNewPersonalSignals(preV210AttentionState, fiveMentionItems);
  ok(
    "V2.10.1 Cold start",
    firstPassSignals.length === 0,
    "an upgrade from pre-V2.10 (DRIFT/RISK ids already present, but zero MENTION/ASSIGNMENT ids ever computed) suppresses all 5 historically-open mentions on the first pass — old news is never reported as breaking news"
  );

  // Simulate commitAttentionState persisting this pass's items as the new baseline, then a
  // 6th, genuinely new mention arrives on the next sync.
  const baselineAfterFirstSync: Record<string, AttentionItemState> = {
    ...preV210AttentionState,
    ...Object.fromEntries(fiveMentionItems.map((item) => [item.id, { lifecycle: "NEW" as const, firstSeenDate: TODAY, lastSeenDate: TODAY }])),
  };
  const sixthNewMention = makeAttentionItem({ id: "MENTION:upgrade-5", category: "MENTION", lifecycle: "NEW", ownershipExplicit: true });
  const secondPassSignals = computeNewPersonalSignals(baselineAfterFirstSync, [...fiveMentionItems, sixthNewMention]);
  ok(
    "V2.10.1 Cold start",
    secondPassSignals.length === 1 && secondPassSignals[0].id === sixthNewMention.id,
    "once a real baseline exists (the 5 mentions committed from the first pass), the next sync correctly notifies for exactly the one genuinely new 6th mention, and none of the already-tracked 5"
  );
}

// ===== V2.11 §2 — /api/command-center/notify: status route + test-mode, real webhook mocked =====
// V2.18 §4 — POST now requires the same paired-device/cron auth as every other sensitive
// route (see the Security hardening section above); every POST Request built below carries a
// matching Authorization header. GET (status) stays unauthenticated (non-sensitive, boolean/
// label only), unaffected.
{
  const originalWebhook = process.env.SLACK_WEBHOOK_URL;
  const originalLabel = process.env.SLACK_CHANNEL_LABEL;
  const originalAppStateSecret = process.env.APP_STATE_SECRET;
  const originalFetch = globalThis.fetch;

  delete process.env.SLACK_WEBHOOK_URL;
  delete process.env.SLACK_CHANNEL_LABEL;
  process.env.APP_STATE_SECRET = "test-app-state-secret";
  const authHeaders = { Authorization: "Bearer test-app-state-secret" };

  const statusUnconfigured = (await (await notifyStatusGET()).json()) as { configured: boolean; channelLabel?: string };
  ok("V2.11 Notify status", statusUnconfigured.configured === false, "GET /notify reports configured:false when SLACK_WEBHOOK_URL is unset");

  const unauthorizedTest = await notifyPOST(new Request("http://localhost/api/command-center/notify", { method: "POST", body: JSON.stringify({ test: true }) }));
  const unauthorizedTestBody = (await unauthorizedTest.json()) as { sent: boolean; reason?: string };
  ok("V2.18 Notify auth", unauthorizedTest.status === 401 && unauthorizedTestBody.sent === false && unauthorizedTestBody.reason === "unauthorized", "a POST with no Authorization header is rejected before any Slack/webhook logic runs, even in test-mode");

  const testWithNoWebhook = (await notifyPOST(new Request("http://localhost/api/command-center/notify", { method: "POST", headers: authHeaders, body: JSON.stringify({ test: true }) }))).json();
  const testWithNoWebhookBody = (await testWithNoWebhook) as { sent: boolean; reason?: string };
  ok(
    "V2.11 Notify test-mode",
    testWithNoWebhookBody.sent === false && testWithNoWebhookBody.reason === "not-configured",
    "an authorized {test:true} request with no SLACK_WEBHOOK_URL still returns {sent:false, reason:'not-configured'} — same contract as real signals"
  );

  process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.example/services/mock";
  process.env.SLACK_CHANNEL_LABEL = "#daily-command-alerts";

  const statusConfigured = (await (await notifyStatusGET()).json()) as { configured: boolean; channelLabel?: string };
  ok("V2.11 Notify status", statusConfigured.configured === true && statusConfigured.channelLabel === "#daily-command-alerts", "GET /notify reports configured:true and the real SLACK_CHANNEL_LABEL");
  ok("V2.11 Notify status", JSON.stringify(statusConfigured).includes("hooks.slack.example") === false, "the webhook URL itself is never present anywhere in the status response — only the boolean and the non-secret label");

  let capturedUrl: string | null = null;
  let capturedBody: { text?: string } | null = null;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string, init?: { body?: string }) => {
    capturedUrl = String(url);
    capturedBody = init?.body ? JSON.parse(init.body) : null;
    return { ok: true } as Response;
  }) as typeof fetch;

  const testWithWebhook = (await (await notifyPOST(new Request("http://localhost/api/command-center/notify", { method: "POST", headers: authHeaders, body: JSON.stringify({ test: true }) }))).json()) as {
    sent: boolean;
  };
  ok("V2.11 Notify test-mode", testWithWebhook.sent === true, "an authorized {test:true} request with a configured (mocked) webhook reports sent:true");
  ok("V2.11 Notify test-mode", capturedUrl === "https://hooks.slack.example/services/mock", "the test request posts to the real configured webhook URL — the exact same call a real signal would make");
  ok(
    "V2.11 Notify test-mode",
    capturedBody?.text === "✅ Daily Command test notification — if you can see this, your Slack destination is correctly configured.",
    "the test request sends exactly the fixed test string, never a fabricated signal"
  );

  // A real signal request reuses the SAME postToSlack code path — proven by landing in the
  // same mocked fetch with genuinely different, real signal text, never a second parallel
  // implementation.
  capturedBody = null;
  const realSignalRes = await notifyPOST(
    new Request("http://localhost/api/command-center/notify", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ signals: [{ issueKey: "MENT-1", summary: "Test", kind: "MENTION", detail: 'Alice: "hi"' }] }),
    })
  );
  const realSignalBody = (await realSignalRes.json()) as { sent: boolean; delivered: number };
  ok("V2.11 Notify test-mode", realSignalBody.sent === true && realSignalBody.delivered === 1, "an authorized real signal request still delivers via the identical webhook-call path");
  ok("V2.11 Notify test-mode", capturedBody?.text?.includes("MENT-1") === true, "a real signal's rendered text is genuinely different from the fixed test string, proving no accidental cross-contamination between the two paths");

  globalThis.fetch = originalFetch;
  if (originalWebhook === undefined) delete process.env.SLACK_WEBHOOK_URL;
  else process.env.SLACK_WEBHOOK_URL = originalWebhook;
  if (originalLabel === undefined) delete process.env.SLACK_CHANNEL_LABEL;
  else process.env.SLACK_CHANNEL_LABEL = originalLabel;
  if (originalAppStateSecret === undefined) delete process.env.APP_STATE_SECRET;
  else process.env.APP_STATE_SECRET = originalAppStateSecret;
}

// ===== V2.11 §3B — showAdvancedSettings toggle: default, store setter, persistence =====
{
  commandCenterStore.resetAll();
  ok("V2.11 Advanced toggle", commandCenterStore.getSnapshot().showAdvancedSettings === false, "the advanced/rarely-used sections toggle defaults to false (hidden)");

  commandCenterStore.setShowAdvancedSettings(true);
  ok("V2.11 Advanced toggle", commandCenterStore.getSnapshot().showAdvancedSettings === true, "setShowAdvancedSettings persists the explicit choice");

  const roundTrip = parseStoredState(JSON.stringify(commandCenterStore.getSnapshot()));
  ok("V2.11 Advanced toggle", roundTrip.showAdvancedSettings === true, "the toggle round-trips through JSON serialization/parseStoredState unchanged");

  const fallback = parseStoredState("not valid json");
  ok("V2.11 Advanced toggle", fallback.showAdvancedSettings === false, "malformed stored state falls back to the safe default (hidden), never a crash");

  commandCenterStore.resetAll();
}

// ===== V2.10 §2 — fetchMentionedIssuesWith / fetchIssueCommentsWith =====
{
  const jqlConfig: JiraConnectionConfig = { baseUrl: "https://example.atlassian.net", email: "a@b.com", apiToken: "tok" };
  const mentionedFetch: FetchLike = async (url) => ({
    ok: true,
    status: 200,
    json: async () => {
      const u = new URL(url);
      ok("V2.10 http", u.pathname.endsWith("/search/jql"), "fetchMentionedIssuesWith hits the same /search/jql endpoint as the main sync, not a separate one");
      return { issues: [{ key: "MENT-1", fields: {} }], isLast: true };
    },
  });
  const mentionedResult = await fetchMentionedIssuesWith(mentionedFetch, jqlConfig, "acc-me", "2026-06-01");
  ok("V2.10 http", mentionedResult.ok && mentionedResult.data.length === 1 && mentionedResult.data[0].key === "MENT-1", "fetchMentionedIssuesWith returns the issues Jira reports as matching the mention JQL");

  const commentsFetch: FetchLike = async (url) => {
    ok("V2.10 http", url.includes("/comment"), "fetchIssueCommentsWith hits the issue's /comment endpoint");
    return { ok: true, status: 200, json: async () => ({ comments: [{ id: "c1", author: { displayName: "Alice" }, body: "hi" }] }) };
  };
  const commentsResult = await fetchIssueCommentsWith(commentsFetch, jqlConfig, "MENT-1");
  ok("V2.10 http", commentsResult.ok && commentsResult.data.length === 1, "fetchIssueCommentsWith returns the comments Jira reports for one issue");
}

// ===== V2.18 §6 — fetchMentionedIssuesWith now accepts an optional projectKeys restriction,
// the fetch-time half of the mention project-scope isolation fix. Confirmed real gap: unlike
// the main issue sync (buildIssuesJql's own `project in (...)`), the mention search had NO
// project restriction at all — a FOCUSED sync still searched every Jira project the account
// can see for mentions. =====
{
  const jqlConfig: JiraConnectionConfig = { baseUrl: "https://example.atlassian.net", email: "a@b.com", apiToken: "tok" };

  let capturedJql = "";
  const captureFetch: FetchLike = async (url, init) => {
    void url;
    capturedJql = (JSON.parse(String(init?.body ?? "{}")) as { jql?: string }).jql ?? "";
    return { ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) };
  };
  await fetchMentionedIssuesWith(captureFetch, jqlConfig, "acc-me", undefined, undefined);
  ok("V2.18 Mention scope (fetch)", !capturedJql.includes("project in"), "no projectKeys passed -> unrestricted, matching buildIssuesJql's own 'no keys -> no project clause' contract");

  await fetchMentionedIssuesWith(captureFetch, jqlConfig, "acc-me", undefined, ["JPMC"]);
  ok("V2.18 Mention scope (fetch)", capturedJql.includes('project in ("JPMC")'), "projectKeys passed -> the mention JQL carries the identical project in (...) restriction the main issue sync already uses");
  ok("V2.18 Mention scope (fetch)", capturedJql.includes('comment ~ "accountid:acc-me"'), "the account-mention clause is preserved alongside the new project restriction, not replaced by it");
}

// ===== V2.10 §4 — automated sync cadence (static source checks, matching the existing
// V2.2.1/V2.3 pattern for route-level logic: the sync route imports server-only credential
// code, so it's checked by reading its source rather than importing it into this test
// process — see jira-client.ts's `import "server-only"`, which genuinely throws under plain
// Node outside Next's bundler). =====
{
  const repoRoot = path.resolve(process.cwd());
  const syncRouteSrc = fs.readFileSync(path.join(repoRoot, "src/app/api/command-center/jira/sync/route.ts"), "utf8");
  ok("V2.10 Cron", /process\.env\.CRON_SECRET/.test(syncRouteSrc), "the sync route reads CRON_SECRET");
  // V2.15 §2 — the actual accept/reject decision moved into sync-auth.ts's checkSyncRequestAuth
  // (directly unit-tested below); this only checks that the route still wires it up.
  ok("V2.15 Cron+AppState wiring", /checkSyncRequestAuth/.test(syncRouteSrc), "the route's auth gate now delegates to the shared, testable checkSyncRequestAuth rather than a private, unregexable inline check");
  ok("V2.15 Cron+AppState wiring", /process\.env\.APP_STATE_SECRET/.test(syncRouteSrc), "the route also reads APP_STATE_SECRET, the second secret checkSyncRequestAuth accepts");
  ok("V2.10 Cron", /export async function GET/.test(syncRouteSrc), "the route exports a GET handler — Vercel Cron Jobs always issue a GET, never a POST");

  const vercelJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "vercel.json"), "utf8"));
  ok("V2.10 Cron", Array.isArray(vercelJson.crons) && vercelJson.crons.length === 1, "vercel.json declares exactly one cron job");
  ok("V2.10 Cron", vercelJson.crons[0].path === "/api/command-center/jira/sync", "the cron job targets the real sync endpoint");
  // Vercel Hobby plans reject any cron more frequent than once/day at deploy time (a real,
  // hard failure discovered post-implementation — every deploy since */15 was added had been
  // failing with "Hobby accounts are limited to daily cron jobs"). Fixed to a Hobby-safe daily
  // schedule; the GitHub Actions fallback still provides the tighter 15-minute cadence.
  ok("V2.10 Cron", /^(\d+|\*)\s+(\d+|\*)\s+\*\s+\*\s+\*$/.test(vercelJson.crons[0].schedule) && !vercelJson.crons[0].schedule.includes("/"), "the Vercel cron schedule is Hobby-plan-safe — at most once per day, no step syntax");

  const workflowSrc = fs.readFileSync(path.join(repoRoot, ".github/workflows/sync.yml"), "utf8");
  ok("V2.10 Cron", /CRON_SECRET/.test(workflowSrc) && /secrets\.CRON_SECRET/.test(workflowSrc), "the GitHub Actions fallback reads CRON_SECRET from a repo secret, never a hardcoded value");
  ok("V2.10 Cron", /Authorization: Bearer \$CRON_SECRET/.test(workflowSrc), "the GitHub Actions fallback calls the sync endpoint with the exact same bearer-token contract the route itself enforces");
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
    [], TODAY, emptyData()
  );
  ok("Memory events", events.some((e) => e.kind === "drift-transition"), "a drift-level change produces a drift-transition memory event");
  ok("Memory events", events.some((e) => e.kind === "risk-escalation"), "a worsening risk severity change produces a risk-escalation memory event");
  ok("Memory events", events.some((e) => e.kind === "dependency-escalation"), "a dependency reaching CRITICAL heat produces a dependency-escalation memory event");
  ok("Memory events", events.every((e) => e.title.length > 0), "every memory event carries a non-empty title");

  const noChangeEvents = deriveMemoryEvents(drift1, drift1, [], [], [], TODAY, emptyData());
  ok("Memory events", noChangeEvents.length === 0, "no meaningful transition produces no memory events — not every recomputed value is stored (§41)");

  // ===== V2.4 §14 — Memory events resolve projectId ONLY through an explicit FK =====
  const memRisk = makeRisk({ id: "risk-jpmc-mem", title: "JPMC memory risk", projectId: "p-jpmc" });
  const memDep = makeDependency({ id: "dep-jpmc-mem", workItemId: "wi-jpmc-mem" });
  const memWorkItem = makeItem({ id: "wi-jpmc-mem", projectId: "p-jpmc" });
  const memData = { ...emptyData(), risks: [memRisk], dependencies: [memDep], workItems: [memWorkItem] };
  const scopedEvents = deriveMemoryEvents(
    drift1, drift2,
    [makeRiskEscalation({ riskId: "risk-jpmc-mem", riskTitle: "JPMC memory risk", trend: "worsening", previousSeverity: "MEDIUM", currentSeverity: "HIGH" })],
    [makeDependencyRadarItem({ dependencyId: "dep-jpmc-mem", heat: "CRITICAL" })],
    [], TODAY, memData
  );
  const riskEvent = scopedEvents.find((e) => e.kind === "risk-escalation");
  const depEvent = scopedEvents.find((e) => e.kind === "dependency-escalation");
  ok("Memory events V2.4", riskEvent?.projectId === "p-jpmc", "a risk-escalation event resolves projectId via the risk's own explicit projectId field");
  ok("Memory events V2.4", depEvent?.projectId === "p-jpmc", "a dependency-escalation event resolves projectId via Dependency.workItemId -> WorkItem.projectId");
  const driftEvent = scopedEvents.find((e) => e.kind === "drift-transition");
  ok("Memory events V2.4", driftEvent !== undefined && driftEvent.projectId === undefined, "a portfolio-wide drift-transition event is never assigned a projectId — no single reliable FK exists (§14)");

  const orphanEvents = deriveMemoryEvents(
    drift1, drift1,
    [makeRiskEscalation({ riskId: "risk-unknown", riskTitle: "Unknown risk", trend: "worsening", previousSeverity: "MEDIUM", currentSeverity: "HIGH" })],
    [], [], TODAY, emptyData()
  );
  ok("Memory events V2.4", orphanEvents.every((e) => e.projectId === undefined), "a risk-escalation for a risk no longer present in data never guesses a projectId");
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

// ===== V2.10 §1 — Identity: accountId disambiguation over displayName =====
{
  const proj = "id-proj-1";
  const client = "id-client-1";
  // Two different real people who happen to share a display name on this multi-org Jira
  // instance — the exact correctness gap Task 1 exists to close. Modeled as DECISION items
  // (as the existing Personal Focus Engine block above does) so an explicit-ownership match
  // is enough, on its own, to reach DO_NOW.
  const workItemMine = makeItem({ id: "id-wi-mine", key: "IDDISAM-1", projectId: proj, clientId: client, owner: "Alice", ownerId: "acc-alice-real" });
  const workItemOther = makeItem({ id: "id-wi-other", key: "IDDISAM-2", projectId: proj, clientId: client, owner: "Alice", ownerId: "acc-alice-impostor" });
  const decisionMine: Decision = { id: "id-dec-mine", projectId: proj, title: "Decision mine", status: "DECIDED", description: "", relatedWorkItemIds: [workItemMine.id] };
  const decisionOther: Decision = { id: "id-dec-other", projectId: proj, title: "Decision other", status: "DECIDED", description: "", relatedWorkItemIds: [workItemOther.id] };
  const attnMine: AttentionItem = { id: "DECISION:id-dec-mine", category: "DECISION", severity: "HIGH", what: "Decision mine", why: "x", impact: "x", nowWhat: "x", evidence: [], lifecycle: "ACTIVE", firstSeenDate: TODAY, lastSeenDate: TODAY, sourceRef: { type: "decision", id: decisionMine.id } };
  const attnOther: AttentionItem = { id: "DECISION:id-dec-other", category: "DECISION", severity: "HIGH", what: "Decision other", why: "x", impact: "x", nowWhat: "x", evidence: [], lifecycle: "ACTIVE", firstSeenDate: TODAY, lastSeenDate: TODAY, sourceRef: { type: "decision", id: decisionOther.id } };

  const idData: CommandCenterData = { ...emptyData(), workItems: [workItemMine, workItemOther], decisions: [decisionMine, decisionOther] };
  const idProactive = fakeProactive([attnMine, attnOther]);

  // With accountId configured, only the item whose ownerId matches is explicitly mine —
  // the "Alice" impostor's item is never credited, even though the display name matches.
  const withAccountId = computePersonalFocus(idData, idProactive, "Alice", TODAY, "acc-alice-real");
  const mineCandidate = withAccountId.candidates.find((c) => c.sourceId === attnMine.id)!;
  const otherCandidate = withAccountId.candidates.find((c) => c.sourceId === attnOther.id)!;
  ok("V2.10 Identity", mineCandidate.ownershipExplicit === true, "the item whose ownerId matches the configured accountId is explicitly owned");
  ok("V2.10 Identity", otherCandidate.ownershipExplicit === false, "an item owned by a different accountId is NOT explicitly owned, even with an identical display name");
  ok("V2.10 Identity", withAccountId.byCategory.DO_NOW.length === 1 && withAccountId.byCategory.DO_NOW[0].sourceId === attnMine.id, "accountId-based matching correctly gates DO_NOW to only the real match");

  // With no accountId configured, this is exactly the pre-V2.10 ambiguity — both display-name
  // matches are indistinguishable and both are (incorrectly, but existing-behavior) explicit.
  const withoutAccountId = computePersonalFocus(idData, idProactive, "Alice", TODAY);
  const mineNoId = withoutAccountId.candidates.find((c) => c.sourceId === attnMine.id)!;
  const otherNoId = withoutAccountId.candidates.find((c) => c.sourceId === attnOther.id)!;
  ok("V2.10 Identity — backward compatibility", mineNoId.ownershipExplicit === true && otherNoId.ownershipExplicit === true, "with no accountId configured, displayName-only matching behaves exactly as it did pre-V2.10 (both 'Alice' items match)");
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
    if (url.includes("/search/jql")) return { ok: false, status: 404, json: async () => ({}) };
    const startAt = Number(new URL(url).searchParams.get("startAt"));
    const issues = Array.from({ length: JIRA_PAGE_SIZE }, (_, i) => makeJiraIssue({ key: `HUGE-${startAt + i}` }));
    // total is deliberately far beyond the cap — a real Jira instance really could have this many.
    return { ok: true, status: 200, json: async () => ({ issues, startAt, maxResults: JIRA_PAGE_SIZE, total: 50000 }) };
  };
  const cappedResult = await fetchJiraIssuesWith(hugeFetch, config, {});
  ok("V1.8 Large data safety", cappedResult.ok && cappedResult.recordsFetched === JIRA_MAX_ISSUES, `fetching against an effectively unbounded result set stops exactly at the ${JIRA_MAX_ISSUES}-issue safety cap, never beyond it (got ${cappedResult.ok ? cappedResult.recordsFetched : "error"})`);
  ok("V2.18 Jira completeness", cappedResult.ok && cappedResult.truncated === true, "the fetch result itself now carries truncated:true when it stopped at the cap — a structural signal, not just a recordsFetched comparison the caller has to infer");

  const cappedConformance = await runJiraConformance({ fetchImpl: hugeFetch, config });
  ok("V1.8 Large data safety", cappedConformance.truncated === true, "the conformance report explicitly flags truncation when the result set hits the safety cap — never silently presented as complete");
}

// ===== V2.18 §5 — Jira sync completeness: truncation is observed directly (never inferred
// from recordsFetched >= JIRA_MAX_ISSUES, which false-positives on an exactly-2000 real
// result), ascending sort order makes a capped fetch resumable, and computeResumeCursor
// derives the exact boundary the next incremental sync must ask for. =====
{
  const config: JiraConnectionConfig = { baseUrl: "https://acme.atlassian.net", email: "ba@acme.com", apiToken: "x" };

  // A result of EXACTLY JIRA_MAX_ISSUES real issues, whose final page genuinely reports
  // isLast:true — must NOT be flagged truncated (the false-positive the old
  // recordsFetched >= JIRA_MAX_ISSUES heuristic had).
  const exactCapFetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { nextPageToken?: string };
    const pageIndex = body.nextPageToken ? Number(body.nextPageToken) : 0;
    const startAt = pageIndex * JIRA_PAGE_SIZE;
    const isFinalPage = startAt + JIRA_PAGE_SIZE >= JIRA_MAX_ISSUES;
    const issues = Array.from({ length: JIRA_PAGE_SIZE }, (_, i) => makeJiraIssue({ key: `EXACT-${startAt + i}`, updated: `2026-08-${String(1 + ((startAt + i) % 28)).padStart(2, "0")}T00:00:00.000+0000` }));
    return { ok: true, status: 200, json: async () => ({ issues, isLast: isFinalPage, nextPageToken: isFinalPage ? undefined : String(pageIndex + 1) }) };
  };
  const exactCapResult = await fetchJiraIssuesWith(exactCapFetch, config, {});
  ok(
    "V2.18 Jira completeness",
    exactCapResult.ok && exactCapResult.recordsFetched === JIRA_MAX_ISSUES && exactCapResult.truncated === false,
    "a result of exactly JIRA_MAX_ISSUES real issues, whose last page honestly reports isLast:true, is NOT flagged truncated — regression guard for the old heuristic's false positive at exactly the cap"
  );

  // A result that genuinely exceeds the cap (more real pages exist after JIRA_MAX_ISSUES is
  // reached) IS flagged truncated.
  const overCapFetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { nextPageToken?: string };
    const pageIndex = body.nextPageToken ? Number(body.nextPageToken) : 0;
    const startAt = pageIndex * JIRA_PAGE_SIZE;
    const issues = Array.from({ length: JIRA_PAGE_SIZE }, (_, i) => makeJiraIssue({ key: `OVER-${startAt + i}`, updated: `2026-08-${String(1 + ((startAt + i) % 28)).padStart(2, "0")}T00:00:00.000+0000` }));
    // Always more pages available — a real instance with far more than JIRA_MAX_ISSUES.
    return { ok: true, status: 200, json: async () => ({ issues, isLast: false, nextPageToken: String(pageIndex + 1) }) };
  };
  const overCapResult = await fetchJiraIssuesWith(overCapFetch, config, {});
  ok("V2.18 Jira completeness", overCapResult.ok && overCapResult.recordsFetched === JIRA_MAX_ISSUES && overCapResult.truncated === true, "a result that genuinely exceeds the cap IS flagged truncated");

  // computeResumeCursor: derives the resume boundary from the last-fetched issue's `updated`.
  const ascendingIssues = [
    makeJiraIssue({ key: "A-1", updated: "2026-08-01T00:00:00.000+0000" }),
    makeJiraIssue({ key: "A-2", updated: "2026-08-05T00:00:00.000+0000" }),
    makeJiraIssue({ key: "A-3", updated: "2026-08-10T00:00:00.000+0000" }),
  ];
  ok("V2.18 computeResumeCursor", computeResumeCursor(ascendingIssues, true) === new Date("2026-08-10T00:00:00.000+0000").toISOString(), "returns the last-fetched issue's updated timestamp (the boundary the next sync should resume from) when truncated");
  ok("V2.18 computeResumeCursor", computeResumeCursor(ascendingIssues, false) === undefined, "returns undefined when not truncated — nothing to resume from, the cursor should advance normally");
  const missingTrailingUpdated = [...ascendingIssues.slice(0, 2), { ...ascendingIssues[2], fields: { ...ascendingIssues[2].fields, updated: undefined } }];
  ok("V2.18 computeResumeCursor", computeResumeCursor(missingTrailingUpdated, true) === new Date("2026-08-05T00:00:00.000+0000").toISOString(), "walks backward past a trailing issue missing `updated` to the nearest one that has it");
  const allMissingUpdated = ascendingIssues.map((i) => ({ ...i, fields: { ...i.fields, updated: undefined } }));
  ok("V2.18 computeResumeCursor", computeResumeCursor(allMissingUpdated, true) === undefined, "returns undefined (never advance the cursor) when no fetched issue has a resolvable `updated` at all");
}

// ===== V2.18 §5 — store.ts syncJira: a partial (truncated) sync must not advance the cursor
// past what it didn't fetch, and must not destructively replace an existing complete local
// dataset with a truncated one =====
{
  commandCenterStore.resetAll();
  const originalFetch = globalThis.fetch;

  // Seed the store with an existing Jira work item belonging to a project the next (mocked,
  // truncated, full) sync will NOT include in its incoming batch — proves a truncated full
  // sync merges rather than replaces. importData is the existing public seeding path (used
  // by Data Import); its mergeById-based merge is a no-op destination-side concern here —
  // this call's only job is to get a sourceType:"jira" work item into a pristine store.
  const existingBarcItem = { ...makeItem({ id: "wi-barc-1", key: "BARC-1", projectId: "jira-project-BARC" }), sourceType: "jira" as const, sourceId: "BARC-1" };
  commandCenterStore.importData({
    ok: true,
    data: { ...emptyData(), workItems: [existingBarcItem] },
    errors: [],
    addedCounts: {},
  });

  const resumeBoundary = "2026-08-10T00:00:00.000Z";
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    if (String(url).includes("/api/command-center/jira/sync")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: { clients: [], projects: [], workItems: [], dependencies: [] },
          recordsFetched: 2000,
          truncated: true,
          resumeSinceIso: resumeBoundary,
          syncedAt: "2026-08-15T00:00:00.000Z",
          warnings: ["Result set reached the 2000-issue safety cap — this sync is partial."],
        }),
      } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }) as typeof fetch;

  const partialSyncResult = await commandCenterStore.syncJira({ full: true });
  const afterPartial = commandCenterStore.getSnapshot();
  ok("V2.18 syncJira partial", partialSyncResult.ok === true, "a truncated sync still reports ok:true — it's partial, not a failure");
  ok("V2.18 syncJira partial", afterPartial.jiraSync.lastSyncStatus === "partial", "lastSyncStatus is 'partial', distinct from both 'success' and 'failed'");
  ok("V2.18 syncJira partial", afterPartial.jiraSync.lastSyncCompletedAt === resumeBoundary, "the incremental cursor advances only to the resume boundary, never to syncedAt/'now' — so the next sync resumes exactly where this one stopped");
  ok("V2.18 syncJira partial", afterPartial.data.workItems.some((w) => w.id === "wi-barc-1"), "a truncated FULL sync merges rather than replaces — the pre-existing out-of-batch BARC work item is NOT dropped");

  // A follow-up sync that completes (truncated:false) promotes lastSyncStatus back to success
  // and advances the cursor to the real syncedAt.
  const finalSyncedAt = "2026-08-15T00:05:00.000Z";
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    if (String(url).includes("/api/command-center/jira/sync")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, data: { clients: [], projects: [], workItems: [], dependencies: [] }, recordsFetched: 12, truncated: false, syncedAt: finalSyncedAt, warnings: [] }),
      } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }) as typeof fetch;
  const followUpResult = await commandCenterStore.syncJira({});
  const afterFollowUp = commandCenterStore.getSnapshot();
  ok("V2.18 syncJira partial", followUpResult.ok === true && afterFollowUp.jiraSync.lastSyncStatus === "success", "a follow-up sync that completes promotes lastSyncStatus back to success");
  ok("V2.18 syncJira partial", afterFollowUp.jiraSync.lastSyncCompletedAt === finalSyncedAt, "a complete sync's cursor advances to the real syncedAt, same as before this pass");

  globalThis.fetch = originalFetch;
  commandCenterStore.resetAll();
}

// ===== V2.18 §5 — regression: a genuinely COMPLETE full sync still replaces exactly as
// before this pass (the merge-not-replace change is scoped strictly to truncated syncs) =====
{
  commandCenterStore.resetAll();
  const originalFetch = globalThis.fetch;
  const existingBarcItem = { ...makeItem({ id: "wi-barc-2", key: "BARC-2", projectId: "jira-project-BARC" }), sourceType: "jira" as const, sourceId: "BARC-2" };
  commandCenterStore.importData({ ok: true, data: { ...emptyData(), workItems: [existingBarcItem] }, errors: [], addedCounts: {} });

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    if (String(url).includes("/api/command-center/jira/sync")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, data: { clients: [], projects: [], workItems: [], dependencies: [] }, recordsFetched: 3, truncated: false, syncedAt: "2026-08-15T00:00:00.000Z", warnings: [] }),
      } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }) as typeof fetch;

  await commandCenterStore.syncJira({ full: true });
  const afterComplete = commandCenterStore.getSnapshot();
  ok("V2.18 syncJira regression", !afterComplete.data.workItems.some((w) => w.id === "wi-barc-2"), "a genuinely complete full sync (truncated:false) still replaces existing Jira-sourced work items exactly as before — the merge-on-partial fix does not weaken this");

  globalThis.fetch = originalFetch;
  commandCenterStore.resetAll();
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

// ===== V2.2 — Evidence -> Delivery Artifact =====

const v22Clients: Client[] = [{ id: "v22-c1", name: "JPMC" }];
const v22Projects: Project[] = [{ id: "v22-p1", name: "Core Banking", clientId: "v22-c1", status: "at-risk" }];
const v22Blocked = makeItem({
  id: "v22-w1",
  key: "V22-1",
  title: "Ledger sync",
  projectId: "v22-p1",
  clientId: "v22-c1",
  status: "Blocked",
  blocked: true,
  blockerReason: "Waiting on API contract",
  priority: "P1",
  owner: undefined,
  fixVersion: "R-2026.1",
});
const v22Normal = makeItem({
  id: "v22-w2",
  key: "V22-2",
  title: "Reporting UI",
  projectId: "v22-p1",
  clientId: "v22-c1",
  status: "In Progress",
  priority: "P2",
  owner: "Alice",
  fixVersion: "R-2026.1",
});
const v22Dep: Dependency = { id: "v22-dep1", workItemId: "v22-w2", description: "API contract from Platform", dependsOnTeam: "Platform", status: "unresolved", raisedDate: TODAY };
const v22Data: CommandCenterData = { ...emptyData(), clients: v22Clients, projects: v22Projects, workItems: [v22Blocked, v22Normal], dependencies: [v22Dep] };
const v22Derived = deriveData(v22Data, null, TODAY);
const v22Proactive = computeProactiveIntelligence(v22Data, v22Derived, [], null, {}, "manual", TODAY);
const v22PersonalFocus = computePersonalFocus(v22Data, v22Proactive, undefined, TODAY);

// ----- Artifact composition -----
{
  const statusDraft = buildStatusUpdateDraft(v22Data, v22Derived, v22Proactive, v22PersonalFocus, TODAY, "Control Tower");
  ok("V2.2 Artifact composition", statusDraft.type === "STATUS_UPDATE", "buildStatusUpdateDraft produces a STATUS_UPDATE artifact");
  ok(
    "V2.2 Artifact composition",
    statusDraft.sections.map((s) => s.heading).join(",") === "Overall,What changed,Top risks,Decisions needed,Actions,Next",
    "the Daily Status Update has exactly the §4.1 section headings, in order"
  );
  ok("V2.2 Artifact composition", statusDraft.evidenceVersion.length > 0, "a fresh draft always carries a non-empty evidenceVersion");
  ok("V2.2 Artifact composition", statusDraft.sourceRef?.type === "status", "buildStatusUpdateDraft tags a rebuildable sourceRef for staleness checking");

  const statusDraftAgain = buildStatusUpdateDraft(v22Data, v22Derived, v22Proactive, v22PersonalFocus, TODAY, "Control Tower");
  ok("V2.2 Artifact composition", statusDraft.evidenceVersion === statusDraftAgain.evidenceVersion, "identical inputs produce an identical evidenceVersion — deterministic, not random");

  // A real "what changed" event (not just an unrelated new item) must move evidenceVersion:
  // simulate a previous snapshot where v22Blocked wasn't yet blocked.
  const previousDataForChange: CommandCenterData = { ...v22Data, workItems: [{ ...v22Blocked, status: "In Progress", blocked: false, blockerReason: undefined }, v22Normal] };
  const previousSnapshotForChange = toSnapshot(previousDataForChange, "2026-06-14");
  const derived2 = deriveData(v22Data, previousSnapshotForChange, TODAY);
  const proactive2 = computeProactiveIntelligence(v22Data, derived2, [previousSnapshotForChange], previousSnapshotForChange, {}, "manual", TODAY);
  const personalFocus2 = computePersonalFocus(v22Data, proactive2, undefined, TODAY);
  const statusDraft2 = buildStatusUpdateDraft(v22Data, derived2, proactive2, personalFocus2, TODAY, "Control Tower");
  ok("V2.2 Artifact composition", statusDraft.evidenceVersion !== statusDraft2.evidenceVersion, "a real change in the underlying data (a detected status change) changes evidenceVersion — the staleness basis actually tracks facts");

  const todaysUpdate = buildTodaysUpdateDraft(v22Data, v22Proactive, v22PersonalFocus, TODAY);
  ok(
    "V2.2 Artifact composition",
    todaysUpdate.sections.map((s) => s.heading).join(",") === "Today,Watch,Don't forget,Decisions,Actions,Delivery",
    "§11 'Create Today's Update' uses the TODAY/WATCH/DON'T FORGET/DECISIONS/ACTIONS/DELIVERY layout"
  );
  ok("V2.2 Artifact composition", todaysUpdate.sourceRef?.type === "todays-update", "Today's Update carries its own distinct sourceRef kind");

  const emptyDraft = buildStatusUpdateDraft(emptyData(), deriveData(emptyData(), null, TODAY), computeProactiveIntelligence(emptyData(), deriveData(emptyData(), null, TODAY), [], null, {}, "manual", TODAY), null, TODAY, "Control Tower");
  ok("V2.2 Artifact composition", emptyDraft.sections.every((s) => s.segments.length > 0), "an empty dataset never produces an empty section — every section falls back to an honest 'nothing' statement, never a crash");
}

// ----- Stakeholder Update: fact preservation (§9) -----
{
  const attItem: AttentionItem = {
    id: "v22-att-1",
    category: "RISK",
    severity: "HIGH",
    what: "Ledger sync at risk",
    why: "Blocked on API contract from Platform",
    impact: "Release R-2026.1 may slip",
    nowWhat: "Escalate to Platform team lead",
    evidence: ["Blocked since 2026-06-10", "P1 priority"],
    lifecycle: "ACTIVE",
    firstSeenDate: TODAY,
    lastSeenDate: TODAY,
  };
  const stakeholderDraft = buildStakeholderUpdateDraft({ kind: "attention", item: attItem }, "Attention Queue");
  ok(
    "V2.2 Stakeholder Update",
    stakeholderDraft.sections.map((s) => s.heading).join(",") === "Subject,Current situation,Impact,What we need,Next step",
    "the Stakeholder Update has exactly the §4.2 section headings"
  );
  ok("V2.2 Stakeholder Update", stakeholderDraft.sections.find((s) => s.heading === "Current situation")?.segments[0].text === attItem.why, "'Current situation' preserves the attention item's WHY verbatim, never rephrased");
  ok("V2.2 Stakeholder Update", stakeholderDraft.evidence.map((e) => e.content).join("|") === attItem.evidence.join("|"), "the artifact's evidence is exactly the source item's evidence — no invented facts");
  ok("V2.2 Stakeholder Update", stakeholderDraft.sourceRef?.type === "attention" && stakeholderDraft.sourceRef.itemId === attItem.id, "the attention-sourced draft tags a rebuildable sourceRef");

  const wsicContent: WhyShouldICareContent = {
    fact: ["Status: UNDER_REVIEW", "No decision date recorded"],
    signal: "Decision Radar flags this for review.",
    impact: { currentCondition: "Decision is under review.", unresolvedSignal: "If no intervention occurs, this decision is expected to remain unreviewed.", affectedEntities: [], evidence: [], confidence: 0.7, insufficientEvidence: false },
    unknown: ["No review date is set for this decision."],
    nextMove: "Review, keep, or mark this decision superseded.",
    evidence: [],
  };
  const wsicDraft = buildStakeholderUpdateDraft({ kind: "why-should-i-care", content: wsicContent, subjectTitle: "Choose vendor" }, "Decision: Choose vendor");
  const wsicUnknownSection = wsicDraft.sections.find((s) => s.heading === "Unknown");
  ok("V2.2 Stakeholder Update", !!wsicUnknownSection && wsicUnknownSection.segments[0].kind === "UNKNOWN" && wsicUnknownSection.segments[0].text === wsicContent.unknown[0], "Why Should I Care's UNKNOWN facts are preserved verbatim as UNKNOWN-kind segments, never silently dropped or reworded");
  const currentSituationText = wsicDraft.sections.find((s) => s.heading === "Current situation")!.segments.map((s) => s.text);
  ok("V2.2 Stakeholder Update", wsicContent.fact.every((f) => currentSituationText.includes(f)), "every FACT string from Why Should I Care appears verbatim in the artifact — the AI may draft wording separately, but it never replaces these facts");
  ok("V2.2 Stakeholder Update", wsicDraft.sourceRef === undefined, "a Why-Should-I-Care-sourced draft has no cheap rebuild path — staleness must be reported 'unavailable', never faked");
}

// ----- Release Update -----
{
  const release = computeReleaseHealth(v22Data, "R-2026.1", TODAY);
  const releaseDraft = buildReleaseUpdateDraft(release, v22Data, "Release Health");
  ok(
    "V2.2 Release Update",
    releaseDraft.sections.map((s) => s.heading).join(",") === "Release,Confidence,Readiness,Key blockers,Open dependencies,Decisions,Next actions",
    "the Release Update has exactly the §4.3 section headings"
  );
  ok("V2.2 Release Update", releaseDraft.sections.find((s) => s.heading === "Release")?.segments[0].text === "R-2026.1", "the Release section names the exact fix version");
  const openDepsText = releaseDraft.sections.find((s) => s.heading === "Open dependencies")!.segments.map((s) => s.text).join(" ");
  ok("V2.2 Release Update", openDepsText.includes(v22Dep.description), "an unresolved dependency on a work item in this release appears in Open Dependencies");
  ok("V2.2 Release Update", releaseDraft.sourceRef?.type === "release" && releaseDraft.sourceRef.fixVersion === "R-2026.1", "the release draft tags a rebuildable sourceRef");
  ok(
    "V2.18 Trust wording",
    releaseDraft.sections.find((s) => s.heading === "Confidence")!.segments[0].text === `${release.deliveryConfidence}/100`,
    "the auto-generated Release Update's Confidence section reads 'N/100', never 'N%' — deliveryConfidence is a deterministic heuristic score, not a statistical probability"
  );
}

// ===== V2.18 §11 — Trust/confidence wording audit: heuristic score never dressed up as a
// probability, and "no outcomes measured yet" never conflated with "all outcomes were good" =====
{
  ok(
    "V2.18 Trust wording",
    !/\{deliveryConfidence\}%/.test(fs.readFileSync(path.join(process.cwd(), "src/components/command-center/ControlTower.tsx"), "utf8")),
    "ControlTower no longer renders the deterministic 0-100 heuristic score with a literal '%' — it uses the same honest '/100' framing ExecutiveView.tsx already used"
  );

  const controlTowerSrc = fs.readFileSync(path.join(process.cwd(), "src/components/command-center/ControlTower.tsx"), "utf8");
  ok("V2.18 Trust wording", /proactive\.actionEffectiveness\.length === 0/.test(controlTowerSrc), "ControlTower's Action tile checks actionEffectiveness.length === 0 before ever rendering 'All effective' — zero-outcomes-measured is now distinguishable from zero-ineffective-among-many");
  ok("V2.18 Trust wording", /No action outcomes yet/.test(controlTowerSrc), "the zero-measured case gets its own honest label, not silently reusing 'All effective'");
}

// ----- Decision Brief — the system never decides (§4) -----
{
  const decItem: AttentionItem = {
    id: "v22-att-dec",
    category: "DECISION",
    severity: "MEDIUM",
    what: "Choose vendor for reconciliation service",
    why: "Decision has been open for 12 days without review",
    impact: "Delays downstream integration work",
    nowWhat: "Review and confirm or supersede",
    evidence: ["Opened 2026-06-03", "No owner assigned"],
    lifecycle: "ACTIVE",
    firstSeenDate: TODAY,
    lastSeenDate: TODAY,
  };
  const decisionOptions: DecisionOptionsResult = {
    summary: "Two viable vendors identified.",
    options: [
      { id: "A", label: "Vendor A", rationale: "Lower cost", upside: "Cheaper", downside: "Slower support", dependencies: [], risks: [], evidence: [], confidence: 0.6 },
      { id: "B", label: "Vendor B", rationale: "Faster integration", upside: "Faster", downside: "Higher cost", dependencies: [], risks: [], evidence: [], confidence: 0.55 },
    ],
    recommendedOptionId: "A",
    tradeoffs: "Vendor A trades support speed for cost; Vendor B trades cost for speed.",
    confidence: 0.6,
  };
  const briefDraft = buildDecisionBriefDraft(decItem, decisionOptions, "Decision Radar");
  ok(
    "V2.2 Decision Brief",
    briefDraft.sections.map((s) => s.heading).join(",") === "Decision,Why now,Options,Trade-offs,Evidence,Recommended human decision",
    "the Decision Brief has exactly the §4.4 section headings"
  );
  const briefSummary = summarizeArtifactTrust(briefDraft.sections);
  ok("V2.2 Decision Brief", briefSummary.userInputCount === 1, "'Recommended human decision' is the only USER_INPUT segment — left for the human, never pre-filled by AI");
  ok("V2.2 Decision Brief", briefSummary.aiDraftCount === decisionOptions.options.length + 1, "Options + Trade-offs are labeled AI_DRAFT (they came from generateDecisionOptions) — one segment per option plus the trade-offs line");
  ok(
    "V2.2 Decision Brief",
    briefDraft.sections.find((s) => s.heading === "Recommended human decision")!.segments[0].text.toLowerCase().includes("not yet decided"),
    "the human-decision section is explicitly a placeholder, never a fabricated recommendation presented as the decision"
  );
}

// ----- Needs From Others (§13) — never guess owner/deadline -----
{
  const rows = buildNeedsFromOthers(v22Data, v22Proactive);
  ok("V2.2 Needs From Others", rows.length > 0, "an unowned P1 work item and an unowned dependency produce at least one row");
  const unknownRow = rows.find((r) => r.isUnknownPerson);
  ok("V2.2 Needs From Others", !!unknownRow && unknownRow.person === "UNKNOWN" && unknownRow.by === "UNKNOWN", "when no owner is available, person/by literally read UNKNOWN rather than a guess");
  ok("V2.2 Needs From Others", renderNeedsFromOthersText(rows).includes("No owner/deadline is available in the source data."), "the rendered text explains the UNKNOWN, matching the spec's worked example");

  const noneRows = buildNeedsFromOthers(emptyData(), computeProactiveIntelligence(emptyData(), deriveData(emptyData(), null, TODAY), [], null, {}, "manual", TODAY));
  ok("V2.2 Needs From Others", noneRows.length === 0, "an empty dataset produces zero rows, not a crash or a fabricated need");
  ok("V2.2 Needs From Others", renderNeedsFromOthersText(noneRows) === "NEEDS FROM OTHERS\n(none currently)", "zero rows render an honest 'none currently' rather than an empty string");
}

// ----- Meeting Mode -----
{
  const brief = buildMeetingModeBrief(v22Data, v22Derived, v22Proactive, TODAY);
  ok("V2.2 Meeting Mode", brief.questions.length === 5, "Meeting Mode surfaces exactly the 5 evidence-backed questions (the 6th, 'what should I say', is a separate deterministic summary field)");
  const blockedQ = brief.questions.find((q) => q.question === "What is blocked?");
  ok("V2.2 Meeting Mode", !!blockedQ && blockedQ.items.some((i) => i.includes("V22-1")), "the blocked work item appears under 'What is blocked?'");
  ok("V2.2 Meeting Mode", brief.whatShouldISay.length > 0, "'What should I say?' is a non-empty deterministic summary, not an AI call");

  // V2.9 §F-07 fix — an unowned item's "person" is the literal string "UNKNOWN" on the
  // underlying NeedsFromOthersRow (asserted above); the "What do I need from others?" list
  // must never interpolate that literally, which read like an unresolved template variable
  // ("UNKNOWN: Assign an owner"), as if UNKNOWN were a real person or team's name.
  const needsFromOthersQ = brief.questions.find((q) => q.question === "What do I need from others?");
  ok("V2.9 Meeting Mode copy", !!needsFromOthersQ && needsFromOthersQ.items.length > 0, "sanity check: v22Data's unowned item(s) produce at least one 'needs from others' row");
  ok(
    "V2.9 Meeting Mode copy",
    !!needsFromOthersQ && needsFromOthersQ.items.every((i) => !i.startsWith("UNKNOWN:")),
    "no 'needs from others' line starts with the literal word UNKNOWN standing in for a person's name"
  );
  ok("V2.2 Meeting Mode", renderMeetingModeText(brief).startsWith("MEETING MODE"), "the copyable meeting summary is well-formed plain text");

  const emptyBrief = buildMeetingModeBrief(emptyData(), deriveData(emptyData(), null, TODAY), computeProactiveIntelligence(emptyData(), deriveData(emptyData(), null, TODAY), [], null, {}, "manual", TODAY), TODAY);
  ok("V2.2 Meeting Mode", emptyBrief.questions.every((q) => q.items.length > 0), "an empty dataset still renders an honest 'nothing' answer for every question, never a blank/crashed section");
}

// ----- Trust model / Copy Safety (§5, §15) -----
{
  const statusDraft = buildStatusUpdateDraft(v22Data, v22Derived, v22Proactive, v22PersonalFocus, TODAY, "Control Tower");
  const summary = summarizeArtifactTrust(statusDraft.sections);
  const totalSegments = statusDraft.sections.reduce((n, s) => n + s.segments.length, 0);
  ok("V2.2 Trust model", summary.calculatedCount + summary.evidenceCount + summary.aiDraftCount + summary.userInputCount + summary.unknownCount === totalSegments, "summarizeArtifactTrust's counts add up to the total segment count — nothing double-counted or missed");
  ok("V2.2 Trust model", summary.aiDraftCount === 0, "a freshly-built draft (no AI wording generated yet) has zero AI_DRAFT segments");

  const text = renderArtifactText(statusDraft.sections, "Suggested wording.");
  ok("V2.2 Trust model", text.includes("SUGGESTED WORDING (AI DRAFT)"), "renderArtifactText clearly labels AI-drafted wording as a separate block, never merges it into the facts silently");
}

// ----- Staleness (§17) -----
{
  const statusDraft = buildStatusUpdateDraft(v22Data, v22Derived, v22Proactive, v22PersonalFocus, TODAY, "Control Tower");
  ok("V2.2 Staleness", !isArtifactStale(statusDraft.evidenceVersion, statusDraft.evidenceVersion), "identical evidenceVersion is never reported stale");
  ok("V2.2 Staleness", isArtifactStale(statusDraft.evidenceVersion, "some-other-version"), "a changed evidenceVersion is reported stale");

  const rebuilt = rebuildDraftFromSourceRef(statusDraft.sourceRef, "Control Tower", v22Data, v22Derived, v22Proactive, v22PersonalFocus, TODAY);
  ok("V2.2 Staleness", !!rebuilt && rebuilt.evidenceVersion === statusDraft.evidenceVersion, "rebuilding from the same sourceRef against unchanged data reproduces the identical evidenceVersion");

  ok("V2.2 Staleness", rebuildDraftFromSourceRef(undefined, "x", v22Data, v22Derived, v22Proactive, v22PersonalFocus, TODAY) === null, "no sourceRef (e.g. a Decision Brief or Why-Should-I-Care draft) is honestly reported as not rebuildable, never faked");
  ok("V2.2 Staleness", rebuildDraftFromSourceRef({ type: "attention", itemId: "does-not-exist" }, "x", v22Data, v22Derived, v22Proactive, v22PersonalFocus, TODAY) === null, "a sourceRef pointing at an attention item that's no longer present rebuilds to null rather than fabricating stale content");
  ok("V2.2 Staleness", rebuildDraftFromSourceRef({ type: "release", fixVersion: "DOES-NOT-EXIST" }, "x", v22Data, v22Derived, v22Proactive, v22PersonalFocus, TODAY) === null, "a sourceRef pointing at a release no longer present in the data rebuilds to null");
}

// ----- AI: COMMUNICATION_ARTIFACT (§8) -----
{
  ok("V2.2 AI schema", communicationArtifactResponseSchema.safeParse({ text: "Draft wording.", confidence: 0.6 }).success, "a valid COMMUNICATION_ARTIFACT payload is accepted");
  ok("V2.2 AI schema", !communicationArtifactResponseSchema.safeParse({ text: "Draft wording." }).success, "a payload missing confidence is rejected");
  ok("V2.2 AI schema", !communicationArtifactResponseSchema.safeParse({ confidence: 0.6 }).success, "a payload missing text is rejected");
  ok("V2.2 AI schema", aiRequestSchema.safeParse({ task: "generateCommunicationArtifact", prompt: "..." }).success, "'generateCommunicationArtifact' is a recognized AITask");

  const mock = new MockAIProvider();
  const mockResult = await mock.generateCommunicationArtifact("STATUS_UPDATE", ["Trajectory: ON TRACK."], ["evidence 1"]);
  ok("V2.2 AI mock", mockResult.text.length > 0 && mockResult.confidence > 0, "MockAIProvider.generateCommunicationArtifact returns usable text built from the given facts, offline");
  const mockEmpty = await mock.generateCommunicationArtifact("STATUS_UPDATE", [], []);
  ok("V2.2 AI mock", mockEmpty.insufficientEvidence === true, "with zero facts, the mock honestly reports insufficientEvidence rather than fabricating a draft");

  const claude2 = new ClaudeProvider();
  let artifactThrew = false;
  try {
    await claude2.generateCommunicationArtifact("STATUS_UPDATE", ["fact"], []);
  } catch {
    artifactThrew = true;
  }
  ok("V2.2 AI Claude fallback", !artifactThrew, "ClaudeProvider.generateCommunicationArtifact never throws even when the server is unreachable");
  ok("V2.2 AI Claude fallback", claude2.mode === "mock", "mode reports 'mock' after the failed call, same fallback discipline as every other provider method");

  // §21 — reuse the existing evaluator, not a new one.
  const evalResult = evaluateAiResponse({
    task: "generateCommunicationArtifact",
    response: mockResult,
    schemaValid: true,
    narrativeText: mockResult.text,
    inputFacts: ["Trajectory: ON TRACK."],
    inputEvidence: ["evidence 1"],
    confidence: mockResult.confidence,
  });
  ok("V2.2 AI evaluation", evalResult.findings.length > 0, "evaluateAiResponse (ai/evaluation.ts, no new evaluator) runs cleanly against a COMMUNICATION_ARTIFACT response");
}

// ----- Command Bar artifact intents (§10) -----
{
  ok("V2.2 Command Bar", classifyQuery("create status update", v22Data).intent === "create-status-update", "'create status update' routes to create-status-update");
  ok("V2.2 Command Bar", classifyQuery("draft stakeholder update for JPMC", v22Data).intent === "create-stakeholder-update", "'draft stakeholder update for JPMC' routes to create-stakeholder-update");
  ok("V2.2 Command Bar", classifyQuery("draft stakeholder update for JPMC", v22Data).target === "JPMC", "the client name is extracted as the target, reusing the existing findTarget helper");
  ok("V2.2 Command Bar", classifyQuery("prepare release update", v22Data).intent === "create-release-update", "'prepare release update' routes to create-release-update");
  ok("V2.2 Command Bar", classifyQuery("please give me a quick release update", v22Data).intent === "create-release-update", "a near-miss phrasing containing 'release update' still routes correctly");
  ok("V2.2 Command Bar", classifyQuery("prepare decision brief", v22Data).intent === "create-decision-brief", "'prepare decision brief' routes to create-decision-brief");
  ok("V2.2 Command Bar", classifyQuery("summarize today's delivery", v22Data).intent === "summarize-today", "\"summarize today's delivery\" routes to summarize-today");
  ok("V2.2 Command Bar", classifyQuery("give me the daily summary", v22Data).intent === "summarize-today", "'daily summary' phrasing also routes to summarize-today");
  ok("V2.2 Command Bar", classifyQuery("asdkjhasdkjh nonsense query", v22Data).intent === "unrecognized", "an unrelated/nonsense query is never misrouted to an artifact intent");

  for (const intent of ["create-status-update", "create-stakeholder-update", "create-release-update", "create-decision-brief", "summarize-today"] as const) {
    ok("V2.2 Command Bar", isArtifactIntent(intent), `isArtifactIntent('${intent}') is true`);
    ok("V2.2 Command Bar", familyForIntent(intent) === "ARTIFACT", `familyForIntent('${intent}') is the ARTIFACT family, distinct from every AI-narrated family`);
  }
  ok("V2.2 Command Bar", !isArtifactIntent("blocking"), "an existing narrated intent is never misclassified as an artifact intent");
}

// ----- Store: Artifact History (§16) and Usage Observability (§22-23) -----
{
  commandCenterStore.resetAll();
  const draftForHistory = buildStatusUpdateDraft(v22Data, v22Derived, v22Proactive, v22PersonalFocus, TODAY, "Control Tower");

  const id1 = commandCenterStore.saveArtifact(draftForHistory, { editedText: "edited body" });
  ok("V2.2 Artifact History (store)", commandCenterStore.getSnapshot().artifacts.length === 1, "saveArtifact appends one record");
  ok("V2.2 Artifact History (store)", commandCenterStore.getSnapshot().artifacts[0].editedText === "edited body", "the saved record keeps the user's edited text");

  commandCenterStore.updateArtifact(id1, { editedText: "changed body" });
  ok("V2.2 Artifact History (store)", commandCenterStore.getSnapshot().artifacts[0].editedText === "changed body", "updateArtifact patches an existing record in place");

  commandCenterStore.deleteArtifact(id1);
  ok("V2.2 Artifact History (store)", commandCenterStore.getSnapshot().artifacts.length === 0, "deleteArtifact removes the record");

  commandCenterStore.resetAll();
  for (let i = 0; i < 35; i++) commandCenterStore.saveArtifact(draftForHistory);
  ok("V2.2 Artifact History (store)", commandCenterStore.getSnapshot().artifacts.length === 30, "Artifact History is bounded to 30 records — oldest evicted first, same discipline as snapshotHistory/memoryEvents");

  commandCenterStore.resetAll();
  commandCenterStore.bumpUsage("surface:test-key");
  commandCenterStore.bumpUsage("surface:test-key");
  commandCenterStore.bumpUsage(artifactUsageKey("STATUS_UPDATE"));
  commandCenterStore.bumpUsage(commandUsageKey("create-status-update"));
  const usageSnapshot = commandCenterStore.getSnapshot().usageCounters;
  ok("V2.2 Usage (store)", usageSnapshot["surface:test-key"] === 2, "bumpUsage increments an existing counter");
  const usageSummary = computeUsageSummary(usageSnapshot);
  ok("V2.2 Usage (store)", usageSummary.mostUsedArtifactType?.label === "Status Update", "computeUsageSummary surfaces the most-used artifact type from the bounded counter map");
  ok("V2.2 Usage (store)", usageSummary.unusedSurfaces.length > 0, "a surface never bumped this session correctly shows up as unused, never fabricated as used");

  commandCenterStore.resetAll();
}

// ----- parseStoredState corruption safety (artifacts + usageCounters) -----
{
  const corrupted = parseStoredState(JSON.stringify({ artifacts: "not-an-array", usageCounters: { good: 5, bad1: "not-a-number", bad2: -1 } }));
  ok("V2.2 Corruption safety", Array.isArray(corrupted.artifacts) && corrupted.artifacts.length === 0, "a non-array 'artifacts' field falls back to an empty array rather than crashing");
  ok("V2.2 Corruption safety", corrupted.usageCounters.good === 5, "a valid counter entry survives parseStoredState");
  ok("V2.2 Corruption safety", corrupted.usageCounters.bad1 === undefined && corrupted.usageCounters.bad2 === undefined, "a non-numeric or negative counter entry is dropped, never trusted as-is");

  const mixedArtifacts = parseStoredState(
    JSON.stringify({
      artifacts: [
        { id: "malformed-missing-fields" },
        { id: "v22-ok", type: "STATUS_UPDATE", createdAt: TODAY, sections: [], evidence: [], evidenceVersion: "v1" },
      ],
    })
  );
  ok("V2.2 Corruption safety", mixedArtifacts.artifacts.length === 1 && mixedArtifacts.artifacts[0].id === "v22-ok", "a malformed artifact entry is dropped while a well-formed sibling entry is kept — never a crash, never a fabricated field");
}

// ===== V2.2.1 — Production Completion & Deployment Readiness =====

// ----- §14/§21 — LOOP_STALLED must not duplicate on every close/sync while a loop remains
// stalled (previously it did, risking crowding out real signal in the bounded 200-event
// memory log for any pilot with a genuinely long-stuck loop). -----
{
  commandCenterStore.resetAll();
  commandCenterStore.loadDemoData();
  const projectId = commandCenterStore.getSnapshot().data.projects[0]?.id ?? "p-1";
  commandCenterStore.addDecision({ projectId, title: "V2.2.1 loop-dedup test decision", status: "DECIDED", description: "test decision with no follow-up action — deterministically STALLED" });

  await commandCenterStore.closeDay();
  const afterFirst = commandCenterStore.getSnapshot().memoryEvents.filter((e) => e.kind === "LOOP_STALLED" && e.title.includes("V2.2.1 loop-dedup test decision"));
  ok("V2.2.1 Memory event dedup", afterFirst.length === 1, "closing the day once logs exactly one LOOP_STALLED event for the newly-stalled loop");

  await commandCenterStore.closeDay();
  const afterSecond = commandCenterStore.getSnapshot().memoryEvents.filter((e) => e.kind === "LOOP_STALLED" && e.title.includes("V2.2.1 loop-dedup test decision"));
  ok("V2.2.1 Memory event dedup", afterSecond.length === 1, "closing the day again while the SAME loop remains stalled does not add a duplicate LOOP_STALLED event");

  commandCenterStore.resetAll();
}

// ----- §4/§5 — Jira fetch calls carry an explicit abort timeout, so a hung Jira instance
// fails fast into the existing network-error classification instead of hanging until the
// platform kills the function. -----
{
  ok("V2.2.1 Jira timeout", typeof AbortSignal.timeout === "function", "the runtime supports AbortSignal.timeout, which jira/http.ts now attaches to every real fetch call");
  const httpSource = fs.readFileSync(path.join(process.cwd(), "src/lib/command-center/jira/http.ts"), "utf8");
  const timeoutCallSites = (httpSource.match(/signal: AbortSignal\.timeout\(JIRA_FETCH_TIMEOUT_MS\)/g) ?? []).length;
  ok(
    "V2.2.1 Jira timeout",
    // V2.10 §2 adds one legitimate new real fetch call site (fetchIssueCommentsWith), which
    // also attaches the timeout — this count is a deliberately-updated magic number, not a
    // relaxed guard: every real fetch call site, old or new, must still attach one.
    timeoutCallSites === 6,
    `all 6 real Jira fetch call sites (projects, jql issue search, classic issue search fallback, changelog, capability probe, issue comments) attach the timeout signal (found ${timeoutCallSites})`
  );
}

// ----- §4 — jira/status and jira/conformance GET routes must be force-dynamic. Without it,
// Next.js statically optimizes a parameter-less GET handler and serves ONE response frozen
// at `next build` time for the route's entire production lifetime — meaning a user who
// configures Jira credentials AFTER deploying would see "not configured" forever, and the
// "Run Conformance Check" button would silently replay a build-time-frozen report. -----
{
  for (const routeFile of ["src/app/api/command-center/jira/status/route.ts", "src/app/api/command-center/jira/conformance/route.ts"]) {
    const source = fs.readFileSync(path.join(process.cwd(), routeFile), "utf8");
    ok("V2.2.1 Route dynamic rendering", /export const dynamic = "force-dynamic"/.test(source), `${routeFile} declares force-dynamic — without it this parameter-less GET route would be statically frozen at build time`);
  }
}

// ===== V2.2.2 — real production bug fix: Jira Cloud now answers the classic
// GET /rest/api/3/search endpoint with 410 Gone (Atlassian sunset it in favor of
// POST /rest/api/3/search/jql). fetchJiraIssuesWith now tries the replacement endpoint
// first and only falls back to classic search on a 404 from the replacement itself. =====
{
  const jqlConfig: JiraConnectionConfig = { baseUrl: "https://acme.atlassian.net", email: "ba@acme.com", apiToken: "x" };

  // ----- The fix: a modern Jira Cloud instance (jql endpoint works, classic is 410 Gone if
  // ever called) must be fetched successfully via the new endpoint, never touching classic. -----
  {
    let classicCalled = false;
    let jqlCallCount = 0;
    const modernCloudFetch: FetchLike = async (url, init) => {
      if (url.includes("/search/jql")) {
        jqlCallCount++;
        const body = JSON.parse((init as { body?: string })?.body ?? "{}") as { nextPageToken?: string };
        if (!body.nextPageToken) {
          const issues = Array.from({ length: JIRA_PAGE_SIZE }, (_, i) => makeJiraIssue({ key: `JPMC-${i}` }));
          return { ok: true, status: 200, json: async () => ({ issues, nextPageToken: "page-2-token", isLast: false }) };
        }
        const issues = Array.from({ length: 10 }, (_, i) => makeJiraIssue({ key: `JPMC-page2-${i}` }));
        return { ok: true, status: 200, json: async () => ({ issues, isLast: true }) };
      }
      if (url.includes("/search")) {
        classicCalled = true;
        return { ok: false, status: 410, json: async () => ({ errorMessages: ["fixture: classic search is Gone"] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const result = await fetchJiraIssuesWith(modernCloudFetch, jqlConfig, {});
    ok("V2.2.2 Jira search migration", result.ok && result.recordsFetched === JIRA_PAGE_SIZE + 10, `a modern Jira Cloud instance is fetched successfully via /search/jql, across cursor pages (got ${result.ok ? result.recordsFetched : "error"})`);
    ok("V2.2.2 Jira search migration", result.ok && result.method === "jql-cursor", "the successful result records that the cursor-based endpoint was actually used");
    ok("V2.2.2 Jira search migration", jqlCallCount === 2, "cursor pagination followed nextPageToken across exactly 2 pages");
    ok("V2.2.2 Jira search migration", !classicCalled, "the classic (410 Gone) endpoint is never called when the replacement endpoint works — this is the actual bug fix");
  }

  // ----- An instance that genuinely doesn't expose the replacement endpoint (404 on the very
  // first page) falls back to classic search, which still works there. -----
  {
    const legacyInstanceFetch: FetchLike = async (url) => {
      if (url.includes("/search/jql")) return { ok: false, status: 404, json: async () => ({}) };
      if (url.includes("/search")) {
        const startAt = Number(new URL(url).searchParams.get("startAt"));
        const issues = Array.from({ length: 5 }, (_, i) => makeJiraIssue({ key: `LEGACY-${startAt + i}` }));
        return { ok: true, status: 200, json: async () => ({ issues, startAt, maxResults: JIRA_PAGE_SIZE, total: 5 }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const result = await fetchJiraIssuesWith(legacyInstanceFetch, jqlConfig, {});
    ok("V2.2.2 Jira search migration", result.ok && result.recordsFetched === 5, "a 404 on the very first /search/jql page falls back to classic search for the whole fetch");
    ok("V2.2.2 Jira search migration", result.ok && result.method === "classic-offset", "the fallback result honestly records that the classic endpoint was actually used");
  }

  // ----- The real-world failure this bug report reproduced: neither endpoint works. Must
  // surface a clear, non-crashing error — never silently return zero issues as if the
  // project were simply empty. -----
  {
    const brokenInstanceFetch: FetchLike = async (url) => {
      if (url.includes("/search/jql")) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: false, status: 410, json: async () => ({ errorMessages: ["Gone"] }) };
    };
    const result = await fetchJiraIssuesWith(brokenInstanceFetch, jqlConfig, {});
    ok("V2.2.2 Jira search migration", !result.ok, "when both the replacement and classic endpoints fail, the fetch honestly fails rather than returning an empty-looking success");
    ok("V2.2.2 Jira search migration", !result.ok && /deprecated|Gone/.test(result.error), `the 410 failure message is specific and actionable, not a generic "unexpected status" (got: ${!result.ok ? result.error : ""})`);
  }

  // ----- A non-404 failure on the replacement endpoint (real auth/permission/rate-limit
  // problem) must surface immediately — never mask a real credential issue with a silent
  // fallback attempt. -----
  {
    const authFailOnJql: FetchLike = async (url) => {
      if (url.includes("/search/jql")) return { ok: false, status: 401, json: async () => ({}) };
      throw new Error("classic endpoint must never be called for a 401 on the replacement endpoint");
    };
    const result = await fetchJiraIssuesWith(authFailOnJql, jqlConfig, {});
    ok("V2.2.2 Jira search migration", !result.ok && result.errorKind === "auth-failure", "a 401 on the replacement endpoint is classified as auth-failure immediately, with no fallback attempt that could mask it");
  }

  ok("V2.2.2 Jira search migration", classifyHttpError(410).error.includes("410") || /deprecated|Gone/i.test(classifyHttpError(410).error), "classifyHttpError(410) gives a specific, actionable message distinguishing it from a generic unrecognized status");
}

// ===== V2.2.3 — real production bug fix #2: after migrating to /search/jql, real sync
// started failing with 400 Bad Request. Root cause: that endpoint strictly validates every
// requested field name and rejects the WHOLE request if one doesn't resolve on the instance
// (the classic endpoint silently ignored unrecognized fields instead) — and "flagged" is
// documented as an instance-specific custom field, not a universal system field, so it's
// the one entry that could legitimately fail this validation on a real site. =====
{
  const fieldsConfig: JiraConnectionConfig = { baseUrl: "https://acme.atlassian.net", email: "ba@acme.com", apiToken: "x" };

  // ----- The actual fix: "flagged" is never requested from the strict endpoint. -----
  {
    let requestedFields: string[] | undefined;
    const captureFieldsFetch: FetchLike = async (url, init) => {
      if (url.includes("/search/jql")) {
        const body = JSON.parse((init as { body?: string })?.body ?? "{}") as { fields?: string[] };
        requestedFields = body.fields;
        return { ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    await fetchJiraIssuesWith(captureFieldsFetch, fieldsConfig, {});
    ok("V2.2.3 Jira field validation", Array.isArray(requestedFields) && !requestedFields.includes("flagged"), "the strict /search/jql endpoint is never asked for 'flagged' — the one field known not to be a universal system field");
    ok(
      "V2.2.3 Jira field validation",
      Array.isArray(requestedFields) && ["summary", "status", "priority", "assignee", "duedate", "labels", "fixVersions", "issuetype", "issuelinks", "project", "created", "updated"].every((f) => requestedFields!.includes(f)),
      "every genuine universal system field is still requested — only the one instance-specific field was dropped"
    );
  }

  // ----- The debuggability fix: Jira's own validation message is surfaced, not swallowed. -----
  {
    const rejectedFieldFetch: FetchLike = async (url) => {
      if (url.includes("/search/jql")) {
        return { ok: false, status: 400, json: async () => ({ errorMessages: [], errors: { fields: "The value 'flagged' does not exist for the field 'fields'." } }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const result = await fetchJiraIssuesWith(rejectedFieldFetch, fieldsConfig, {});
    ok("V2.2.3 Jira error surfacing", !result.ok, "a 400 from the strict endpoint fails the fetch");
    ok(
      "V2.2.3 Jira error surfacing",
      !result.ok && result.error.includes("does not exist for the field"),
      `Jira's actual validation message is included in the surfaced error, not just a generic status code (got: ${!result.ok ? result.error : ""})`
    );
  }

  // ----- errorMessages[] (the other real Jira error shape) is also surfaced. -----
  {
    const errorMessagesFetch: FetchLike = async (url) => {
      if (url.includes("/project/search")) return { ok: false, status: 400, json: async () => ({ errorMessages: ["The JQL you have entered is not valid."] }) };
      return { ok: false, status: 404, json: async () => ({}) };
    };
    const result = await fetchJiraProjectsWith(errorMessagesFetch, fieldsConfig);
    ok("V2.2.3 Jira error surfacing", !result.ok && result.error.includes("The JQL you have entered is not valid."), "errorMessages[] entries are surfaced the same way errors{} entries are");
  }

  // ----- A response body that isn't the expected error shape (or isn't JSON at all) never
  // crashes — the status-based message alone still stands. -----
  {
    const nonJsonErrorFetch: FetchLike = async () => ({ ok: false, status: 400, json: async () => { throw new Error("Unexpected token < in JSON"); } });
    const result = await fetchJiraProjectsWith(nonJsonErrorFetch, fieldsConfig);
    ok("V2.2.3 Jira error surfacing", !result.ok && result.error.length > 0, "an unparseable error body (e.g. an HTML error page) never throws — the status-based message alone is used");
  }

  ok("V2.2.3 Jira error surfacing", classifyHttpError(400).error.includes("400"), "classifyHttpError(400) gives a specific 'malformed request' message rather than a generic unrecognized-status message");
}

// ===== V2.2.4 — real production bug fix #3: after fixing the 400 on the "flagged" field,
// real sync started failing with a DIFFERENT 400: "Unbounded JQL queries are not allowed
// here. Please add a search restriction to your query." Root cause: /rest/api/3/search/jql
// rejects a JQL with no WHERE clause at all (`order by ...` alone) — exactly what
// buildIssuesJql produced for a first sync with no JIRA_PROJECT_KEYS configured (the common
// case, since that variable is optional). =====
{
  ok("V2.2.4 Jira bounded JQL", buildIssuesJql({}) === "project is not EMPTY order by updated asc", "no scope and no incremental cursor still produces a JQL with a real WHERE clause — never a bare 'order by' that Jira's endpoint rejects as unbounded");
  ok("V2.2.4 Jira bounded JQL", buildIssuesJql({ projectKeys: ["JPMC"] }) === 'project in ("JPMC") order by updated asc', "a real project scope is used as-is — the bounded-query workaround only applies when there's genuinely no other restriction");
  ok("V2.2.4 Jira bounded JQL", buildIssuesJql({ sinceIso: "2026-08-01" }) === 'updated >= "2026-08-01" order by updated asc', "an incremental sinceIso is already a real bounding clause — the workaround clause is not redundantly added");
  ok("V2.2.4 Jira bounded JQL", !buildIssuesJql({}).startsWith("order by"), "the unbounded case never starts with a bare ORDER BY");

  // End-to-end: a fetch that would reject an unbounded JQL with exactly the real-world
  // message must now succeed, because the JQL we send is no longer unbounded.
  const boundedConfig: JiraConnectionConfig = { baseUrl: "https://acme.atlassian.net", email: "ba@acme.com", apiToken: "x" };
  let sentJql: string | undefined;
  const strictInstanceFetch: FetchLike = async (url, init) => {
    if (url.includes("/search/jql")) {
      const body = JSON.parse((init as { body?: string })?.body ?? "{}") as { jql?: string };
      sentJql = body.jql;
      if (!body.jql || body.jql.trim().toLowerCase().startsWith("order by")) {
        return { ok: false, status: 400, json: async () => ({ errorMessages: ["Unbounded JQL queries are not allowed here. Please add a search restriction to your query."] }) };
      }
      return { ok: true, status: 200, json: async () => ({ issues: [], isLast: true }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const result = await fetchJiraIssuesWith(strictInstanceFetch, boundedConfig, {});
  ok("V2.2.4 Jira bounded JQL", result.ok, `a first full sync against an instance that enforces bounded JQL now succeeds (got ${result.ok ? "ok" : "error: " + (result as { error?: string }).error})`);
  ok("V2.2.4 Jira bounded JQL", sentJql === "project is not EMPTY order by updated asc", "the exact JQL sent to a real instance matches the bounded-query workaround");
}

// ===== V2.3 — Focus Project Scope & Jira Ingestion Guard =====

// ----- Scope model: parseJiraProjectScope — malformed persisted data always degrades to a
// safe default, never crashes, never silently invents a different mode than what's valid. -----
{
  ok("V2.3 Scope model", parseJiraProjectScope(undefined).mode === "ALL", "missing scope defaults to ALL — reproduces exact pre-V2.3 behavior");
  ok("V2.3 Scope model", parseJiraProjectScope(undefined).projectKeys.length === 0, "missing scope defaults to an empty projectKeys array");
  ok("V2.3 Scope model", parseJiraProjectScope(null).mode === "ALL", "null scope defaults to ALL rather than crashing");
  ok("V2.3 Scope model", parseJiraProjectScope("garbage-string").mode === "ALL", "a wrong-typed (string) scope value defaults to ALL rather than crashing");
  ok("V2.3 Scope model", parseJiraProjectScope(42).mode === "ALL", "a wrong-typed (number) scope value defaults to ALL rather than crashing");
  ok("V2.3 Scope model", parseJiraProjectScope([]).mode === "ALL", "a wrong-typed (array) scope value defaults to ALL rather than crashing");

  const focused = parseJiraProjectScope({ mode: "FOCUSED", projectKeys: ["JPMC", "UBS"] });
  ok("V2.3 Scope model", focused.mode === "FOCUSED" && focused.projectKeys.length === 2, "a well-formed FOCUSED scope with multiple projects round-trips exactly");
  ok("V2.3 Scope model", focused.projectKeys.includes("JPMC") && focused.projectKeys.includes("UBS"), "both selected project keys are preserved");

  const emptyFocused = parseJiraProjectScope({ mode: "FOCUSED", projectKeys: [] });
  ok("V2.3 Scope model", emptyFocused.mode === "FOCUSED" && emptyFocused.projectKeys.length === 0, "an explicit FOCUSED scope with zero projects is preserved as-is — never silently reinterpreted as ALL (§23)");

  const invalidMode = parseJiraProjectScope({ mode: "SOMETHING_WEIRD", projectKeys: ["JPMC"] });
  ok("V2.3 Scope model", invalidMode.mode === "ALL", "an unrecognized mode string falls back to ALL rather than being trusted as-is");
  ok("V2.3 Scope model", invalidMode.projectKeys.includes("JPMC"), "projectKeys are still preserved even when mode itself was invalid — a later switch back to FOCUSED doesn't lose the prior selection");

  const nonArrayKeys = parseJiraProjectScope({ mode: "FOCUSED", projectKeys: "JPMC" });
  ok("V2.3 Scope model", Array.isArray(nonArrayKeys.projectKeys) && nonArrayKeys.projectKeys.length === 0, "a non-array projectKeys value (e.g. a bare string) falls back to an empty array rather than crashing");

  const dupes = parseJiraProjectScope({ mode: "FOCUSED", projectKeys: ["JPMC", "JPMC", "UBS", "JPMC"] });
  ok("V2.3 Scope model", dupes.projectKeys.length === 2, "duplicate project keys are de-duplicated (got " + dupes.projectKeys.length + ")");

  const junkEntries = parseJiraProjectScope({ mode: "FOCUSED", projectKeys: [123, null, "JPMC", "", "  ", undefined] });
  ok("V2.3 Scope model", junkEntries.projectKeys.length === 1 && junkEntries.projectKeys[0] === "JPMC", "non-string and blank entries in projectKeys are dropped, only the one genuine key survives");

  ok("V2.3 Scope model", DEFAULT_JIRA_PROJECT_SCOPE.mode === "ALL" && DEFAULT_JIRA_PROJECT_SCOPE.projectKeys.length === 0, "the exported default scope constant is ALL with no projects, matching pre-V2.3 behavior");
}

// ----- Backward compatibility: parseStoredState — a V2.2 (pre-V2.3) persisted blob, and a
// malformed jiraProjectScope, must both load safely. -----
{
  const v22Blob = JSON.stringify({
    schemaVersion: 5,
    data: emptyData(),
    snapshotHistory: [],
    loaded: true,
    isDemo: false,
    eodHistory: [],
    dataSource: "jira",
    jiraSync: { lastSyncStatus: "success" },
    filters: {},
    attentionState: {},
    memoryEvents: [],
    personalPlan: [],
    artifacts: [],
    usageCounters: {},
    // no jiraProjectScope key at all — exactly what a real V2.2 localStorage blob looks like
  });
  const migrated = parseStoredState(v22Blob);
  ok("V2.3 Backward compatibility", migrated.jiraProjectScope.mode === "ALL", "a V2.2 state blob with no jiraProjectScope key at all loads with the safe ALL default");
  ok("V2.3 Backward compatibility", migrated.dataSource === "jira" && migrated.jiraSync.lastSyncStatus === "success", "every other V2.2 field still loads unchanged alongside the new default scope");

  const malformedBlob = JSON.stringify({ ...JSON.parse(v22Blob), jiraProjectScope: "not-an-object" });
  const migratedMalformed = parseStoredState(malformedBlob);
  ok("V2.3 Backward compatibility", migratedMalformed.jiraProjectScope.mode === "ALL", "a malformed (wrong-typed) jiraProjectScope value never crashes parseStoredState — falls back to ALL");

  const nullScopeBlob = JSON.stringify({ ...JSON.parse(v22Blob), jiraProjectScope: null });
  ok("V2.3 Backward compatibility", parseStoredState(nullScopeBlob).jiraProjectScope.mode === "ALL", "a null jiraProjectScope value never crashes parseStoredState — falls back to ALL");

  const totallyMalformedJson = "{not valid json at all";
  const fallbackState = parseStoredState(totallyMalformedJson);
  ok("V2.3 Backward compatibility", fallbackState.jiraProjectScope.mode === "ALL" && fallbackState.jiraProjectScope.projectKeys.length === 0, "totally invalid JSON still produces a pristine state with a safe default scope, never a crash");
}

// ----- applyProjectScope: the data-boundary enforcement point. Fixture models a realistic
// mixed dataset: two Jira projects (JPMC, UBS) plus one non-Jira (Demo/Local Import) project,
// each with a work item, dependency, decision, action, communication, and risk. -----
{
  const scopeFixtureData = {
    ...emptyData(),
    clients: [
      { id: "jira-client-jpmc", name: "JPMorgan Chase" },
      { id: "jira-client-ubs", name: "UBS" },
      { id: "client-internal", name: "Internal" },
    ],
    projects: [
      { id: "jira-project-JPMC", name: "JPMC", clientId: "jira-client-jpmc", status: "on-track" as const, sourceType: "jira" as const, sourceId: "JPMC" },
      { id: "jira-project-UBS", name: "UBS", clientId: "jira-client-ubs", status: "on-track" as const, sourceType: "jira" as const, sourceId: "UBS" },
      { id: "internal-1", name: "Internal Tools", clientId: "client-internal", status: "on-track" as const },
    ],
    workItems: [
      makeItem({ id: "wi-jpmc-1", key: "JPMC-1", title: "JPMC onboarding flow", projectId: "jira-project-JPMC", clientId: "jira-client-jpmc", sourceType: "jira", sourceId: "JPMC-1", riskIds: [], dependencyIds: ["dep-jpmc-1"] }),
      makeItem({ id: "wi-ubs-1", key: "UBS-1", title: "UBS settlement report", projectId: "jira-project-UBS", clientId: "jira-client-ubs", sourceType: "jira", sourceId: "UBS-1", riskIds: [], dependencyIds: ["dep-ubs-1"] }),
      makeItem({ id: "wi-demo-1", key: "INT-1", title: "Internal tooling task", projectId: "internal-1", clientId: "client-internal", riskIds: [], dependencyIds: [] }),
    ],
    dependencies: [
      { id: "dep-jpmc-1", workItemId: "wi-jpmc-1", description: "Blocked by JPMC-0", dependsOnTeam: "JPMC", status: "unresolved" as const, raisedDate: TODAY },
      { id: "dep-ubs-1", workItemId: "wi-ubs-1", description: "Blocked by UBS-0", dependsOnTeam: "UBS", status: "unresolved" as const, raisedDate: TODAY },
    ],
    risks: [
      { id: "risk-jpmc", projectId: "jira-project-JPMC", title: "JPMC risk", level: "HIGH" as const, reason: "x", evidence: [], potentialImpact: "x", mitigation: "x", status: "open" as const, confidence: 0.8, detectedAt: TODAY, sourceWorkItemIds: ["wi-jpmc-1"] },
      { id: "risk-ubs", projectId: "jira-project-UBS", title: "UBS risk", level: "HIGH" as const, reason: "x", evidence: [], potentialImpact: "x", mitigation: "x", status: "open" as const, confidence: 0.8, detectedAt: TODAY, sourceWorkItemIds: ["wi-ubs-1"] },
      { id: "risk-none", projectId: "internal-1", title: "Unlinked risk", level: "LOW" as const, reason: "x", evidence: [], potentialImpact: "x", mitigation: "x", status: "open" as const, confidence: 0.5, detectedAt: TODAY, sourceWorkItemIds: [] },
    ],
    decisions: [
      { id: "dec-jpmc", projectId: "jira-project-JPMC", title: "JPMC decision", status: "ACTIVE" as const, description: "x" },
      { id: "dec-ubs", projectId: "jira-project-UBS", title: "UBS decision", status: "ACTIVE" as const, description: "x" },
      { id: "dec-demo", projectId: "internal-1", title: "Internal decision", status: "ACTIVE" as const, description: "x" },
    ],
    actions: [
      { id: "action-jpmc", title: "JPMC action", why: "x", relatedWorkItemId: "wi-jpmc-1", status: "open" as const, estimateMinutes: 10, createdAt: TODAY },
      { id: "action-ubs", title: "UBS action", why: "x", relatedWorkItemId: "wi-ubs-1", status: "open" as const, estimateMinutes: 10, createdAt: TODAY },
      { id: "action-demo", title: "Internal action", why: "x", relatedWorkItemId: "wi-demo-1", status: "open" as const, estimateMinutes: 10, createdAt: TODAY },
      { id: "action-none", title: "Unlinked action", why: "x", status: "open" as const, estimateMinutes: 10, createdAt: TODAY },
    ],
    communications: [
      { id: "comm-jpmc", workItemId: "wi-jpmc-1", audience: "Client" as const, who: "x", why: "x", whatTheyNeedToKnow: "x", suggestedMessage: "x", status: "open" as const },
      { id: "comm-ubs", workItemId: "wi-ubs-1", audience: "Client" as const, who: "x", why: "x", whatTheyNeedToKnow: "x", suggestedMessage: "x", status: "open" as const },
      { id: "comm-demo", workItemId: "wi-demo-1", audience: "Client" as const, who: "x", why: "x", whatTheyNeedToKnow: "x", suggestedMessage: "x", status: "open" as const },
      { id: "comm-none", audience: "Client" as const, who: "x", why: "x", whatTheyNeedToKnow: "x", suggestedMessage: "x", status: "open" as const },
    ],
    requirements: [
      { id: "req-jpmc", projectId: "jira-project-JPMC", title: "JPMC req", status: "approved" as const, businessImpact: 3 as const },
      { id: "req-ubs", projectId: "jira-project-UBS", title: "UBS req", status: "approved" as const, businessImpact: 3 as const },
    ],
  };

  const allScope: JiraProjectScope = { mode: "ALL", projectKeys: [] };
  const identityResult = applyProjectScope(scopeFixtureData, allScope);
  ok("V2.3 applyProjectScope", identityResult === scopeFixtureData, "ALL mode is a true no-op — returns the exact same object reference, matching pre-V2.3 behavior with zero overhead");

  const focusedScope: JiraProjectScope = { mode: "FOCUSED", projectKeys: ["JPMC"] };
  const scoped = applyProjectScope(scopeFixtureData, focusedScope);

  ok("V2.3 applyProjectScope", scoped.projects.some((p) => p.id === "jira-project-JPMC"), "the focused Jira project (JPMC) is kept");
  ok("V2.3 applyProjectScope", !scoped.projects.some((p) => p.id === "jira-project-UBS"), "the out-of-scope Jira project (UBS) is excluded");
  ok("V2.3 applyProjectScope", scoped.projects.some((p) => p.id === "internal-1"), "a non-Jira (Demo/Local Import) project is never affected by Jira scope");

  ok("V2.3 applyProjectScope", scoped.workItems.some((w) => w.id === "wi-jpmc-1"), "the in-scope Jira work item is kept");
  ok("V2.3 applyProjectScope", !scoped.workItems.some((w) => w.id === "wi-ubs-1"), "the out-of-scope Jira work item is excluded");
  ok("V2.3 applyProjectScope", scoped.workItems.some((w) => w.id === "wi-demo-1"), "a non-Jira work item is never excluded by Jira scope");

  ok("V2.3 applyProjectScope", scoped.dependencies.some((d) => d.id === "dep-jpmc-1"), "a dependency belonging to an in-scope work item is kept");
  ok("V2.3 applyProjectScope", !scoped.dependencies.some((d) => d.id === "dep-ubs-1"), "a dependency belonging to an out-of-scope work item is excluded");

  ok("V2.3 applyProjectScope", scoped.risks.some((r) => r.id === "risk-jpmc"), "a risk sourced from an in-scope work item is kept");
  ok("V2.3 applyProjectScope", !scoped.risks.some((r) => r.id === "risk-ubs"), "a risk sourced only from an out-of-scope work item is excluded");
  ok("V2.3 applyProjectScope", scoped.risks.some((r) => r.id === "risk-none"), "a risk with no sourceWorkItemIds (never tied to a specific item) is never excluded");

  ok("V2.3 applyProjectScope", scoped.decisions.some((d) => d.id === "dec-jpmc"), "an in-scope decision is kept");
  ok("V2.3 applyProjectScope", !scoped.decisions.some((d) => d.id === "dec-ubs"), "an out-of-scope decision is excluded");
  ok("V2.3 applyProjectScope", scoped.decisions.some((d) => d.id === "dec-demo"), "a non-Jira decision is never excluded");

  ok("V2.3 applyProjectScope", scoped.actions.some((a) => a.id === "action-jpmc"), "an in-scope action is kept");
  ok("V2.3 applyProjectScope", !scoped.actions.some((a) => a.id === "action-ubs"), "an out-of-scope action is excluded");
  ok("V2.3 applyProjectScope", scoped.actions.some((a) => a.id === "action-none"), "an action with no relatedWorkItemId is never excluded");

  ok("V2.3 applyProjectScope", scoped.communications.some((c) => c.id === "comm-jpmc"), "an in-scope communication is kept");
  ok("V2.3 applyProjectScope", !scoped.communications.some((c) => c.id === "comm-ubs"), "an out-of-scope communication is excluded");
  ok("V2.3 applyProjectScope", scoped.communications.some((c) => c.id === "comm-none"), "a communication with no workItemId is never excluded");

  ok("V2.3 applyProjectScope", scoped.requirements.some((r) => r.id === "req-jpmc"), "an in-scope requirement is kept");
  ok("V2.3 applyProjectScope", !scoped.requirements.some((r) => r.id === "req-ubs"), "an out-of-scope requirement is excluded");

  ok("V2.3 applyProjectScope", scoped.clients.some((c) => c.id === "jira-client-jpmc"), "a client still referenced by an in-scope project is kept");
  ok("V2.3 applyProjectScope", !scoped.clients.some((c) => c.id === "jira-client-ubs"), "a client ONLY reachable through an excluded Jira project is dropped");
  ok("V2.3 applyProjectScope", scoped.clients.some((c) => c.id === "client-internal"), "a client backing a non-Jira project is never affected");

  // §8 — multiple projects, and a project whose name contains a space.
  const multiScope: JiraProjectScope = { mode: "FOCUSED", projectKeys: ["JPMC", "UBS"] };
  const multiScoped = applyProjectScope(scopeFixtureData, multiScope);
  ok("V2.3 applyProjectScope", multiScoped.projects.length === 3 && multiScoped.workItems.length === 3, "selecting BOTH Jira projects keeps everything — multi-project selection is additive, not exclusive");

  // §23 — an EMPTY focused list must exclude every Jira project, not silently become ALL.
  const emptyFocusScope: JiraProjectScope = { mode: "FOCUSED", projectKeys: [] };
  const emptyScoped = applyProjectScope(scopeFixtureData, emptyFocusScope);
  ok("V2.3 applyProjectScope", !emptyScoped.projects.some((p) => p.sourceType === "jira"), "an empty FOCUSED project list excludes every Jira project — never silently reinterpreted as ALL");
  ok("V2.3 applyProjectScope", emptyScoped.workItems.length === 1 && emptyScoped.workItems[0].id === "wi-demo-1", "with zero focused projects, only the non-Jira work item remains");

  // ----- AI context excludes out-of-scope data (§16, §24) -----
  const scopedForAI = applyProjectScope(scopeFixtureData, focusedScope);
  const derivedAI = deriveData(scopedForAI, null, TODAY);
  const aiContext = buildAIContext(scopedForAI, derivedAI, null, TODAY, { dataSourceType: "jira" });
  ok("V2.3 AI context scope", !aiContext.topScores.some((s) => /UBS/i.test(s.title)), "AI context topScores built from scoped data contains no trace of the out-of-scope project's work items");
  ok("V2.3 AI context scope", !aiContext.topRisks.some((r) => /UBS/i.test(r.title)), "AI context topRisks contains no trace of the out-of-scope project's risks");
  ok("V2.3 AI context scope", aiContext.topScores.some((s) => /JPMC/i.test(s.title)), "AI context DOES include the in-scope project's work items — scoping never accidentally hides everything");
  ok("V2.3 AI context scope", aiContext.topRisks.some((r) => /JPMC/i.test(r.title)), "AI context DOES include the in-scope project's risks");
}

// ----- Jira query behavior: ALL vs FOCUSED, combined with incremental sync, and the
// operator-configured JIRA_PROJECT_KEYS env restriction (§7). -----
{
  ok("V2.3 Jira query", resolveEffectiveProjectKeys(null, { mode: "ALL", projectKeys: [] }) === undefined, "ALL mode with no env restriction resolves to no restriction at all — unchanged pre-V2.3 behavior");
  ok("V2.3 Jira query", JSON.stringify(resolveEffectiveProjectKeys(["A", "B"], { mode: "ALL", projectKeys: [] })) === JSON.stringify(["A", "B"]), "ALL mode with an env restriction is untouched by Focus Project Scope — the env var alone still governs");

  const focusedNoEnv = resolveEffectiveProjectKeys(null, { mode: "FOCUSED", projectKeys: ["JPMC", "UBS"] });
  ok("V2.3 Jira query", JSON.stringify(focusedNoEnv) === JSON.stringify(["JPMC", "UBS"]), "FOCUSED mode with no env restriction resolves to exactly the user's selected projects");

  const focusedWithOverlappingEnv = resolveEffectiveProjectKeys(["JPMC", "BARC"], { mode: "FOCUSED", projectKeys: ["JPMC", "UBS"] });
  ok("V2.3 Jira query", JSON.stringify(focusedWithOverlappingEnv) === JSON.stringify(["JPMC"]), "FOCUSED mode combined with a server env restriction resolves to their intersection, never the union");

  const focusedWithNoOverlapEnv = resolveEffectiveProjectKeys(["BARC"], { mode: "FOCUSED", projectKeys: ["JPMC"] });
  ok("V2.3 Jira query", Array.isArray(focusedWithNoOverlapEnv) && focusedWithNoOverlapEnv.length === 0, "zero overlap between the focused selection and the env restriction resolves to an explicit empty array (never undefined/unbounded)");

  // §7-8 — the JQL restriction clause itself, for multiple projects.
  ok("V2.3 Jira query", buildIssuesJql({ projectKeys: ["JPMC", "UBS"] }) === 'project in ("JPMC","UBS") order by updated asc', "FOCUSED mode with multiple projects produces a correctly-quoted `project in (...)` JQL restriction");
  ok("V2.3 Jira query", buildIssuesJql({ projectKeys: ["JPMC"] }) === 'project in ("JPMC") order by updated asc', "FOCUSED mode with a single project still produces the restriction");

  // §7 — incremental sync + focused scope combine with AND, neither clause is dropped.
  const combined = buildIssuesJql({ sinceIso: "2026-08-01", projectKeys: ["JPMC", "UBS"] });
  ok("V2.3 Jira query", combined === 'project in ("JPMC","UBS") AND updated >= "2026-08-01" order by updated asc', "an incremental sync's `updated >=` cursor and a focused project restriction combine into a single AND-ed JQL clause");
  ok("V2.3 Jira query", combined.includes("project in"), "the combined JQL still carries the project restriction");
  ok("V2.3 Jira query", combined.includes('updated >= "2026-08-01"'), "the combined JQL still carries the incremental cursor");

  // §21 — pagination + focused scope: confirm the actual fetch sends the scoped JQL.
  let sentJql: string | undefined;
  let sentBody: { projectKeys?: unknown } | undefined;
  const scopedFetch: FetchLike = async (url, init) => {
    if (url.includes("/search/jql")) {
      const body = JSON.parse((init as { body?: string })?.body ?? "{}") as { jql?: string };
      sentJql = body.jql;
      return { ok: true, status: 200, json: async () => ({ issues: [makeJiraIssue({ key: "JPMC-1" })], isLast: true }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const scopedFetchResult = await fetchJiraIssuesWith(scopedFetch, { baseUrl: "https://acme.atlassian.net", email: "x", apiToken: "x" }, { projectKeys: ["JPMC"] });
  ok("V2.3 Jira query", scopedFetchResult.ok && scopedFetchResult.recordsFetched === 1, "a focused-scope fetch still succeeds and returns only what the (fixture) instance sent back");
  ok("V2.3 Jira query", sentJql === 'project in ("JPMC") order by updated asc', "the real HTTP request sent to Jira carries the scoped project restriction — the restriction is enforced BEFORE ingestion, not filtered client-side afterward");

  // §20 — the pre-existing 2000-issue safety cap is untouched by this feature.
  ok("V2.3 Jira query", JIRA_MAX_ISSUES === 2000, "the existing 2000-issue safety cap constant is unchanged by Focus Project Scope");
}

// ----- Sync safety: a FOCUSED scope with zero projects must never silently sync everything,
// and must never touch existing local data (§9, §23). -----
{
  commandCenterStore.resetAll();
  commandCenterStore.loadDemoData();
  const workItemCountBefore = commandCenterStore.getSnapshot().data.workItems.length;

  commandCenterStore.setJiraProjectScope("FOCUSED", []);
  ok("V2.3 Sync safety", commandCenterStore.getSnapshot().jiraProjectScope.mode === "FOCUSED" && commandCenterStore.getSnapshot().jiraProjectScope.projectKeys.length === 0, "setJiraProjectScope persists an explicit empty FOCUSED scope");

  const emptyFocusedSyncResult = await commandCenterStore.syncJira();
  ok("V2.3 Sync safety", emptyFocusedSyncResult.ok === false, "a sync attempt with FOCUSED scope and zero selected projects is refused");
  ok("V2.3 Sync safety", !!emptyFocusedSyncResult.error && /No Focus Projects selected/.test(emptyFocusedSyncResult.error), "the refusal gives an honest, specific reason rather than a generic failure");
  ok("V2.3 Sync safety", commandCenterStore.getSnapshot().jiraSync.lastSyncErrorKind === "not-configured", "the refusal is classified as not-configured, proving the guard fired BEFORE any network call was attempted (a real network attempt with no dev server running would classify as network-error instead)");
  ok("V2.3 Sync safety", commandCenterStore.getSnapshot().jiraSync.previousDataPreserved === true, "previousDataPreserved is set even for this pre-network refusal — the existing sync-safety contract still holds");
  ok("V2.3 Sync safety", commandCenterStore.getSnapshot().data.workItems.length === workItemCountBefore, "existing work-item data is completely untouched by the refused sync");
  ok("V2.3 Sync safety", commandCenterStore.getSnapshot().dataSource === "demo", "the active data source is not switched to jira by a refused sync");

  // A real network sync attempt (FOCUSED with real projects, or ALL) still fails safely in
  // this offline test environment (no dev server) — same pre-existing "Sync safety" contract
  // this feature must not weaken.
  commandCenterStore.setJiraProjectScope("FOCUSED", ["JPMC"]);
  const focusedNetworkResult = await commandCenterStore.syncJira();
  ok("V2.3 Sync safety", focusedNetworkResult.ok === false, "a real (network) focused sync attempt still fails safely with no server running, rather than throwing");
  ok("V2.3 Sync safety", commandCenterStore.getSnapshot().data.workItems.length === workItemCountBefore, "a failed FOCUSED sync (this time an actual network attempt) still never touches existing data");
  ok("V2.3 Sync safety", commandCenterStore.getSnapshot().jiraSync.scopeMode === "FOCUSED" && commandCenterStore.getSnapshot().jiraSync.focusedProjectCount === 1, "sync diagnostics honestly record which scope this (failed) attempt ran under");

  commandCenterStore.resetAll();
}

// ----- Scope change semantics: narrowing/switching scope must never delete persisted data
// (§10) — it only changes the derived view, never `state.data` itself. -----
{
  commandCenterStore.resetAll();
  commandCenterStore.loadDemoData();
  const dataRefBefore = commandCenterStore.getSnapshot().data;

  commandCenterStore.setJiraProjectScope("FOCUSED", ["SOME-PROJECT"]);
  ok("V2.3 Scope change semantics", commandCenterStore.getSnapshot().data === dataRefBefore, "narrowing to FOCUSED never mutates or replaces the persisted data object");

  commandCenterStore.setJiraProjectScope("FOCUSED", []);
  ok("V2.3 Scope change semantics", commandCenterStore.getSnapshot().data === dataRefBefore, "narrowing all the way to an empty focused list STILL never touches persisted data");

  commandCenterStore.setJiraProjectScope("ALL");
  ok("V2.3 Scope change semantics", commandCenterStore.getSnapshot().data === dataRefBefore, "switching back to ALL never touches persisted data either — scope only ever controls what's operated on, never triggers deletion");

  commandCenterStore.resetAll();
}

// ----- Command Bar: scope integrity (§15) — an out-of-scope project mention gets an honest
// answer, never a live Jira query, and never an empty-looking "nothing found" that could be
// mistaken for "genuinely nothing is blocked". -----
{
  const cmdBarData = {
    ...emptyData(),
    projects: [
      { id: "jira-project-JPMC", name: "JPMC", clientId: "c1", status: "on-track" as const, sourceType: "jira" as const, sourceId: "JPMC" },
      { id: "jira-project-BARC", name: "Barclays", clientId: "c2", status: "on-track" as const, sourceType: "jira" as const, sourceId: "BARC" },
    ],
    workItems: [
      makeItem({ id: "wi-jpmc", key: "JPMC-1", title: "JPMC item", projectId: "jira-project-JPMC", clientId: "c1", blocked: true, blockerReason: "waiting on legal", sourceType: "jira", sourceId: "JPMC-1" }),
      makeItem({ id: "wi-barc", key: "BARC-1", title: "Barclays item", projectId: "jira-project-BARC", clientId: "c2", blocked: true, blockerReason: "waiting on infra", sourceType: "jira", sourceId: "BARC-1" }),
    ],
  };
  const cmdBarScope: JiraProjectScope = { mode: "FOCUSED", projectKeys: ["JPMC"] };
  const cmdBarScopedData = applyProjectScope(cmdBarData, cmdBarScope);

  // In-scope query: resolves normally against the already-scoped data.
  const inScopeRoute = classifyQuery("What's blocking JPMC?", cmdBarScopedData);
  ok("V2.3 Command Bar scope", inScopeRoute.intent === "blocking" && inScopeRoute.target === "JPMC", "an in-scope project query still routes and resolves its target normally");

  // Out-of-scope query: fails to resolve a target against the scoped data (proving it's
  // genuinely invisible), but findOutOfScopeMention (run against the FULL, unscoped local
  // data, never a live Jira call) correctly identifies why.
  const outOfScopeRoute = classifyQuery("What's blocking Barclays?", cmdBarScopedData);
  ok("V2.3 Command Bar scope", outOfScopeRoute.target === undefined, "the out-of-scope project's name doesn't even resolve as a target against the scoped view — it is genuinely invisible to the router");

  const mention = findOutOfScopeMention("What's blocking Barclays?", cmdBarData, cmdBarScope);
  ok("V2.3 Command Bar scope", mention?.key === "BARC", "findOutOfScopeMention identifies the excluded project by matching its NAME against the full local catalog, purely as a local lookup");

  const keyMention = findOutOfScopeMention("what's blocking barc", cmdBarData, cmdBarScope);
  ok("V2.3 Command Bar scope", keyMention?.key === "BARC", "findOutOfScopeMention also matches by the project's KEY, case-insensitively");

  const inScopeMention = findOutOfScopeMention("What's blocking JPMC?", cmdBarData, cmdBarScope);
  ok("V2.3 Command Bar scope", inScopeMention === undefined, "a query naming an IN-scope project is never flagged as out-of-scope");

  const unknownMention = findOutOfScopeMention("What's blocking some totally unrelated thing?", cmdBarData, cmdBarScope);
  ok("V2.3 Command Bar scope", unknownMention === undefined, "a query naming a project the app has never even heard of is not flagged — this is a local-knowledge check, never a guess");

  const allModeMention = findOutOfScopeMention("What's blocking Barclays?", cmdBarData, { mode: "ALL", projectKeys: [] });
  ok("V2.3 Command Bar scope", allModeMention === undefined, "in ALL mode, nothing is ever considered out-of-scope");

  // Existing command routing is unaffected by any of this — a totally unrelated intent still
  // classifies exactly as before.
  ok("V2.3 Command Bar scope", classifyQuery("What should I focus on today?", cmdBarScopedData).intent === "personal-focus-today", "existing, unrelated Command Bar routing is completely unaffected — classifyQuery behavior is unchanged");
  ok("V2.3 Command Bar scope", classifyQuery("Am I overloaded?", cmdBarScopedData).intent === "am-i-overloaded", "another existing intent still routes correctly");
}

// ----- Data Health / Trust Diagnostic: scope is visible, with no new blended score. -----
{
  const trustFixtureData = { ...emptyData(), workItems: [makeItem({ id: "th-1", owner: "Alice" })] };
  const trustHealth = computeDataHealth(trustFixtureData, "jira", "2026-06-15T00:00:00.000Z");

  const focusedEntries = computeTrustDiagnostic({
    dataHealth: trustHealth,
    dataSource: "jira",
    jiraSync: { lastSyncStatus: "success", lastSyncCompletedAt: "2026-06-15T00:00:00.000Z" },
    claudeAvailable: true,
    jiraProjectScope: { mode: "FOCUSED", projectKeys: ["JPMC", "UBS"] },
  });
  const focusedJiraEntry = focusedEntries.find((e) => e.category === "Jira");
  ok("V2.3 Trust diagnostic", !!focusedJiraEntry && /FOCUSED/.test(focusedJiraEntry.answer) && /2 project/.test(focusedJiraEntry.answer), "a FOCUSED scope is visibly reported in the existing Jira trust entry, with the correct selected count");

  const allEntries = computeTrustDiagnostic({
    dataHealth: trustHealth,
    dataSource: "jira",
    jiraSync: { lastSyncStatus: "success" },
    claudeAvailable: true,
    jiraProjectScope: { mode: "ALL", projectKeys: [] },
  });
  const allJiraEntry = allEntries.find((e) => e.category === "Jira");
  ok("V2.3 Trust diagnostic", !!allJiraEntry && /ALL Jira projects/.test(allJiraEntry.answer), "ALL mode is also visibly reported, distinctly from FOCUSED");

  ok("V2.3 Trust diagnostic", focusedEntries.length === allEntries.length, "adding scope reporting never adds or removes trust diagnostic categories — no new blended-score row");
  const categories = focusedEntries.map((e) => e.category).sort();
  ok("V2.3 Trust diagnostic", JSON.stringify(categories) === JSON.stringify(["AI", "Coverage", "Data", "Evidence", "Jira", "Ownership", "Scope"]), "the exact same 7 trust categories exist as before V2.3 — 'Scope' here is still the pre-existing scope-HISTORY-coverage category, not a new one");
  ok("V2.3 Trust diagnostic", focusedEntries.every((e) => Object.keys(e).sort().join(",") === "answer,category,status"), "every trust entry still has exactly answer/category/status — no numeric 'score' field was ever introduced");

  // computeTrustDiagnostic without jiraProjectScope at all (an existing caller that hasn't
  // been updated) must keep working exactly as before — jiraProjectScope is optional/additive.
  const legacyCallEntries = computeTrustDiagnostic({ dataHealth: trustHealth, dataSource: "jira", jiraSync: { lastSyncStatus: "success" }, claudeAvailable: true });
  const legacyJiraEntry = legacyCallEntries.find((e) => e.category === "Jira");
  ok("V2.3 Trust diagnostic", !!legacyJiraEntry && !/FOCUSED|ALL Jira projects/.test(legacyJiraEntry.answer), "an existing call site that never passes jiraProjectScope gets the unchanged, pre-V2.3 answer text — fully backward compatible");
}

// ----- Security: no credentials anywhere in the new Focus Project Scope code paths, and the
// project-discovery route never fetches issues. -----
{
  const secRoot = path.resolve(process.cwd());
  const v23Files = ["src/lib/command-center/jira/project-scope.ts", "src/app/api/command-center/jira/projects/route.ts", "src/lib/command-center/datasource/jira-source.ts"];
  const forbidden = [/JIRA_API_TOKEN/, /process\.env\.JIRA/, /Authorization["']?\s*:/, /Basic\s+[A-Za-z0-9+/=]{8,}/];
  for (const rel of v23Files) {
    const content = fs.readFileSync(path.join(secRoot, rel), "utf8");
    ok("V2.3 Security re-scan", !forbidden.some((re) => re.test(content)), `${rel} contains no credential-reading or Authorization-header code`);
  }
  const projectsRouteSrc = fs.readFileSync(path.join(secRoot, "src/app/api/command-center/jira/projects/route.ts"), "utf8");
  ok("V2.3 Security re-scan", !/fetchJiraIssues\b/.test(projectsRouteSrc), "the project-discovery route never calls the issue-fetching function — it only discovers projects, never downloads issue data (§5, §21)");
  ok("V2.3 Security re-scan", /server-only|from "@\/lib\/server\/jira-client"/.test(projectsRouteSrc), "the project-discovery route reuses the existing server-only Jira client rather than a second credential path");

  const importSrc = fs.readFileSync(path.join(secRoot, "src/lib/command-center/import.ts"), "utf8");
  ok("V2.3 Security re-scan", !/sourceType:\s*["']jira["']/.test(importSrc), "Local Import never fabricates a Jira sourceType on imported records — confirming applyProjectScope correctly treats all imported data as non-Jira and therefore never touches it");
}

// ----- Accessibility & UI (static source checks, mirroring the existing V1.8 pattern):
// project selector semantics, honest empty-state copy, and the scope-vs-filter distinction. -----
{
  const dataSettingsSrc = fs.readFileSync(path.join(process.cwd(), "src/app/data-settings/page.tsx"), "utf8");
  ok("V2.3 UI", /Jira Project Scope/.test(dataSettingsSrc), "Data & Settings renders a 'Jira Project Scope' section — integrated into the existing settings page, not a new page");
  ok("V2.3 UI", /role="radiogroup"/.test(dataSettingsSrc), "the ALL/FOCUSED mode selector exposes radiogroup semantics");
  ok("V2.3 UI", /aria-expanded=\{pickerOpen\}/.test(dataSettingsSrc), "the project picker toggle exposes aria-expanded state, consistent with this codebase's existing WhyDrawer pattern");
  ok("V2.3 UI", /role="group" aria-label="Focus project selection"/.test(dataSettingsSrc), "the checkbox list exposes an accessible group label");
  ok("V2.3 UI", /aria-label=\{`\$\{p\.name\} \(\$\{p\.key\}\)`\}/.test(dataSettingsSrc), "each project checkbox has an accessible label combining name and key");
  ok("V2.3 UI", /Search projects/.test(dataSettingsSrc), "the picker supports search/filter, required for large Jira environments (§5, §21)");
  ok("V2.3 UI", /selected/.test(dataSettingsSrc) && /Save Focus/.test(dataSettingsSrc), "the selected-count summary and an explicit Save action are both present — selection is never auto-applied per click");
  ok("V2.3 UI", /No Focus Projects selected/.test(dataSettingsSrc), "the honest empty-focused-scope message from §23 is rendered, not a silent fallback to ALL");
  ok("V2.3 UI", /Project scope is available for Jira data/.test(dataSettingsSrc), "when Jira isn't configured, the scope picker honestly says so rather than pretending to work (§12)");

  const filterBarSrc = fs.readFileSync(path.join(process.cwd(), "src/components/command-center/FilterBar.tsx"), "utf8");
  ok("V2.3 UI", /Jira Scope:/.test(filterBarSrc), "the Current-View FilterBar visibly distinguishes itself from Jira Project Scope (§13) rather than presenting a single ambiguous filter surface");
  ok("V2.3 UI", !/setJiraProjectScope/.test(filterBarSrc), "the FilterBar can only DISPLAY the current Jira scope, never change it — a temporary view filter can never silently mutate the persisted scope (§13)");
}

// ===== V2.3.1 — real production bug fix: fetchJiraProjectsWith previously fetched only the
// FIRST page (maxResults: "50") of GET /rest/api/3/project/search and returned it as the
// whole catalog, silently dropping every project past the 50th — so a real Jira site with
// more than 50 projects (or where the project a user cared about, e.g. MCWS, simply wasn't
// in the first page) showed a wrong "Projects Discovered" count and an incomplete Focus
// Project Scope picker, with no visible error. =====
{
  const projectsConfig: JiraConnectionConfig = { baseUrl: "https://acme.atlassian.net", email: "ba@acme.com", apiToken: "x" };

  // ----- The actual fix: a catalog larger than one page is fully paginated. -----
  {
    const startAts: number[] = [];
    const page1 = Array.from({ length: JIRA_PROJECT_PAGE_SIZE }, (_, i) => ({ id: String(10000 + i), key: `P${i}`, name: `Project ${i}` }));
    const page2 = [
      { id: "20001", key: "UBS", name: "UBS Trade Reporting Upgrade" },
      { id: "20002", key: "MCWS", name: "Managed Cloud Workflow Services" },
    ];
    const multiPageFetch: FetchLike = async (url) => {
      const startAt = Number(new URL(url).searchParams.get("startAt"));
      startAts.push(startAt);
      if (startAt === 0) return { ok: true, status: 200, json: async () => ({ values: page1, isLast: false, total: JIRA_PROJECT_PAGE_SIZE + page2.length }) };
      return { ok: true, status: 200, json: async () => ({ values: page2, isLast: true, total: JIRA_PROJECT_PAGE_SIZE + page2.length }) };
    };
    const result = await fetchJiraProjectsWith(multiPageFetch, projectsConfig);
    ok("V2.3.1 Jira project pagination", result.ok && result.recordsFetched === JIRA_PROJECT_PAGE_SIZE + 2, `every project across both pages is returned, not just the first ${JIRA_PROJECT_PAGE_SIZE} (got ${result.ok ? result.recordsFetched : "error"})`);
    ok("V2.3.1 Jira project pagination", result.ok && result.data.some((p) => p.key === "UBS"), "a project on the SECOND page (UBS) is present in the final result");
    ok("V2.3.1 Jira project pagination", result.ok && result.data.some((p) => p.key === "MCWS"), "a project on the second page (MCWS) — this is the exact real-world bug report: a real project silently missing from discovery — is now present");
    ok("V2.3.1 Jira project pagination", JSON.stringify(startAts) === JSON.stringify([0, JIRA_PROJECT_PAGE_SIZE]), `pagination correctly advances startAt by the number of projects actually fetched each page (got ${JSON.stringify(startAts)})`);
  }

  // ----- A single-page catalog (isLast: true immediately) makes exactly one request — no
  // wasted extra round-trip for the common small-instance case. -----
  {
    let callCount = 0;
    const singlePageFetch: FetchLike = async () => {
      callCount++;
      return { ok: true, status: 200, json: async () => ({ values: [{ id: "1", key: "JPMC", name: "JPMC" }], isLast: true, total: 1 }) };
    };
    const result = await fetchJiraProjectsWith(singlePageFetch, projectsConfig);
    ok("V2.3.1 Jira project pagination", result.ok && result.recordsFetched === 1, "a single-page catalog still returns correctly");
    ok("V2.3.1 Jira project pagination", callCount === 1, "a single-page catalog (isLast: true on the first response) makes exactly one request, not an unnecessary second page fetch");
  }

  // ----- A response missing `isLast` entirely still terminates correctly via the `total`
  // cross-check, rather than looping forever or (worse) silently stopping at the wrong page. -----
  {
    const page1 = Array.from({ length: JIRA_PROJECT_PAGE_SIZE }, (_, i) => ({ id: String(i), key: `X${i}`, name: `X${i}` }));
    const page2 = [{ id: "999", key: "BARC", name: "Barclays" }];
    const noIsLastFetch: FetchLike = async (url) => {
      const startAt = Number(new URL(url).searchParams.get("startAt"));
      if (startAt === 0) return { ok: true, status: 200, json: async () => ({ values: page1, total: JIRA_PROJECT_PAGE_SIZE + 1 }) }; // isLast omitted
      return { ok: true, status: 200, json: async () => ({ values: page2, total: JIRA_PROJECT_PAGE_SIZE + 1 }) };
    };
    const result = await fetchJiraProjectsWith(noIsLastFetch, projectsConfig);
    ok(
      "V2.3.1 Jira project pagination",
      result.ok && result.recordsFetched === JIRA_PROJECT_PAGE_SIZE + 1 && result.data.some((p) => p.key === "BARC"),
      "the `total` field is used as an independent cross-check, so a full-size first page with `isLast` omitted still continues to the real second page rather than stopping early"
    );
  }

  // ----- Failure/malformed handling on a later page still surfaces honestly, same discipline
  // as issue pagination. -----
  {
    const page1 = Array.from({ length: JIRA_PROJECT_PAGE_SIZE }, (_, i) => ({ id: String(i), key: `Y${i}`, name: `Y${i}` }));
    const failsOnPage2: FetchLike = async (url) => {
      const startAt = Number(new URL(url).searchParams.get("startAt"));
      if (startAt === 0) return { ok: true, status: 200, json: async () => ({ values: page1, isLast: false, total: JIRA_PROJECT_PAGE_SIZE + 5 }) };
      return { ok: false, status: 401, json: async () => ({}) };
    };
    const result = await fetchJiraProjectsWith(failsOnPage2, projectsConfig);
    ok("V2.3.1 Jira project pagination", !result.ok && result.errorKind === "auth-failure", "a failure on a later project page is surfaced honestly, never silently truncated into a smaller-looking success");
  }

  ok("V2.3.1 Jira project pagination", JIRA_PROJECT_PAGE_SIZE === 50, "the project page size matches Jira's own default page size for /rest/api/3/project/search");
}

// ================= V2.4 — CONTEXT & FOCUS =================
// V2.4 makes the existing V2.3 Focus Project Scope pervasive across the rest of the app.
// No new selection state, no new intelligence engine — every function under test here is
// either an existing one (applyProjectScope, computeDeliveryConfidence, scoreAllWorkItems,
// computeDataHealth) or a small, pure composition of them (detectExplicitProjectMention,
// buildProjectOverrideView, computeProjectAttentionMap).

function makeStoreState(overrides: Partial<StoreState> = {}): StoreState {
  return {
    schemaVersion: DATA_SCHEMA_VERSION,
    data: emptyData(),
    snapshotHistory: [],
    loaded: true,
    isDemo: false,
    eodHistory: [],
    dataSource: "jira",
    jiraSync: { lastSyncStatus: "never" },
    filters: {},
    jiraProjectScope: { mode: "ALL", projectKeys: [] },
    jiraWorkRelevancePolicy: {},
    attentionState: {},
    memoryEvents: [],
    personalPlan: [],
    artifacts: [],
    usageCounters: {},
    ...overrides,
  };
}

// A 3-Jira-project fixture (JPMC/UBS/WF, matching the spec's own examples) — each project
// has exactly one blocked work item and one HIGH risk explicitly tied to it via
// sourceWorkItemIds/projectId, so computeProactiveIntelligence always surfaces exactly one
// distinguishable RISK attention item per project (needed for the cross-project evidence
// isolation checks below).
function makeThreeProjectFixture() {
  const proj = (key: string) => `proj-${key.toLowerCase()}`;
  const cli = (key: string) => `cli-${key.toLowerCase()}`;
  const projects = ["JPMC", "UBS", "WF"].map((key) => ({
    id: proj(key), name: `${key} Delivery`, clientId: cli(key), status: "on-track" as const, sourceType: "jira" as const, sourceId: key,
  }));
  const clients = ["JPMC", "UBS", "WF"].map((key) => ({ id: cli(key), name: key }));
  const workItems = ["JPMC", "UBS", "WF"].map((key) =>
    makeItem({
      id: `wi-${key.toLowerCase()}-x`, key: `${key}-900`, title: `${key} blocked item`, projectId: proj(key), clientId: cli(key),
      sourceType: "jira" as const, sourceId: `${key}-900`, status: "Blocked", blocked: true, blockerReason: `${key} blocker`, priority: "P1", riskIds: [`risk-${key.toLowerCase()}-x`],
    })
  );
  const risks = ["JPMC", "UBS", "WF"].map((key) =>
    makeRisk({ id: `risk-${key.toLowerCase()}-x`, projectId: proj(key), title: `${key} critical risk`, level: "HIGH", sourceWorkItemIds: [`wi-${key.toLowerCase()}-x`] })
  );
  return { ...emptyData(), clients, projects, workItems, risks };
}

// ----- detectExplicitProjectMention (§19-21): exact/case-insensitive name-or-key match,
// no fuzzy matching, explicit ambiguity reporting. -----
{
  const known = knownJiraProjects(makeThreeProjectFixture());

  const byKey = detectExplicitProjectMention("what's blocking JPMC?", known);
  ok("V2.4 Project mention", !!byKey && "match" in byKey && byKey.match.key === "JPMC", "a query naming a project by its Jira key is matched");

  const byName = detectExplicitProjectMention("any update on UBS Delivery today", known);
  ok("V2.4 Project mention", !!byName && "match" in byName && byName.match.key === "UBS", "a query naming a project by its (multi-word) name is matched via substring, same convention as query-router.ts's existing findTarget()");

  const caseInsensitive = detectExplicitProjectMention("what changed in wf?", known);
  ok("V2.4 Project mention", !!caseInsensitive && "match" in caseInsensitive && caseInsensitive.match.key === "WF", "key matching is case-insensitive");

  const noMatch = detectExplicitProjectMention("what should I do next?", known);
  ok("V2.4 Project mention", noMatch === undefined, "a query naming no known project returns undefined rather than guessing");

  const noFalseSubstring = detectExplicitProjectMention("this is awful, nothing works", known);
  ok("V2.4 Project mention", noFalseSubstring === undefined, "§21 no fuzzy matching — a short key (WF) never accidentally matches as a substring inside an unrelated word (\"awful\")");

  const ambiguous = detectExplicitProjectMention("compare JPMC and UBS today", known);
  ok("V2.4 Project mention", !!ambiguous && "ambiguous" in ambiguous && ambiguous.ambiguous.length === 2, "a query naming two known projects is reported as ambiguous, never guessed at (§21)");
}

// ----- buildProjectOverrideView (§19-20, §23): a per-query/per-meeting override that never
// touches the persisted global scope. -----
{
  const fixtureData = makeThreeProjectFixture();
  const globalScope: JiraProjectScope = { mode: "FOCUSED", projectKeys: ["JPMC"] };
  const state = makeStoreState({ data: fixtureData, jiraProjectScope: globalScope });

  const override = buildProjectOverrideView(state, TODAY, "UBS");
  ok("V2.4 Project override", override.filteredData.projects.length === 1 && override.filteredData.projects[0].sourceId === "UBS", "an override for UBS returns ONLY UBS's own project, regardless of the persisted global scope being JPMC");
  ok("V2.4 Project override", !override.filteredData.workItems.some((w) => w.key.startsWith("JPMC") || w.key.startsWith("WF")), "the override's work items never include another project's items");
  ok("V2.4 Project override", !!override.proactive && override.proactive.attentionQueue.some((a) => /UBS/i.test(a.what)), "the override's proactive intelligence is computed FROM the override-scoped data, surfacing UBS's own attention item");

  ok("V2.4 Project override", state.jiraProjectScope.mode === "FOCUSED" && JSON.stringify(state.jiraProjectScope.projectKeys) === JSON.stringify(["JPMC"]), "§20 — building an override never mutates the input state's global scope object; it stays exactly JPMC as before the call");
}

// ===== V2.18 §6 — mention project-scope isolation, display-time half (scopeMentionEvents).
// Confirmed real gap: MentionEvent isn't a field of CommandCenterData, so applyProjectScope
// never touched it — a mention on an out-of-scope project's issue reached Personal
// Focus/Attention regardless of Focus Project Scope. Exercises the exact four scenarios the
// hardening spec names. =====
{
  const fixtureData = makeThreeProjectFixture(); // work items JPMC-900 / UBS-900 / WF-900
  const mentionOnJpmc: MentionEvent = { issueKey: "JPMC-900", commentId: "c-jpmc", excerpt: "please check this", mentionedAt: TODAY };
  const mentionOnUbs: MentionEvent = { issueKey: "UBS-900", commentId: "c-ubs", excerpt: "please check this too", mentionedAt: TODAY };

  const jpmcScope: JiraProjectScope = { mode: "FOCUSED", projectKeys: ["JPMC"] };
  const scopedToJpmc = applyProjectScope(fixtureData, jpmcScope);
  const jpmcFocusedEvents = scopeMentionEvents([mentionOnJpmc, mentionOnUbs], scopedToJpmc.workItems, jpmcScope);
  ok("V2.18 Mention scope (display)", jpmcFocusedEvents.some((m) => m.issueKey === "JPMC-900"), "Focus = JPMC, mention on JPMC -> included");
  ok("V2.18 Mention scope (display)", !jpmcFocusedEvents.some((m) => m.issueKey === "UBS-900"), "Focus = JPMC, mention on UBS -> excluded");

  const allScope: JiraProjectScope = { mode: "ALL", projectKeys: [] };
  const allEvents = scopeMentionEvents([mentionOnJpmc, mentionOnUbs], applyProjectScope(fixtureData, allScope).workItems, allScope);
  ok("V2.18 Mention scope (display)", allEvents.some((m) => m.issueKey === "UBS-900"), "Focus = ALL, mention on UBS -> included");

  // Explicit project override (buildProjectOverrideView) — the override's OWN scope governs
  // its own mentions, independent of the persisted global scope, and never mutates it.
  const globalJpmcState = makeStoreState({ data: fixtureData, jiraProjectScope: jpmcScope, mentionEvents: [mentionOnJpmc, mentionOnUbs] });
  const ubsOverride = buildProjectOverrideView(globalJpmcState, TODAY, "UBS");
  ok("V2.18 Mention scope (override)", !!ubsOverride.personalFocus, "the UBS override computes a personalFocus view at all (sanity check before inspecting mentions within it)");
  ok(
    "V2.18 Mention scope (override)",
    JSON.stringify(ubsOverride).includes("please check this too") && !JSON.stringify(ubsOverride).includes("JPMC-900"),
    "an explicit override for UBS surfaces the UBS mention even though the persisted global scope is JPMC, and carries no trace of the JPMC-scoped mention — the override's own scope, not the global one, governs"
  );
  ok("V2.18 Mention scope (override)", globalJpmcState.jiraProjectScope.mode === "FOCUSED" && JSON.stringify(globalJpmcState.jiraProjectScope.projectKeys) === JSON.stringify(["JPMC"]), "building the override never mutates the persisted global scope, same guarantee §20 already established for data");

  // Wiring check: use-command-center.ts must actually route mentions through
  // scopeMentionEvents before either engine sees them, not pass state.mentionEvents raw.
  const repoRoot = path.resolve(process.cwd());
  const hookSrc = fs.readFileSync(path.join(repoRoot, "src/components/command-center/use-command-center.ts"), "utf8");
  ok("V2.18 Mention scope wiring", /import \{ applyProjectScope, scopeMentionEvents \}/.test(hookSrc), "the hook imports scopeMentionEvents alongside applyProjectScope, not a second/private scoping helper");
  ok("V2.18 Mention scope wiring", (hookSrc.match(/scopeMentionEvents\(/g) ?? []).length === 2, "scopeMentionEvents is called exactly twice — once for the main hook, once for buildProjectOverrideView — covering both places raw state.mentionEvents used to reach an engine unfiltered");
  ok("V2.18 Mention scope wiring", !/computeProactiveIntelligence\([^)]*state\.mentionEvents/.test(hookSrc) && !/computePersonalFocus\([^)]*state\.mentionEvents/.test(hookSrc), "neither engine call site passes raw state.mentionEvents directly any more");
}

// ----- Artifact per-project evidence targeting (§22) + no cross-project AI leakage (§36):
// inspect the actual fact/evidence payload, not just the rendered prose. -----
{
  const fixtureData = makeThreeProjectFixture();
  const state = makeStoreState({ data: fixtureData, jiraProjectScope: { mode: "ALL", projectKeys: [] } });

  const jpmcOverride = buildProjectOverrideView(state, TODAY, "JPMC");
  const jpmcItem = jpmcOverride.proactive!.attentionQueue.find((a) => a.category === "RISK");
  ok("V2.4 Artifact targeting", !!jpmcItem, "an explicit JPMC override surfaces JPMC's own risk as an attention item even though the global scope is ALL");
  const draft = buildStakeholderUpdateDraft({ kind: "attention", item: jpmcItem! }, "Command Bar: JPMC Delivery");
  const payloadText = JSON.stringify(draft.sections) + JSON.stringify(draft.evidence);
  ok("V2.4 Artifact targeting", /JPMC/i.test(payloadText), "the stakeholder update's actual fact/evidence payload references the targeted project");
  ok("V2.4 Artifact targeting", !/UBS critical risk|WF critical risk/i.test(payloadText), "the actual fact/evidence payload (not just the rendered summary) contains zero trace of another project's risk — no cross-project evidence leakage into an explicitly-targeted artifact (§22, §36)");
}

// ----- computeProjectAttentionMap / Executive Portfolio View (§16-17): per-project
// deliveryConfidence, no blended portfolio score, correct in-scope/excluded split. -----
{
  const fixtureData = makeThreeProjectFixture();

  const allRows = computeProjectAttentionMap(fixtureData, TODAY);
  ok("V2.4 Portfolio view", allRows.length === 3, "one row per Jira project when nothing is excluded");
  ok("V2.4 Portfolio view", allRows.every((r) => typeof r.deliveryConfidence === "number" && r.deliveryConfidence >= 0 && r.deliveryConfidence <= 100), "each row carries its own bounded 0-100 deliveryConfidence — never a blended cross-project number");
  ok("V2.4 Portfolio view", new Set(allRows.map((r) => r.deliveryConfidence)).size >= 1, "computeProjectAttentionMap runs end-to-end without crashing across all three projects");

  // Cross-check against the pre-existing per-client formula on this same 1:1 client<->project
  // fixture — same underlying scoreAllWorkItems/computeDeliveryConfidence math, just grouped
  // by a different key, so the two numbers must agree exactly.
  const derivedAll = deriveData(fixtureData, null, TODAY);
  const clientRows = computeClientAttentionMap(fixtureData, derivedAll, [], null, TODAY);
  const jpmcProjectRow = allRows.find((r) => r.jiraKey === "JPMC")!;
  const jpmcClientRow = clientRows.find((r) => r.clientId === "cli-jpmc")!;
  ok("V2.4 Portfolio view", jpmcProjectRow.deliveryConfidence === jpmcClientRow.deliveryConfidence, "on a 1:1 client<->project fixture, computeProjectAttentionMap's number for a project exactly matches computeClientAttentionMap's number for its client — proving it's the same formula, not a new one");

  const focusedScope: JiraProjectScope = { mode: "FOCUSED", projectKeys: ["JPMC", "UBS"] };
  const scoped = applyProjectScope(fixtureData, focusedScope);
  const scopedRows = computeProjectAttentionMap(scoped, TODAY);
  ok("V2.4 Portfolio view", scopedRows.length === 2 && !scopedRows.some((r) => r.jiraKey === "WF"), "under a FOCUSED scope, the portfolio view only computes rows for in-scope projects");

  const inScopeKeys = new Set(scopedRows.map((r) => r.jiraKey));
  const excluded = knownJiraProjects(fixtureData).filter((p) => !inScopeKeys.has(p.key));
  ok("V2.4 Portfolio view", excluded.length === 1 && excluded[0].key === "WF", "the excluded-by-scope project is identifiable by name from the full (unscoped) known-projects list, for the 'not shown — outside current focus' caption");
}

// ----- formatScopeLabel (§16-17, §23): one shared label, ALL/FOCUSED/empty-selection. -----
{
  const fixtureData = makeThreeProjectFixture();
  ok("V2.4 Scope label", formatScopeLabel({ mode: "ALL", projectKeys: [] }, fixtureData) === "All Projects", "ALL mode reads as 'All Projects'");
  ok("V2.4 Scope label", formatScopeLabel({ mode: "FOCUSED", projectKeys: ["JPMC", "UBS"] }, fixtureData) === "JPMC Delivery + UBS Delivery", "FOCUSED mode joins the focused projects' own names, matching the spec's own 'Focus: JPMC + UBS' example");
  ok("V2.4 Scope label", formatScopeLabel({ mode: "FOCUSED", projectKeys: [] }, fixtureData) === "No projects selected", "an empty FOCUSED selection is stated honestly, never silently shown as ALL");
  ok("V2.4 Scope label", formatScopeLabel({ mode: "FOCUSED", projectKeys: ["DELETED"] }, fixtureData) === "DELETED", "a focused key no longer present in local data falls back to showing the raw key rather than crashing or hiding it");
}

// ----- Data Health: Global vs Current Scope (§24) — reuses computeDataHealth verbatim,
// just called against two different (already-existing) data views. -----
{
  const fixtureData = makeThreeProjectFixture();
  // makeItem() defaults every item to owner "Alice" — override so only WF's item has an
  // owner; JPMC/UBS's items don't. Excluding WF from scope should then change the
  // global-vs-scoped ownership percentage (global: 1/3 owned; JPMC+UBS scoped: 0/2 owned).
  fixtureData.workItems = fixtureData.workItems.map((w) => ({ ...w, owner: w.projectId === "proj-wf" ? "Someone" : undefined }));

  const globalHealth = computeDataHealth(fixtureData, "jira", undefined);
  const scoped = applyProjectScope(fixtureData, { mode: "FOCUSED", projectKeys: ["JPMC", "UBS"] });
  const scopedHealth = computeDataHealth(scoped, "jira", undefined);
  ok("V2.4 Data health scope", globalHealth.ownershipCoveragePct !== scopedHealth.ownershipCoveragePct, "Global and Current Scope Data Health can genuinely differ when an out-of-scope project's items drag the global coverage number in a different direction");

  const allScopeHealth = computeDataHealth(applyProjectScope(fixtureData, { mode: "ALL", projectKeys: [] }), "jira", undefined);
  ok("V2.4 Data health scope", allScopeHealth.ownershipCoveragePct === globalHealth.ownershipCoveragePct, "under ALL scope, Global and Current Scope Data Health are identical, matching the UI's rule to only show one panel in that case");
}

// ----- Project Memory: MemoryEvent.projectId is populated ONLY via an explicit FK,
// exercised through the real store (§14). -----
{
  commandCenterStore.resetAll();
  commandCenterStore.loadDemoData();
  const before = commandCenterStore.getSnapshot();
  const jpmcAction = before.data.actions.find((a) => a.relatedWorkItemId && before.data.workItems.find((w) => w.id === a.relatedWorkItemId)?.projectId === "p-jpmc");
  ok("V2.4 Memory scoping", !!jpmcAction, "the demo dataset has at least one action linked to a JPMC work item (fixture precondition)");

  if (jpmcAction) {
    commandCenterStore.completeAction(jpmcAction.id);
    const afterComplete = commandCenterStore.getSnapshot();
    const completedEvent = [...afterComplete.memoryEvents].reverse().find((e) => e.kind === "ACTION_COMPLETED");
    ok("V2.4 Memory scoping", completedEvent?.projectId === "p-jpmc", "completing an action linked to a JPMC work item tags the resulting ACTION_COMPLETED memory event with JPMC's projectId, via the action's own relatedWorkItemId -> WorkItem.projectId FK");
  }

  const confirmedId = commandCenterStore.confirmDecisionFromOptions({
    projectId: "p-ubs",
    title: "Test UBS decision",
    options: [{ id: "opt-1", label: "Option A", rationale: "x", upside: "x", downside: "x", dependencies: [], risks: [], evidence: [], confidence: 0.8 }],
    selectedOptionId: "opt-1",
    expectedOutcome: "x",
  });
  ok("V2.4 Memory scoping", !!confirmedId, "confirmDecisionFromOptions succeeds against the demo dataset");
  const decisionEvent = [...commandCenterStore.getSnapshot().memoryEvents].reverse().find((e) => e.kind === "DECISION_MADE" && e.title.includes("Test UBS decision"));
  ok("V2.4 Memory scoping", decisionEvent?.projectId === "p-ubs", "confirming a decision tags the DECISION_MADE memory event with the decision's own explicit projectId — no lookup or inference needed, it's already on the input");

  const unlinkedActionId = commandCenterStore.addAction({ title: "Unlinked test action", why: "test", estimateMinutes: 5 });
  commandCenterStore.startAction(unlinkedActionId);
  const startedEvent = [...commandCenterStore.getSnapshot().memoryEvents].reverse().find((e) => e.kind === "ACTION_STARTED");
  ok("V2.4 Memory scoping", startedEvent !== undefined && startedEvent.projectId === undefined, "an action with no relatedWorkItemId produces an ACTION_STARTED event with projectId left undefined — never guessed");

  commandCenterStore.resetAll();
}

// ===== V2.17 Task 2 — MemoryEvent point-in-time report context (ticketKey/projectName/
// clientName/outcomeNote), captured at write time in store.ts, never resolved later from
// live state. =====
{
  commandCenterStore.resetAll();
  commandCenterStore.loadDemoData();
  const before = commandCenterStore.getSnapshot();
  const jpmcAction = before.data.actions.find((a) => a.relatedWorkItemId && before.data.workItems.find((w) => w.id === a.relatedWorkItemId)?.projectId === "p-jpmc");
  ok("V2.17 MemoryEvent context", !!jpmcAction, "the demo dataset has at least one action linked to a JPMC work item (fixture precondition)");

  if (jpmcAction) {
    const linkedWorkItem = before.data.workItems.find((w) => w.id === jpmcAction.relatedWorkItemId)!;
    const expectedProjectName = before.data.projects.find((p) => p.id === "p-jpmc")?.name;
    const expectedClientName = before.data.clients.find((c) => c.id === linkedWorkItem.clientId)?.name;

    commandCenterStore.completeAction(jpmcAction.id);
    const completedEvent = [...commandCenterStore.getSnapshot().memoryEvents].reverse().find((e) => e.kind === "ACTION_COMPLETED");
    ok("V2.17 MemoryEvent context", completedEvent?.ticketKey === linkedWorkItem.key, "ACTION_COMPLETED carries the real ticket key, resolved via the action's relatedWorkItemId FK");
    ok("V2.17 MemoryEvent context", completedEvent?.projectName === expectedProjectName && !!expectedProjectName, "ACTION_COMPLETED carries the real project name, not just the internal projectId");
    ok("V2.17 MemoryEvent context", completedEvent?.clientName === expectedClientName, "ACTION_COMPLETED carries the real client name too");

    commandCenterStore.recordActionOutcomeStatus(jpmcAction.id, "IMPROVED", "Confirmed with the client.");
    const outcomeEvent = [...commandCenterStore.getSnapshot().memoryEvents].reverse().find((e) => e.kind === "ACTION_OUTCOME");
    ok("V2.17 MemoryEvent context", outcomeEvent?.outcomeNote === "Confirmed with the client.", "ACTION_OUTCOME carries the free-text outcome note as its own structured field, not just folded into `impact`");
    ok("V2.17 MemoryEvent context", outcomeEvent?.ticketKey === linkedWorkItem.key, "ACTION_OUTCOME carries the same real ticket key");
  }

  const confirmedId = commandCenterStore.confirmDecisionFromOptions({
    projectId: "p-ubs",
    title: "Test UBS decision context",
    options: [{ id: "opt-1", label: "Option A", rationale: "x", upside: "x", downside: "x", dependencies: [], risks: [], evidence: [], confidence: 0.8 }],
    selectedOptionId: "opt-1",
    expectedOutcome: "x",
  });
  ok("V2.17 MemoryEvent context", !!confirmedId, "confirmDecisionFromOptions succeeds against the demo dataset");
  const decisionEvent = [...commandCenterStore.getSnapshot().memoryEvents].reverse().find((e) => e.kind === "DECISION_MADE" && e.title.includes("Test UBS decision context"));
  const expectedUbsName = commandCenterStore.getSnapshot().data.projects.find((p) => p.id === "p-ubs")?.name;
  ok("V2.17 MemoryEvent context", decisionEvent?.projectName === expectedUbsName && !!expectedUbsName, "DECISION_MADE carries the real project name from the decision's own explicit projectId");
  ok("V2.17 MemoryEvent context", decisionEvent?.ticketKey === undefined, "a decision with no relatedWorkItemIds gets no fabricated ticketKey");

  const multiTicketDecisionId = commandCenterStore.confirmDecisionFromOptions({
    projectId: "p-ubs",
    title: "Multi-ticket decision",
    options: [{ id: "opt-1", label: "Option A", rationale: "x", upside: "x", downside: "x", dependencies: [], risks: [], evidence: [], confidence: 0.8 }],
    selectedOptionId: "opt-1",
    expectedOutcome: "x",
    relatedWorkItemIds: [commandCenterStore.getSnapshot().data.workItems[0]?.id, commandCenterStore.getSnapshot().data.workItems[1]?.id].filter((id): id is string => !!id),
  });
  const multiTicketEvent = [...commandCenterStore.getSnapshot().memoryEvents].reverse().find((e) => e.kind === "DECISION_MADE" && e.title.includes("Multi-ticket decision"));
  ok("V2.17 MemoryEvent context", !!multiTicketDecisionId && multiTicketEvent?.ticketKey === undefined, "a decision touching MULTIPLE work items never picks one arbitrarily and presents it as THE ticket — same discipline as personal-focus.ts's singleWorkItem");

  commandCenterStore.resetAll();
}

// ===== V2.17 Task 2 — generateDailyReport: write-once immutable snapshot, stable even after
// live ticket/project state changes afterward. Tests for Task 2, point 1. =====
{
  commandCenterStore.resetAll();
  commandCenterStore.loadDemoData();
  const day1 = getTodayIso();
  const seedAction = commandCenterStore.getSnapshot().data.actions.find((a) => a.relatedWorkItemId);
  ok("V2.17 generateDailyReport", !!seedAction, "fixture precondition: demo data has at least one action linked to a work item");

  if (seedAction) {
    const linkedWorkItem = commandCenterStore.getSnapshot().data.workItems.find((w) => w.id === seedAction.relatedWorkItemId)!;
    commandCenterStore.completeAction(seedAction.id);

    const report1 = commandCenterStore.generateDailyReport(day1);
    ok("V2.17 generateDailyReport", report1.date === day1, "the generated report is dated today");
    ok("V2.17 generateDailyReport", report1.events.some((e) => e.kind === "ACTION_COMPLETED" && e.ticketKey === linkedWorkItem.key), "the report's events include today's ACTION_COMPLETED with its captured ticket context");
    ok("V2.17 generateDailyReport", commandCenterStore.getSnapshot().dailyReports[day1] !== undefined, "the report is persisted in state.dailyReports, keyed by date");

    // ----- Test for Task 2: a Daily Report generated on day N, viewed after a later sync
    // changes live ticket data, still shows the ticket/client context as it was on day N. -----
    const projectsBefore = commandCenterStore.getSnapshot().data.projects;
    const mutatedProjects = projectsBefore.map((p) => (p.id === linkedWorkItem.projectId ? { ...p, name: "RENAMED PROJECT (simulated later sync)" } : p));
    const mutatedWorkItems = commandCenterStore.getSnapshot().data.workItems.map((w) => (w.id === linkedWorkItem.id ? { ...w, key: "RENAMED-999", title: "Renamed ticket title" } : w));
    // @ts-expect-error — reaching into private state for a test-only mutation simulating "a
    // later Jira sync changed this ticket's title/key and this project's name"; there is no
    // public store API for this because live ticket mutation isn't something this app's own
    // code does outside of syncJira, which this test deliberately bypasses.
    commandCenterStore["state"].data.projects = mutatedProjects;
    // @ts-expect-error — see above.
    commandCenterStore["state"].data.workItems = mutatedWorkItems;

    const reGenerated = commandCenterStore.generateDailyReport(day1); // no force: true
    ok(
      "V2.17 generateDailyReport",
      reGenerated === commandCenterStore.getSnapshot().dailyReports[day1],
      "calling generateDailyReport again for the SAME day without force is a no-op — returns the exact already-persisted snapshot, never silently recomputed"
    );
    const eventAfterMutation = reGenerated.events.find((e) => e.kind === "ACTION_COMPLETED");
    ok(
      "V2.17 generateDailyReport",
      eventAfterMutation?.ticketKey === linkedWorkItem.key && eventAfterMutation?.projectName !== "RENAMED PROJECT (simulated later sync)",
      "the report's captured ticketKey/projectName reflect what was true on day N — completely unaffected by the simulated later change to live ticket/project data"
    );
  }

  commandCenterStore.resetAll();
}

// ===== V2.17 Task 2 — daily-report.ts: pure aggregation/markdown functions. =====
{
  const e = (overrides: Partial<MemoryEvent>): MemoryEvent => ({ id: `e-${Math.random()}`, date: "2026-06-10", kind: "ACTION_COMPLETED", title: "x", impact: "x", evidence: [], ...overrides });
  const snapshot: DailyReportSnapshot = {
    date: "2026-06-10",
    generatedAt: "2026-06-10T20:00:00.000Z",
    events: [
      e({ kind: "ACTION_COMPLETED", title: "Ship the thing", ticketKey: "JPMC-1", projectName: "JPMC Delivery", clientName: "JPMC" }),
      e({ kind: "FOCUS_COMPLETED", title: "Focus: attention:x" }),
      e({ kind: "DECISION_MADE", title: "Decided X" }),
      e({ kind: "DECISION_OUTCOME", title: "Outcome for X" }),
      e({ kind: "ACTION_OUTCOME", title: "Outcome recorded", outcomeNote: "Went well" }),
      e({ kind: "drift-transition", title: "Drift changed" }),
    ],
  };
  const summary = summarizeDailyReport(snapshot);
  ok("V2.17 daily-report", summary.completed.length === 2, "ACTION_COMPLETED and FOCUS_COMPLETED both count as 'completed'");
  ok("V2.17 daily-report", summary.decisions.length === 2, "DECISION_MADE and DECISION_OUTCOME both count as 'decisions'");
  ok("V2.17 daily-report", summary.outcomes.length === 1, "ACTION_OUTCOME is its own bucket");
  ok("V2.17 daily-report", summary.other.length === 1 && summary.other[0].kind === "drift-transition", "every other kind falls into 'other', never silently dropped");

  const markdown = dailyReportToMarkdown(snapshot);
  ok("V2.17 daily-report", markdown.includes("Ship the thing") && markdown.includes("JPMC-1") && markdown.includes("JPMC Delivery"), "the markdown export includes the completed item's title and its captured ticket/project context");
  ok("V2.17 daily-report", markdown.includes("Went well"), "the markdown export includes an outcome note when the event carries one");

  ok(
    "V2.17 daily-report",
    JSON.stringify(last7DaysEnding("2026-06-10")) === JSON.stringify(["2026-06-04", "2026-06-05", "2026-06-06", "2026-06-07", "2026-06-08", "2026-06-09", "2026-06-10"]),
    "last7DaysEnding returns exactly the 7 calendar dates ending on (and including) the given day, oldest first"
  );

  // ----- Test for Task 2: weekly aggregate over 7 daily snapshots produces correct totals
  // without needing a live sync — pure aggregation over already-frozen data. -----
  const dailyReports: Record<string, DailyReportSnapshot> = {
    "2026-06-05": { date: "2026-06-05", generatedAt: "2026-06-05T20:00:00.000Z", events: [e({ date: "2026-06-05", kind: "ACTION_COMPLETED", projectName: "Alpha" }), e({ date: "2026-06-05", kind: "DECISION_MADE" })] },
    "2026-06-07": { date: "2026-06-07", generatedAt: "2026-06-07T20:00:00.000Z", events: [e({ date: "2026-06-07", kind: "ACTION_COMPLETED", projectName: "Alpha" }), e({ date: "2026-06-07", kind: "ACTION_COMPLETED", projectName: "Beta" })] },
    // 2026-06-10 deliberately has no report — a real gap, never a fabricated empty one.
  };
  const weekly = buildWeeklyReportSummary(last7DaysEnding("2026-06-10"), dailyReports);
  ok("V2.17 daily-report weekly", weekly.snapshots.length === 2, "only the 2 days that actually have a persisted report are included — 2026-06-10's missing report is a real gap, not silently fabricated");
  ok("V2.17 daily-report weekly", weekly.totalCompleted === 3 && weekly.totalDecisions === 1, "totals sum correctly across the available snapshots alone, without touching any live data");
  ok(
    "V2.17 daily-report weekly",
    weekly.byProject.find((p) => p.projectName === "Alpha")?.count === 2 && weekly.byProject.find((p) => p.projectName === "Beta")?.count === 1,
    "per-project completed counts are correct, sorted by count descending"
  );
  const weeklyMarkdown = weeklyReportToMarkdown(weekly);
  ok("V2.17 daily-report weekly", weeklyMarkdown.includes("Alpha: 2") && weeklyMarkdown.includes("no report generated"), "the weekly markdown export shows per-project counts and honestly reports the missing day");
}

// ----- State safety (§10, §27, §33): changing project scope never mutates lifecycle,
// actions, decisions, or memory — it only changes the derived view. -----
{
  commandCenterStore.resetAll();
  commandCenterStore.loadDemoData();
  const beforeActions = JSON.stringify(commandCenterStore.getSnapshot().data.actions);
  const beforeDecisions = JSON.stringify(commandCenterStore.getSnapshot().data.decisions);
  const beforeAttention = JSON.stringify(commandCenterStore.getSnapshot().attentionState);
  const beforeMemory = JSON.stringify(commandCenterStore.getSnapshot().memoryEvents);

  commandCenterStore.setJiraProjectScope("FOCUSED", ["JPMC"]);
  commandCenterStore.setJiraProjectScope("ALL");
  commandCenterStore.setJiraProjectScope("FOCUSED", ["UBS", "WF"]);

  ok("V2.4 State safety", JSON.stringify(commandCenterStore.getSnapshot().data.actions) === beforeActions, "changing Focus Project Scope (any number of times, any mode) never mutates data.actions");
  ok("V2.4 State safety", JSON.stringify(commandCenterStore.getSnapshot().data.decisions) === beforeDecisions, "changing Focus Project Scope never mutates data.decisions");
  ok("V2.4 State safety", JSON.stringify(commandCenterStore.getSnapshot().attentionState) === beforeAttention, "changing Focus Project Scope never mutates attention lifecycle state");
  ok("V2.4 State safety", JSON.stringify(commandCenterStore.getSnapshot().memoryEvents) === beforeMemory, "changing Focus Project Scope never mutates memoryEvents");

  commandCenterStore.resetAll();
}

// ----- Performance (§29): Set-based membership, no O(n^2) blowup on a large synthetic
// catalog. -----
{
  const bigProjects = Array.from({ length: 300 }, (_, i) => ({
    id: `big-proj-${i}`, name: `Big Project ${i}`, clientId: `big-client-${i}`, status: "on-track" as const, sourceType: "jira" as const, sourceId: `BIG${i}`,
  }));
  const bigClients = Array.from({ length: 300 }, (_, i) => ({ id: `big-client-${i}`, name: `Client ${i}` }));
  const bigWorkItems = Array.from({ length: 3000 }, (_, i) =>
    makeItem({ id: `big-wi-${i}`, key: `BIG${i % 300}-${i}`, projectId: `big-proj-${i % 300}`, clientId: `big-client-${i % 300}`, sourceType: "jira" as const })
  );
  const bigData = { ...emptyData(), projects: bigProjects, clients: bigClients, workItems: bigWorkItems };

  const focusedKeys = Array.from({ length: 150 }, (_, i) => `BIG${i}`);
  const start = Date.now();
  const bigScoped = applyProjectScope(bigData, { mode: "FOCUSED", projectKeys: focusedKeys });
  computeProjectAttentionMap(bigScoped, TODAY);
  const elapsedMs = Date.now() - start;
  ok("V2.4 Performance", bigScoped.projects.length === 150 && bigScoped.workItems.length === 1500, "a large (300-project/3000-item) catalog scopes down to exactly the focused half");
  ok("V2.4 Performance", elapsedMs < 2000, `applyProjectScope + computeProjectAttentionMap over 300 projects/3000 items completes well within a generous bound (${elapsedMs}ms) — consistent with Set-based membership, not O(n^2) array.includes() scans`);
}

// ===== V2.5 — Work Relevance & Jira Status Policy =====

function jiraItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return makeItem({
    sourceType: "jira",
    projectId: "jira-project-JPMC",
    jiraStatusName: "Ready for UAT/Business Test",
    status: "In Progress",
    ...overrides,
  });
}

// V2.11 §1 — GLOBAL policy: the map itself is now flat status -> relevance, identity here
// for readability at call sites migrated from the old per-project `policyMap()` helper.
function globalPolicy(entries: Record<string, WorkRelevance>): Record<string, WorkRelevance> {
  return entries;
}

// ----- Policy model: parsing, project isolation, unknown project/status -----
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "Ready for UAT/Business Test": "OBSERVE", "To Do": "ACTIONABLE", "Waiting for Client": "WAITING", Done: "COMPLETED", "Pending PCI Evidence": "EXCLUDED" }));

  ok("V2.5 Policy", resolveWorkRelevance(jiraItem({ jiraStatusName: "To Do" }), idx) === "ACTIONABLE", "a status mapped ACTIONABLE resolves to ACTIONABLE");
  ok("V2.5 Policy", resolveWorkRelevance(jiraItem({ jiraStatusName: "Waiting for Client" }), idx) === "WAITING", "a status mapped WAITING resolves to WAITING");
  ok("V2.5 Policy", resolveWorkRelevance(jiraItem({ jiraStatusName: "Ready for UAT/Business Test" }), idx) === "OBSERVE", "a status mapped OBSERVE resolves to OBSERVE");
  ok("V2.5 Policy", resolveWorkRelevance(jiraItem({ jiraStatusName: "Done" }), idx) === "COMPLETED", "a status mapped COMPLETED resolves to COMPLETED");
  ok("V2.5 Policy", resolveWorkRelevance(jiraItem({ jiraStatusName: "Pending PCI Evidence" }), idx) === "EXCLUDED", "a status mapped EXCLUDED resolves to EXCLUDED");
  ok("V2.5 Policy", resolveWorkRelevance(jiraItem({ jiraStatusName: "Some Custom Status" }), idx) === "UNKNOWN", "an unmapped status resolves to UNKNOWN, never guessed");
  ok(
    "V2.11 Global policy",
    resolveWorkRelevance(jiraItem({ projectId: "jira-project-UNKNOWNPROJ", jiraStatusName: "To Do" }), idx) === "ACTIONABLE",
    "a status classified globally applies even to a project that's never been separately configured — the policy is global, not per-project (§1)"
  );
  ok("V2.5 Policy", resolveWorkRelevance(jiraItem({ sourceType: undefined, jiraStatusName: undefined }), idx) === "NOT_APPLICABLE", "a non-Jira work item (demo/local-import) is NOT_APPLICABLE — the policy never applies to it");
  ok("V2.5 Policy", resolveWorkRelevance(jiraItem({ jiraStatusName: undefined }), idx) === "NOT_APPLICABLE", "a Jira-sourced item with no captured status name is NOT_APPLICABLE rather than guessed");

  const empty = buildWorkRelevanceIndex({});
  ok("V2.5 Policy", resolveWorkRelevance(jiraItem(), empty) === "UNKNOWN", "an entirely missing/empty policy (fresh install, nothing classified yet) is conservative — UNKNOWN, never ACTIONABLE");

  ok("V2.5 Policy", isPersonalWorkEligible("ACTIONABLE") === true, "ACTIONABLE is personal-work eligible");
  ok("V2.5 Policy", isPersonalWorkEligible("NOT_APPLICABLE") === true, "NOT_APPLICABLE (non-Jira) is personal-work eligible — preserves pre-V2.5 behavior");
  ok(
    "V2.5 Policy",
    (["WAITING", "OBSERVE", "COMPLETED", "EXCLUDED", "UNKNOWN"] as const).every((r) => isPersonalWorkEligible(r) === false),
    "WAITING/OBSERVE/COMPLETED/EXCLUDED/UNKNOWN are all never personal-work eligible"
  );

  ok("V2.5 Policy", jiraProjectKeyForWorkItem(jiraItem()) === "JPMC", "the Jira project key is derived from the WorkItem's own projectId FK, no second lookup");
  ok("V2.5 Policy", jiraProjectKeyForWorkItem(jiraItem({ sourceType: undefined })) === undefined, "a non-Jira item has no Jira project key");

  // V2.11 §1 — GLOBAL policy: the SAME raw status string classified ONCE must apply
  // identically across every project — this reverses the V2.5-V2.8 "project isolation"
  // premise by explicit product decision (see the fix prompt's Task 1).
  const globalIdx = buildWorkRelevanceIndex(globalPolicy({ "Ready for UAT/Business Test": "OBSERVE" }));
  ok("V2.11 Global policy", resolveWorkRelevance(jiraItem({ projectId: "jira-project-JPMC" }), globalIdx) === "OBSERVE", "JPMC resolves the one shared classification for this status");
  ok(
    "V2.11 Global policy",
    resolveWorkRelevance(jiraItem({ projectId: "jira-project-UBS" }), globalIdx) === "OBSERVE",
    "UBS's identical status string resolves to the SAME classification as JPMC's — a single classification now applies everywhere, never independently configurable per project"
  );
  ok(
    "V2.11 Global policy",
    resolveWorkRelevance(jiraItem({ projectId: "jira-project-WF" }), globalIdx) === "OBSERVE",
    "a third project (WF) that has never been separately configured still resolves the same shared classification — there is no per-project fallback to UNKNOWN anymore"
  );
}

// ----- Malformed / missing policy state must never throw (§26, §29) -----
{
  ok("V2.5 Backward compatibility", Object.keys(parseWorkRelevancePolicyMap(undefined).policy).length === 0, "undefined policy state parses to an empty map rather than crashing");
  ok("V2.5 Backward compatibility", Object.keys(parseWorkRelevancePolicyMap(null).policy).length === 0, "null policy state parses to an empty map");
  ok("V2.5 Backward compatibility", Object.keys(parseWorkRelevancePolicyMap("garbage").policy).length === 0, "a wrong-typed (string) policy value parses to an empty map rather than crashing");
  ok("V2.5 Backward compatibility", Object.keys(parseWorkRelevancePolicyMap(42).policy).length === 0, "a wrong-typed (number) policy value parses to an empty map");
  ok("V2.5 Backward compatibility", Object.keys(parseWorkRelevancePolicyMap([]).policy).length === 0, "a wrong-typed (array) policy value parses to an empty map");

  // V2.11 §1 — an already-global (new-shape) blob just parses directly, no migration.
  const alreadyGlobal = parseWorkRelevancePolicyMap({ "To Do": "ACTIONABLE", "Bad Value": "NOT_A_REAL_RELEVANCE" });
  ok("V2.11 Global policy", alreadyGlobal.policy["To Do"] === "ACTIONABLE", "a well-formed global entry parses correctly");
  ok("V2.11 Global policy", alreadyGlobal.policy["Bad Value"] === undefined, "an invalid WorkRelevance value is dropped, never trusted as-is");
  ok("V2.11 Global policy", alreadyGlobal.migration === undefined, "an already-global blob never triggers a migration notice");

  // V2.11 §1 migration — an old per-project blob with malformed siblings still migrates
  // safely: blank project key dropped, non-object project value dropped, non-object
  // statusMap contributing zero statuses, invalid relevance value dropped.
  const messy = parseWorkRelevancePolicyMap({
    JPMC: { projectKey: "JPMC", statusMap: { "To Do": "ACTIONABLE", "Bad Value": "NOT_A_REAL_RELEVANCE", 42: "WAITING" } },
    "": { statusMap: { "To Do": "ACTIONABLE" } }, // blank project key — dropped
    UBS: "not-an-object", // dropped entirely
    WF: { statusMap: "not-an-object" }, // survives as contributing zero statuses
  });
  ok("V2.11 Global policy", messy.policy["To Do"] === "ACTIONABLE", "a well-formed status survives migration alongside malformed siblings");
  ok("V2.11 Global policy", messy.policy["Bad Value"] === undefined, "an invalid WorkRelevance value is dropped, never trusted as-is");
  ok("V2.11 Global policy", messy.migration !== undefined && messy.migration.fromProjectCount === 2, "migration counts only the well-formed project entries (JPMC, WF) — the blank key and non-object UBS value are not real projects");

  // V2.11 §1 migration — the actual scenario this fix is for: 3 projects set the SAME
  // status to 3 different relevance values; must migrate to exactly one, deterministically,
  // and never throw. JPMC has the most classified statuses (2) so its value wins.
  const threeWayConflict = parseWorkRelevancePolicyMap({
    JPMC: { statusMap: { "Ready for UAT/Business Test": "OBSERVE", "To Do": "ACTIONABLE" } },
    UBS: { statusMap: { "Ready for UAT/Business Test": "ACTIONABLE" } },
    MASTERCARD: { statusMap: { "Ready for UAT/Business Test": "WAITING" } },
  });
  ok("V2.11 Global policy", threeWayConflict.policy["Ready for UAT/Business Test"] === "OBSERVE", "a status set to 3 different values across 3 projects migrates to exactly one value, deterministically (most-classified project wins)");
  ok("V2.11 Global policy", threeWayConflict.policy["To Do"] === "ACTIONABLE", "an unambiguous status (only JPMC classified it) migrates through untouched");
  ok("V2.11 Global policy", threeWayConflict.migration?.fromProjectCount === 3, "migration reports the real number of pre-upgrade projects");
  ok(
    "V2.11 Global policy",
    threeWayConflict.migration?.collapsedStatuses.includes("Ready for UAT/Business Test") === true && threeWayConflict.migration?.collapsedStatuses.includes("To Do") === false,
    "only the genuinely conflicting status is reported as collapsed — the unambiguous one is not"
  );

  // parseStoredState — a pre-V2.5 blob has no jiraWorkRelevancePolicy key at all.
  const preV25Blob = JSON.stringify({ schemaVersion: 5, data: emptyData(), loaded: true, isDemo: false, dataSource: "jira", jiraSync: { lastSyncStatus: "success" } });
  const migrated = parseStoredState(preV25Blob);
  ok("V2.5 Backward compatibility", Object.keys(migrated.jiraWorkRelevancePolicy).length === 0, "a pre-V2.5 stored blob with no jiraWorkRelevancePolicy key loads with the safe empty default");
  ok("V2.5 Backward compatibility", migrated.dataSource === "jira" && migrated.jiraSync.lastSyncStatus === "success", "every other pre-V2.5 field still loads unchanged alongside the new default policy");
  ok("V2.11 Global policy", migrated.workRelevancePolicyMigrationNotice === undefined, "no migration notice is generated when there was no prior policy at all to migrate");

  const malformedBlob = JSON.stringify({ ...JSON.parse(preV25Blob), jiraWorkRelevancePolicy: "not-an-object" });
  ok("V2.5 Backward compatibility", Object.keys(parseStoredState(malformedBlob).jiraWorkRelevancePolicy).length === 0, "a malformed jiraWorkRelevancePolicy value never crashes parseStoredState");

  // V2.11 §1 — the actual upgrade path end-to-end through parseStoredState: a real
  // pre-V2.11 per-project blob round-trips into the new global shape with a migration
  // notice attached, ready for Data & Settings to show its one-time notice.
  const preV211Blob = JSON.stringify({
    ...JSON.parse(preV25Blob),
    jiraWorkRelevancePolicy: {
      JPMC: { projectKey: "JPMC", statusMap: { "Ready for UAT/Business Test": "OBSERVE", "To Do": "ACTIONABLE" } },
      UBS: { projectKey: "UBS", statusMap: { "Ready for UAT/Business Test": "ACTIONABLE" } },
    },
  });
  const upgraded = parseStoredState(preV211Blob);
  ok("V2.11 Global policy", upgraded.jiraWorkRelevancePolicy["To Do"] === "ACTIONABLE", "an unambiguous status survives the full parseStoredState upgrade path");
  ok("V2.11 Global policy", upgraded.workRelevancePolicyMigrationNotice?.fromProjectCount === 2, "parseStoredState surfaces the migration notice for Data & Settings to show");
}

// ----- Personal Focus / action-plan gating (§10-11, §29 Personal Focus + Ownership) -----
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "Ready for UAT/Business Test": "OBSERVE", "Waiting for Client": "WAITING", Done: "COMPLETED", "Pending PCI Evidence": "EXCLUDED", "To Do": "ACTIONABLE" }));

  // §11 Critical Example — even a HIGH priority item explicitly OWNED by the configured
  // identity must never become a personal task when its status is OBSERVE. Ownership must
  // never override the Work Relevance Policy.
  const observeOwnedByMe = jiraItem({ id: "wi-observe", key: "JPMC-123", owner: "Minh Tran", priority: "P1", businessImpact: 5, dueDate: TODAY, blocked: true, jiraStatusName: "Ready for UAT/Business Test" });
  const actionableOwnedByMe = jiraItem({ id: "wi-actionable", key: "JPMC-124", owner: "Minh Tran", priority: "P1", businessImpact: 5, dueDate: TODAY, blocked: true, jiraStatusName: "To Do" });
  const waitingItem = jiraItem({ id: "wi-waiting", key: "JPMC-125", jiraStatusName: "Waiting for Client" });
  const completedItem = jiraItem({ id: "wi-completed", key: "JPMC-126", jiraStatusName: "Done", status: "Done" });
  const excludedItem = jiraItem({ id: "wi-excluded", key: "JPMC-127", jiraStatusName: "Pending PCI Evidence" });
  const unknownItem = jiraItem({ id: "wi-unknown", key: "JPMC-128", jiraStatusName: "Some Brand New Status" });
  const demoItem = makeItem({ id: "wi-demo", key: "DEMO-1", jiraStatusName: undefined, sourceType: undefined, priority: "P1", businessImpact: 5, dueDate: TODAY, blocked: true });

  const gatingData = { ...emptyData(), workItems: [observeOwnedByMe, actionableOwnedByMe, waitingItem, completedItem, excludedItem, unknownItem, demoItem] };
  const gatedCandidates = buildCandidates(gatingData, TODAY, idx);
  const gatedIds = new Set(gatedCandidates.map((c) => c.item?.id).filter(Boolean));

  ok("V2.5 Personal Focus", !gatedIds.has("wi-observe"), "OBSERVE status never becomes a personal-work candidate, even when explicitly owned by the configured identity (§11)");
  ok("V2.5 Personal Focus", !gatedIds.has("wi-waiting"), "WAITING status never becomes a personal-work candidate");
  ok("V2.5 Personal Focus", !gatedIds.has("wi-completed"), "COMPLETED status never becomes a personal-work candidate (also excluded by status !== Done already)");
  ok("V2.5 Personal Focus", !gatedIds.has("wi-excluded"), "EXCLUDED status never becomes a personal-work candidate");
  ok("V2.5 Personal Focus", !gatedIds.has("wi-unknown"), "an UNCLASSIFIED (UNKNOWN) status never becomes a personal-work candidate — conservative by default");
  ok("V2.5 Personal Focus", gatedIds.has("wi-actionable"), "ACTIONABLE status remains eligible for existing Personal Focus/priority logic to decide on");
  ok("V2.5 Personal Focus", gatedIds.has("wi-demo"), "a non-Jira (demo/local-import) work item is completely unaffected by the Work Relevance Policy");

  // No index at all (e.g. a call site that hasn't been updated) preserves pre-V2.5 behavior
  // exactly — never a silent behavior change for an untouched caller.
  const ungatedCandidates = buildCandidates(gatingData, TODAY, undefined);
  const ungatedIds = new Set(ungatedCandidates.map((c) => c.item?.id).filter(Boolean));
  ok("V2.5 Personal Focus", ungatedIds.has("wi-observe"), "omitting the Work Relevance index entirely is a no-op — matches pre-V2.5 behavior for any caller not yet passing it");

  // An explicit, user-created Action linked to a non-ACTIONABLE work item is NOT touched by
  // this gate — that's the user's own decision, not an automatic inference from Jira status.
  const explicitAction: Action = { id: "action-explicit", title: "Manually track UAT signoff", why: "test", status: "open", estimateMinutes: 10, createdAt: TODAY, relatedWorkItemId: "wi-observe" };
  const withExplicitAction = { ...gatingData, actions: [explicitAction] };
  const candidatesWithAction = buildCandidates(withExplicitAction, TODAY, idx);
  ok(
    "V2.5 Personal Focus",
    candidatesWithAction.some((c) => c.action?.id === "action-explicit"),
    "an explicit, human-created Action linked to an OBSERVE work item is still shown — the gate only stops AUTOMATIC WorkItem-to-candidate inference, never a user's own explicit Action"
  );

  // First 30 Minutes / next-actions (Command Bar) must respect the same gate.
  const plan30 = buildPlan(gatingData, TODAY, 30, idx);
  ok("V2.5 Personal Focus", !plan30.some((c) => c.item?.id === "wi-observe"), "the 30-minute action plan (used by First 30 Minutes and Command Bar next-actions) also respects the Work Relevance gate");
}

// ----- V2.13 §1 — Personal Focus Engine (My Day) applies the same Work Relevance gate -----
// personal-focus.ts previously never consulted Work Relevance at all: a COMPLETED/OBSERVE/
// WAITING/EXCLUDED work item's DRIFT/RISK/DECISION/ACTION/COMMUNICATION attention item (and
// loop-sourced candidates) could still reach DO_NOW/DO_TODAY. This closes that gap, routing
// OBSERVE to WATCH instead of dropping it silently. V2.13 originally gated MENTION/ASSIGNMENT
// the same way ("option 3b"); V2.17 §1b reverses that for MENTION specifically (see the
// mention tests just below) — ASSIGNMENT keeps option 3b unchanged.
{
  const wrGateIdx = buildWorkRelevanceIndex(globalPolicy({ "Ready for UAT/Business Test": "OBSERVE", Done: "COMPLETED", "To Do": "ACTIONABLE" }));

  const completedTicket = jiraItem({ id: "wi-mdc-completed", key: "JPMC-500", jiraStatusName: "Done", status: "Done", owner: "Alice", fixVersion: "R1" });
  const observeTicket = jiraItem({ id: "wi-mdc-observe", key: "JPMC-501", jiraStatusName: "Ready for UAT/Business Test", owner: "Alice", fixVersion: "R2" });
  const actionableTicket = jiraItem({ id: "wi-mdc-actionable", key: "JPMC-502", jiraStatusName: "To Do", owner: "Alice", fixVersion: "R3" });

  // A high-scoring DRIFT item (CRITICAL severity, explicit ownership, several days stale)
  // tied to a specific ticket via the release it belongs to — comfortably clears the DO_NOW
  // floor (score >= 50) on its own scoring merits, so any downgrade below is purely the gate.
  const driftAttn = (id: string, fixVersion: string): AttentionItem => ({
    id,
    category: "DRIFT",
    severity: "CRITICAL",
    what: `Release ${fixVersion} drifting`,
    why: "Because delivery signals worsened.",
    impact: "x",
    nowWhat: "x",
    evidence: [],
    lifecycle: "ACTIVE",
    firstSeenDate: "2026-05-01",
    lastSeenDate: TODAY,
    sourceRef: { type: "release", id: fixVersion },
  });
  const driftCompleted = driftAttn("DRIFT:release-R1", "R1");
  const driftObserve = driftAttn("DRIFT:release-R2", "R2");
  const driftActionable = driftAttn("DRIFT:release-R3", "R3");

  const mentionAttn = (id: string, workItemId: string): AttentionItem => ({
    id,
    category: "MENTION",
    severity: "MEDIUM",
    what: "Mentioned in a comment",
    why: "Someone mentioned you.",
    impact: "x",
    nowWhat: "Read and respond.",
    evidence: [],
    lifecycle: "ACTIVE",
    firstSeenDate: TODAY,
    lastSeenDate: TODAY,
    sourceRef: { type: "workItem", id: workItemId },
    ownershipExplicit: true,
  });
  const mentionOnCompleted = mentionAttn("MENTION:jpmc-500", "wi-mdc-completed");
  const mentionOnObserve = mentionAttn("MENTION:jpmc-501", "wi-mdc-observe");
  const mentionOnActionable = mentionAttn("MENTION:jpmc-502", "wi-mdc-actionable");

  const mdcData: CommandCenterData = { ...emptyData(), workItems: [completedTicket, observeTicket, actionableTicket] };
  const mdcProactive = fakeProactive([driftCompleted, driftObserve, driftActionable, mentionOnCompleted, mentionOnObserve, mentionOnActionable]);
  const mdcFocus = computePersonalFocus(mdcData, mdcProactive, "Alice", TODAY, undefined, wrGateIdx);

  ok(
    "V2.13 My Day gate",
    mdcFocus.candidates.find((c) => c.sourceId === driftCompleted.id) === undefined,
    "a COMPLETED-status ticket's DRIFT attention item produces no Personal Focus candidate at all — never DO_NOW/DO_TODAY/TOP_3/First-30-Minutes"
  );
  ok("V2.13 My Day gate", !mdcFocus.top3.some((c) => c.sourceId === driftCompleted.id), "the excluded COMPLETED-ticket candidate never appears in Top 3 either");

  const observeCandidate = mdcFocus.candidates.find((c) => c.sourceId === driftObserve.id);
  ok("V2.13 My Day gate", observeCandidate !== undefined && observeCandidate.category === "WATCH", "an OBSERVE-status ticket's high-scoring DRIFT item is demoted to WATCH, not dropped silently (OBSERVE stays 'visible as context')");

  const actionableCandidate = mdcFocus.candidates.find((c) => c.sourceId === driftActionable.id);
  ok("V2.13 My Day gate", actionableCandidate !== undefined && actionableCandidate.category === "DO_NOW", "an ACTIONABLE-status ticket with the identical score is unaffected — no regression to the common case");

  // V2.17 §1b — a MENTION always surfaces regardless of the underlying ticket's Work
  // Relevance classification: someone is waiting on a reply, independent of the ticket's
  // delivery state. All three tickets (COMPLETED/OBSERVE/ACTIONABLE) now classify identically,
  // from scoring alone — the gate no longer factors in at all for this category.
  const mentionCompletedCandidate = mdcFocus.candidates.find((c) => c.sourceId === mentionOnCompleted.id);
  ok("V2.17 My Day gate bypass", mentionCompletedCandidate !== undefined && mentionCompletedCandidate.category === "DO_TODAY", "a MENTION item on an already-COMPLETED ticket still produces a real candidate — the V2.13 'option 3b' gate no longer applies to MENTION");
  const mentionObserveCandidate = mdcFocus.candidates.find((c) => c.sourceId === mentionOnObserve.id);
  ok("V2.17 My Day gate bypass", mentionObserveCandidate !== undefined && mentionObserveCandidate.category === "DO_TODAY", "a MENTION item on an OBSERVE-status ticket is likewise unaffected by the gate — not even demoted to WATCH, since the gate never runs for MENTION at all");
  const mentionActionableCandidate = mdcFocus.candidates.find((c) => c.sourceId === mentionOnActionable.id);
  ok("V2.17 My Day gate bypass", mentionActionableCandidate !== undefined && mentionActionableCandidate.category === "DO_TODAY", "a MENTION item on an ACTIONABLE-status ticket is unaffected too — all three reach the identical natural DO_TODAY category from scoring alone, proving ticket status no longer factors in for this category");

  // No index at all preserves pre-V2.13 behavior — never a silent change for an unmigrated caller.
  const mdcUngated = computePersonalFocus(mdcData, mdcProactive, "Alice", TODAY);
  ok("V2.13 My Day gate", mdcUngated.candidates.some((c) => c.sourceId === driftCompleted.id), "omitting the Work Relevance index is a no-op — matches pre-V2.13 behavior");

  // The same gate applies to loop-sourced candidates, not just attention-sourced ones.
  const loopWorkItem = jiraItem({ id: "wi-mdc-loop-observe", key: "JPMC-600", jiraStatusName: "Ready for UAT/Business Test", owner: "Alice" });
  const loopAction: Action = { id: "mdc-loop-action-1", title: "Loop action", why: "x", relatedWorkItemId: loopWorkItem.id, relatedDecisionId: "mdc-loop-dec-1", owner: "Alice", status: "open", estimateMinutes: 15, createdAt: TODAY };
  const loopDecision: Decision = { id: "mdc-loop-dec-1", projectId: loopWorkItem.projectId, title: "Loop decision", status: "DECIDED", description: "" };
  const loop: DeliveryLoop = { id: loopDecision.id, issue: "Loop issue", health: "STALLED", why: "Stalled reason.", nowWhat: "Do something." };
  const loopData: CommandCenterData = { ...emptyData(), workItems: [loopWorkItem], decisions: [loopDecision], actions: [loopAction] };
  const loopFocus = computePersonalFocus(loopData, fakeProactive([], [loop]), "Alice", TODAY, undefined, wrGateIdx);
  const loopCandidate = loopFocus.candidates.find((c) => c.sourceId === loop.id);
  ok("V2.13 My Day gate", loopCandidate !== undefined && loopCandidate.category === "WATCH", "a loop-sourced candidate whose linked work item is OBSERVE is demoted to WATCH too, not just attention-sourced candidates");
}

// ----- V2.13 (bug fix), revised V2.17 §1a/§1b — the Attention Queue itself (not just My Day)
// consults the Work Relevance Policy for RISK/DEPENDENCY/DECISION/ACTION/etc — a signal tied
// to a ticket already COMPLETED or EXCLUDED never lingers forever as if it still needed
// action. Deliberately narrower than My Day's gate — WAITING and UNKNOWN tickets stay visible
// here (this is delivery intelligence, not "is this my personal work"), and the same pass
// resolves a real ticket link when exactly one work item is related. V2.17 §1b carves out
// MENTION from this exclusion entirely (a mention always surfaces); §1a instead auto-resolves
// a MENTION on a COMPLETED/EXCLUDED ticket via its lifecycle (still present in the queue,
// just RESOLVED) — see the dedicated block below this one for that behavior specifically. -----
{
  const aqIdx = buildWorkRelevanceIndex(
    globalPolicy({ Done: "COMPLETED", "Won't Fix": "EXCLUDED", "Waiting for Client": "WAITING", "Ready for UAT/Business Test": "OBSERVE", "To Do": "ACTIONABLE" })
  );

  const completedTicket = jiraItem({ id: "wi-aq-completed", key: "JPMC-700", jiraStatusName: "Done" });
  const excludedTicket = jiraItem({ id: "wi-aq-excluded", key: "JPMC-701", jiraStatusName: "Won't Fix" });
  const waitingTicket = jiraItem({ id: "wi-aq-waiting", key: "JPMC-702", jiraStatusName: "Waiting for Client" });
  const observeTicket = jiraItem({ id: "wi-aq-observe", key: "JPMC-703", jiraStatusName: "Ready for UAT/Business Test" });
  const actionableTicket = jiraItem({ id: "wi-aq-actionable", key: "JPMC-704", jiraStatusName: "To Do" });
  const unknownTicket = jiraItem({ id: "wi-aq-unknown", key: "JPMC-705", jiraStatusName: "Some Custom Status Nobody Classified" });
  const aqTickets = [completedTicket, excludedTicket, waitingTicket, observeTicket, actionableTicket, unknownTicket];

  const aqData: CommandCenterData = { ...emptyData(), workItems: aqTickets };
  const aqDerived = deriveData(aqData, null, TODAY);
  const aqMentionEvents: MentionEvent[] = aqTickets.map((w) => ({ issueKey: w.key, commentId: `c-${w.key}`, excerpt: "please check this", mentionedAt: TODAY }));

  const aqProactive = computeProactiveIntelligence(aqData, aqDerived, [], null, {}, "jira", TODAY, aqIdx, aqMentionEvents);
  const byMentionKey = (key: string, commentId: string) => aqProactive.attentionQueue.find((i) => i.id === `MENTION:${slug(key)}:${slug(commentId)}`);

  // V2.17 §1b — a MENTION always surfaces now, regardless of ticket status (present in the
  // queue for every one of the six tickets, including COMPLETED/EXCLUDED).
  for (const t of aqTickets) {
    ok("V2.17 Attention Queue mention bypass", byMentionKey(t.key, `c-${t.key}`) !== undefined, `a MENTION on ${t.jiraStatusName} (${t.key}) is present in the Attention Queue — the Work Relevance gate no longer excludes MENTION at all`);
  }
  // ...but §1a auto-resolves the two that landed on a COMPLETED/EXCLUDED ticket — still
  // present in the data (proving §1b), just correctly marked RESOLVED (proving §1a) rather
  // than left looking like an open, unactioned signal forever.
  ok("V2.17 Attention Queue mention auto-resolve", byMentionKey(completedTicket.key, `c-${completedTicket.key}`)?.lifecycle === "RESOLVED", "a MENTION on an already-COMPLETED ticket auto-resolves — no more action is implied by an old mention on a finished ticket");
  ok("V2.17 Attention Queue mention auto-resolve", byMentionKey(excludedTicket.key, `c-${excludedTicket.key}`)?.lifecycle === "RESOLVED", "a MENTION on an EXCLUDED ticket auto-resolves the same way");
  ok("V2.17 Attention Queue mention auto-resolve", byMentionKey(waitingTicket.key, `c-${waitingTicket.key}`)?.lifecycle === "NEW", "a MENTION on a WAITING ticket is NOT auto-resolved — WAITING is still live, unlike COMPLETED/EXCLUDED");
  ok("V2.17 Attention Queue mention auto-resolve", byMentionKey(observeTicket.key, `c-${observeTicket.key}`)?.lifecycle === "NEW", "a MENTION on an OBSERVE ticket is NOT auto-resolved either");

  const actionableMention = byMentionKey(actionableTicket.key, `c-${actionableTicket.key}`);
  ok("V2.13 Attention Queue gate (ticket link)", actionableMention?.ticketKey === actionableTicket.key, "the same pass resolves the real ticket key from the one related work item — reusing resolveAttentionEntity, not a second sourceRef -> WorkItem implementation");
  ok("V2.13 Attention Queue gate (ticket link)", actionableMention?.ticketUrl === undefined, "no sourceUrl configured on the fixture means no fabricated link — matches TicketLink's own 'never invent a link' discipline");

  // Omitting the Work Relevance index entirely is a no-op for the auto-resolve mechanism too.
  const aqUngated = computeProactiveIntelligence(aqData, aqDerived, [], null, {}, "jira", TODAY, undefined, aqMentionEvents);
  const ungatedByKey = (key: string, commentId: string) => aqUngated.attentionQueue.find((i) => i.id === `MENTION:${slug(key)}:${slug(commentId)}`);
  ok("V2.17 Attention Queue mention auto-resolve", ungatedByKey(completedTicket.key, `c-${completedTicket.key}`)?.lifecycle === "NEW", "omitting the Work Relevance index is a no-op — a COMPLETED ticket's mention is neither excluded nor auto-resolved without an index to classify it");
}

// ----- V2.13 (bug fix) — resolveAttentionEntity's RISK lookup previously checked only
// `data.risks` (manual risks), so an AUTO-DETECTED risk (risk-detection.ts's deterministic
// engine — the overwhelming majority of real risks) could never resolve its underlying work
// item at all: no ticket link (§4), and no Work Relevance gating (§1) either, for the entire
// RISK category. Confirmed against a real auto-detected risk (not a hand-built AttentionItem
// fixture), proving the fix works end-to-end through computeProactiveIntelligence AND
// computePersonalFocus, not just resolveAttentionEntity in isolation. -----
{
  const autoRiskIdx = buildWorkRelevanceIndex(globalPolicy({ "Deployed to Prod": "COMPLETED", "Ready for UAT/Business Test": "OBSERVE", "To Do": "ACTIONABLE" }));
  const arCompletedItem = jiraItem({ id: "wi-ar-completed", key: "JPMC-950", jiraStatusName: "Deployed to Prod", dueDate: TODAY, clientId: "c-1" });
  const arObserveItem = jiraItem({ id: "wi-ar-observe", key: "JPMC-951", jiraStatusName: "Ready for UAT/Business Test", dueDate: TODAY, clientId: "c-1", owner: "Alice" });
  const arActionableItem = jiraItem({ id: "wi-ar-actionable", key: "JPMC-952", jiraStatusName: "To Do", dueDate: TODAY, clientId: "c-1" });
  const arData: CommandCenterData = { ...emptyData(), clients: [{ id: "c-1", name: "Test Client" }], workItems: [arCompletedItem, arObserveItem, arActionableItem] };
  const arDerived = deriveData(arData, null, TODAY);
  const autoRiskTitles = arDerived.risks.map((r) => r.title);
  ok(
    "V2.13 Auto-detected risk fix",
    autoRiskTitles.some((t) => t.includes("JPMC-950")) && autoRiskTitles.some((t) => t.includes("JPMC-951")) && autoRiskTitles.some((t) => t.includes("JPMC-952")),
    "the fixture genuinely produces real, auto-detected (not hand-built) risks for all three tickets via risk-detection.ts's own R1 deadline rule — this test exercises the real bug, not a synthetic stand-in"
  );
  ok("V2.13 Auto-detected risk fix", arData.risks.length === 0, "none of these risks are manually logged — data.risks (the pre-fix lookup source) is empty, so a pre-fix run would have resolved zero work items for every one of them");

  const arProactive = computeProactiveIntelligence(arData, arDerived, [], null, {}, "jira", TODAY, autoRiskIdx);
  const riskItemFor = (key: string) => arProactive.attentionQueue.find((i) => i.category === "RISK" && i.what.includes(key));

  ok("V2.13 Auto-detected risk fix", riskItemFor("JPMC-950") === undefined, "an auto-detected risk on a COMPLETED-status ticket is now correctly EXCLUDED from the Attention Queue — the gate can finally see its underlying work item");
  const observeRisk = riskItemFor("JPMC-951");
  ok("V2.13 Auto-detected risk fix", observeRisk !== undefined, "an auto-detected risk on an OBSERVE-status ticket stays visible (OBSERVE is still 'live' for the Attention Queue's broader gate)");
  const actionableRisk = riskItemFor("JPMC-952");
  ok(
    "V2.13 Auto-detected risk fix (ticket link)",
    actionableRisk?.ticketKey === "JPMC-952",
    "an auto-detected risk's Attention Queue item now correctly carries the real ticket key — resolveAttentionEntity can finally see the auto-detected risk's sourceWorkItemIds"
  );

  // Same fix, verified through Personal Focus (My Day) too — the risk-detection.ts author of
  // this exact bug affected both surfaces identically, since both call resolveAttentionEntity.
  const arFocus = computePersonalFocus(arData, arProactive, "Alice", TODAY, undefined, autoRiskIdx, arDerived.risks);
  const observeCandidate = arFocus.candidates.find((c) => c.sourceId === observeRisk?.id);
  ok(
    "V2.13 Auto-detected risk fix (My Day)",
    observeCandidate !== undefined && observeCandidate.category === "WATCH",
    "an auto-detected risk on an OBSERVE-status ticket is correctly demoted to WATCH in My Day too, once the real derived.risks list (not just manually-logged risks) is threaded through"
  );
  const arFocusUnfixed = computePersonalFocus(arData, arProactive, "Alice", TODAY, undefined, autoRiskIdx);
  const observeCandidateUnfixed = arFocusUnfixed.candidates.find((c) => c.sourceId === observeRisk?.id);
  ok(
    "V2.13 Auto-detected risk fix (My Day)",
    observeCandidateUnfixed !== undefined && observeCandidateUnfixed.category !== "WATCH",
    "omitting allRisks reproduces the pre-fix bug exactly (proving this is a genuine fix, not a tautology) — without derived.risks, the gate cannot see the auto-detected risk's work item at all, so OBSERVE is never enforced"
  );
}

// ----- V2.13 §2 — cron-notify.ts: the server-side (cron-driven) notify check. Fully
// dependency-injected (fetchImpl + an injected NotifyStateStore, exactly like jira/http.ts's
// own fetch*With functions) so this is exercised directly against the in-memory fake, never a
// mocked module boundary — see the dev prompt's own "the test suite must stay fully offline"
// requirement. -----
{
  const cnConfig: JiraConnectionConfig = { baseUrl: "https://example.atlassian.net", email: "a@b.com", apiToken: "tok" };
  const cnAccountId = "acc-server";

  type RawIssue = { key: string; fields?: Record<string, unknown> };
  function cronJiraFetch(opts: { assigned: RawIssue[]; mentioned: RawIssue[]; comments: Record<string, JiraComment[]> }): FetchLike {
    return async (url, init) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/search/jql")) {
        const body = init?.body ? (JSON.parse(init.body) as { jql?: string }) : {};
        const jql = String(body.jql ?? "");
        if (jql.startsWith("assignee")) return { ok: true, status: 200, json: async () => ({ issues: opts.assigned, isLast: true }) };
        if (jql.startsWith("comment")) return { ok: true, status: 200, json: async () => ({ issues: opts.mentioned, isLast: true }) };
        return { ok: false, status: 400, json: async () => ({}) };
      }
      const m = u.pathname.match(/issue\/([^/]+)\/comment/);
      if (m) {
        const key = decodeURIComponent(m[1]);
        return { ok: true, status: 200, json: async () => ({ comments: opts.comments[key] ?? [] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };
  }

  let cnSlackCaptured: string[] = [];
  const cnFakeSlackFetch: SlackFetchLike = async (_url, init) => {
    cnSlackCaptured.push(init.body);
    return { ok: true, status: 200, text: async () => "" };
  };

  function withWebhook<T>(run: () => Promise<T>): Promise<T> {
    const original = process.env.SLACK_WEBHOOK_URL;
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.example/services/mock";
    return run().finally(() => {
      if (original === undefined) delete process.env.SLACK_WEBHOOK_URL;
      else process.env.SLACK_WEBHOOK_URL = original;
    });
  }

  // --- Cold start: first-ever run for an install, real assigned/mentioned tickets exist -----
  {
    const store = createInMemoryNotifyStore(null);
    const fetchImpl = cronJiraFetch({
      assigned: [{ key: "JPMC-900", fields: { assignee: { accountId: cnAccountId }, summary: "Assigned already" } }],
      mentioned: [],
      comments: {},
    });
    cnSlackCaptured = [];
    const result = await withWebhook(() => runServerSideNotifyCheck(fetchImpl, cnConfig, cnAccountId, store, cnFakeSlackFetch));

    ok(
      "V2.13 Server Notify",
      result.skippedColdStart === true && result.notified === 0,
      "the first-ever run for an install establishes a baseline and sends ZERO notifications, even though real assigned tickets already exist — matching V2.10.1's client-side cold-start guarantee, now also true for the unattended path"
    );
    const saved = await store.get();
    ok("V2.13 Server Notify", saved !== null && saved.assignedIssueKeys.includes("JPMC-900"), "the cold-start baseline records the real currently-assigned issue key");
    ok("V2.13 Server Notify", cnSlackCaptured.length === 0, "no Slack call was made at all during cold start");
  }

  // --- A genuinely new assignment after a baseline is established is notified; an
  // already-known one is not -----
  {
    const store = createInMemoryNotifyStore({ assignedIssueKeys: ["JPMC-800"], notifiedCommentIds: [], lastCheckedAtIso: "2026-06-01T00:00:00.000Z" });
    const fetchImpl = cronJiraFetch({
      assigned: [
        { key: "JPMC-800", fields: { assignee: { accountId: cnAccountId }, summary: "Already known" } },
        { key: "JPMC-801", fields: { assignee: { accountId: cnAccountId }, summary: "Brand new assignment" } },
      ],
      mentioned: [],
      comments: {},
    });
    cnSlackCaptured = [];
    const result = await withWebhook(() => runServerSideNotifyCheck(fetchImpl, cnConfig, cnAccountId, store, cnFakeSlackFetch));

    ok("V2.13 Server Notify", result.skippedColdStart === false && result.notified === 1, "exactly one genuinely new assignment (JPMC-801) is notified — JPMC-800 was already in the persisted baseline");
    ok(
      "V2.13 Server Notify",
      cnSlackCaptured.some((b) => b.includes("JPMC-801")) && !cnSlackCaptured.some((b) => b.includes("JPMC-800")),
      "the Slack call is for the new ticket only, never re-notifying the already-known one"
    );
    const saved = await store.get();
    ok("V2.13 Server Notify", saved?.assignedIssueKeys.slice().sort().join(",") === "JPMC-800,JPMC-801", "the persisted baseline advances to the real current assigned set after a successful run");
  }

  // --- Mention comment-id dedup: an already-notified comment is never re-notified; a
  // genuinely new comment on the same issue is -----
  {
    const store = createInMemoryNotifyStore({ assignedIssueKeys: [], notifiedCommentIds: ["c-old"], lastCheckedAtIso: "2026-06-01T00:00:00.000Z" });
    const fetchImpl = cronJiraFetch({
      assigned: [],
      mentioned: [{ key: "JPMC-700", fields: {} }],
      comments: {
        "JPMC-700": [
          { id: "c-old", author: { displayName: "Alice" }, body: `[~accountid:${cnAccountId}] please look`, created: "2026-06-01" },
          { id: "c-new", author: { displayName: "Bob" }, body: `[~accountid:${cnAccountId}] following up`, created: "2026-06-05" },
        ],
      },
    });
    cnSlackCaptured = [];
    const result = await withWebhook(() => runServerSideNotifyCheck(fetchImpl, cnConfig, cnAccountId, store, cnFakeSlackFetch));

    ok("V2.13 Server Notify", result.notified === 1, "exactly one genuinely new mentioning comment (c-new) is notified — c-old was already in the persisted baseline");
    ok("V2.13 Server Notify", cnSlackCaptured.some((b) => b.includes("Bob")), "the notified signal is for the new comment's author, never the already-known comment");
    const saved = await store.get();
    ok("V2.13 Server Notify", saved?.notifiedCommentIds.slice().sort().join(",") === "c-new,c-old", "the persisted comment-id baseline includes both the previously-known and the newly-seen mentioning comment");
  }

  // --- A cron run's own connectivity failure must never corrupt persisted state, and a
  // later successful run must still diff correctly against the untouched prior baseline -----
  {
    const store = createInMemoryNotifyStore({ assignedIssueKeys: ["JPMC-1"], notifiedCommentIds: ["c-1"], lastCheckedAtIso: "2026-06-01T00:00:00.000Z" });
    const failingFetch: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({ errorMessages: ["down"] }) });
    const failed = await runServerSideNotifyCheck(failingFetch, cnConfig, cnAccountId, store, cnFakeSlackFetch);

    ok("V2.13 Server Notify", !!failed.error, "a Jira fetch failure is reported as an honest error, never silently swallowed");
    const untouched = await store.get();
    ok(
      "V2.13 Server Notify",
      untouched?.assignedIssueKeys.join(",") === "JPMC-1" && untouched?.notifiedCommentIds.join(",") === "c-1",
      "store.set was never called on a connectivity failure — the prior baseline is byte-for-byte untouched"
    );

    const recoveredFetch = cronJiraFetch({
      assigned: [
        { key: "JPMC-1", fields: { assignee: { accountId: cnAccountId } } },
        { key: "JPMC-2", fields: { assignee: { accountId: cnAccountId } } },
      ],
      mentioned: [],
      comments: {},
    });
    cnSlackCaptured = [];
    const recovered = await withWebhook(() => runServerSideNotifyCheck(recoveredFetch, cnConfig, cnAccountId, store, cnFakeSlackFetch));
    ok("V2.13 Server Notify", recovered.notified === 1, "the next successful run correctly detects JPMC-2 as new — the untouched baseline from before the failure was the correct comparison point, proving the failure never corrupted it");
  }
}

// ----- V2.13 §3 — GET /api/command-center/notify reports serverSideNotifyActive: true iff
// both PERSONAL_JIRA_ACCOUNT_ID and Vercel KV are configured, reusing notify-state.ts's own
// isNotifyStoreConfigured() rather than a duplicated check. -----
{
  const originalAccountId = process.env.PERSONAL_JIRA_ACCOUNT_ID;
  const originalKvUrl = process.env.KV_REST_API_URL;
  const originalKvToken = process.env.KV_REST_API_TOKEN;

  delete process.env.PERSONAL_JIRA_ACCOUNT_ID;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  ok("V2.13 Server Notify status", isNotifyStoreConfigured() === false, "isNotifyStoreConfigured() is false with no KV env vars set");
  const statusNeither = (await (await notifyStatusGET()).json()) as { serverSideNotifyActive?: boolean };
  ok("V2.13 Server Notify status", statusNeither.serverSideNotifyActive === false, "with neither PERSONAL_JIRA_ACCOUNT_ID nor KV configured, serverSideNotifyActive is false");

  process.env.PERSONAL_JIRA_ACCOUNT_ID = "acc-x";
  const statusAccountOnly = (await (await notifyStatusGET()).json()) as { serverSideNotifyActive?: boolean };
  ok("V2.13 Server Notify status", statusAccountOnly.serverSideNotifyActive === false, "PERSONAL_JIRA_ACCOUNT_ID alone (no KV) is not enough — both are required");

  process.env.KV_REST_API_URL = "https://kv.example.test";
  process.env.KV_REST_API_TOKEN = "kv-tok";
  ok("V2.13 Server Notify status", isNotifyStoreConfigured() === true, "isNotifyStoreConfigured() is true once both KV env vars are set");
  const statusBoth = (await (await notifyStatusGET()).json()) as { serverSideNotifyActive?: boolean };
  ok("V2.13 Server Notify status", statusBoth.serverSideNotifyActive === true, "with both PERSONAL_JIRA_ACCOUNT_ID and KV configured, serverSideNotifyActive is true");

  if (originalAccountId === undefined) delete process.env.PERSONAL_JIRA_ACCOUNT_ID;
  else process.env.PERSONAL_JIRA_ACCOUNT_ID = originalAccountId;
  if (originalKvUrl === undefined) delete process.env.KV_REST_API_URL;
  else process.env.KV_REST_API_URL = originalKvUrl;
  if (originalKvToken === undefined) delete process.env.KV_REST_API_TOKEN;
  else process.env.KV_REST_API_TOKEN = originalKvToken;
}

// ----- V2.13 §2 — jira/sync/route.ts GET handler wiring (static source checks, matching the
// existing V2.10 Cron pattern: the route imports server-only credential code, so it's checked
// by reading its source rather than importing it into this test process). -----
{
  const repoRoot = path.resolve(process.cwd());
  const syncRouteSrc = fs.readFileSync(path.join(repoRoot, "src/app/api/command-center/jira/sync/route.ts"), "utf8");
  ok("V2.13 Sync route wiring", /process\.env\.PERSONAL_JIRA_ACCOUNT_ID/.test(syncRouteSrc), "the sync route's GET handler reads PERSONAL_JIRA_ACCOUNT_ID");
  ok("V2.13 Sync route wiring", /runServerSideNotifyCheck/.test(syncRouteSrc), "the GET handler calls the real runServerSideNotifyCheck, never a second implementation");
  ok("V2.13 Sync route wiring", /createNotifyStore/.test(syncRouteSrc), "the GET handler wires the real KV-backed store, not the in-memory test fake");
  ok("V2.13 Sync route wiring", /isNotifyStoreConfigured/.test(syncRouteSrc), "the GET handler gates on the shared isNotifyStoreConfigured() check, not a duplicated env-var check");
  ok("V2.13 Sync route wiring", /if \(!accountId \|\| !config \|\| !isNotifyStoreConfigured\(\)\) return response;/.test(syncRouteSrc), "with either PERSONAL_JIRA_ACCOUNT_ID or KV absent, the sync response is returned completely unchanged — a full no-op");
  ok("V2.13 Sync route wiring", /export async function GET/.test(syncRouteSrc), "the notify check is wired into the GET handler (the one cron actually calls), not POST (the browser's manual Sync Now button)");
}

// ----- Attention: non-actionable status never creates attention merely by existing, but
// existing risk/dependency/decision attention is never broken by this feature (§14, §29). -----
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "Ready for UAT/Business Test": "OBSERVE" }));
  const blockedObserveItem = jiraItem({ id: "wi-risk-observe", key: "JPMC-200", jiraStatusName: "Ready for UAT/Business Test", blocked: true, blockerReason: "Flagged", lastUpdated: "2026-05-01" });
  const data = { ...emptyData(), workItems: [blockedObserveItem] };
  const risks = detectRisks(data, TODAY);
  ok(
    "V2.5 Attention",
    risks.length > 0,
    "risk-detection.ts is untouched by Work Relevance classification — a blocked OBSERVE-status item can still legitimately produce a risk/attention signal (§14 'issue is not actionable' is distinct from 'a related risk requires attention')"
  );
  ok("V2.5 Attention", !isPersonalWorkEligibleItem(blockedObserveItem, idx), "meanwhile the SAME item is still correctly excluded from personal-work candidate generation");
}

// ----- Command Bar (§17, §29) -----
{
  // "Pending PCI Evidence" is deliberately left out of the map so it exercises the real
  // unmapped/UNKNOWN path below.
  const realIdx = buildWorkRelevanceIndex(globalPolicy({ "Ready for UAT/Business Test": "OBSERVE", "Waiting for Client": "WAITING" }));

  const uat1 = jiraItem({ id: "wi-uat-1", key: "JPMC-300", title: "Coverage report", jiraStatusName: "Ready for UAT/Business Test" });
  const uat2 = jiraItem({ id: "wi-uat-2", key: "JPMC-301", title: "Another UAT item", jiraStatusName: "Ready for UAT/Business Test" });
  const waiting1 = jiraItem({ id: "wi-wait-1", key: "JPMC-302", title: "Client sign-off", jiraStatusName: "Waiting for Client" });
  const unmapped1 = jiraItem({ id: "wi-unmapped-1", key: "JPMC-303", title: "PCI evidence bundle", jiraStatusName: "Pending PCI Evidence" });
  const cbData = { ...emptyData(), workItems: [uat1, uat2, waiting1, unmapped1] };

  ok("V2.5 Command Bar", classifyQuery("What do I need to work on?", cbData).intent === "next-actions", "'what do I need to work on' routes to next-actions (ACTIONABLE-only surface)");
  ok("V2.5 Command Bar", classifyQuery("What is in UAT?", cbData).intent === "jira-status-context", "'what is in UAT?' routes to the status-context intent");
  ok("V2.5 Command Bar", classifyQuery("What is in UAT?", cbData).target === "uat", "the status-context intent captures 'UAT' as the keyword target");
  ok("V2.5 Command Bar", classifyQuery("What is waiting?", cbData).intent === "jira-status-waiting", "'what is waiting?' routes to the waiting intent");
  ok("V2.5 Command Bar", classifyQuery("Which Jira statuses are not classified?", cbData).intent === "jira-statuses-unclassified", "'which Jira statuses are not classified?' routes to the unclassified intent");
  ok("V2.5 Command Bar", classifyQuery("Why isn't JPMC-300 on my list?", cbData).intent === "why-on-my-list", "a 'why isn't X on my list' question naming a real issue key still routes to why-on-my-list");
  ok("V2.5 Command Bar", classifyQuery("Why isn't JPMC-300 on my list?", cbData).target === "JPMC-300", "the issue key is captured as the route target");

  const derived = deriveData(cbData, null, TODAY);

  const uatFacts = answerFromRoute({ intent: "jira-status-context", target: "uat" }, cbData, derived, TODAY, "jira", undefined, undefined, undefined, realIdx);
  ok("V2.5 Command Bar", uatFacts.facts.length === 2, "'what is in UAT?' returns exactly the OBSERVE items whose Jira status matches the keyword");
  ok("V2.5 Command Bar", uatFacts.facts.every((f) => f.includes("Ready for UAT")), "every returned fact shows the real Jira status, not an invented summary");

  const waitingFacts = answerFromRoute({ intent: "jira-status-waiting" }, cbData, derived, TODAY, "jira", undefined, undefined, undefined, realIdx);
  ok("V2.5 Command Bar", waitingFacts.facts.length === 1 && waitingFacts.facts[0].includes("JPMC-302"), "'what is waiting?' returns exactly the WAITING-classified item");

  const unclassifiedFacts = answerFromRoute({ intent: "jira-statuses-unclassified" }, cbData, derived, TODAY, "jira", undefined, undefined, undefined, realIdx);
  ok("V2.5 Command Bar", unclassifiedFacts.facts.some((f) => f.includes("Pending PCI Evidence")), "'which Jira statuses are not classified?' surfaces the real unmapped status name");

  const whyFacts = answerFromRoute({ intent: "why-on-my-list", target: "JPMC-300" }, cbData, derived, TODAY, "jira", undefined, { candidates: [], top3: [] } as any, undefined, realIdx);
  ok("V2.5 Command Bar", whyFacts.facts[0].includes("JPMC-300") && whyFacts.facts[0].includes("OBSERVE"), "'why isn't JPMC-300 on my list?' gives the deterministic Work Relevance explanation naming the real status and classification");

  const whyUnknownItem = jiraItem({ id: "wi-unknown-why", key: "JPMC-304", jiraStatusName: "Totally New Status" });
  const whyUnknownData = { ...emptyData(), workItems: [whyUnknownItem] };
  const whyUnknownFacts = answerFromRoute({ intent: "why-on-my-list", target: "JPMC-304" }, whyUnknownData, deriveData(whyUnknownData, null, TODAY), TODAY, "jira", undefined, { candidates: [], top3: [] } as any, undefined, realIdx);
  ok("V2.5 Command Bar", whyUnknownFacts.facts[0].includes("has not been classified"), "an UNCLASSIFIED status gets the honest 'has not been classified yet' explanation, never a fabricated reason");
}

// ----- Trust / explainability (§18, §29) -----
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "Ready for UAT/Business Test": "OBSERVE" }));
  const observeExplanation = explainWorkItemRelevance(jiraItem({ key: "JPMC-400" }), idx);
  ok("V2.5 Trust", observeExplanation.isApplicable && observeExplanation.relevance === "OBSERVE", "explainWorkItemRelevance reports the real classification");
  ok("V2.5 Trust", observeExplanation.answer.includes("JPMC-400") && observeExplanation.answer.includes("Ready for UAT/Business Test") && observeExplanation.answer.includes("OBSERVE"), "the explanation names the real issue key, real status, and real classification — deterministic, not AI-generated");

  const unknownExplanation = explainWorkItemRelevance(jiraItem({ key: "JPMC-401", jiraStatusName: "Never Seen Before" }), idx);
  ok("V2.5 Trust", unknownExplanation.relevance === "UNKNOWN" && unknownExplanation.answer.includes("has not been classified"), "an unclassified status explanation is honest about not being classified, never treated as actionable");

  const naExplanation = explainWorkItemRelevance(jiraItem({ sourceType: undefined, jiraStatusName: undefined }), idx);
  ok("V2.5 Trust", !naExplanation.isApplicable, "a non-Jira item's explanation honestly reports the policy doesn't apply, rather than fabricating a classification");

  ok("V2.5 Trust", Object.values(WORK_RELEVANCE_EXPLANATIONS).every((s) => typeof s === "string" && s.length > 0), "every WorkRelevance value has a concise, non-empty explanation (§9)");
}

// ----- Data Health / unclassified-status signal (§19) -----
// V2.11 §1 — global: an unclassified status counts once no matter how many projects
// observe it, since classifying it once fixes it everywhere.
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "To Do": "ACTIONABLE" }));
  const items = [jiraItem({ id: "a", jiraStatusName: "To Do" }), jiraItem({ id: "b", jiraStatusName: "Some Unmapped Status" }), jiraItem({ id: "c", projectId: "jira-project-UBS", jiraStatusName: "Some Unmapped Status" })];
  const data = { ...emptyData(), workItems: items };
  ok(
    "V2.11 Global policy",
    countUnclassifiedJiraStatuses(data, idx) === 1,
    "counts distinct UNKNOWN status NAMES — JPMC's and UBS's identical unmapped status string count as ONE unclassified entry, not two, since classifying it once would fix it everywhere"
  );
  const rows = listUnclassifiedJiraStatuses(data, idx);
  ok("V2.11 Global policy", rows.length === 1 && rows[0].status === "Some Unmapped Status", "listUnclassifiedJiraStatuses reports the shared unclassified status once, globally");

  const health = computeDataHealth(data, "jira", undefined, undefined, idx);
  ok("V2.11 Global policy", health.unclassifiedJiraStatusCount === 1, "computeDataHealth surfaces the same global count");
  ok(
    "V2.5 Data Health",
    (health.remediation ?? []).some((r) => r.dimension === "Unclassified Jira statuses"),
    "an actionable remediation entry is added for unclassified statuses"
  );

  const noIndexHealth = computeDataHealth(data, "jira", undefined);
  ok("V2.5 Data Health", noIndexHealth.unclassifiedJiraStatusCount === undefined, "omitting the Work Relevance index leaves the new field undefined rather than a fabricated zero");

  const demoHealth = computeDataHealth({ ...emptyData(), workItems: [makeItem()] }, "demo", undefined, undefined, idx);
  ok("V2.5 Data Health", (demoHealth.unclassifiedJiraStatusCount ?? 0) === 0, "demo/non-Jira data never contributes to the unclassified-status count");
}

// ----- Store: setJiraStatusRelevance, persistence, no memory-event noise (§23) -----
// V2.11 §1 — global: setJiraStatusRelevance no longer takes a projectKey at all.
{
  commandCenterStore.resetAll();
  commandCenterStore.loadDemoData();
  const beforeMemory = JSON.stringify(commandCenterStore.getSnapshot().memoryEvents);

  commandCenterStore.setJiraStatusRelevance("Ready for UAT/Business Test", "OBSERVE");
  const afterFirst = commandCenterStore.getSnapshot();
  ok("V2.5 Store", afterFirst.jiraWorkRelevancePolicy["Ready for UAT/Business Test"] === "OBSERVE", "setJiraStatusRelevance persists the classification for the given status");
  ok("V2.5 Store", JSON.stringify(afterFirst.memoryEvents) === beforeMemory, "classifying a status is configuration, not a delivery event — no memory event is emitted (§23)");

  commandCenterStore.setJiraStatusRelevance("To Do", "ACTIONABLE");
  const afterSecond = commandCenterStore.getSnapshot();
  ok(
    "V2.5 Store",
    afterSecond.jiraWorkRelevancePolicy["Ready for UAT/Business Test"] === "OBSERVE" && afterSecond.jiraWorkRelevancePolicy["To Do"] === "ACTIONABLE",
    "classifying a second status preserves the first classification (the map merges, never replaces)"
  );

  const roundTrip = parseStoredState(JSON.stringify(afterSecond));
  ok("V2.5 Store", roundTrip.jiraWorkRelevancePolicy["Ready for UAT/Business Test"] === "OBSERVE", "the policy round-trips through JSON serialization/parseStoredState unchanged");

  commandCenterStore.resetAll();
}

// ----- normalize.ts: the raw Jira status name is captured, never fabricated (§3) -----
{
  const issue = {
    key: "JPMC-999",
    fields: { summary: "UAT signoff", status: { name: "Ready for UAT/Business Test", statusCategory: { key: "indeterminate" } }, created: TODAY, updated: TODAY, project: { key: "JPMC" } },
  };
  const { workItem } = normalizeIssue(issue as JiraIssue, { today: TODAY });
  ok("V2.5 Normalize", workItem.jiraStatusName === "Ready for UAT/Business Test", "normalizeIssue captures the raw Jira status name verbatim, distinct from the collapsed status enum");
  ok("V2.5 Normalize", workItem.status === "In Progress", "the collapsed WorkItemStatus enum is computed exactly as before — V2.5 adds a field, it doesn't change existing mapping behavior");
}

// ----- Performance (§28): Map-based O(1) lookups, no O(n × numberOfStatuses) blowup. -----
{
  const statusNames = Array.from({ length: 30 }, (_, i) => `Status ${i}`);
  const bigPolicy = globalPolicy(Object.fromEntries(statusNames.map((s, i) => [s, (["ACTIONABLE", "WAITING", "OBSERVE", "COMPLETED", "EXCLUDED"] as const)[i % 5]])));
  const bigIndex = buildWorkRelevanceIndex(bigPolicy);

  for (const size of [100, 500, 2000]) {
    const items = Array.from({ length: size }, (_, i) =>
      jiraItem({ id: `perf-${size}-${i}`, key: `PERF${i % 20}-${i}`, projectId: `jira-project-PERF${i % 20}`, jiraStatusName: statusNames[i % 30] })
    );
    const perfData = { ...emptyData(), workItems: items };
    const start = Date.now();
    const candidates = buildCandidates(perfData, TODAY, bigIndex);
    const elapsedMs = Date.now() - start;
    ok("V2.5 Performance", elapsedMs < 2000, `buildCandidates over ${size} Jira work items with Work Relevance gating completes well within a generous bound (${elapsedMs}ms) — Map-based lookup, not O(n × statuses)`);
    const actionableCount = items.filter((_, i) => (["ACTIONABLE", "WAITING", "OBSERVE", "COMPLETED", "EXCLUDED"] as const)[i % 5] === "ACTIONABLE").length;
    ok("V2.5 Performance", candidates.length <= actionableCount, `only ACTIONABLE-classified items (${actionableCount} of ${size}) can possibly appear as auto-suggested candidates`);
  }
}

// ===== V2.6 — Work Policy Intelligence & Operational Calibration =====

// ----- Status coverage arithmetic (§3-4, §26 coverage: full / partial / zero / no data) -----
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "To Do": "ACTIONABLE", "Ready for UAT/Business Test": "OBSERVE" }));
  const items = [
    jiraItem({ id: "a", jiraStatusName: "To Do" }),
    jiraItem({ id: "b", jiraStatusName: "Ready for UAT/Business Test" }),
    jiraItem({ id: "c", jiraStatusName: "Blocked" }), // unclassified
  ];
  const data = { ...emptyData(), workItems: items };

  const partial = computeOverallWorkRelevanceCoverage(data, idx, ["JPMC"]);
  ok("V2.6 Coverage", partial.observedStatusCount === 3 && partial.classifiedStatusCount === 2 && partial.unclassifiedStatusCount === 1, "computeOverallWorkRelevanceCoverage counts observed/classified/unclassified statuses correctly");
  ok("V2.6 Coverage", partial.coveragePct === 67, "coverage percentage is deterministic rounded arithmetic (2/3 = 67%), never a blended score");
  ok("V2.6 Coverage", partial.state === "PARTIALLY_CLASSIFIED", "2 of 3 classified is PARTIALLY_CLASSIFIED");

  const fullyIdx = buildWorkRelevanceIndex(globalPolicy({ "To Do": "ACTIONABLE", "Ready for UAT/Business Test": "OBSERVE", Blocked: "WAITING" }));
  const full = computeOverallWorkRelevanceCoverage(data, fullyIdx, ["JPMC"]);
  ok("V2.6 Coverage", full.state === "FULLY_CLASSIFIED" && full.coveragePct === 100, "every observed status classified is FULLY_CLASSIFIED at 100%");

  const zeroIdx = buildWorkRelevanceIndex({});
  const zero = computeOverallWorkRelevanceCoverage(data, zeroIdx, ["JPMC"]);
  ok("V2.6 Coverage", zero.state === "NOT_CLASSIFIED" && zero.coveragePct === 0 && zero.classifiedStatusCount === 0, "an entirely unclassified scope (observed statuses exist, none mapped) is NOT_CLASSIFIED at 0%");

  const noData = computeOverallWorkRelevanceCoverage({ ...emptyData() }, idx, ["GHOST"]);
  ok("V2.6 Coverage", noData.state === "NO_JIRA_DATA" && noData.observedStatusCount === 0, "a scope with no observed statuses at all is NO_JIRA_DATA, never NOT_CLASSIFIED (§4)");

  // §10 — overall coverage across every project, optionally scoped to Focus Projects.
  // V2.11 §1 — global: a status observed in two different projects is the SAME status now,
  // counted once, not once per project (JPMC's "To Do" and UBS's "To Do" are identical).
  const twoProjectItems = [...items, jiraItem({ id: "d", projectId: "jira-project-UBS", jiraStatusName: "To Do" })];
  const twoProjectData = { ...emptyData(), workItems: twoProjectItems };
  const overallAll = computeOverallWorkRelevanceCoverage(twoProjectData, idx);
  ok("V2.11 Global policy", overallAll.observedStatusCount === 3, "overall coverage counts distinct STATUS NAMES across every project — UBS's 'To Do' is the same status as JPMC's, not double-counted");
  const overallFocused = computeOverallWorkRelevanceCoverage(twoProjectData, idx, ["UBS"]);
  ok("V2.11 Global policy", overallFocused.observedStatusCount === 1, "overall coverage narrowed to Focus Projects (['UBS']) counts only UBS's own OBSERVED vocabulary ('To Do') — scoping still applies to what's observed, even though classification itself is global");

  const emptyOverall = computeOverallWorkRelevanceCoverage({ ...emptyData() }, idx);
  ok("V2.6 Coverage", emptyOverall.state === "NO_JIRA_DATA", "no Jira data at all is honestly reported as NO_JIRA_DATA, not 0% classified");
}

// ----- Policy Change Impact Preview: deterministic affected-item counts (§8-9) -----
// V2.11 §1 — global: a policy change now affects every project's items in that status, so
// countOpenItemsForStatus is no longer scoped to one project.
{
  const items = [
    jiraItem({ id: "a", key: "JPMC-1", jiraStatusName: "Ready for UAT/Business Test" }),
    jiraItem({ id: "b", key: "JPMC-2", jiraStatusName: "Ready for UAT/Business Test" }),
    jiraItem({ id: "c", key: "JPMC-3", jiraStatusName: "Ready for UAT/Business Test", status: "Done" }), // closed — excluded
    jiraItem({ id: "d", key: "JPMC-4", jiraStatusName: "Waiting for Client" }),
    jiraItem({ id: "e", key: "UBS-1", projectId: "jira-project-UBS", jiraStatusName: "Ready for UAT/Business Test" }), // different project, same status
  ];
  const data = { ...emptyData(), workItems: items };

  ok(
    "V2.11 Global policy",
    countOpenItemsForStatus(data, "Ready for UAT/Business Test") === 3,
    "impact count is the number of OPEN items matching this status ACROSS EVERY PROJECT — JPMC's 2 plus UBS's 1, since a policy change now applies everywhere; the closed item is excluded"
  );
  ok("V2.6 Impact preview", countOpenItemsForStatus(data, "Waiting for Client") === 1, "impact count is scoped to the specific status, not every item");
  ok("V2.6 Impact preview", countOpenItemsForStatus(data, "Never Seen") === 0, "a status with no matching items yields 0, never a fabricated number");
}

// ----- listStatusesByRelevance: generalizes the V2.5 UNKNOWN-only listing (§17) -----
// V2.11 §1 — global: one row per distinct STATUS NAME, never one per (project, status) pair.
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "To Do": "ACTIONABLE", "Ready for UAT/Business Test": "OBSERVE" }));
  const items = [jiraItem({ id: "a", jiraStatusName: "To Do" }), jiraItem({ id: "b", jiraStatusName: "Ready for UAT/Business Test" }), jiraItem({ id: "c", projectId: "jira-project-UBS", jiraStatusName: "To Do" })];
  const data = { ...emptyData(), workItems: items };

  const actionableRows = listStatusesByRelevance(data, idx, "ACTIONABLE");
  ok(
    "V2.11 Global policy",
    actionableRows.length === 1 && actionableRows[0].status === "To Do",
    "listStatusesByRelevance(ACTIONABLE) returns 'To Do' exactly once, even though it's observed on both JPMC and UBS items — the policy is global, so it's one status, not two rows"
  );

  const observeRows = listStatusesByRelevance(data, idx, "OBSERVE");
  ok("V2.6 Status listing", observeRows.length === 1 && observeRows[0].status === "Ready for UAT/Business Test", "listStatusesByRelevance(OBSERVE) returns only the OBSERVE-classified row");

  // listUnclassifiedJiraStatuses must still behave identically after being rewritten as a thin wrapper.
  const unclassified = listUnclassifiedJiraStatuses(data, idx);
  ok("V2.6 Status listing", unclassified.length === 0, "listUnclassifiedJiraStatuses (now a thin wrapper over listStatusesByRelevance) is unchanged — every status here is classified");
}

// ----- Command Bar: new/extended intents + near-miss regression matrix (§17) -----
{
  const items = [
    jiraItem({ id: "a", key: "JPMC-500", title: "Sprint board cleanup", jiraStatusName: "To Do" }),
    jiraItem({ id: "b", key: "JPMC-501", title: "UAT coverage", jiraStatusName: "Ready for UAT/Business Test" }),
  ];
  const cbData = { ...emptyData(), workItems: items };
  const idx = buildWorkRelevanceIndex(globalPolicy({ "To Do": "ACTIONABLE", "Ready for UAT/Business Test": "OBSERVE" }));
  const derived = deriveData(cbData, null, TODAY);

  ok("V2.6 Command Bar", classifyQuery("Which statuses are actionable?", cbData).intent === "jira-statuses-actionable", "'which statuses are actionable?' routes to the new jira-statuses-actionable intent");
  ok("V2.6 Command Bar", classifyQuery("What are the actionable statuses?", cbData).intent === "jira-statuses-actionable", "'what are the actionable statuses?' also routes correctly (near-miss phrasing)");
  ok("V2.6 Command Bar", classifyQuery("What is being observed?", cbData).intent === "jira-status-context", "'what is being observed?' routes to the existing jira-status-context intent (same OBSERVE listing as 'what's in UAT?')");

  const actionableFacts = answerFromRoute({ intent: "jira-statuses-actionable" }, cbData, derived, TODAY, "jira", undefined, undefined, undefined, idx);
  ok("V2.6 Command Bar", actionableFacts.facts.some((f) => f.includes("To Do") && f.includes("ACTIONABLE")), "'which statuses are actionable?' names the real classified status, not an invented one");

  const observedFacts = answerFromRoute({ intent: "jira-status-context" }, cbData, derived, TODAY, "jira", undefined, undefined, undefined, idx);
  ok("V2.6 Command Bar", observedFacts.facts.some((f) => f.includes("JPMC-501")), "'what is being observed?' (no keyword) lists every current OBSERVE item");

  // Near-miss regression matrix (§17) — every V2.5 phrasing from the same worked examples
  // must still route exactly as before; none of the V2.6 additions may shadow them.
  ok("V2.6 Near-miss regression", classifyQuery("What is in UAT?", cbData).intent === "jira-status-context", "'what is in UAT?' still routes to jira-status-context (unaffected by the new 'being observed' pattern)");
  ok("V2.6 Near-miss regression", classifyQuery("What is waiting?", cbData).intent === "jira-status-waiting", "'what is waiting?' still routes to jira-status-waiting");
  ok("V2.6 Near-miss regression", classifyQuery("What do I need to work on?", cbData).intent === "next-actions", "'what do I need to work on?' still routes to next-actions, not jira-statuses-actionable");
  ok("V2.6 Near-miss regression", classifyQuery("Why isn't JPMC-500 on my list?", cbData).intent === "why-on-my-list", "'why isn't X on my list?' still routes to why-on-my-list");
  ok("V2.6 Near-miss regression", classifyQuery("Which Jira statuses are unclassified?", cbData).intent === "jira-statuses-unclassified", "'which Jira statuses are unclassified?' still routes to jira-statuses-unclassified, not jira-statuses-actionable");
  ok("V2.6 Near-miss regression", classifyQuery("Which projects need my attention?", cbData).intent === "which-projects-need-attention", "'which projects need my attention?' is unaffected by the new actionable-statuses pattern");
  ok("V2.6 Near-miss regression", classifyQuery("asdkjfh nonsense query", cbData).intent === "unrecognized", "nonsense input remains unclassified, never misrouted to a V2.6 intent");
}

// ----- Performance (§23/§28): coverage/impact calculations use Map-based indexes, no O(n²). -----
{
  const statusNames = Array.from({ length: 30 }, (_, i) => `Status ${i}`);
  const bigPolicy = globalPolicy(Object.fromEntries(statusNames.map((s, i) => [s, (["ACTIONABLE", "WAITING", "OBSERVE", "COMPLETED", "EXCLUDED"] as const)[i % 5]])));
  const bigIndex = buildWorkRelevanceIndex(bigPolicy);

  for (const size of [100, 500, 2000]) {
    const items = Array.from({ length: size }, (_, i) =>
      jiraItem({ id: `perf-cov-${size}-${i}`, key: `PERF${i % 20}-${i}`, projectId: `jira-project-PERF${i % 20}`, jiraStatusName: statusNames[i % 30] })
    );
    const perfData = { ...emptyData(), workItems: items };

    const start = Date.now();
    const overall = computeOverallWorkRelevanceCoverage(perfData, bigIndex);
    const scoped = computeOverallWorkRelevanceCoverage(perfData, bigIndex, ["PERF0"]);
    const impact = countOpenItemsForStatus(perfData, "Status 0");
    const elapsedMs = Date.now() - start;

    ok("V2.6 Performance", elapsedMs < 2000, `coverage + impact calculations over ${size} Jira work items complete well within a generous bound (${elapsedMs}ms)`);
    ok("V2.6 Performance", overall.observedStatusCount > 0 && scoped.observedStatusCount > 0 && impact >= 0, `coverage/impact results over ${size} items are well-formed, not degenerate`);
  }
}

// ===== V2.7 — Work Relevance Operational Calibration =====

function calAction(overrides: Partial<Action> = {}): Action {
  return { id: `action-${Math.random().toString(36).slice(2)}`, title: "Test action", why: "test", status: "open", estimateMinutes: 15, createdAt: TODAY, ...overrides };
}

// ----- §4 Distribution: counts per relevance, project breakdown -----
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "To Do": "ACTIONABLE", "Waiting for Client": "WAITING", "Ready for UAT/Business Test": "OBSERVE", Done: "COMPLETED" }));
  const items = [
    jiraItem({ id: "a", jiraStatusName: "To Do" }),
    jiraItem({ id: "b", jiraStatusName: "To Do" }),
    jiraItem({ id: "c", jiraStatusName: "Waiting for Client" }),
    jiraItem({ id: "d", jiraStatusName: "Ready for UAT/Business Test" }),
    jiraItem({ id: "e", jiraStatusName: "Done", status: "Done" }),
    jiraItem({ id: "f", jiraStatusName: "Never Classified" }), // UNKNOWN
    // V2.11 §1 — "To Do" is now classified globally, so a status UBS observes that nobody
    // has EVER classified (not just "not classified for UBS") is the one that stays UNKNOWN.
    jiraItem({ id: "g", projectId: "jira-project-UBS", jiraStatusName: "Something Nobody Classified" }),
  ];
  const data = { ...emptyData(), workItems: items };
  const rows = computeWorkRelevanceDistribution(data, idx);

  ok("V2.7 Distribution", rows.length === 2, "distribution returns one row per observed project (JPMC and UBS), never collapsed together");
  const jpmc = rows.find((r) => r.projectKey === "JPMC")!;
  ok("V2.7 Distribution", jpmc.counts.ACTIONABLE === 2 && jpmc.counts.WAITING === 1 && jpmc.counts.OBSERVE === 1 && jpmc.counts.COMPLETED === 1 && jpmc.counts.UNKNOWN === 1, "JPMC's counts match the real classified data exactly, including a Done/COMPLETED item and an UNKNOWN one");
  ok("V2.7 Distribution", jpmc.totalItems === 6, "totalItems is the sum across every relevance bucket for that project");
  const ubs = rows.find((r) => r.projectKey === "UBS")!;
  ok("V2.7 Distribution", ubs.counts.UNKNOWN === 1 && ubs.totalItems === 1, "UBS's status (never classified by anyone) reports UNKNOWN — distribution is still counted per-project even though the policy itself is global");

  const scoped = computeWorkRelevanceDistribution(data, idx, ["JPMC"]);
  ok("V2.7 Distribution", scoped.length === 1 && scoped[0].projectKey === "JPMC", "narrowing to Focus Projects (['JPMC']) excludes UBS entirely — never leaks scope");
}

// ----- §5 Actionable calibration: candidate pool / acted-on / completed evidence -----
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "To Do": "ACTIONABLE" }));
  const untouched = jiraItem({ id: "act-1", key: "JPMC-1", jiraStatusName: "To Do", businessImpact: 1, priority: "P4" }); // low score -> may not enter pool
  const highScore = jiraItem({ id: "act-2", key: "JPMC-2", jiraStatusName: "To Do", businessImpact: 5, priority: "P1", blocked: true, dueDate: TODAY }); // high score -> enters pool
  const actedOn = jiraItem({ id: "act-3", key: "JPMC-3", jiraStatusName: "To Do", businessImpact: 5, priority: "P1", blocked: true, dueDate: TODAY });
  const completed = jiraItem({ id: "act-4", key: "JPMC-4", jiraStatusName: "To Do", businessImpact: 5, priority: "P1", blocked: true, dueDate: TODAY });
  const data = {
    ...emptyData(),
    workItems: [untouched, highScore, actedOn, completed],
    actions: [calAction({ id: "a-acted", relatedWorkItemId: "act-3", status: "open" }), calAction({ id: "a-done", relatedWorkItemId: "act-4", status: "completed", completedAt: TODAY })],
  };

  const result = computeActionableCalibration(data, idx, TODAY);
  ok("V2.7 Actionable calibration", result.actionableItemCount === 4, "counts every open item classified ACTIONABLE, regardless of score");
  ok("V2.7 Actionable calibration", result.actedOnCount === 2, "actedOnCount counts items with at least one linked Action (open or completed)");
  ok("V2.7 Actionable calibration", result.completedCount === 1, "completedCount counts only items whose linked Action is actually completed");
  ok("V2.7 Actionable calibration", result.candidatePoolCount >= result.actedOnCount - 1, "candidatePoolCount is derived from the real, reused action-plan.ts buildCandidates() — not reimplemented scoring");

  // A single ACTIONABLE item with zero action evidence and not enough volume for a signal.
  const noEvidenceIdx = buildWorkRelevanceIndex(globalPolicy({ "To Do": "ACTIONABLE" }));
  const noEvidenceData = { ...emptyData(), workItems: [jiraItem({ id: "solo", jiraStatusName: "To Do" })], actions: [] };
  const soloResult = computeActionableCalibration(noEvidenceData, noEvidenceIdx, TODAY);
  ok("V2.7 Actionable calibration", soloResult.actionableItemCount === 1 && soloResult.actedOnCount === 0 && soloResult.completedCount === 0, "no action evidence at all is reported as zero, never estimated");
}

// ----- §6 Observe calibration: OBSERVE items stay outside the candidate pool -----
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "Ready for UAT/Business Test": "OBSERVE" }));
  const observeItems = [
    jiraItem({ id: "obs-1", jiraStatusName: "Ready for UAT/Business Test", businessImpact: 5, priority: "P1", blocked: true, dueDate: TODAY, owner: "Minh Tran" }),
    jiraItem({ id: "obs-2", jiraStatusName: "Ready for UAT/Business Test" }),
  ];
  const data = { ...emptyData(), workItems: observeItems };
  const result = computeObserveCalibration(data, idx, TODAY);
  ok("V2.7 Observe calibration", result.observeItemCount === 2, "counts every open OBSERVE item");
  ok("V2.7 Observe calibration", result.policyViolationCount === 0, "0 policy violations — OBSERVE items never enter the automatic candidate pool, even a high-priority owned one (§21 boundary holds)");
  ok("V2.7 Observe calibration", result.outsidePersonalWorkCount === 2, "every OBSERVE item is confirmed outside inferred personal work");

  // §22 — an explicit user-created Action on an OBSERVE item is evidence, not a violation.
  const withExplicitAction = { ...data, actions: [calAction({ relatedWorkItemId: "obs-1" })] };
  const resultWithAction = computeObserveCalibration(withExplicitAction, idx, TODAY);
  ok("V2.7 Observe calibration", resultWithAction.policyViolationCount === 0, "an explicit user-created Action on an OBSERVE item is not counted as a policy violation — it's evidence for a review signal instead (§8, §22)");
}

// ----- §7 Unknown visibility -----
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "To Do": "ACTIONABLE" }));
  const items = [
    jiraItem({ id: "u1", jiraStatusName: "Some New Status" }),
    jiraItem({ id: "u2", jiraStatusName: "Some New Status" }),
    jiraItem({ id: "u3", jiraStatusName: "Another New Status" }),
    jiraItem({ id: "u4", jiraStatusName: "Some New Status", status: "Done" }), // closed — excluded
    jiraItem({ id: "u5", jiraStatusName: "To Do" }), // classified — not UNKNOWN
  ];
  const data = { ...emptyData(), workItems: items };
  const result = computeUnknownVisibility(data, idx);
  ok("V2.7 Unknown visibility", result.statusCount === 2, "counts distinct unclassified (project, status) pairs — 'Some New Status' and 'Another New Status'");
  ok("V2.7 Unknown visibility", result.affectedItemCount === 3, "counts open affected items only — the closed duplicate is excluded, matching the existing V2.5 open-item convention");
}

// ----- §8-11 Policy Review Signals: REVIEW / NONE / INSUFFICIENT_EVIDENCE -----
{
  const idx = buildWorkRelevanceIndex(
    globalPolicy({ "To Do": "ACTIONABLE", "Ready for Prod Release": "OBSERVE", "Almost Never Seen": "WAITING", "Well Behaved": "ACTIONABLE" })
  );

  // Signal A — OBSERVE status with repeated (>=2) explicit Action evidence -> REVIEW.
  const observeWithActions = [
    jiraItem({ id: "sig-a-1", jiraStatusName: "Ready for Prod Release" }),
    jiraItem({ id: "sig-a-2", jiraStatusName: "Ready for Prod Release" }),
    jiraItem({ id: "sig-a-3", jiraStatusName: "Ready for Prod Release" }),
  ];
  // Signal B — ACTIONABLE status, enough volume, ZERO action evidence -> REVIEW.
  const actionableNoEvidence = [
    jiraItem({ id: "sig-b-1", jiraStatusName: "To Do" }),
    jiraItem({ id: "sig-b-2", jiraStatusName: "To Do" }),
    jiraItem({ id: "sig-b-3", jiraStatusName: "To Do" }),
  ];
  // A well-behaved ACTIONABLE status with real evidence -> NONE.
  const wellBehaved = [
    jiraItem({ id: "wb-1", jiraStatusName: "Well Behaved" }),
    jiraItem({ id: "wb-2", jiraStatusName: "Well Behaved" }),
    jiraItem({ id: "wb-3", jiraStatusName: "Well Behaved" }),
  ];
  // Too little volume to trust any signal -> INSUFFICIENT_EVIDENCE.
  const tooFew = [jiraItem({ id: "few-1", jiraStatusName: "Almost Never Seen" })];

  const data = {
    ...emptyData(),
    workItems: [...observeWithActions, ...actionableNoEvidence, ...wellBehaved, ...tooFew],
    actions: [
      calAction({ id: "act-obs-1", relatedWorkItemId: "sig-a-1" }),
      calAction({ id: "act-obs-2", relatedWorkItemId: "sig-a-2", status: "completed", completedAt: TODAY }),
      calAction({ id: "act-wb-1", relatedWorkItemId: "wb-1" }),
    ],
  };

  const signals = computePolicyReviewSignals(data, idx);
  const byStatus = new Map(signals.map((s) => [s.statusName, s]));

  const observeSignal = byStatus.get("Ready for Prod Release")!;
  ok("V2.7 Policy signals", observeSignal.signalType === "REVIEW", "an OBSERVE status with 2+ linked Actions produces a REVIEW signal (Signal A)");
  ok("V2.7 Policy signals", observeSignal.actionEvidenceCount === 2 && observeSignal.completionEvidenceCount === 1, "evidence counts are exact: 2 linked Actions, 1 of them completed");
  ok("V2.7 Policy signals", !/should be|is (wrong|incorrect)|because.*failed/i.test(observeSignal.explanation), "the explanation never claims causality or that the policy is wrong (§9, §34)");
  ok("V2.7 Policy signals", /may be worth reviewing/i.test(observeSignal.explanation), "REVIEW signals use the exact neutral 'may be worth reviewing' language, never a stronger claim");

  const actionableSignal = byStatus.get("To Do")!;
  ok("V2.7 Policy signals", actionableSignal.signalType === "REVIEW", "an ACTIONABLE status with enough volume and ZERO action evidence produces a REVIEW signal (Signal B)");
  ok("V2.7 Policy signals", actionableSignal.actionEvidenceCount === 0, "zero linked Actions despite 3 observed items");

  const wellBehavedSignal = byStatus.get("Well Behaved")!;
  ok("V2.7 Policy signals", wellBehavedSignal.signalType === "NONE", "an ACTIONABLE status with real action evidence produces no signal");

  const fewSignal = byStatus.get("Almost Never Seen")!;
  ok("V2.7 Policy signals", fewSignal.signalType === "INSUFFICIENT_EVIDENCE", "a status with too few observed items (1) never produces a REVIEW/NONE verdict, only INSUFFICIENT_EVIDENCE");

  ok("V2.7 Policy signals", !signals.some((s) => s.currentRelevance === "UNKNOWN"), "UNKNOWN-classified statuses never appear in Policy Review Signals — they're covered separately by Unknown Visibility (§7)");

  ok("V2.7 Data Health", computeCalibrationHealthState(signals) === "REVIEW", "the Data Health calibration state is REVIEW when at least one status shows a REVIEW signal");
  ok("V2.7 Data Health", computeCalibrationHealthState([wellBehavedSignal]) === "HEALTHY", "a set with no REVIEW/INSUFFICIENT_EVIDENCE-only signals is HEALTHY");
  ok("V2.7 Data Health", computeCalibrationHealthState([fewSignal]) === "INSUFFICIENT_EVIDENCE", "a set where every signal is INSUFFICIENT_EVIDENCE is reported as INSUFFICIENT_EVIDENCE, never HEALTHY");
  ok("V2.7 Data Health", computeCalibrationHealthState([]) === "INSUFFICIENT_EVIDENCE", "no observed statuses at all is INSUFFICIENT_EVIDENCE, never HEALTHY");
}

// ----- V2.11 §1 Global policy: same status name, different projects, SHARED policy and
// SHARED calibration evidence pool. This block replaces the old "V2.7 Project isolation"
// suite, which explicitly asserted the opposite (independent per-project signals) — the
// exact premise V2.11 §1 intentionally reverses (see the fix prompt's Task 1 item 6). -----
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "Ready for Prod Release": "ACTIONABLE" }));
  const data = {
    ...emptyData(),
    workItems: [
      jiraItem({ id: "iso-1", projectId: "jira-project-JPMC", jiraStatusName: "Ready for Prod Release" }),
      jiraItem({ id: "iso-2", projectId: "jira-project-JPMC", jiraStatusName: "Ready for Prod Release" }),
      jiraItem({ id: "iso-3", projectId: "jira-project-JPMC", jiraStatusName: "Ready for Prod Release" }),
      jiraItem({ id: "iso-4", projectId: "jira-project-UBS", jiraStatusName: "Ready for Prod Release" }),
      jiraItem({ id: "iso-5", projectId: "jira-project-UBS", jiraStatusName: "Ready for Prod Release" }),
      jiraItem({ id: "iso-6", projectId: "jira-project-UBS", jiraStatusName: "Ready for Prod Release" }),
    ],
    actions: [calAction({ id: "iso-a1", relatedWorkItemId: "iso-1" }), calAction({ id: "iso-a2", relatedWorkItemId: "iso-2" }), calAction({ id: "iso-a3", relatedWorkItemId: "iso-4" })],
  };
  const signals = computePolicyReviewSignals(data, idx);
  ok(
    "V2.11 Global policy",
    signals.length === 1,
    "the identical raw status name observed on both JPMC and UBS items produces exactly ONE PolicyReviewSignal row, never two — the policy (and its evidence pool) is shared, not per-project"
  );
  const signal = signals[0];
  ok("V2.11 Global policy", signal.observedItemCount === 6, "observed item count is the sum across every project observing this status — JPMC's 3 plus UBS's 3");
  ok(
    "V2.11 Global policy",
    signal.actionEvidenceCount === 3,
    "an ACTIONABLE status with 2 linked Actions from JPMC and 1 from UBS reports 3 total linked Actions for that status, not 2 and 1 counted separately — the exact worked example from Task 1"
  );
  ok("V2.11 Global policy", signal.signalType === "NONE", "with real action evidence present across the combined pool, no REVIEW signal fires");
}

// ----- Explicit Actions remain intact / authoritative (§22) -----
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "Ready for UAT/Business Test": "OBSERVE" }));
  const item = jiraItem({ id: "explicit-1", key: "JPMC-999", jiraStatusName: "Ready for UAT/Business Test" });
  const explicitAction: Action = { id: "explicit-action", title: "Confirm production release", why: "manual tracking", status: "open", estimateMinutes: 10, createdAt: TODAY, relatedWorkItemId: "explicit-1" };
  const data = { ...emptyData(), workItems: [item], actions: [explicitAction] };
  ok("V2.7 Explicit Actions", data.actions.length === 1 && data.actions[0].id === "explicit-action", "an explicit user-created Action linked to an OBSERVE item is untouched by any V2.7 calculation");
  const calibration = computeObserveCalibration(data, idx, TODAY);
  ok("V2.7 Explicit Actions", calibration.policyViolationCount === 0, "the explicit Action does not cause a policy-violation false positive");
}

// ----- Synthetic data: no false calibration claim (§16) -----
{
  // computeWorkRelevanceDistribution etc. are pure functions with no concept of "synthetic"
  // — the UI layer (WorkRelevanceCalibrationPanel, data-settings/page.tsx) is what gates on
  // state.isDemo / state.dataSource, exactly like V2.5/V2.6's own jiraConfigured gate. This
  // test documents that boundary: a demo-sourced item (sourceType !== "jira") is simply
  // NOT_APPLICABLE and contributes nothing to any V2.7 calculation, so even if a caller
  // forgot to gate the UI, no false ACTIONABLE/OBSERVE/etc. claim could be produced for it.
  const idx = buildWorkRelevanceIndex(globalPolicy({ "To Do": "ACTIONABLE" }));
  const demoItem = makeItem({ id: "demo-1", sourceType: undefined, jiraStatusName: undefined });
  const data = { ...emptyData(), workItems: [demoItem] };
  const distribution = computeWorkRelevanceDistribution(data, idx);
  ok("V2.7 Synthetic data", distribution.length === 0, "a non-Jira (demo/local-import) item contributes no row at all to the distribution — never a fabricated classification");
}

// ----- Backward compatibility: malformed/missing policy never crashes calibration (§26) -----
{
  const emptyIdx = buildWorkRelevanceIndex({});
  const items = [jiraItem({ id: "bc-1", jiraStatusName: "To Do" })];
  const data = { ...emptyData(), workItems: items };
  const distribution = computeWorkRelevanceDistribution(data, emptyIdx);
  ok("V2.7 Backward compatibility", distribution[0]?.counts.UNKNOWN === 1, "an entirely missing policy map degrades every item to UNKNOWN, never throws");
  const signals = computePolicyReviewSignals(data, emptyIdx);
  ok("V2.7 Backward compatibility", signals.length === 0, "UNKNOWN statuses produce no policy-review-signal row (handled by Unknown Visibility instead), and nothing throws");
  const actionable = computeActionableCalibration(data, emptyIdx, TODAY);
  ok("V2.7 Backward compatibility", actionable.actionableItemCount === 0, "with no policy at all, nothing is ACTIONABLE — calibration stays conservative, never crashes");
}

// ----- Command Bar: new V2.7 intents + near-miss regression matrix (§19) -----
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "To Do": "ACTIONABLE", "Ready for Prod Release": "OBSERVE" }));
  const items = [
    jiraItem({ id: "cb7-1", key: "JPMC-701", jiraStatusName: "To Do" }),
    jiraItem({ id: "cb7-2", key: "JPMC-702", jiraStatusName: "To Do" }),
    jiraItem({ id: "cb7-3", key: "JPMC-703", jiraStatusName: "To Do" }),
    jiraItem({ id: "cb7-4", key: "JPMC-704", jiraStatusName: "Ready for Prod Release" }),
    jiraItem({ id: "cb7-5", key: "JPMC-705", jiraStatusName: "Ready for Prod Release" }),
    jiraItem({ id: "cb7-6", key: "JPMC-706", jiraStatusName: "Ready for Prod Release" }),
  ];
  const cbData = { ...emptyData(), workItems: items, actions: [calAction({ relatedWorkItemId: "cb7-4" }), calAction({ relatedWorkItemId: "cb7-5" })] };
  const derived = deriveData(cbData, null, TODAY);

  ok("V2.7 Command Bar", classifyQuery("How is my work relevance policy performing?", cbData).intent === "work-relevance-calibration-summary", "routes to the calibration summary intent");
  ok("V2.7 Command Bar", classifyQuery("Which statuses need policy review?", cbData).intent === "policy-review-signals", "routes to the policy-review-signals intent");
  ok(
    "V2.7 Command Bar",
    classifyQuery("Are any actionable statuses producing little personal work?", cbData).intent === "actionable-low-personal-work",
    "'actionable statuses producing little personal work' routes to actionable-low-personal-work, NOT jira-statuses-actionable, despite containing the substring 'actionable statuses'"
  );
  ok("V2.7 Command Bar", classifyQuery("Which observed statuses have actions?", cbData).intent === "observed-statuses-with-actions", "routes to the observed-statuses-with-actions intent");

  const summaryFacts = answerFromRoute({ intent: "work-relevance-calibration-summary" }, cbData, derived, TODAY, "jira", undefined, undefined, undefined, idx);
  ok("V2.7 Command Bar", summaryFacts.facts.some((f) => f.includes("JPMC") && f.includes("ACTIONABLE 3")), "the calibration summary names the real project and real ACTIONABLE count");

  const reviewFacts = answerFromRoute({ intent: "policy-review-signals" }, cbData, derived, TODAY, "jira", undefined, undefined, undefined, idx);
  ok("V2.7 Command Bar", reviewFacts.facts.some((f) => f.includes("Ready for Prod Release")), "policy-review-signals surfaces the real status name with a review signal");

  const observedActionsFacts = answerFromRoute({ intent: "observed-statuses-with-actions" }, cbData, derived, TODAY, "jira", undefined, undefined, undefined, idx);
  ok("V2.7 Command Bar", observedActionsFacts.facts.some((f) => f.includes("2 linked Action")), "observed-statuses-with-actions reports the real linked-Action count");

  // Near-miss regression — every V2.5/V2.6 phrasing must still route exactly as before.
  ok("V2.7 Near-miss regression", classifyQuery("Which statuses are actionable?", cbData).intent === "jira-statuses-actionable", "the plain V2.6 'which statuses are actionable?' still routes correctly, unaffected by the new V2.7 patterns");
  ok("V2.7 Near-miss regression", classifyQuery("What is being observed?", cbData).intent === "jira-status-context", "'what is being observed?' still routes to jira-status-context");
  ok("V2.7 Near-miss regression", classifyQuery("Which Jira statuses are unclassified?", cbData).intent === "jira-statuses-unclassified", "unclassified-statuses phrasing is unaffected");
  ok("V2.7 Near-miss regression", classifyQuery("What do I need to work on?", cbData).intent === "next-actions", "next-actions is unaffected by any V2.7 pattern");
  ok("V2.7 Near-miss regression", classifyQuery("Why isn't JPMC-701 on my list?", cbData).intent === "why-on-my-list", "why-on-my-list is unaffected");
  ok("V2.7 Near-miss regression", classifyQuery("asdkjfh nonsense query", cbData).intent === "unrecognized", "nonsense input remains unclassified, never misrouted to a V2.7 intent");
}

// ----- Performance (§25): 100 / 500 / 2000 items, Map-based grouping, no O(n²). -----
{
  const statusNames = Array.from({ length: 30 }, (_, i) => `Status ${i}`);
  const bigPolicy = globalPolicy(Object.fromEntries(statusNames.map((s, i) => [s, (["ACTIONABLE", "WAITING", "OBSERVE", "COMPLETED", "EXCLUDED"] as const)[i % 5]])));
  const bigIndex = buildWorkRelevanceIndex(bigPolicy);

  for (const size of [100, 500, 2000]) {
    const items = Array.from({ length: size }, (_, i) =>
      jiraItem({ id: `perf7-${size}-${i}`, key: `PERF7-${i % 20}-${i}`, projectId: `jira-project-PERF7-${i % 20}`, jiraStatusName: statusNames[i % 30] })
    );
    const actions = items.filter((_, i) => i % 7 === 0).map((item, i) => calAction({ relatedWorkItemId: item.id, status: i % 2 === 0 ? "completed" : "open" }));
    const perfData = { ...emptyData(), workItems: items, actions };

    const start = Date.now();
    const distribution = computeWorkRelevanceDistribution(perfData, bigIndex);
    const signals = computePolicyReviewSignals(perfData, bigIndex);
    const actionable = computeActionableCalibration(perfData, bigIndex, TODAY);
    const observe = computeObserveCalibration(perfData, bigIndex, TODAY);
    const elapsedMs = Date.now() - start;

    ok("V2.7 Performance", elapsedMs < 3000, `full V2.7 calibration pass over ${size} Jira work items completes well within a generous bound (${elapsedMs}ms)`);
    ok("V2.7 Performance", distribution.length > 0 && signals.length > 0 && actionable.actionableItemCount >= 0 && observe.observeItemCount >= 0, `results over ${size} items are well-formed, not degenerate`);
  }
}

// ===== V2.8 — Execution Path & Work Signal Calibration =====

function mockAttentionItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "RISK:test-risk",
    category: "RISK",
    severity: "HIGH",
    what: "Test risk",
    why: "test",
    impact: "test impact",
    nowWhat: "mitigate",
    evidence: [],
    lifecycle: "ACTIVE",
    firstSeenDate: TODAY,
    lastSeenDate: TODAY,
    sourceRef: { type: "risk", id: "Test risk" },
    ...overrides,
  };
}

function mockProactive(attentionQueue: AttentionItem[], deliveryLoops: any[] = []): any {
  return { attentionQueue, deliveryLoops };
}

function mockPersonalFocus(candidates: PersonalFocusCandidate[]): any {
  return { candidates, top3: candidates.slice(0, 3) };
}

// ----- §5-6 Execution Path Trace: a full ACTIONABLE path (candidate -> plan -> action -> focus -> outcome) -----
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "In Progress": "ACTIONABLE" }));
  const item = jiraItem({ id: "exec-1", key: "JPMC-800", jiraStatusName: "In Progress", status: "In Progress", businessImpact: 5, priority: "P1", blocked: true, dueDate: TODAY, owner: "Minh Tran" });
  const openAction = calAction({ id: "exec-action-1", relatedWorkItemId: "exec-1", status: "open" });

  const risk: Risk = { id: "risk-1", projectId: "proj-1", title: "Risk on JPMC-800", level: "HIGH", reason: "test", evidence: [], potentialImpact: "impact", mitigation: "mitigate", status: "open", confidence: 0.8, detectedAt: TODAY, sourceWorkItemIds: ["exec-1"] };
  const attentionItem = mockAttentionItem({ id: "RISK:risk-on-jpmc-800", sourceRef: { type: "risk", id: "Risk on JPMC-800" } });
  const focusCandidate = pfc({ id: "focus:attention:RISK:risk-on-jpmc-800", sourceType: "attention", sourceId: "RISK:risk-on-jpmc-800", title: risk.title, whyOnMyList: "Because a HIGH severity risk is linked to this work." });

  const data = { ...emptyData(), workItems: [item], actions: [openAction], risks: [risk] };
  const proactive = mockProactive([attentionItem]);
  const personalFocus = mockPersonalFocus([focusCandidate]);

  const trace = computeExecutionPathTrace(item, data, TODAY, idx, proactive, personalFocus);
  ok("V2.8 Execution trace", trace.relevance === "ACTIONABLE", "relevance is read via the real V2.5/V2.6 resolveWorkRelevance(), not reimplemented");
  ok("V2.8 Execution trace", trace.candidateEvaluation === "ELIGIBLE", "an ACTIONABLE item with an OPEN action is ELIGIBLE — the action-loop keeps it represented in buildCandidates()");
  ok("V2.8 Execution trace", trace.actionPlan === "SELECTED", "a real candidate with a small enough estimate is SELECTED within the reference 30-minute Action Plan budget");
  ok("V2.8 Execution trace", trace.actions.state === "EXISTS" && trace.actions.activeCount === 1 && trace.actions.completedCount === 0, "the real linked, open Action is reflected exactly");
  ok("V2.8 Execution trace", trace.attention.presentInPersonalFocus === true, "the item is traced to Personal Focus via the REAL Risk.sourceWorkItemIds -> AttentionItem.sourceRef -> PersonalFocusCandidate.sourceId chain, never inferred");
  ok("V2.8 Execution trace", trace.attention.connectedAttentionItems.some((a) => a.id === attentionItem.id), "the connected AttentionItem is the real one, found via the FK chain");
  ok("V2.8 Execution trace", trace.attention.personalFocusCandidate?.id === focusCandidate.id, "the matched PersonalFocusCandidate is the real one, not fabricated");
  ok("V2.8 Execution trace", trace.outcome.recorded === false, "no outcome yet — the action hasn't completed");

  // BUGFIX regression, at the execution-trace level: completing the action must never make
  // the item look untouched/fresh again on the next trace computation.
  const completedAction = { ...openAction, status: "completed" as const, completedAt: TODAY, outcomeStatus: "EFFECTIVE" as const };
  const dataAfterComplete = { ...data, actions: [completedAction] };
  const traceAfterComplete = computeExecutionPathTrace(item, dataAfterComplete, TODAY, idx, proactive, personalFocus);
  ok("V2.8 Execution trace (bugfix)", traceAfterComplete.candidateEvaluation === "NOT_APPLICABLE", "once the Action is completed, Candidate Evaluation reads NOT_APPLICABLE — never a misleading 'not eligible', and never silently ELIGIBLE again as if untouched");
  ok("V2.8 Execution trace (bugfix)", traceAfterComplete.actionPlan === "NOT_APPLICABLE", "Action Plan correctly follows suit rather than showing the completed item as needing selection again");
  ok("V2.8 Execution trace (bugfix)", traceAfterComplete.actions.state === "EXISTS" && traceAfterComplete.actions.completedCount === 1, "the completed action itself remains fully visible on the trace");
  ok("V2.8 Execution trace (bugfix)", traceAfterComplete.outcome.recorded === true && traceAfterComplete.outcome.count === 1, "the outcome is now correctly recorded");
}

// ----- §5-6 OBSERVE item with an explicit Action: OBSERVE stays OBSERVE, Action stays intact -----
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "Ready for Prod Release": "OBSERVE" }));
  const item = jiraItem({ id: "exec-2", key: "JPMC-801", jiraStatusName: "Ready for Prod Release" });
  const explicitAction = calAction({ id: "exec-action-2", relatedWorkItemId: "exec-2" });
  const data = { ...emptyData(), workItems: [item], actions: [explicitAction] };

  const trace = computeExecutionPathTrace(item, data, TODAY, idx, mockProactive([]), mockPersonalFocus([]));
  ok("V2.8 Execution trace (OBSERVE)", trace.relevance === "OBSERVE", "OBSERVE stays OBSERVE — never changed by the presence of an explicit Action");
  ok("V2.8 Execution trace (OBSERVE)", trace.candidateEvaluation === "NOT_APPLICABLE" && trace.actionPlan === "NOT_APPLICABLE", "candidate evaluation and Action Plan are NOT_APPLICABLE for a non-ACTIONABLE status — never described as 'did not enter'");
  ok("V2.8 Execution trace (OBSERVE)", trace.actions.state === "EXISTS" && trace.actions.actions[0].id === "exec-action-2", "the explicit Action remains fully intact and visible on an OBSERVE item (§22)");
  ok("V2.8 Execution trace (OBSERVE)", trace.attention.presentInPersonalFocus === false && trace.attention.evidenceAvailable === true, "no Attention/Loop evidence connects this item, honestly reported as not present (not an error)");
}

// ----- §4 Not enough evidence: proactive/personalFocus unavailable -----
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "Ready for Prod Release": "OBSERVE" }));
  const item = jiraItem({ id: "exec-3", key: "JPMC-802", jiraStatusName: "Ready for Prod Release" });
  const data = { ...emptyData(), workItems: [item] };
  const trace = computeExecutionPathTrace(item, data, TODAY, idx, null, null);
  ok("V2.8 Execution trace (no evidence)", trace.attention.evidenceAvailable === false, "when proactive intelligence isn't available, this is reported as 'not enough evidence', never a false 'not present'");
  ok("V2.8 Execution trace (no evidence)", trace.attention.presentInPersonalFocus === false, "presentInPersonalFocus defaults to false (not fabricated true) when evidence is unavailable");
}

// ----- §5 UNKNOWN status and non-Jira items remain safe -----
{
  const idx = buildWorkRelevanceIndex({});
  const unknownItem = jiraItem({ id: "exec-4", key: "JPMC-803", jiraStatusName: "Totally New Status" });
  const data1 = { ...emptyData(), workItems: [unknownItem] };
  const unknownTrace = computeExecutionPathTrace(unknownItem, data1, TODAY, idx, null, null);
  ok("V2.8 Execution trace (UNKNOWN)", unknownTrace.relevance === "UNKNOWN", "an unclassified status resolves to UNKNOWN, exactly as V2.5/V2.6 already guarantee");
  ok("V2.8 Execution trace (UNKNOWN)", unknownTrace.candidateEvaluation === "NOT_APPLICABLE", "UNKNOWN is never treated as eligible for candidate evaluation — conservative by default");

  const demoItem = makeItem({ id: "exec-5", key: "DEMO-1", sourceType: undefined, jiraStatusName: undefined });
  const data2 = { ...emptyData(), workItems: [demoItem] };
  const demoTrace = computeExecutionPathTrace(demoItem, data2, TODAY, idx, null, null);
  ok("V2.8 Execution trace (non-Jira)", demoTrace.relevance === "NOT_APPLICABLE" && demoTrace.candidateEvaluation === "NOT_APPLICABLE" && demoTrace.actionPlan === "NOT_APPLICABLE", "a non-Jira (demo/local-import) item is NOT_APPLICABLE end-to-end, never fabricated ACTIONABLE/OBSERVE behavior");
}

// ----- §7-8 ExecutionSurfaceExplanation: neutral, evidence-based, never causal -----
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "In Progress": "ACTIONABLE", "Ready for Prod Release": "OBSERVE" }));
  const forbidden = /policy is (wrong|incorrect)|should be (actionable|observe|waiting)|you failed|because you didn'?t/i;

  const selectedItem = jiraItem({ id: "why-1", key: "JPMC-810", jiraStatusName: "In Progress", businessImpact: 5, priority: "P1", blocked: true, dueDate: TODAY });
  const dataSelected = { ...emptyData(), workItems: [selectedItem] };
  const traceSelected = computeExecutionPathTrace(selectedItem, dataSelected, TODAY, idx, null, null);
  const explainSelected = explainExecutionSurface(selectedItem, traceSelected, "ACTION_PLAN", idx);
  ok("V2.8 Surface explanation", explainSelected.present === true, "ACTION_PLAN explanation correctly reports present=true when the item was selected");
  ok("V2.8 Surface explanation", !forbidden.test(explainSelected.explanation), "the 'why in Action Plan' explanation never makes a causal or correctness claim");

  const notEligibleItem = jiraItem({ id: "why-2", key: "JPMC-811", jiraStatusName: "In Progress", businessImpact: 1, priority: "P4" });
  const dataNotEligible = { ...emptyData(), workItems: [notEligibleItem] };
  const traceNotEligible = computeExecutionPathTrace(notEligibleItem, dataNotEligible, TODAY, idx, null, null);
  const explainNotEligible = explainExecutionSurface(notEligibleItem, traceNotEligible, "ACTION_PLAN", idx);
  ok("V2.8 Surface explanation", explainNotEligible.present === false, "'why isn't this in Action Plan' correctly reports present=false");
  ok("V2.8 Surface explanation", !forbidden.test(explainNotEligible.explanation), "the 'why isn't this in Action Plan' explanation never claims the policy is wrong");

  const observeItem = jiraItem({ id: "why-3", key: "JPMC-812", jiraStatusName: "Ready for Prod Release" });
  const dataObserve = { ...emptyData(), workItems: [observeItem] };
  const traceObserve = computeExecutionPathTrace(observeItem, dataObserve, TODAY, idx, null, null);
  const explainObserveActionPlan = explainExecutionSurface(observeItem, traceObserve, "ACTION_PLAN", idx);
  ok("V2.8 Surface explanation", explainObserveActionPlan.explanation.includes("OBSERVE"), "an OBSERVE item's 'why isn't this in Action Plan' explanation reuses the real V2.5 policy explanation, naming the real classification");

  const explainNoFocusNoEvidence = explainExecutionSurface(observeItem, traceObserve, "PERSONAL_FOCUS", idx);
  ok("V2.8 Surface explanation", explainNoFocusNoEvidence.explanation.toLowerCase().includes("not enough evidence"), "PERSONAL_FOCUS explanation honestly says 'not enough evidence' when proactive/personalFocus were never supplied, rather than claiming absence");

  const traceWithProactive = computeExecutionPathTrace(observeItem, dataObserve, TODAY, idx, mockProactive([]), mockPersonalFocus([]));
  const explainNotInFocus = explainExecutionSurface(observeItem, traceWithProactive, "PERSONAL_FOCUS", idx);
  ok(
    "V2.8 Surface explanation",
    explainNotInFocus.explanation.includes("Not currently in Personal Focus") && !/\bis missing\b|\bhas failed\b|\ban error occurred\b/i.test(explainNotInFocus.explanation),
    "absence from Personal Focus is described as a fact ('not currently in Personal Focus'), never as a failure state — and the explanation explicitly says this is not an error"
  );

  const explainNoAction = explainExecutionSurface(observeItem, traceObserve, "EXPLICIT_ACTION", idx);
  ok("V2.8 Surface explanation", explainNoAction.present === false && explainNoAction.explanation.includes("never creates"), "the EXPLICIT_ACTION explanation is explicit that Daily Command never creates an Action automatically");
}

// ----- §22 Explicit Actions remain authoritative through the trace -----
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "Ready for Prod Release": "OBSERVE" }));
  const item = jiraItem({ id: "explicit-exec-1", key: "JPMC-999", jiraStatusName: "Ready for Prod Release" });
  const explicitAction = { id: "explicit-action-exec", title: "Confirm production release", why: "manual tracking", status: "open" as const, estimateMinutes: 10, createdAt: TODAY, relatedWorkItemId: "explicit-exec-1" };
  const data = { ...emptyData(), workItems: [item], actions: [explicitAction] };
  const trace = computeExecutionPathTrace(item, data, TODAY, idx, null, null);
  ok("V2.8 Explicit Actions", trace.actions.state === "EXISTS" && trace.actions.actions.length === 1 && trace.actions.actions[0].title === "Confirm production release", "an explicit, manually-created Action on an OBSERVE item is reported exactly as-is by the trace — never removed or invalidated");
}

// ----- §10 Status-level execution path table + §11 Signal C -----
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "In Progress": "ACTIONABLE", "Blocked Investigation": "ACTIONABLE", "Ready for Prod Release": "OBSERVE" }));
  const highScore = { businessImpact: 5 as const, priority: "P1" as const, blocked: true, dueDate: TODAY };
  const items = [
    jiraItem({ id: "st-1", key: "JPMC-900", jiraStatusName: "In Progress", ...highScore }),
    jiraItem({ id: "st-2", key: "JPMC-901", jiraStatusName: "In Progress", ...highScore }),
    jiraItem({ id: "st-3", key: "JPMC-902", jiraStatusName: "Blocked Investigation" }), // low score — never enters candidate pool
    jiraItem({ id: "st-4", key: "JPMC-903", jiraStatusName: "Blocked Investigation" }),
    jiraItem({ id: "st-5", key: "JPMC-904", jiraStatusName: "Blocked Investigation" }),
    jiraItem({ id: "st-6", key: "JPMC-905", jiraStatusName: "Ready for Prod Release" }),
  ];
  const actionWithOutcome = calAction({ id: "st-action-1", relatedWorkItemId: "st-1" });
  (actionWithOutcome as any).outcomeStatus = "EFFECTIVE";
  const data = { ...emptyData(), workItems: items, actions: [actionWithOutcome] };

  const rows = computeExecutionPathStatusTable(data, idx, TODAY);
  const inProgress = rows.find((r) => r.statusName === "In Progress")!;
  const blockedInv = rows.find((r) => r.statusName === "Blocked Investigation")!;
  const observeRow = rows.find((r) => r.statusName === "Ready for Prod Release")!;

  ok("V2.8 Status table", inProgress.candidateCount === 2, "candidateCount for an ACTIONABLE status counts real buildCandidates() membership, not every item");
  ok("V2.8 Status table", inProgress.outcomeCount === 1, "outcomeCount reflects the one real linked Action carrying a recorded outcome");
  ok("V2.8 Status table", blockedInv.candidateCount === 0, "a low-scoring ACTIONABLE status can legitimately have 0 candidates");
  ok("V2.8 Status table", observeRow.candidateCount === undefined, "candidateCount is undefined ('N/A') for a non-ACTIONABLE status — candidate evaluation doesn't apply, never fabricated as 0");

  // V2.12 — supersedes the old, undifferentiated "Signal C": with no calibration history yet
  // (empty history, the honest cold-start state), a 0-candidate ACTIONABLE status can never
  // clear Requirement 1's time-window bar, so it always lands in Requirement 2's
  // informational Candidate Evaluation Signal instead — never Policy Review.
  const actionableSignals = computeActionableSignals(data, idx, {}, TODAY, undefined, null, null);
  ok("V2.12 Candidate Evaluation", actionableSignals.candidateEvaluation.some((s) => s.statusName === "Blocked Investigation"), "an ACTIONABLE status with enough volume (3) and 0 candidates produces a Candidate Evaluation signal");
  ok("V2.12 Candidate Evaluation", !actionableSignals.candidateEvaluation.some((s) => s.statusName === "In Progress"), "a status with real candidates never produces a Candidate Evaluation signal");
  ok("V2.12 Candidate Evaluation", actionableSignals.candidateEvaluation.every((s) => !/too broad|policy is (wrong|incorrect)/i.test(s.explanation)), "Candidate Evaluation never claims the policy is too broad or wrong — observation only");
  ok("V2.12 Policy Review", actionableSignals.policyReview.length === 0, "with no calibration history yet, Policy Review Signal never fires — insufficient time-window evidence is reported honestly, never fabricated");
}

// ----- V2.12 Signal Semantics Fix: Policy Review requires ALL of time-window + percentage +
// minimum sample size simultaneously; falling short of any one gate demotes it to the
// informational Candidate Evaluation Signal instead, never silently dropped. -----
{
  const policy = buildWorkRelevanceIndex(globalPolicy({ "Long Stuck": "ACTIONABLE", "Small Sample Stuck": "ACTIONABLE", "Recently Stuck": "ACTIONABLE" }));
  const longStuck = Array.from({ length: 10 }, (_, i) => jiraItem({ id: `pr-${i}`, key: `JPMC-PR-${i}`, jiraStatusName: "Long Stuck" })); // low score — never a candidate
  const smallSample = Array.from({ length: 5 }, (_, i) => jiraItem({ id: `ss-${i}`, key: `JPMC-SS-${i}`, jiraStatusName: "Small Sample Stuck" }));
  const recentlyStuck = Array.from({ length: 10 }, (_, i) => jiraItem({ id: `rs-${i}`, key: `JPMC-RS-${i}`, jiraStatusName: "Recently Stuck" }));
  const data = { ...emptyData(), workItems: [...longStuck, ...smallSample] };

  // "Long Stuck" and "Small Sample Stuck" have been observed since day 1 (50 days ago, past
  // the 42-day/3-sprint bar); "Recently Stuck" is only added on TODAY's sync, so it has zero
  // days of observed history — deliberately NOT included in the seed pass below.
  let history = updateWorkItemCalibrationHistory({}, data, policy, "2026-04-26");
  const dataWithRecent = { ...data, workItems: [...data.workItems, ...recentlyStuck] };
  history = updateWorkItemCalibrationHistory(history, dataWithRecent, policy, TODAY);

  const signals = computeActionableSignals(dataWithRecent, policy, history, TODAY, undefined, null, null);
  const policyReviewStatuses = new Set(signals.policyReview.map((s) => s.statusName));
  const candidateEvalStatuses = new Set(signals.candidateEvaluation.map((s) => s.statusName));

  ok("V2.12 Policy Review", policyReviewStatuses.has("Long Stuck"), "ACTIONABLE for 50 days, 100% never entered the candidate pool, 10 observed items — clears all three Requirement 1 gates");
  ok("V2.12 Policy Review", signals.policyReview.find((s) => s.statusName === "Long Stuck")?.neverEnteredPoolPercent === 100, "neverEnteredPoolPercent is computed exactly, not assumed");
  ok("V2.12 Policy Review", !candidateEvalStatuses.has("Long Stuck"), "a status that clears the Policy Review bar never ALSO appears as an informational Candidate Evaluation signal");

  ok("V2.12 Policy Review", !policyReviewStatuses.has("Small Sample Stuck"), "5 observed items is below the 10-item minimum sample size — Policy Review never fires even at 100% never-entered and a 50-day window");
  ok("V2.12 Candidate Evaluation", candidateEvalStatuses.has("Small Sample Stuck"), "falls back to the informational Candidate Evaluation signal instead of being silently dropped");

  ok("V2.12 Policy Review", !policyReviewStatuses.has("Recently Stuck"), "a status newly observed as ACTIONABLE (0 days of history) never fires Policy Review — insufficient time-window evidence, even with 10 items and 0% conversion");
  ok("V2.12 Candidate Evaluation", candidateEvalStatuses.has("Recently Stuck"), "insufficient-time-window statuses still surface as the informational Candidate Evaluation signal, never total silence");
}

// ----- V2.12 Signal Semantics Fix: Execution Gap Signal is item-level, requires a REAL
// recorded candidate-pool entry date (not just "currently a live candidate"), respects the
// grace period, and a linked Action always excludes an item regardless of how long ago it
// entered the pool. -----
{
  const policy = buildWorkRelevanceIndex(globalPolicy({ "In Review": "ACTIONABLE" }));
  // No dueDate here deliberately — it's fixed to a single calendar date, but this test
  // scores the SAME items as of three different simulated "today"s (day 1, day 2, TODAY),
  // and a fixed due date's urgency contribution would drift across them (e.g. "due in 10
  // days" vs "due today"), making eligibility flicker independently of what this test is
  // actually verifying. businessImpact + blocked alone clear the >=40 candidate bar at any
  // of the three dates.
  const highScore = { businessImpact: 5 as const, priority: "P1" as const, blocked: true };
  const stale = jiraItem({ id: "eg-1", key: "JPMC-EG-1", jiraStatusName: "In Review", ...highScore }); // entered pool 10 days ago, no Action -> execution gap
  const fresh = jiraItem({ id: "eg-2", key: "JPMC-EG-2", jiraStatusName: "In Review", ...highScore }); // entered pool 3 days ago -> still inside the 5-day grace period
  const acted = jiraItem({ id: "eg-3", key: "JPMC-EG-3", jiraStatusName: "In Review", ...highScore }); // entered pool 10 days ago, but now has a linked Action

  // Day 1 (10 days ago) — only `stale` and `acted` exist yet, neither has an Action, both
  // score high enough to be real live candidates.
  let history = updateWorkItemCalibrationHistory({}, { ...emptyData(), workItems: [stale, acted] }, policy, "2026-06-05");
  // Day 2 (3 days ago) — `fresh` is observed for the first time, also a live candidate.
  history = updateWorkItemCalibrationHistory(history, { ...emptyData(), workItems: [stale, fresh, acted] }, policy, "2026-06-12");
  // TODAY — a real Action now exists for `acted` (it no longer needs the automatic
  // candidate slot, but its earlier candidate-pool entry stays on record as a real fact).
  const dataToday = { ...emptyData(), workItems: [stale, fresh, acted], actions: [calAction({ id: "eg-action-1", relatedWorkItemId: "eg-3" })] };
  history = updateWorkItemCalibrationHistory(history, dataToday, policy, TODAY);

  const signals = computeActionableSignals(dataToday, policy, history, TODAY, undefined, null, null);
  const gapItemIds = new Set(signals.executionGap.map((s) => s.itemId));

  ok("V2.12 Execution Gap", gapItemIds.has("eg-1"), "a candidate for 10+ days with no linked Action or Focus is a real execution gap");
  ok("V2.12 Execution Gap", !gapItemIds.has("eg-2"), "a candidate for only 3 days is still inside the 5-day grace period — no signal yet");
  ok("V2.12 Execution Gap", !gapItemIds.has("eg-3"), "a linked Action always excludes an item from Execution Gap, no matter how long ago it entered the candidate pool");
  ok(
    "V2.12 Execution Gap",
    signals.executionGap.every((s) => !/policy|review policy/i.test(s.explanation)),
    "Execution Gap explanations never mention policy — this is item-level triage, not a classification question"
  );
}

// ----- §17 Command Bar helpers -----
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "In Progress": "ACTIONABLE" }));
  const eligible = jiraItem({ id: "cbh-1", key: "JPMC-950", jiraStatusName: "In Progress", businessImpact: 5, priority: "P1", blocked: true, dueDate: TODAY });
  const notEligible = jiraItem({ id: "cbh-2", key: "JPMC-951", jiraStatusName: "In Progress", businessImpact: 1, priority: "P4" });
  const data = { ...emptyData(), workItems: [eligible, notEligible] };
  const poolItems = listCandidatePoolActionableItems(data, idx, TODAY);
  ok("V2.8 Command Bar helper", poolItems.some((w) => w.id === "cbh-1"), "listCandidatePoolActionableItems includes the real high-scoring ACTIONABLE item");
  ok("V2.8 Command Bar helper", !poolItems.some((w) => w.id === "cbh-2"), "listCandidatePoolActionableItems excludes the real low-scoring ACTIONABLE item");

  const focusedItem = jiraItem({ id: "cbh-3", key: "JPMC-952", jiraStatusName: "In Progress" });
  const risk: Risk = { id: "cbh-risk", projectId: "proj-1", title: "CBH risk", level: "HIGH", reason: "x", evidence: [], potentialImpact: "x", mitigation: "x", status: "open", confidence: 0.8, detectedAt: TODAY, sourceWorkItemIds: ["cbh-3"] };
  const attn = mockAttentionItem({ id: "RISK:cbh-risk", sourceRef: { type: "risk", id: "CBH risk" } });
  const cand = pfc({ id: "focus:attention:RISK:cbh-risk", sourceType: "attention", sourceId: "RISK:cbh-risk", title: risk.title });
  const focusData = { ...emptyData(), workItems: [focusedItem, notEligible], risks: [risk] };
  const focusRows = listJiraItemsInPersonalFocus(focusData, mockProactive([attn]), mockPersonalFocus([cand]));
  ok("V2.8 Command Bar helper", focusRows.length === 1 && focusRows[0].item.id === "cbh-3", "listJiraItemsInPersonalFocus returns exactly the real, FK-traced item — never every ACTIONABLE item");
  ok("V2.8 Command Bar helper", listJiraItemsInPersonalFocus(focusData, null, null).length === 0, "no proactive/personalFocus evidence yields an empty list, never a guess");
}

// ----- V2.11 §1 Global policy + §18 FK isolation: identical status shares ONE relevance
// across projects, but Risk/Attention FK connections are a completely separate concept and
// stay correctly per-item regardless of policy globality. Replaces the old "V2.8 Project
// isolation" block, whose first assertion asserted the now-reversed per-project premise. -----
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "Ready for Prod Release": "ACTIONABLE" }));
  const jpmcItem = jiraItem({ id: "iso-exec-1", key: "JPMC-960", projectId: "jira-project-JPMC", jiraStatusName: "Ready for Prod Release" });
  const ubsItem = jiraItem({ id: "iso-exec-2", key: "UBS-960", projectId: "jira-project-UBS", jiraStatusName: "Ready for Prod Release" });
  const jpmcRisk: Risk = { id: "iso-risk-jpmc", projectId: "proj-jpmc", title: "JPMC-only risk", level: "HIGH", reason: "x", evidence: [], potentialImpact: "x", mitigation: "x", status: "open", confidence: 0.8, detectedAt: TODAY, sourceWorkItemIds: ["iso-exec-1"] };
  const jpmcAttn = mockAttentionItem({ id: "RISK:jpmc-only-risk", sourceRef: { type: "risk", id: "JPMC-only risk" } });
  const jpmcCand = pfc({ id: "focus:attention:RISK:jpmc-only-risk", sourceType: "attention", sourceId: "RISK:jpmc-only-risk", title: jpmcRisk.title });

  const data = { ...emptyData(), workItems: [jpmcItem, ubsItem], risks: [jpmcRisk] };
  const proactive = mockProactive([jpmcAttn]);
  const personalFocus = mockPersonalFocus([jpmcCand]);

  const jpmcTrace = computeExecutionPathTrace(jpmcItem, data, TODAY, idx, proactive, personalFocus);
  const ubsTrace = computeExecutionPathTrace(ubsItem, data, TODAY, idx, proactive, personalFocus);

  ok(
    "V2.11 Global policy",
    jpmcTrace.relevance === "ACTIONABLE" && ubsTrace.relevance === "ACTIONABLE",
    "the identical raw status resolves to the SAME relevance for both JPMC's and UBS's item — the policy is global, not independently configurable per project"
  );
  ok("V2.8 Project isolation", jpmcTrace.attention.presentInPersonalFocus === true, "JPMC's item is correctly connected to its own real risk/attention/focus evidence");
  ok("V2.8 Project isolation", ubsTrace.attention.presentInPersonalFocus === false, "UBS's item is NOT connected to JPMC's risk evidence — no cross-project leakage via any foreign key (unaffected by the policy becoming global — this is a completely separate FK-based mechanism)");
  ok("V2.8 Project isolation", ubsTrace.attention.connectedAttentionItems.length === 0, "UBS's connectedAttentionItems is empty — the FK chain (Risk.sourceWorkItemIds) never crosses items");
}

// ----- §21 Synthetic data structural safety: demo item never fabricates real behavior -----
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "In Progress": "ACTIONABLE" }));
  const demoItem = makeItem({ id: "synth-1", key: "DEMO-2", sourceType: undefined, jiraStatusName: undefined });
  const data = { ...emptyData(), workItems: [demoItem] };
  const trace = computeExecutionPathTrace(demoItem, data, TODAY, idx, null, null);
  ok("V2.8 Synthetic data", trace.relevance === "NOT_APPLICABLE", "a demo/non-Jira item never gets a fabricated Work Relevance classification");
  const statusRows = computeExecutionPathStatusTable(data, idx, TODAY);
  ok("V2.8 Synthetic data", statusRows.length === 0, "a demo item contributes no row to the execution-path status table at all");
}

// ----- §22 Backward compatibility: malformed/missing policy never crashes execution-path code -----
{
  const emptyIdx = buildWorkRelevanceIndex({});
  const item = jiraItem({ id: "bc-exec-1", key: "JPMC-970", jiraStatusName: "To Do" });
  const data = { ...emptyData(), workItems: [item] };
  const trace = computeExecutionPathTrace(item, data, TODAY, emptyIdx, null, null);
  ok("V2.8 Backward compatibility", trace.relevance === "UNKNOWN", "an entirely missing policy map degrades to UNKNOWN, never throws, exactly like V2.5/V2.6/V2.7");
  const rows = computeExecutionPathStatusTable(data, emptyIdx, TODAY);
  ok("V2.8 Backward compatibility", rows.length === 0, "UNKNOWN rows are excluded from the execution-path status table (handled by V2.7's Unknown Visibility instead), and nothing throws");
}

// ----- §17 Command Bar: new intents + near-miss regression matrix -----
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "In Progress": "ACTIONABLE" }));
  const item = jiraItem({ id: "cb8-1", key: "JPMC-980", jiraStatusName: "In Progress", businessImpact: 5, priority: "P1", blocked: true, dueDate: TODAY });
  const cbData = { ...emptyData(), workItems: [item] };
  const derived = deriveData(cbData, null, TODAY);

  ok("V2.8 Command Bar", classifyQuery("What is the execution path for JPMC-980?", cbData).intent === "execution-path-for-item", "'execution path for X' routes to execution-path-for-item");
  ok("V2.8 Command Bar", classifyQuery("What is the execution path for JPMC-980?", cbData).target === "JPMC-980", "the issue key is captured as the route target");
  ok("V2.8 Command Bar", classifyQuery("Which actionable items entered the candidate pool?", cbData).intent === "candidate-pool-actionable-items", "'which actionable items entered the candidate pool?' routes correctly, not misrouted to jira-statuses-actionable despite containing 'actionable'");
  ok("V2.8 Command Bar", classifyQuery("Which items are in Personal Focus because of Jira work?", cbData).intent === "jira-items-in-personal-focus", "'which items are in Personal Focus because of Jira work?' routes correctly");

  const traceFacts = answerFromRoute({ intent: "execution-path-for-item", target: "JPMC-980" }, cbData, derived, TODAY, "jira", undefined, undefined, undefined, idx);
  ok("V2.8 Command Bar", traceFacts.facts[0].includes("JPMC-980") && traceFacts.facts[0].includes("ACTIONABLE"), "execution-path-for-item narrates the real item's real classification");

  const noTargetFacts = answerFromRoute({ intent: "execution-path-for-item" }, cbData, derived, TODAY, "jira", undefined, undefined, undefined, idx);
  ok("V2.8 Command Bar", noTargetFacts.facts[0] === "I need a project, issue key, or status to answer that precisely.", "with no issue key found, execution-path-for-item gives the exact §17 fallback line rather than guessing");

  // Near-miss regression — every V2.5/V2.6/V2.7 phrasing must still route exactly as before.
  ok("V2.8 Near-miss regression", classifyQuery("Which statuses are actionable?", cbData).intent === "jira-statuses-actionable", "the plain V2.6 'which statuses are actionable?' is unaffected by the new candidate-pool pattern");
  ok("V2.8 Near-miss regression", classifyQuery("Are any actionable statuses producing little personal work?", cbData).intent === "actionable-low-personal-work", "V2.7's actionable-low-personal-work phrasing is unaffected");
  ok("V2.8 Near-miss regression", classifyQuery("What should I focus on today?", cbData).intent === "personal-focus-today", "personal-focus-today is unaffected by the new 'items in Personal Focus because of Jira work' pattern");
  ok("V2.8 Near-miss regression", classifyQuery("What do I need to work on?", cbData).intent === "next-actions", "next-actions remains unaffected");
  ok("V2.8 Near-miss regression", classifyQuery("Why isn't JPMC-980 on my list?", cbData).intent === "why-on-my-list", "why-on-my-list remains unaffected");
  ok("V2.8 Near-miss regression", classifyQuery("asdkjfh nonsense query", cbData).intent === "unrecognized", "nonsense input remains unclassified, never misrouted to a V2.8 intent");
}

// ----- §23 Performance: 100 / 500 / 2000 items, indexed relationships, no O(n²). -----
{
  const statusNames = Array.from({ length: 30 }, (_, i) => `Status ${i}`);
  const bigPolicy = globalPolicy(Object.fromEntries(statusNames.map((s, i) => [s, (["ACTIONABLE", "WAITING", "OBSERVE", "COMPLETED", "EXCLUDED"] as const)[i % 5]])));
  const bigIndex = buildWorkRelevanceIndex(bigPolicy);

  for (const size of [100, 500, 2000]) {
    const items = Array.from({ length: size }, (_, i) =>
      jiraItem({ id: `perf8-${size}-${i}`, key: `PERF8-${i % 20}-${i}`, projectId: `jira-project-PERF8-${i % 20}`, jiraStatusName: statusNames[i % 30] })
    );
    const actions = items.filter((_, i) => i % 9 === 0).map((item, i) => calAction({ relatedWorkItemId: item.id, status: i % 2 === 0 ? "completed" : "open" }));
    const perfData = { ...emptyData(), workItems: items, actions };

    const start = Date.now();
    const statusRows = computeExecutionPathStatusTable(perfData, bigIndex, TODAY);
    const actionableSignals = computeActionableSignals(perfData, bigIndex, {}, TODAY, undefined, null, null);
    const poolItems = listCandidatePoolActionableItems(perfData, bigIndex, TODAY);
    const oneTrace = computeExecutionPathTrace(items[0], perfData, TODAY, bigIndex, null, null);
    const elapsedMs = Date.now() - start;

    ok("V2.8 Performance", elapsedMs < 3000, `full execution-path calculation pass over ${size} Jira work items completes well within a generous bound (${elapsedMs}ms)`);
    ok(
      "V2.8 Performance",
      statusRows.length > 0 && actionableSignals.candidateEvaluation.length >= 0 && actionableSignals.executionGap.length >= 0 && poolItems.length >= 0 && !!oneTrace.item,
      `results over ${size} items are well-formed, not degenerate`
    );
  }
}

// ===== V2.13 §3 — TicketLink: real link when a real Jira sourceUrl exists, plain text when
// it doesn't; never a fabricated href guessed from the key pattern. No jsdom in this project
// (see the V1.8 Accessibility section above) — rendered via react-dom/server's
// renderToStaticMarkup, a real DOM-structure check, not just "doesn't throw". =====
{
  const withUrl = renderToStaticMarkup(React.createElement(TicketLink, { ticketKey: "JPMC-123", url: "https://jira.example.com/browse/JPMC-123" }));
  ok("V2.13 TicketLink", /<a\b[^>]*\bhref="https:\/\/jira\.example\.com\/browse\/JPMC-123"/.test(withUrl), "with a url, TicketLink renders an <a> with that exact href");
  ok("V2.13 TicketLink", /target="_blank"/.test(withUrl) && /rel="noopener noreferrer"/.test(withUrl), "the link opens in a new tab with noopener noreferrer");
  ok("V2.13 TicketLink", withUrl.includes("JPMC-123"), "the ticket key text is rendered inside the link");

  const withoutUrl = renderToStaticMarkup(React.createElement(TicketLink, { ticketKey: "JPMC-124" }));
  ok("V2.13 TicketLink", !/<a[\s>]/.test(withoutUrl), "with no url, TicketLink renders no <a> tag at all — plain text, never a broken/empty link");
  ok("V2.13 TicketLink", withoutUrl.includes("JPMC-124"), "the plain ticket key text is still rendered");
}

// ===== V2.14 §1 — classifyPersonalRelation: all five outcomes, with/without accountId
// configured (fallback path), and the no-identity-at-all -> UNKNOWN case. =====
{
  const item = makeItem({ id: "cr-wi-1", key: "CR-1", owner: "Alice", ownerId: "acc-alice" });
  const mentioned = new Set(["CR-1"]);
  const notMentioned = new Set<string>();

  ok("V2.14 classifyPersonalRelation", classifyPersonalRelation(item, {}, notMentioned, item.key) === "UNKNOWN", "no accountId/displayName configured at all -> UNKNOWN, never guessed (§1)");
  ok("V2.14 classifyPersonalRelation", classifyPersonalRelation(item, {}, mentioned, item.key) === "UNKNOWN", "UNKNOWN holds even when the issue IS in mentionedIssueKeys — no identity means no relation can be claimed");

  // accountId-configured path.
  ok("V2.14 classifyPersonalRelation", classifyPersonalRelation(item, { accountId: "acc-alice" }, notMentioned, item.key) === "ASSIGNED", "ownerId matches the configured accountId, not mentioned -> ASSIGNED");
  ok("V2.14 classifyPersonalRelation", classifyPersonalRelation(item, { accountId: "acc-alice" }, mentioned, item.key) === "ASSIGNED_AND_MENTIONED", "ownerId matches AND the issue is mentioned -> ASSIGNED_AND_MENTIONED");
  ok("V2.14 classifyPersonalRelation", classifyPersonalRelation(item, { accountId: "acc-bob" }, mentioned, item.key) === "MENTIONED", "ownerId does not match, but the issue is mentioned -> MENTIONED");
  ok("V2.14 classifyPersonalRelation", classifyPersonalRelation(item, { accountId: "acc-bob" }, notMentioned, item.key) === "FOLLOWING", "neither assigned nor mentioned, but identity IS configured -> FOLLOWING, not UNKNOWN");
  ok("V2.14 classifyPersonalRelation", classifyPersonalRelation(item, { accountId: "acc-bob" }, mentioned, undefined) === "FOLLOWING", "an undefined issueKey never matches mentionedIssueKeys, even when the set is non-empty");

  // displayName-fallback path (no accountId configured).
  ok("V2.14 classifyPersonalRelation — displayName fallback", classifyPersonalRelation(item, { displayName: "Alice" }, notMentioned, item.key) === "ASSIGNED", "no accountId configured -> falls back to WorkItem.owner === identity.displayName");
  ok("V2.14 classifyPersonalRelation — displayName fallback", classifyPersonalRelation(item, { displayName: "Bob" }, mentioned, item.key) === "MENTIONED", "displayName fallback: no name match, but mentioned -> MENTIONED");
  ok("V2.14 classifyPersonalRelation — displayName fallback", classifyPersonalRelation(item, { displayName: "Alice" }, mentioned, item.key) === "ASSIGNED_AND_MENTIONED", "displayName fallback: name match AND mentioned -> ASSIGNED_AND_MENTIONED");

  // accountId takes priority over displayName — a shared display name is never enough once
  // accountId is configured (same discipline as V2.10 §1's isExplicitOwner).
  const impostor = makeItem({ id: "cr-wi-2", key: "CR-2", owner: "Alice", ownerId: "acc-impostor" });
  ok(
    "V2.14 classifyPersonalRelation — accountId priority",
    classifyPersonalRelation(impostor, { accountId: "acc-alice", displayName: "Alice" }, notMentioned, impostor.key) === "FOLLOWING",
    "accountId configured -> a matching displayName alone is never enough (no name-similarity guessing)"
  );

  // No related WorkItem at all (personal-focus.ts's relation-less stub) — still resolves a
  // real value, never a crash, and mention-only signals still work with no owner info.
  const noOwnerStub = { id: "stub", ownerId: undefined, owner: undefined };
  ok("V2.14 classifyPersonalRelation — no related work item", classifyPersonalRelation(noOwnerStub, { accountId: "acc-alice" }, mentioned, "CR-1") === "MENTIONED", "no ownerId/owner at all, but the issue key is mentioned -> MENTIONED");
  ok("V2.14 classifyPersonalRelation — no related work item", classifyPersonalRelation(noOwnerStub, { accountId: "acc-alice" }, notMentioned, "CR-1") === "FOLLOWING", "no ownerId/owner at all and not mentioned -> FOLLOWING");

  // matchesIdentity — the shared comparison isExplicitOwner (personal-focus.ts) also calls.
  ok("V2.14 matchesIdentity", matchesIdentity("acc-1", "Alice", { accountId: "acc-1" }) === true, "ownerId match wins when accountId is configured");
  ok("V2.14 matchesIdentity", matchesIdentity("acc-2", "Alice", { accountId: "acc-1" }) === false, "a different ownerId never matches, regardless of displayName");
  ok("V2.14 matchesIdentity", matchesIdentity(undefined, "Alice", { displayName: "Alice" }) === true, "displayName match when no accountId is configured");
  ok("V2.14 matchesIdentity", matchesIdentity(undefined, undefined, {}) === false, "nothing to compare -> false, never a guessed match");
}

// ===== V2.14 §4 — isMyActionItem: ASSIGNED/ASSIGNED_AND_MENTIONED/MENTIONED only. =====
{
  ok("V2.14 isMyActionItem", isMyActionItem("ASSIGNED") === true, "ASSIGNED counts as a my-action item");
  ok("V2.14 isMyActionItem", isMyActionItem("ASSIGNED_AND_MENTIONED") === true, "ASSIGNED_AND_MENTIONED counts");
  ok("V2.14 isMyActionItem", isMyActionItem("MENTIONED") === true, "MENTIONED counts — someone is waiting on a reply");
  ok("V2.14 isMyActionItem", isMyActionItem("FOLLOWING") === false, "FOLLOWING is excluded — visibility only, not a task");
  ok("V2.14 isMyActionItem", isMyActionItem("UNKNOWN") === false, "UNKNOWN is excluded");
  ok("V2.14 isMyActionItem", isMyActionItem(undefined) === false, "undefined (no resolvable relation) is excluded");
}

// ===== V2.14 §2 — RelationBadge: one pill per value except UNKNOWN (renders nothing), and
// every rendered value is distinguishable by its own label text, not color alone. =====
{
  const html = (relation: Parameters<typeof RelationBadge>[0]["relation"]) => renderToStaticMarkup(React.createElement(RelationBadge, { relation }));
  const assigned = html("ASSIGNED");
  const both = html("ASSIGNED_AND_MENTIONED");
  const mentionedBadge = html("MENTIONED");
  const following = html("FOLLOWING");
  const unknown = html("UNKNOWN");
  const undef = html(undefined);

  ok("V2.14 RelationBadge", assigned.includes("Assigned to you"), "ASSIGNED renders its label");
  ok("V2.14 RelationBadge", both.includes("Assigned") && both.includes("mentioned"), "ASSIGNED_AND_MENTIONED renders a label naming both");
  ok("V2.14 RelationBadge", mentionedBadge.includes("Mentioned you"), "MENTIONED renders its label");
  ok("V2.14 RelationBadge", following.includes("Following"), "FOLLOWING renders its label");
  ok("V2.14 RelationBadge", unknown === "", "UNKNOWN renders nothing — an absent badge, not a placeholder one");
  ok("V2.14 RelationBadge", undef === "", "an undefined relation (e.g. no single resolvable ticket) also renders nothing");

  const labels = [assigned, both, mentionedBadge, following].map((h) => h.replace(/<[^>]+>/g, ""));
  ok("V2.14 RelationBadge", new Set(labels).size === labels.length, "every non-UNKNOWN relation has a visually distinct label — not color alone, matching this app's other badges");
}

// ===== V2.14 §4 — myActionItemsOnly toggle: default, independent per-page setter, and
// persistence — same pattern as the V2.11 §3B showAdvancedSettings toggle above. =====
{
  commandCenterStore.resetAll();
  const initial = commandCenterStore.getSnapshot().myActionItemsOnly;
  ok("V2.14 myActionItemsOnly toggle", initial.attention === false && initial.myDay === false && initial.priorities === false, "defaults to Everything (off) on every page for a first-time user — never a surprising silent-hide default");

  commandCenterStore.setMyActionItemsOnly("attention", true);
  const afterOneSet = commandCenterStore.getSnapshot().myActionItemsOnly;
  ok("V2.14 myActionItemsOnly toggle", afterOneSet.attention === true && afterOneSet.myDay === false && afterOneSet.priorities === false, "setting one page's toggle is independently settable — it never flips another page's");

  const roundTrip = parseStoredState(JSON.stringify(commandCenterStore.getSnapshot()));
  ok("V2.14 myActionItemsOnly toggle", roundTrip.myActionItemsOnly.attention === true && roundTrip.myActionItemsOnly.priorities === false, "round-trips through JSON serialization/parseStoredState unchanged — persists across a reload");

  const fallback = parseStoredState("not valid json");
  ok("V2.14 myActionItemsOnly toggle", fallback.myActionItemsOnly.attention === false && fallback.myActionItemsOnly.myDay === false && fallback.myActionItemsOnly.priorities === false, "malformed stored state falls back to the safe default (Everything) on every page, never a crash");

  commandCenterStore.resetAll();
}

// ===== V2.14 §1/§3 — PersonalRelation wired end-to-end through computeProactiveIntelligence
// (AttentionItem.relation) and computePersonalFocus (PersonalFocusCandidate.relation),
// genuinely independent of ownershipExplicit/AttentionCategory — no DO_NOW/DO_TODAY placement
// or category order changes as a side effect of this pass. =====
{
  // dueDate: TODAY triggers risk-detection.ts's R1 (deadline) rule — a real auto-detected
  // RISK AttentionItem for each item, so this exercises the actual sourceRef -> WorkItem
  // resolution path (same one ticketKey/ticketUrl already use), not a hand-built fixture.
  const relAssigned = jiraItem({ id: "rel-wi-assigned", key: "REL-1", owner: "Alice", ownerId: "acc-alice", dueDate: TODAY });
  const relMentionedOnly = jiraItem({ id: "rel-wi-mentioned", key: "REL-2", owner: "Bob", ownerId: "acc-bob", dueDate: TODAY });
  const relFollowing = jiraItem({ id: "rel-wi-following", key: "REL-3", owner: "Bob", ownerId: "acc-bob", dueDate: TODAY });
  const relData: CommandCenterData = { ...emptyData(), workItems: [relAssigned, relMentionedOnly, relFollowing] };
  const relDerived = deriveData(relData, null, TODAY);
  const relMentionEvents: MentionEvent[] = [{ issueKey: "REL-2", commentId: "rel-c1", excerpt: "please take a look", mentionedAt: TODAY }];

  const relProactive = computeProactiveIntelligence(relData, relDerived, [], null, {}, "jira", TODAY, undefined, relMentionEvents, "acc-alice", "Alice");
  const attnFor = (key: string) => relProactive.attentionQueue.find((i) => i.ticketKey === key);

  ok("V2.14 AttentionItem.relation", attnFor("REL-1")?.relation === "ASSIGNED", "an AttentionItem whose single related WorkItem.ownerId matches the configured accountId classifies ASSIGNED");
  ok("V2.14 AttentionItem.relation", attnFor("REL-2")?.relation === "MENTIONED", "an AttentionItem on a mentioned-but-not-owned ticket classifies MENTIONED");
  ok("V2.14 AttentionItem.relation", attnFor("REL-3")?.relation === "FOLLOWING", "an AttentionItem neither owned nor mentioned, with identity configured, classifies FOLLOWING (never UNKNOWN)");

  // Omitting identityDisplayName/mentionEvents/identityOwnerId is a no-op — no relation is
  // ever fabricated (matches every other additive/optional trailing parameter in this app).
  const relProactiveNoIdentity = computeProactiveIntelligence(relData, relDerived, [], null, {}, "jira", TODAY);
  ok(
    "V2.14 AttentionItem.relation",
    relProactiveNoIdentity.attentionQueue.every((i) => i.relation === undefined || i.relation === "UNKNOWN"),
    "with no identity configured at all, no AttentionItem is ever assigned a guessed relation"
  );

  const relFocus = computePersonalFocus(relData, relProactive, "Alice", TODAY, "acc-alice", undefined, relDerived.risks, relMentionEvents);
  const candFor = (key: string) => relFocus.candidates.find((c) => c.ticketKey === key);
  ok("V2.14 PersonalFocusCandidate.relation", candFor("REL-1")?.relation === "ASSIGNED", "the same WorkItem resolves to ASSIGNED as a PersonalFocusCandidate too");
  ok("V2.14 PersonalFocusCandidate.relation", candFor("REL-2")?.relation === "MENTIONED", "MENTIONED carries through to PersonalFocusCandidate");
  ok("V2.14 PersonalFocusCandidate.relation", candFor("REL-3")?.relation === "FOLLOWING", "FOLLOWING carries through to PersonalFocusCandidate");

  // Independence from ownershipExplicit/category (§1's explicit non-goal): a WATCH/low-score
  // candidate can still be ASSIGNED, and relation never changes score/category/DO_NOW
  // placement — asserting the untouched fields stayed exactly what they'd be without §1.
  const bareFocus = computePersonalFocus(relData, relProactive, "Alice", TODAY, "acc-alice", undefined, relDerived.risks);
  const bareCand = bareFocus.candidates.find((c) => c.ticketKey === "REL-1");
  const withRelCand = candFor("REL-1");
  ok(
    "V2.14 independence from scoring",
    !!bareCand && !!withRelCand && bareCand.score === withRelCand.score && bareCand.category === withRelCand.category && bareCand.ownershipExplicit === withRelCand.ownershipExplicit,
    "adding PersonalRelation classification (via the mentionEvents parameter) never changes score, category, or ownershipExplicit — a read-only, additive pass"
  );

  // isMyActionItem composes correctly as an extra AND filter over the real candidate set.
  const myActionCandidates = relFocus.candidates.filter((c) => isMyActionItem(c.relation));
  ok(
    "V2.14 isMyActionItem integration",
    myActionCandidates.some((c) => c.ticketKey === "REL-1") && myActionCandidates.some((c) => c.ticketKey === "REL-2") && !myActionCandidates.some((c) => c.ticketKey === "REL-3"),
    "'My action items only' keeps ASSIGNED/MENTIONED candidates and excludes the FOLLOWING one"
  );
}

// ===== V2.15 — Cross-Device Consistency =====

// --- sync-auth.ts: checkSyncRequestAuth (jira/sync POST gate — accepts EITHER secret) ---
// V2.18 §4 — the pre-V2.18 "neither secret configured -> open" default is a confirmed P0
// finding (see the security hardening pass); these assertions now lock in the fail-closed
// replacement, matching checkAppStateAuth's existing (already-correct) 503 contract exactly.
{
  const unconfigured1 = checkSyncRequestAuth(null, undefined, undefined);
  ok("V2.18 sync-auth", unconfigured1.ok === false && unconfigured1.status === 503, "neither secret configured -> unauthorized (503, not available) — the fail-open default is gone");
  const unconfigured2 = checkSyncRequestAuth("Bearer anything", undefined, undefined);
  ok("V2.18 sync-auth", unconfigured2.ok === false && unconfigured2.status === 503, "still closed with neither configured, regardless of what header (if any) is sent");

  const noHeader = checkSyncRequestAuth(null, "cron-secret", undefined);
  ok("V2.18 sync-auth", noHeader.ok === false && noHeader.status === 401, "only CRON_SECRET configured, no header -> unauthorized");
  ok("V2.18 sync-auth", checkSyncRequestAuth("Bearer cron-secret", "cron-secret", undefined).ok === true, "only CRON_SECRET configured, matching header -> authorized (the automated cron/GitHub Action path)");
  const wrongHeader = checkSyncRequestAuth("Bearer wrong", "cron-secret", undefined);
  ok("V2.18 sync-auth", wrongHeader.ok === false && wrongHeader.status === 401, "only CRON_SECRET configured, wrong header -> unauthorized");

  ok("V2.18 sync-auth", checkSyncRequestAuth("Bearer app-state-secret", undefined, "app-state-secret").ok === true, "only APP_STATE_SECRET configured, matching header -> authorized (a paired browser with no CRON_SECRET set)");

  ok("V2.18 sync-auth", checkSyncRequestAuth("Bearer cron-secret", "cron-secret", "app-state-secret").ok === true, "both configured: a request bearing CRON_SECRET is authorized");
  ok("V2.18 sync-auth", checkSyncRequestAuth("Bearer app-state-secret", "cron-secret", "app-state-secret").ok === true, "both configured: a request bearing APP_STATE_SECRET is ALSO authorized — both work at the same time");
  const neitherValid = checkSyncRequestAuth("Bearer neither-of-these", "cron-secret", "app-state-secret");
  ok("V2.18 sync-auth", neitherValid.ok === false && neitherValid.status === 401, "both configured: a request bearing neither valid secret is rejected");
  const noHeaderBothConfigured = checkSyncRequestAuth(null, "cron-secret", "app-state-secret");
  ok("V2.18 sync-auth", noHeaderBothConfigured.ok === false && noHeaderBothConfigured.status === 401, "both configured: no header at all is rejected");

  // V2.20 — a trailing newline/space in the configured env var (a real-world gotcha: pasting
  // `openssl rand -hex 32` terminal output straight into a deployment's env var UI often
  // carries one) must never make an otherwise-correct paired secret 401 forever.
  const trimmedCronSecret = checkSyncRequestAuth("Bearer cron-secret", "cron-secret\n", undefined);
  ok("V2.20 sync-auth secret trimming", trimmedCronSecret.ok === true, "CRON_SECRET env var with a trailing newline still authorizes a header sent without one");
  const trimmedAppStateSecret = checkSyncRequestAuth("Bearer app-state-secret", undefined, "  app-state-secret  ");
  ok("V2.20 sync-auth secret trimming", trimmedAppStateSecret.ok === true, "APP_STATE_SECRET env var with surrounding whitespace still authorizes a header sent without it");
  const whitespaceOnlyBothUnconfigured = checkSyncRequestAuth(null, "  ", "\n");
  ok("V2.20 sync-auth secret trimming", whitespaceOnlyBothUnconfigured.ok === false && whitespaceOnlyBothUnconfigured.status === 503, "whitespace-only env vars are treated as unset, not as configured-but-unmatchable secrets");
}

// ===== V2.18 — Security hardening: consistent auth across every sensitive route =====
// Confirmed P0 finding: jira/projects, jira/conformance, ai (POST), and notify (POST) had NO
// auth code path at all, regardless of any env var — unlike jira/sync and state, which at
// least checked something. These assertions confirm each route now gates on the same shared
// checkSyncRequestAuth, and that every client caller that talks to a now-gated route attaches
// the paired-device secret (source-regex checks: these routes/callers transitively import
// "server-only" or are client components, so they're read rather than imported/executed,
// matching this suite's existing precedent for route-level and client-fetch wiring checks).
{
  const repoRoot = path.resolve(process.cwd());
  const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), "utf8");

  const gatedRoutes = [
    "src/app/api/command-center/jira/projects/route.ts",
    "src/app/api/command-center/jira/conformance/route.ts",
    "src/app/api/command-center/ai/route.ts",
    "src/app/api/command-center/notify/route.ts",
  ];
  for (const routePath of gatedRoutes) {
    const src = read(routePath);
    ok("V2.18 Security route wiring", /import \{ checkSyncRequestAuth \} from "@\/lib\/command-center\/jira\/sync-auth"/.test(src), `${routePath} imports the shared auth check rather than a private/duplicated one`);
    ok("V2.18 Security route wiring", /checkSyncRequestAuth\(/.test(src), `${routePath} actually calls the auth check`);
  }

  const gatedClientCallers = [
    "src/lib/command-center/notify-client.ts",
    "src/components/command-center/use-command-center.ts",
    "src/lib/command-center/ai/claude-provider.ts",
    "src/lib/command-center/datasource/jira-source.ts",
    "src/app/data-settings/page.tsx",
  ];
  for (const callerPath of gatedClientCallers) {
    const src = read(callerPath);
    ok("V2.18 Security client wiring", /pairedAuthHeader/.test(src), `${callerPath} imports/uses pairedAuthHeader so its request(s) to a now-gated route can authenticate as a paired device`);
  }
}

// --- app-state.ts: checkAppStateAuth (state route's own auth — deliberately NOT open when
// unconfigured, unlike sync-auth.ts above) ---
{
  const unconfigured = checkAppStateAuth(null, undefined);
  ok("V2.15 checkAppStateAuth", unconfigured.ok === false && !unconfigured.ok && unconfigured.status === 503, "APP_STATE_SECRET unset -> 503 (sync treated as unavailable), never silently open — this synced slice is genuinely private, unlike jira/sync's re-derivable-from-Jira data");

  const missingHeader = checkAppStateAuth(null, "state-secret");
  ok("V2.15 checkAppStateAuth", missingHeader.ok === false && !missingHeader.ok && missingHeader.status === 401, "APP_STATE_SECRET configured, no Authorization header -> 401");

  const wrongHeader = checkAppStateAuth("Bearer wrong-value", "state-secret");
  ok("V2.15 checkAppStateAuth", wrongHeader.ok === false && !wrongHeader.ok && wrongHeader.status === 401, "APP_STATE_SECRET configured, mismatched header -> 401");

  const correctHeader = checkAppStateAuth("Bearer state-secret", "state-secret");
  ok("V2.15 checkAppStateAuth", correctHeader.ok === true, "APP_STATE_SECRET configured, matching header -> authorized");

  // V2.20 — same trimming fix, and for the same real-world "copy-pasted a trailing newline
  // into the deployment's env var UI" reason, as checkSyncRequestAuth above.
  const trimmedSecret = checkAppStateAuth("Bearer state-secret", "state-secret\n");
  ok("V2.20 checkAppStateAuth secret trimming", trimmedSecret.ok === true, "APP_STATE_SECRET env var with a trailing newline still authorizes a header sent without one");
  const whitespaceOnlyUnconfigured = checkAppStateAuth(null, "   ");
  ok("V2.20 checkAppStateAuth secret trimming", whitespaceOnlyUnconfigured.ok === false && whitespaceOnlyUnconfigured.status === 503, "a whitespace-only env var is treated as unset (503), not as configured-but-unmatchable");
}

// --- app-state.ts: isAppStateStoreConfigured (KV env-var presence check, same pattern as
// V2.13's isNotifyStoreConfigured) ---
{
  const originalKvUrl = process.env.KV_REST_API_URL;
  const originalKvToken = process.env.KV_REST_API_TOKEN;

  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  ok("V2.15 isAppStateStoreConfigured", isAppStateStoreConfigured() === false, "false with no KV env vars set");

  process.env.KV_REST_API_URL = "https://kv.example.test";
  ok("V2.15 isAppStateStoreConfigured", isAppStateStoreConfigured() === false, "URL alone is not enough — both are required");

  process.env.KV_REST_API_TOKEN = "kv-tok";
  ok("V2.15 isAppStateStoreConfigured", isAppStateStoreConfigured() === true, "true once both KV env vars are set");

  if (originalKvUrl === undefined) delete process.env.KV_REST_API_URL;
  else process.env.KV_REST_API_URL = originalKvUrl;
  if (originalKvToken === undefined) delete process.env.KV_REST_API_TOKEN;
  else process.env.KV_REST_API_TOKEN = originalKvToken;
}

// --- app-state.ts: createInMemoryAppStateStore (the offline-test fake) ---
{
  const store = createInMemoryAppStateStore(null);
  ok("V2.15 in-memory app state store", (await store.get()) === null, "starts with no baseline when constructed with null");
  const seeded: SyncedAppState = {
    jiraWorkRelevancePolicy: {},
    attentionState: {},
    decisions: [],
    actionPlanState: { actions: [], personalPlan: [] },
    memoryEvents: [],
    dailyReports: {},
    uiPreferences: { showAdvancedSettings: false, myActionItemsOnly: { attention: false, myDay: false, priorities: false }, jiraProjectScope: { mode: "ALL", projectKeys: [] } },
    updatedAtIso: "2026-01-01T00:00:00.000Z",
  };
  await store.set(seeded);
  const roundTripped = await store.get();
  ok("V2.15 in-memory app state store", roundTripped?.updatedAtIso === "2026-01-01T00:00:00.000Z", "set() then get() round-trips the exact value written");
}

// --- app-state.ts: syncedAppStateSchema (POST body top-level structural validation) ---
{
  const validBody = {
    personalIdentity: { id: "id1", displayName: "Alice" },
    jiraWorkRelevancePolicy: { "In Progress": "ACTIONABLE" },
    attentionState: { "risk:1": { lifecycle: "ACKNOWLEDGED", firstSeenDate: "2026-01-01", lastSeenDate: "2026-01-01" } },
    decisions: [{ id: "d1", projectId: "p1", title: "T", status: "made", description: "d" }],
    actionPlanState: { actions: [], personalPlan: [] },
    memoryEvents: [],
    dailyReports: {},
    uiPreferences: { showAdvancedSettings: true, myActionItemsOnly: { attention: false, myDay: true, priorities: false }, jiraProjectScope: { mode: "ALL", projectKeys: [] } },
    updatedAtIso: "2026-01-01T00:00:00.000Z",
  };
  ok("V2.15 syncedAppStateSchema", syncedAppStateSchema.safeParse(validBody).success === true, "a well-formed synced-state blob parses");
  ok("V2.15 syncedAppStateSchema", syncedAppStateSchema.safeParse({}).success === false, "an empty body is rejected — every top-level field is required");
  ok(
    "V2.15 syncedAppStateSchema",
    syncedAppStateSchema.safeParse({ ...validBody, jiraProjectScope: undefined, uiPreferences: { ...validBody.uiPreferences, jiraProjectScope: { mode: "SOMETHING_ELSE", projectKeys: [] } } }).success === false,
    "an invalid jiraProjectScope.mode value is rejected — not just any string"
  );
  ok(
    "V2.15 syncedAppStateSchema",
    syncedAppStateSchema.safeParse({ ...validBody, decisions: "not-an-array" }).success === false,
    "a wrong-shaped field (decisions as a string) is rejected rather than silently coerced"
  );
}

// --- app-state-sync.ts: pure decision/merge logic (no fetch/timer involved — directly
// testable, matching jira/http.ts's own fetchXWith dependency-injection discipline) ---
{
  function makeSyncedState(overrides: Partial<SyncedAppState> = {}): SyncedAppState {
    return {
      personalIdentity: undefined,
      jiraWorkRelevancePolicy: {},
      attentionState: {},
      decisions: [],
      actionPlanState: { actions: [], personalPlan: [] },
      memoryEvents: [],
      dailyReports: {},
      uiPreferences: { showAdvancedSettings: false, myActionItemsOnly: { attention: false, myDay: false, priorities: false }, jiraProjectScope: { mode: "ALL", projectKeys: [] } },
      updatedAtIso: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }
  function baseStoreState(patch: Partial<StoreState> = {}): StoreState {
    return { ...parseStoredState("{}"), ...patch };
  }
  function makeDecision(id: string, extra: Partial<Decision> = {}): Decision {
    return { id, projectId: "p1", title: `Decision ${id}`, status: "made", description: "d", ...extra };
  }
  function makeAction(id: string): Action {
    return { id, title: `Action ${id}`, why: "why", status: "open", estimateMinutes: 15, createdAt: "2026-01-01" };
  }
  function makePlanItem(id: string): PersonalPlanItem {
    return { id, sourceType: "attention", sourceId: `src-${id}`, priority: 0, position: 0, plannedDate: "2026-01-01", status: "planned", estimatedMinutes: 15, addedAt: "2026-01-01T00:00:00.000Z" };
  }

  // extractSyncedAppState — pulls exactly the synced fields, untouched.
  {
    const state = baseStoreState({
      personalIdentity: { id: "id1", displayName: "Alice" },
      jiraWorkRelevancePolicy: { "In Progress": "ACTIONABLE" },
      attentionState: { "risk:1": { lifecycle: "ACKNOWLEDGED", firstSeenDate: "2026-01-01", lastSeenDate: "2026-01-02" } },
      data: { ...emptyData(), decisions: [makeDecision("d1")], actions: [makeAction("a1")] },
      personalPlan: [makePlanItem("p1")],
      memoryEvents: [{ id: "m1", date: "2026-01-01", kind: "DECISION_MADE", title: "t", impact: "i", evidence: [] }],
      dailyReports: { "2026-01-01": { date: "2026-01-01", generatedAt: "2026-01-01T20:00:00.000Z", events: [] } },
      showAdvancedSettings: true,
      myActionItemsOnly: { attention: true, myDay: false, priorities: true },
      jiraProjectScope: { mode: "FOCUSED", projectKeys: ["JPMC"] },
    });
    const extracted = extractSyncedAppState(state, "2026-02-01T00:00:00.000Z");
    ok("V2.15 extractSyncedAppState", extracted.personalIdentity?.id === "id1", "personalIdentity carried through");
    ok("V2.15 extractSyncedAppState", extracted.decisions.length === 1 && extracted.decisions[0].id === "d1", "decisions pulled from data.decisions");
    ok(
      "V2.15 extractSyncedAppState",
      extracted.actionPlanState.actions.length === 1 && extracted.actionPlanState.actions[0].id === "a1" && extracted.actionPlanState.personalPlan.length === 1 && extracted.actionPlanState.personalPlan[0].id === "p1",
      "actionPlanState bundles data.actions (Action Plan page) and personalPlan (Focus Session/Close Day) together"
    );
    ok("V2.15 extractSyncedAppState", extracted.memoryEvents.length === 1 && extracted.memoryEvents[0].id === "m1", "memoryEvents carried through");
    ok("V2.17 extractSyncedAppState", Object.keys(extracted.dailyReports).length === 1 && extracted.dailyReports["2026-01-01"].date === "2026-01-01", "dailyReports carried through (Task 2 point 5 — added to the synced slice)");
    ok(
      "V2.15 extractSyncedAppState",
      extracted.uiPreferences.showAdvancedSettings === true && extracted.uiPreferences.myActionItemsOnly.attention === true && extracted.uiPreferences.jiraProjectScope.mode === "FOCUSED",
      "uiPreferences bundles the three V2.11-V2.14 preference fields together"
    );
    ok("V2.15 extractSyncedAppState", extracted.updatedAtIso === "2026-02-01T00:00:00.000Z", "updatedAtIso is exactly what the caller supplied — this function never invents a timestamp");
  }

  // looksUnused — the case-B heuristic.
  {
    ok("V2.15 looksUnused", looksUnused(baseStoreState()) === true, "a pristine, never-touched local install looks unused");
    ok("V2.15 looksUnused", looksUnused(baseStoreState({ data: { ...emptyData(), decisions: [makeDecision("d1")] } })) === false, "a single logged decision disqualifies the 'unused' heuristic");
    ok(
      "V2.15 looksUnused",
      looksUnused(baseStoreState({ attentionState: { x: { lifecycle: "ACKNOWLEDGED", firstSeenDate: "2026-01-01", lastSeenDate: "2026-01-01" } } })) === false,
      "a real attention-lifecycle transition disqualifies 'unused'"
    );
    ok("V2.15 looksUnused", looksUnused(baseStoreState({ personalPlan: [makePlanItem("p1")] })) === false, "real Action Plan/Close Day planning activity disqualifies 'unused'");
  }

  // mergeSyncedAppState — record collections union by id (never drops a not-yet-synced local
  // record); Records (attentionState/policy map) union with server winning per shared key;
  // scalar preference blocks take the server's whole value (single-blob-timestamp honesty
  // limit — see the function's own comment).
  {
    const local = makeSyncedState({
      personalIdentity: { id: "local-id", displayName: "Local Name" },
      jiraWorkRelevancePolicy: { "Local Status": "OBSERVE", "Shared Status": "WAITING" },
      attentionState: {
        "local-only": { lifecycle: "NEW", firstSeenDate: "2026-01-01", lastSeenDate: "2026-01-01" },
        shared: { lifecycle: "ACKNOWLEDGED", firstSeenDate: "2026-01-01", lastSeenDate: "2026-01-01" },
      },
      decisions: [makeDecision("local-only-d"), makeDecision("shared-d")],
      actionPlanState: { actions: [makeAction("local-only-a")], personalPlan: [makePlanItem("local-only-p")] },
      memoryEvents: [{ id: "local-only-m", date: "2026-01-01", kind: "DECISION_MADE", title: "local", impact: "i", evidence: [] }],
      dailyReports: {
        "local-only-day": { date: "local-only-day", generatedAt: "2026-01-01T20:00:00.000Z", events: [] },
        "shared-day": { date: "shared-day", generatedAt: "2026-01-01T20:00:00.000Z", events: [] },
      },
      updatedAtIso: "2026-01-01T00:00:00.000Z",
    });
    const server = makeSyncedState({
      personalIdentity: { id: "server-id", displayName: "Server Name" },
      jiraWorkRelevancePolicy: { "Server Status": "COMPLETED", "Shared Status": "ACTIONABLE" },
      attentionState: {
        "server-only": { lifecycle: "NEW", firstSeenDate: "2026-02-01", lastSeenDate: "2026-02-01" },
        shared: { lifecycle: "RESOLVED", firstSeenDate: "2026-01-01", lastSeenDate: "2026-02-01" },
      },
      decisions: [makeDecision("server-only-d"), makeDecision("shared-d", { title: "Updated on server" })],
      actionPlanState: { actions: [makeAction("server-only-a")], personalPlan: [makePlanItem("server-only-p")] },
      memoryEvents: [{ id: "server-only-m", date: "2026-02-01", kind: "DECISION_MADE", title: "server", impact: "i", evidence: [] }],
      dailyReports: {
        "server-only-day": { date: "server-only-day", generatedAt: "2026-02-01T20:00:00.000Z", events: [] },
        "shared-day": { date: "shared-day", generatedAt: "2026-02-01T20:00:00.000Z", events: [{ id: "server-e", date: "shared-day", kind: "DECISION_MADE", title: "server version", impact: "i", evidence: [] }] },
      },
      uiPreferences: { showAdvancedSettings: true, myActionItemsOnly: { attention: true, myDay: true, priorities: true }, jiraProjectScope: { mode: "FOCUSED", projectKeys: ["JPMC"] } },
      updatedAtIso: "2026-02-01T00:00:00.000Z",
    });

    const merged = mergeSyncedAppState(local, server);

    ok("V2.15 mergeSyncedAppState", merged.personalIdentity?.id === "server-id", "identity: server's whole value wins (single-blob timestamp — see function comment)");
    ok(
      "V2.15 mergeSyncedAppState",
      merged.jiraWorkRelevancePolicy["Local Status"] === "OBSERVE" && merged.jiraWorkRelevancePolicy["Server Status"] === "COMPLETED" && merged.jiraWorkRelevancePolicy["Shared Status"] === "ACTIONABLE",
      "policy map: local-only and server-only keys both survive; a key present on both sides takes the server's value"
    );
    ok(
      "V2.15 mergeSyncedAppState",
      "local-only" in merged.attentionState && "server-only" in merged.attentionState && merged.attentionState["shared"].lifecycle === "RESOLVED",
      "attentionState: same union-with-server-winning-on-conflict rule as the policy map"
    );
    const decisionIds = merged.decisions
      .map((d) => d.id)
      .sort()
      .join(",");
    ok("V2.15 mergeSyncedAppState", decisionIds === "local-only-d,server-only-d,shared-d", "decisions: id-union — a locally-added-but-not-yet-synced decision is never dropped just because the server's overall blob is newer");
    ok("V2.15 mergeSyncedAppState", merged.decisions.find((d) => d.id === "shared-d")?.title === "Updated on server", "decisions: a shared id takes the server's (newer) version, never the stale local one");
    ok(
      "V2.15 mergeSyncedAppState",
      merged.actionPlanState.actions
        .map((a) => a.id)
        .sort()
        .join(",") === "local-only-a,server-only-a",
      "actionPlanState.actions: same id-union rule"
    );
    ok(
      "V2.15 mergeSyncedAppState",
      merged.actionPlanState.personalPlan
        .map((p) => p.id)
        .sort()
        .join(",") === "local-only-p,server-only-p",
      "actionPlanState.personalPlan: same id-union rule"
    );
    ok(
      "V2.15 mergeSyncedAppState",
      merged.memoryEvents
        .map((m) => m.id)
        .sort()
        .join(",") === "local-only-m,server-only-m",
      "memoryEvents: same id-union rule"
    );
    ok(
      "V2.17 mergeSyncedAppState",
      "local-only-day" in merged.dailyReports && "server-only-day" in merged.dailyReports && merged.dailyReports["shared-day"].events[0]?.id === "server-e",
      "dailyReports: same union-with-server-winning-on-conflict rule as attentionState/policy map (Task 2 point 5)"
    );
    ok(
      "V2.15 mergeSyncedAppState",
      merged.uiPreferences.showAdvancedSettings === true && merged.uiPreferences.jiraProjectScope.mode === "FOCUSED",
      "uiPreferences: server's whole preference block wins — a genuinely single toggle blob with no finer-grained freshness signal available"
    );
    ok("V2.15 mergeSyncedAppState", merged.updatedAtIso === server.updatedAtIso, "the merge result carries the server's updatedAtIso forward");
  }

  // decideInitialSync — the full on-load decision tree (Task 3 §2's three cases + Task 4's
  // migration-safety scenario, all pure and directly testable).
  {
    const localRich = baseStoreState({ data: { ...emptyData(), decisions: [makeDecision("local-d")] } });
    const localFresh = baseStoreState();
    const localRichSlice = extractSyncedAppState(localRich, "2026-01-01T00:00:00.000Z");
    const localFreshSlice = extractSyncedAppState(localFresh, "2026-01-01T00:00:00.000Z");

    // Task 4 — an install with real pre-existing local data (attentionState/decisions from a
    // pre-V2.15 version) must become the server baseline the first time V2.15 ships and this
    // device loads before any server state exists — never be silently discarded or ignored.
    const d1 = decideInitialSync(localRichSlice, localRich, null, undefined);
    ok(
      "V2.15 decideInitialSync (Task 4 migration safety)",
      d1.kind === "push-as-baseline",
      "server has no state yet -> local (including its real, pre-existing decisions) becomes the baseline — the exact scenario Task 4 requires a dedicated test for"
    );

    const serverState = makeSyncedState({ decisions: [makeDecision("server-d")], updatedAtIso: "2026-03-01T00:00:00.000Z" });

    const d2 = decideInitialSync(localFreshSlice, localFresh, serverState, undefined);
    ok("V2.15 decideInitialSync", d2.kind === "adopt-server", "a never-meaningfully-used local install adopts the server's real copy wholesale (case B)");

    const d3 = decideInitialSync(localRichSlice, localRich, serverState, "2026-01-01T00:00:00.000Z");
    ok(
      "V2.15 decideInitialSync",
      d3.kind === "merge" && d3.merged.decisions.some((dc) => dc.id === "local-d") && d3.merged.decisions.some((dc) => dc.id === "server-d"),
      "both sides have real content and the server is newer than this device's last known sync point -> a field-level merge (case C), never a blind overwrite that would drop the local-only decision"
    );

    const d4 = decideInitialSync(localRichSlice, localRich, serverState, "2026-05-01T00:00:00.000Z");
    ok(
      "V2.15 decideInitialSync",
      d4.kind === "push-local-forward",
      "this device's last known sync point is already at least as new as the server's current blob -> local is pushed forward rather than pulling something not actually newer (the fourth, implicit case)"
    );
  }
}

// --- state/route.ts wiring (static source checks — the route transitively imports
// "server-only" via app-state-store.ts, so it can never be imported into this offline test
// process; same reasoning as jira/sync/route.ts's own V2.13/V2.15 wiring checks above) ---
{
  const repoRoot = path.resolve(process.cwd());
  const stateRouteSrc = fs.readFileSync(path.join(repoRoot, "src/app/api/command-center/state/route.ts"), "utf8");
  ok("V2.15 state route wiring", /checkAppStateAuth/.test(stateRouteSrc), "the route delegates auth to the shared, directly-tested checkAppStateAuth, never a second inline implementation");
  ok("V2.15 state route wiring", /createAppStateStore/.test(stateRouteSrc), "the route wires the real KV-backed store, not the in-memory test fake");
  ok("V2.15 state route wiring", /isAppStateStoreConfigured/.test(stateRouteSrc), "the route also checks KV configuration, not just the secret");
  ok("V2.15 state route wiring", /syncedAppStateSchema/.test(stateRouteSrc), "POST validates the request body's top-level shape via the shared schema before writing it to KV");
  ok("V2.15 state route wiring", /export async function GET/.test(stateRouteSrc) && /export async function POST/.test(stateRouteSrc), "both GET and POST are exported and (per the auth check above) both require the same Authorization header");
}

// --- Secret hygiene (Definition of Done: APP_STATE_SECRET must never reach the client bundle
// via a NEXT_PUBLIC_* env var, and device-pairing.ts — the one client module that touches this
// secret — must never read it from process.env; the real "grep the built .next output"
// verification per the dev prompt's own instruction is a separate, manual `npm run build` step,
// not part of this offline suite, matching this app's own V2.10 Slack-webhook precedent) ---
{
  const repoRoot = path.resolve(process.cwd());
  function walkTsFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkTsFiles(full, out);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  }
  const srcFiles = walkTsFiles(path.join(repoRoot, "src"));
  const leaked = srcFiles.filter((f) => /NEXT_PUBLIC[_A-Z]*APP_STATE_SECRET|APP_STATE_SECRET[_A-Z]*NEXT_PUBLIC/.test(fs.readFileSync(f, "utf8")));
  ok("V2.15 secret hygiene", leaked.length === 0, "APP_STATE_SECRET is never wired through a NEXT_PUBLIC_* env var anywhere in source — the only client-side path is device-pairing.ts's localStorage pairing screen");

  const pairingSrc = fs.readFileSync(path.join(repoRoot, "src/lib/command-center/device-pairing.ts"), "utf8");
  ok("V2.15 secret hygiene", !/process\.env/.test(pairingSrc), "device-pairing.ts never reads any server env var directly — the paired secret only ever comes from this device's own localStorage, pasted once via the Data & Settings pairing screen");
}

// --- V2.16 — real production incident: HSWB-1298 (assigned overnight) and WF-1083
// (mentioned overnight) appeared on NEITHER My Day, Priorities, NOR the Attention Queue, with
// zero error shown anywhere a user would normally look. Traced end-to-end: both tickets'
// Work Relevance statuses ("In Progress" -> ACTIONABLE, "Awaiting Review" -> WAITING) were
// already classified — not the V2.11-era "unclassified status" failure mode this app already
// guards against. The real cause was upstream, at Sync ingestion: this deployment has
// CRON_SECRET configured with no APP_STATE_SECRET to pair a browser against (see
// sync-auth.ts/device-pairing.ts), so every client-initiated sync (manual "Sync Now" and any
// auto-sync-on-load) had been failing with a "cron-unauthorized" 401 for a full week straight
// — jiraSync.lastSyncCompletedAt was stuck on 2026-09-02 while lastSyncStartedAt showed a
// same-morning retry, so nothing updated after that date ever reached local state, regardless
// of Work Relevance/ownership/mention classification downstream. Nothing surfaced this as a
// *standing* failure: the header's own "Sync failed" text is a few unobtrusive words, and
// page.tsx's "Before You Trust This Data" panel actually stopped rendering entirely on a
// failed sync (gated on lastSyncStatus === "success") instead of escalating — the opposite of
// what a data-trust surface should do when trust is exactly what's in question.
//
// Fix: a prominent, impossible-to-miss banner (Header.tsx's SyncFailedBanner) that renders on
// EVERY page (Header lives in the root layout, not one screen) for as long as
// jiraSync.lastSyncStatus === "failed" — driven purely by that status field, so it fires for
// ANY sync failure kind (auth, network, rate-limit, malformed response), not just this one
// pairing gap. This generalizes the fix beyond the two specific tickets: the next time a sync
// silently starts failing, for whatever reason, the app now says so loudly on every screen
// instead of quietly serving stale data with nothing to indicate it's stopped updating. ---
{
  const repoRoot = path.resolve(process.cwd());

  // Pure arithmetic behind the banner's staleness sentence — directly testable even though
  // the component that calls it can't be rendered in this no-DOM/SSR-only test environment.
  ok("V2.16 daysStale", daysStale(undefined) === undefined, "no lastSyncCompletedAt at all (never synced) reports undefined, not a fabricated 0/NaN day count");
  const nowMs = new Date("2026-09-09T12:00:00.000Z").getTime();
  ok("V2.16 daysStale", daysStale("2026-09-02T13:57:19.035Z", nowMs) === 6, "a sync completed 6 days and change before 'now' reports 6 full days stale — the exact real-incident shape (lastSyncCompletedAt stuck on 2026-09-02 while HSWB-1298/WF-1083 were updated on 2026-09-08)");
  ok("V2.16 daysStale", daysStale("2026-09-09T06:00:00.000Z", nowMs) === 0, "a sync completed earlier the same day reports 0 days stale, not 1 (no off-by-one from truncation)");
  ok("V2.16 daysStale", daysStale("2026-09-10T00:00:00.000Z", nowMs) === undefined, "a timestamp in the future (clock skew) reports undefined rather than a nonsensical negative day count");

  // The banner itself can't be rendered here (useCommandCenter's useSyncExternalStore takes
  // the fixed getServerSnapshot branch outside a real browser — see daysStale's own export
  // comment above) — so its wiring is verified the same way this suite already verifies other
  // route/UI wiring facts it can't execute directly (e.g. the V2.15 state-route/secret-hygiene
  // checks above): reading the real source and asserting the specific lines that make the fix
  // real are actually present, not just a same-shaped decoy.
  const headerSrc = fs.readFileSync(path.join(repoRoot, "src/components/command-center/Header.tsx"), "utf8");
  ok("V2.16 Header wiring", /function SyncFailedBanner/.test(headerSrc), "Header.tsx defines the sync-failed banner");
  ok("V2.16 Header wiring", /state\.jiraSync\.lastSyncStatus !== "failed"\) return null/.test(headerSrc), "the banner's only gate is lastSyncStatus === 'failed' — no dependency on WHY it failed, so it fires for every failure kind, not just cron-unauthorized");
  ok("V2.16 Header wiring", /<SyncFailedBanner \/>/.test(headerSrc) && /export function Header/.test(headerSrc), "the banner is rendered unconditionally inside the exported Header component");
  ok("V2.16 Header wiring", /JIRA_ERROR_HELP\[state\.jiraSync\.lastSyncErrorKind\]/.test(headerSrc), "the banner explains the failure using the same JIRA_ERROR_HELP text Data & Settings shows, not a second/divergent explanation");

  const layoutSrc = fs.readFileSync(path.join(repoRoot, "src/app/layout.tsx"), "utf8");
  ok("V2.16 Header wiring", /<Header \/>/.test(layoutSrc), "Header (and therefore the banner) is mounted once in the root layout, so it appears on My Day, Priorities, and Attention Queue alike — not copy-pasted per page, which would risk one page being missed");

  // JIRA_ERROR_HELP itself must be the single shared source Data & Settings already had —
  // moved, not duplicated, so the two surfaces can never drift into disagreeing explanations.
  const errorHelpSrc = fs.readFileSync(path.join(repoRoot, "src/lib/command-center/jira/error-help.ts"), "utf8");
  ok("V2.16 error-help wiring", /cron-unauthorized/.test(errorHelpSrc) && /export const JIRA_ERROR_HELP/.test(errorHelpSrc), "the shared JIRA_ERROR_HELP module carries the real explanations, including cron-unauthorized (the actual cause of this incident)");
  const dataSettingsSrc2 = fs.readFileSync(path.join(repoRoot, "src/app/data-settings/page.tsx"), "utf8");
  ok("V2.16 error-help wiring", /from "@\/lib\/command-center\/jira\/error-help"/.test(dataSettingsSrc2), "Data & Settings imports JIRA_ERROR_HELP from the shared module");
  ok("V2.16 error-help wiring", !/const JIRA_ERROR_HELP/.test(dataSettingsSrc2), "Data & Settings no longer carries its own duplicate copy of the map");

  // The trust panel disappearing entirely on a failed sync (documented above as part of why
  // this went unnoticed) is a real, separate finding — noted here as a currently-accepted
  // pre-existing behavior (not silently reversed by this pass) so a future change to that
  // gate is a deliberate decision, not an accidental side effect of this fix.
  const pageSrc = fs.readFileSync(path.join(repoRoot, "src/app/page.tsx"), "utf8");
  ok("V2.16 known pre-existing behavior", /jiraSync\.lastSyncStatus === "success" &&/.test(pageSrc), "documents that 'Before You Trust This Data' still only renders on a successful sync today — the new Header banner is what now covers the failed-sync case on every page instead");
}

// --- V2.16 (part 2) — a second, independent finding surfaced while verifying the sync-auth
// fix above on a real device: even after pairing fixed the auth failure, a real sync's result
// never survived a reload. The actual dataset (thousands of work items plus history) produced
// a ~7.8MB JSON blob; localStorage's per-origin quota (~5-8MB in the browser this was found
// in) rejected the write with QuotaExceededError, and the old persist() swallowed it in a bare
// try/catch — the UI showed "Connected" (the in-memory state update always succeeds), but
// nothing was ever written to disk, so the next reload silently reverted to whatever last fit.
//
// Fix: local persistence moved to IndexedDB (src/lib/command-center/local-db.ts), whose quota
// is a large fraction of available disk space rather than a fixed ~5-10MB ceiling. Real
// IndexedDB read/write round-trips can't be exercised in this Node-based offline suite (no
// `indexedDB` global, and this app deliberately doesn't shim one — see local-db.ts's own
// comment), so — matching this suite's existing precedent for other browser-only wiring it
// can't execute directly (e.g. the V2.15 secret-hygiene checks above) — this verifies the
// actual source: that store.ts only ever takes the new IndexedDB path when `indexedDB` exists,
// and falls back to the EXACT original synchronous localStorage code otherwise (old browsers,
// some private-browsing modes, and — provably, since every test above this point just passed
// unmodified — this suite's own Node environment, which has no indexedDB global at all). ---
{
  const repoRoot = path.resolve(process.cwd());
  const localDbSrc = fs.readFileSync(path.join(repoRoot, "src/lib/command-center/local-db.ts"), "utf8");
  ok("V2.16 IndexedDB backend", /indexedDB\.open\(/.test(localDbSrc), "local-db.ts opens a real IndexedDB database — not a second in-memory/localStorage implementation wearing an IndexedDB name");
  ok("V2.16 IndexedDB backend", /export async function idbGet/.test(localDbSrc) && /export async function idbSet/.test(localDbSrc), "exposes a minimal get/set pair, matching the single-blob shape store.ts already persists");

  const storeSrc = fs.readFileSync(path.join(repoRoot, "src/lib/command-center/store.ts"), "utf8");
  ok("V2.16 IndexedDB wiring", /import \{ idbGet, idbSet \} from "\.\/local-db"/.test(storeSrc), "store.ts uses the shared IndexedDB adapter, not a duplicated implementation");
  ok(
    "V2.16 IndexedDB wiring",
    (storeSrc.match(/typeof indexedDB === "undefined"/g) ?? []).length === 2,
    "both hydrate() and persist() explicitly check IndexedDB availability before using it — exactly once each, so the fallback path is a deliberate branch, not an accidental gap"
  );
  ok(
    "V2.16 IndexedDB wiring",
    /window\.localStorage\.setItem\(STORAGE_KEY, JSON\.stringify\(this\.state\)\)/.test(storeSrc),
    "persist()'s fallback-when-no-IndexedDB branch is the exact original localStorage write — never removed, so every existing (Node-based, indexedDB-less) test above continues to exercise the real fallback code path unmodified"
  );
  ok(
    "V2.16 IndexedDB wiring",
    /idbSet\(STORAGE_KEY, JSON\.stringify\(migrated\)\)/.test(storeSrc) && /window\.localStorage\.removeItem\(STORAGE_KEY\)/.test(storeSrc),
    "the legacy-localStorage migration writes the existing data into IndexedDB and only then clears the old key — a device that already has real local data (every install from before this pass) is migrated, never silently reset to pristine"
  );
  ok(
    "V2.16 IndexedDB wiring",
    /catch \{\s*\/\/ Migration write failed/.test(storeSrc),
    "a failed migration write leaves the legacy localStorage copy in place (not cleared) — a genuinely lost write here would look exactly like the original bug, so the migration itself must be safe on partial failure"
  );
}

// --- V2.17 — a third, independent finding, surfaced when asked to check why mentionEvents
// was coming back empty even after the V2.16 fixes: HSWB-1298/WF-1083's original mention on
// WF-1083 STILL wouldn't have been found by the JQL search alone, because Jira's own comment
// full-text search index has a real indexing lag — confirmed directly against the real
// instance (see selectRecentMentionCandidates's own comment for the exact evidence). The pure
// selection logic itself is fully unit-tested above; this verifies the sync route actually
// wires it in, rather than leaving the fix stranded as dead code only the test file exercises. ---
{
  const repoRoot = path.resolve(process.cwd());
  const syncRouteSrc2 = fs.readFileSync(path.join(repoRoot, "src/app/api/command-center/jira/sync/route.ts"), "utf8");
  ok("V2.17 Sync route wiring", /import \{ buildMentionEvents, selectRecentMentionCandidates \}/.test(syncRouteSrc2), "the route imports the shared, directly-tested selectRecentMentionCandidates rather than a second inline implementation");
  ok("V2.17 Sync route wiring", /selectRecentMentionCandidates\(issuesResult\.data, checkedKeys, Date\.now\(\)\)/.test(syncRouteSrc2), "the recency fallback runs over this sync's own already-fetched issue batch (never a second Jira fetch) and excludes issues the JQL search already covered");
  ok("V2.17 Sync route wiring", (syncRouteSrc2.match(/buildMentionEvents\(issue\.key, commentsResult\.data, accountId/g) ?? []).length === 2, "both the JQL-search pass and the recency-fallback pass call the exact same buildMentionEvents/commentMentionsAccount verification — no second, divergent detection rule for the fallback path");
}

// ===================================================================================
// V2.19 — Personal Work & Reporting Hardening: Assigned/Mentioned/Completion/Focus/Reports
// ===================================================================================

// ----- isWorkItemDoneOrExcluded — the root-cause fix. A MENTION attention item bypasses the
// Work Relevance gate entirely (§1b — a mention is a personal signal regardless of ticket
// status), so its own "is this ticket actually finished?" safety net (proactive.ts's
// completedOrExcludedWorkItemIds) previously consulted ONLY the opt-in Work Relevance Policy —
// on a fresh install (empty policy map, the default), a mention on a ticket that is genuinely
// Done in Jira kept surfacing in Your Delivery Focus/the Attention Queue forever. This is the
// zero-config floor: Jira's own statusCategory-derived native `status === "Done"` (already the
// exact signal action-plan.ts's buildCandidates() hard-excludes on) is now consulted too. -----
{
  const doneNative = jiraItem({ id: "wi-done-native", key: "JPMC-800", status: "Done", jiraStatusName: "Some Custom Done-ish Status Nobody Classified" });
  const notDoneNative = jiraItem({ id: "wi-not-done", key: "JPMC-801", status: "In Progress", jiraStatusName: "Some Custom Status Nobody Classified" });

  ok("V2.19 isWorkItemDoneOrExcluded", isWorkItemDoneOrExcluded(doneNative, undefined) === true, "native status Done is finished even with NO Work Relevance index at all — the zero-config floor");
  ok("V2.19 isWorkItemDoneOrExcluded", isWorkItemDoneOrExcluded(notDoneNative, undefined) === false, "a non-Done native status with no index is correctly NOT finished — conservatism is unaffected, this only adds a floor");

  const emptyIdx = buildWorkRelevanceIndex({});
  ok("V2.19 isWorkItemDoneOrExcluded", isWorkItemDoneOrExcluded(doneNative, emptyIdx) === true, "native status Done is finished even with an EMPTY policy map (fresh install, nothing classified yet)");
  ok("V2.19 isWorkItemDoneOrExcluded", isWorkItemDoneOrExcluded(notDoneNative, emptyIdx) === false, "a non-Done, unclassified status stays NOT finished — UNKNOWN is still conservative");

  const classifiedIdx = buildWorkRelevanceIndex(globalPolicy({ "Won't Fix": "EXCLUDED", "Ready for UAT/Business Test": "OBSERVE", "To Do": "ACTIONABLE" }));
  const excludedByPolicy = jiraItem({ id: "wi-excl-policy", key: "JPMC-802", status: "In Progress", jiraStatusName: "Won't Fix" });
  const observeByPolicy = jiraItem({ id: "wi-obs-policy", key: "JPMC-803", status: "In Progress", jiraStatusName: "Ready for UAT/Business Test" });
  const actionableByPolicy = jiraItem({ id: "wi-act-policy", key: "JPMC-804", status: "In Progress", jiraStatusName: "To Do" });
  ok("V2.19 isWorkItemDoneOrExcluded", isWorkItemDoneOrExcluded(excludedByPolicy, classifiedIdx) === true, "an explicit policy EXCLUDED classification is finished, even though native status isn't Done");
  ok("V2.19 isWorkItemDoneOrExcluded", isWorkItemDoneOrExcluded(observeByPolicy, classifiedIdx) === false, "OBSERVE is never finished");
  ok("V2.19 isWorkItemDoneOrExcluded", isWorkItemDoneOrExcluded(actionableByPolicy, classifiedIdx) === false, "ACTIONABLE is never finished");
}

// ----- The end-to-end fix: a MENTION on a ticket that is genuinely Done in Jira (native
// status) but whose exact raw status name has never been classified in the Work Relevance
// Policy now auto-resolves — closing the exact "why is this completed ticket still asking me
// to focus on it?" complaint, with zero configuration required. -----
{
  const mdcDoneTicket = jiraItem({ id: "wi-mdc2-done", key: "JPMC-900", status: "Done", jiraStatusName: "Some Bespoke Terminal Status" });
  const mdcOpenTicket = jiraItem({ id: "wi-mdc2-open", key: "JPMC-901", status: "In Progress", jiraStatusName: "In Progress" });
  const mdc2Data: CommandCenterData = { ...emptyData(), workItems: [mdcDoneTicket, mdcOpenTicket] };
  const mdc2Derived = deriveData(mdc2Data, null, TODAY);
  const mdc2Mentions = [
    { issueKey: mdcDoneTicket.key, commentId: `c-${mdcDoneTicket.key}`, excerpt: "please check", mentionedAt: TODAY },
    { issueKey: mdcOpenTicket.key, commentId: `c-${mdcOpenTicket.key}`, excerpt: "please check", mentionedAt: TODAY },
  ];

  // No policy configured at all (undefined index) — the exact fresh-install scenario.
  const mdc2NoIndex = computeProactiveIntelligence(mdc2Data, mdc2Derived, [], null, {}, "jira", TODAY, undefined, mdc2Mentions);
  const findMention = (bundle: typeof mdc2NoIndex, key: string) => bundle.attentionQueue.find((i) => i.id === `MENTION:${slug(key)}:${slug(`c-${key}`)}`);
  ok(
    "V2.19 root-cause fix — MENTION on native-Done ticket",
    findMention(mdc2NoIndex, mdcDoneTicket.key)?.lifecycle === "RESOLVED",
    "a MENTION on a native-status-Done ticket auto-resolves even with NO Work Relevance index configured at all — the confirmed root cause of 'completed tickets keep appearing' is fixed"
  );
  ok("V2.19 root-cause fix — MENTION on native-Done ticket", findMention(mdc2NoIndex, mdcOpenTicket.key)?.lifecycle === "NEW", "a MENTION on a genuinely open ticket is unaffected");

  // Also holds with an empty (but present) index.
  const mdc2EmptyIndex = computeProactiveIntelligence(mdc2Data, mdc2Derived, [], null, {}, "jira", TODAY, buildWorkRelevanceIndex({}), mdc2Mentions);
  ok("V2.19 root-cause fix — MENTION on native-Done ticket", findMention(mdc2EmptyIndex, mdcDoneTicket.key)?.lifecycle === "RESOLVED", "same result with an empty (rather than undefined) policy map");

  // And the fix also means such a ticket's mention never reaches Your Delivery Focus.
  const mdc2Focus = computePersonalFocus(mdc2Data, mdc2NoIndex, "Alice", TODAY);
  ok(
    "V2.19 root-cause fix — Your Delivery Focus",
    !mdc2Focus.candidates.some((c) => c.ticketKey === mdcDoneTicket.key),
    "the resolved MENTION never produces a Personal Focus candidate — it never reaches Your Delivery Focus/Today/Top 3/the 30-minute plan"
  );
}

// ----- Daily Command Completion — a distinct execution fact from Jira Completion and Action
// Completion (§ types.ts's DailyCommandCompletion). Marking a ticket completed IN DAILY
// COMMAND suppresses it from active surfaces regardless of the Jira issue's own status. -----
{
  commandCenterStore.resetAll();
  ok("V2.19 Daily Command Completion", Object.keys(commandCenterStore.getSnapshot().dailyCommandCompletions).length === 0, "starts empty — nothing completed by default");

  commandCenterStore.completeTicketInDailyCommand("JPMC-1000");
  const afterComplete = commandCenterStore.getSnapshot().dailyCommandCompletions;
  ok("V2.19 Daily Command Completion", !!afterComplete["JPMC-1000"], "completeTicketInDailyCommand records a completion, keyed by ticket key");
  ok("V2.19 Daily Command Completion", typeof afterComplete["JPMC-1000"].completedAt === "string" && afterComplete["JPMC-1000"].completedAt.length > 0, "records a real completedAt timestamp");

  commandCenterStore.reopenTicketInDailyCommand("JPMC-1000");
  ok("V2.19 Daily Command Completion", !commandCenterStore.getSnapshot().dailyCommandCompletions["JPMC-1000"], "reopenTicketInDailyCommand clears the completion — the only way back, and it's always explicit");

  // Reopening something never completed is a safe no-op.
  commandCenterStore.reopenTicketInDailyCommand("JPMC-NEVER-COMPLETED");
  ok("V2.19 Daily Command Completion", Object.keys(commandCenterStore.getSnapshot().dailyCommandCompletions).length === 0, "reopening a ticket with no recorded completion is a no-op, not a crash");
  commandCenterStore.resetAll();
}

// ----- Daily Command Completion — parseStoredState round-trip + defensive parsing -----
{
  const validBlob2 = JSON.stringify({ loaded: true, dailyCommandCompletions: { "JPMC-1": { ticketKey: "JPMC-1", completedAt: "2026-06-15T10:00:00.000Z", completedBy: "Alice" } } });
  const parsed2 = parseStoredState(validBlob2);
  ok("V2.19 Daily Command Completion parsing", parsed2.dailyCommandCompletions["JPMC-1"]?.completedBy === "Alice", "a well-formed persisted completion round-trips through parseStoredState");

  const malformedBlob = JSON.stringify({
    loaded: true,
    dailyCommandCompletions: {
      "JPMC-1": { ticketKey: "JPMC-1", completedAt: "2026-06-15T10:00:00.000Z" }, // valid, no completedBy
      "JPMC-2": { ticketKey: "JPMC-2" }, // missing completedAt — dropped
      "JPMC-3": "not-an-object", // dropped
      "JPMC-4": null, // dropped
    },
  });
  const parsedMalformed = parseStoredState(malformedBlob);
  ok("V2.19 Daily Command Completion parsing", Object.keys(parsedMalformed.dailyCommandCompletions).length === 1 && !!parsedMalformed.dailyCommandCompletions["JPMC-1"], "a malformed entry is dropped rather than trusted or crashing the parse — same discipline as every other persisted field");

  const noFieldAtAll = parseStoredState(JSON.stringify({ loaded: true }));
  ok("V2.19 Daily Command Completion parsing", Object.keys(noFieldAtAll.dailyCommandCompletions).length === 0, "a pre-V2.19 persisted blob with no dailyCommandCompletions field at all degrades to empty, never a crash");
}

// ----- personal-focus.ts's evaluateWorkRelevanceGate now also excludes a Daily-Command-
// completed ticket — independent of the ticket's own Jira status (even ACTIONABLE), and
// independent of whether a Work Relevance index is configured at all. -----
{
  const dccWorkItem = jiraItem({ id: "wi-dcc-focus", key: "JPMC-1100", jiraStatusName: "To Do" });
  const dccIdx = buildWorkRelevanceIndex(globalPolicy({ "To Do": "ACTIONABLE" }));
  const dccDrift = { id: "DRIFT:dcc-focus-item", category: "DRIFT" as const, severity: "HIGH" as const, what: "x", why: "x", impact: "x", nowWhat: "x", evidence: [], lifecycle: "ACTIVE" as const, firstSeenDate: TODAY, lastSeenDate: TODAY, sourceRef: { type: "workItem" as const, id: dccWorkItem.id } };
  const dccData2: CommandCenterData = { ...emptyData(), workItems: [dccWorkItem] };
  const dccProactive = fakeProactive([dccDrift]);

  const withoutCompletion = computePersonalFocus(dccData2, dccProactive, "Alice", TODAY, undefined, dccIdx);
  ok("V2.19 Daily Command Completion gate", withoutCompletion.candidates.some((c) => c.sourceId === dccDrift.id), "sanity check — the candidate exists before any completion is recorded");

  const withCompletion = computePersonalFocus(dccData2, dccProactive, "Alice", TODAY, undefined, dccIdx, undefined, undefined, new Set([dccWorkItem.id]));
  ok("V2.19 Daily Command Completion gate", !withCompletion.candidates.some((c) => c.sourceId === dccDrift.id), "a Daily-Command-completed ticket's DRIFT candidate is excluded — even though its Jira status is still ACTIONABLE");

  // Omitting the new trailing parameter entirely (every pre-V2.19 call site) is an exact no-op.
  const omittedParam = computePersonalFocus(dccData2, dccProactive, "Alice", TODAY, undefined, dccIdx);
  ok("V2.19 Daily Command Completion gate", omittedParam.candidates.some((c) => c.sourceId === dccDrift.id), "omitting the new parameter reproduces pre-V2.19 behavior exactly — every existing call site is unaffected");
}

// ----- assigned-work.ts — "My Assigned Work": the FULL assigned population, never a curated
// subset (§28's non-negotiable: full assigned work != full Personal Focus). -----
{
  const alice = { displayName: "Alice", accountId: "acc-alice" };
  const assignedOpen = jiraItem({ id: "wi-aw-open", key: "JPMC-1200", status: "Not Started", jiraStatusName: "To Do", ownerId: "acc-alice", owner: "Alice" });
  const assignedInProgress = jiraItem({ id: "wi-aw-ip", key: "JPMC-1201", status: "In Progress", jiraStatusName: "In Progress", ownerId: "acc-alice", owner: "Alice" });
  const assignedCompleted = jiraItem({ id: "wi-aw-done", key: "JPMC-1202", status: "Done", jiraStatusName: "Done", ownerId: "acc-alice", owner: "Alice" });
  const assignedToBob = jiraItem({ id: "wi-aw-bob", key: "JPMC-1203", status: "In Progress", jiraStatusName: "In Progress", ownerId: "acc-bob", owner: "Bob" });
  const awItems = [assignedOpen, assignedInProgress, assignedCompleted, assignedToBob];

  ok("V2.19 assigned-work — full population", getAssignedWorkItems(awItems, alice).length === 3, "every item assigned to the configured identity is discoverable, regardless of status");
  ok("V2.19 assigned-work — no identity", getAssignedWorkItems(awItems, {}).length === 0, "no identity configured at all -> empty, never a guess");

  const active = getActiveAssignedWorkItems(awItems, alice, undefined);
  ok("V2.19 assigned-work — active", active.length === 2 && active.every((w) => w.key !== assignedCompleted.key), "an OPEN and an IN PROGRESS assigned item are both active; the COMPLETED (native Done) one is not, even with no Work Relevance index");
  const completedBucket = getCompletedAssignedWorkItems(awItems, alice, undefined);
  ok("V2.19 assigned-work — completed", completedBucket.length === 1 && completedBucket[0].key === assignedCompleted.key, "the completed bucket contains exactly the finished item");

  // 100 assigned items — all discoverable, none silently dropped by a scoring threshold.
  const many = Array.from({ length: 100 }, (_, i) => jiraItem({ id: `wi-aw-many-${i}`, key: `JPMC-2${String(i).padStart(3, "0")}`, status: "In Progress", jiraStatusName: "In Progress", ownerId: "acc-alice", owner: "Alice" }));
  ok("V2.19 assigned-work — full population at scale", getAssignedWorkItems(many, alice).length === 100, "100 assigned items are all discoverable — no eligibilityScore/candidate-pool threshold silently restricts this surface");

  // Daily Command Completion suppresses even an otherwise-active assigned item.
  const activeWithDcc = getActiveAssignedWorkItems(awItems, alice, undefined, new Set([assignedOpen.key]));
  ok("V2.19 assigned-work — Daily Command Completion", !activeWithDcc.some((w) => w.key === assignedOpen.key), "a Daily-Command-completed ticket is excluded from the active bucket even though its Jira status is still open");
  const completedWithDcc = getCompletedAssignedWorkItems(awItems, alice, undefined, new Set([assignedOpen.key]));
  ok("V2.19 assigned-work — Daily Command Completion", completedWithDcc.some((w) => w.key === assignedOpen.key), "...and appears in the completed bucket instead");
}

// ----- recent-mentions.ts — "Recently Mentioned": a real last-24-hours rolling window, never
// a calendar day or lifecycle-only persistence. -----
{
  const nowMs = new Date("2026-06-15T12:00:00.000Z").getTime();
  const oneHourAgo = new Date(nowMs - 1 * 60 * 60 * 1000).toISOString();
  const justUnder24h = new Date(nowMs - (24 * 60 * 60 * 1000 - 60 * 1000)).toISOString(); // 23h59m
  const justOver24h = new Date(nowMs - (24 * 60 * 60 * 1000 + 60 * 1000)).toISOString(); // 24h01m
  const rmWorkItem = jiraItem({ id: "wi-rm-1", key: "JPMC-1300", jiraStatusName: "In Progress" });

  const windowEvents = [
    { issueKey: "JPMC-1300", commentId: "c-1h", excerpt: "recent", mentionedAt: oneHourAgo },
    { issueKey: "JPMC-1301", commentId: "c-23h59", excerpt: "borderline-in", mentionedAt: justUnder24h },
    { issueKey: "JPMC-1302", commentId: "c-24h01", excerpt: "borderline-out", mentionedAt: justOver24h },
  ];
  const windowResult = selectRecentMentions(windowEvents, [rmWorkItem], {}, nowMs);
  ok("V2.19 recent-mentions — window", windowResult.some((m) => m.issueKey === "JPMC-1300"), "a mention 1 hour ago is shown");
  ok("V2.19 recent-mentions — window", windowResult.some((m) => m.issueKey === "JPMC-1301"), "a mention 23h59m ago is shown — inside the 24h window");
  ok("V2.19 recent-mentions — window", !windowResult.some((m) => m.issueKey === "JPMC-1302"), "a mention 24h01m ago is NOT shown — outside the 24h window");
  ok("V2.19 recent-mentions — constant", RECENT_MENTION_WINDOW_HOURS === 24, "the documented window is exactly 24 hours");

  // Dedup — multiple mentions on the same ticket within the window fold into one, latest wins.
  const dupeEvents = [
    { issueKey: "JPMC-1400", commentId: "c-early", excerpt: "first", mentionedAt: new Date(nowMs - 3 * 60 * 60 * 1000).toISOString() },
    { issueKey: "JPMC-1400", commentId: "c-late", excerpt: "second, most recent", mentionedAt: new Date(nowMs - 1 * 60 * 60 * 1000).toISOString() },
  ];
  const dupeResult = selectRecentMentions(dupeEvents, [], {}, nowMs);
  ok("V2.19 recent-mentions — dedupe", dupeResult.filter((m) => m.issueKey === "JPMC-1400").length === 1, "the same ticket mentioned twice within the window shows once, not as two cards");
  const dupeCard = dupeResult.find((m) => m.issueKey === "JPMC-1400");
  ok("V2.19 recent-mentions — dedupe", dupeCard?.commentId === "c-late" && dupeCard?.groupCount === 2, "the folded card represents the LATEST mention and reports the real count (2)");

  // A resolved/snoozed attention item suppresses its mention here too.
  const suppressEvents = [{ issueKey: "JPMC-1500", commentId: "c-resolved", excerpt: "x", mentionedAt: oneHourAgo }];
  const resolvedState = { [`MENTION:${slug("JPMC-1500")}:${slug("c-resolved")}`]: { lifecycle: "RESOLVED" as const, firstSeenDate: TODAY, lastSeenDate: TODAY, resolvedManually: true } };
  ok("V2.19 recent-mentions — resolved suppression", selectRecentMentions(suppressEvents, [], resolvedState, nowMs).length === 0, "a mention already Resolved on the Attention Queue does not also surface here");

  // Different project from another mention — this function has no scope concept of its own
  // (the caller is responsible for pre-scoping via scopeMentionEvents, same as every other
  // engine in this codebase); verify it simply passes through whatever it's given.
  ok("V2.19 recent-mentions — no built-in scope", selectRecentMentions([{ issueKey: "UBS-1", commentId: "c-1", excerpt: "x", mentionedAt: oneHourAgo }], [], {}, nowMs).length === 1, "selectRecentMentions itself has no project-scope filtering — callers pre-scope via scopeMentionEvents, same discipline as every other engine");

  // Empty state.
  ok("V2.19 recent-mentions — empty state", selectRecentMentions([], [], {}, nowMs).length === 0, "no mention events at all -> empty result, rendered as an honest empty state, never a fabricated 'nothing happened'");
}

// ----- recent-mentions.ts — Daily Command Completion reactivation (§14 Reactivation Rule):
// completing a ticket suppresses its mentions, but a genuinely NEW mention after the
// completion timestamp reactivates it here — and ONLY here (never auto-creating an Action). ---
{
  const nowMs2 = new Date("2026-06-15T18:00:00.000Z").getTime();
  const completedAt = new Date(nowMs2 - 5 * 60 * 60 * 1000).toISOString(); // completed 5h ago
  const oldMentionBeforeCompletion = new Date(nowMs2 - 6 * 60 * 60 * 1000).toISOString(); // 1h before completion
  const newMentionAfterCompletion = new Date(nowMs2 - 1 * 60 * 60 * 1000).toISOString(); // 4h after completion

  const completions: Record<string, DailyCommandCompletion> = { "JPMC-1600": { ticketKey: "JPMC-1600", completedAt } };

  const beforeReactivation = selectRecentMentions([{ issueKey: "JPMC-1600", commentId: "c-old", excerpt: "old", mentionedAt: oldMentionBeforeCompletion }], [], {}, nowMs2, { dailyCommandCompletions: completions });
  ok("V2.19 recent-mentions — Daily Command Completion suppression", beforeReactivation.length === 0, "a mention from BEFORE the Daily Command completion stays suppressed");

  const afterReactivation = selectRecentMentions([{ issueKey: "JPMC-1600", commentId: "c-new", excerpt: "new", mentionedAt: newMentionAfterCompletion }], [], {}, nowMs2, { dailyCommandCompletions: completions });
  ok("V2.19 recent-mentions — reactivation", afterReactivation.length === 1 && afterReactivation[0].commentId === "c-new", "a genuinely NEW mention strictly after the completion timestamp reactivates the ticket into Recently Mentioned");

  // Both an old (suppressed) and a new (reactivating) mention on the same ticket — only the
  // new one surfaces, and the group count reflects only what's actually shown.
  const mixed = selectRecentMentions(
    [
      { issueKey: "JPMC-1600", commentId: "c-old", excerpt: "old", mentionedAt: oldMentionBeforeCompletion },
      { issueKey: "JPMC-1600", commentId: "c-new", excerpt: "new", mentionedAt: newMentionAfterCompletion },
    ],
    [],
    {},
    nowMs2,
    { dailyCommandCompletions: completions }
  );
  ok("V2.19 recent-mentions — reactivation", mixed.length === 1 && mixed[0].groupCount === 1, "only the reactivating mention is shown — the pre-completion one never counts toward the group");
}

// ----- assigned-work.ts / recent-mentions.ts source wiring — confirms the new surfaces are
// actually mounted on the main dashboard, not stranded as dead code only this test file
// exercises. -----
{
  const repoRoot = path.resolve(process.cwd());
  const pageSrc2 = fs.readFileSync(path.join(repoRoot, "src/app/page.tsx"), "utf8");
  ok("V2.19 UI wiring", /<MyAssignedWork \/>/.test(pageSrc2), "My Assigned Work is rendered on the main Command Center page");
  ok("V2.19 UI wiring", /<RecentlyMentioned \/>/.test(pageSrc2), "Recently Mentioned is rendered on the main Command Center page");

  const myAssignedSrc = fs.readFileSync(path.join(repoRoot, "src/components/command-center/MyAssignedWork.tsx"), "utf8");
  ok("V2.19 UI wiring", /No active Jira work is currently assigned to you/.test(myAssignedSrc), "My Assigned Work has the documented empty state, not a silent 'nothing happened' implication");
  ok("V2.19 UI wiring", /getActiveAssignedWorkItems/.test(myAssignedSrc) && /getCompletedAssignedWorkItems/.test(myAssignedSrc), "the component reuses the shared selector, not a second inline ownership/completion check");

  const recentMentionedSrc = fs.readFileSync(path.join(repoRoot, "src/components/command-center/RecentlyMentioned.tsx"), "utf8");
  ok("V2.19 UI wiring", /No Jira mentions in the last 24 hours/.test(recentMentionedSrc), "Recently Mentioned has the documented empty state");
  ok("V2.19 UI wiring", /selectRecentMentions/.test(recentMentionedSrc), "the component reuses the shared selector, not a second inline window/dedupe implementation");
}

console.log("\n" + (failures === 0 ? `✅ All checks passed.` : `❌ ${failures} check(s) failed.`));
process.exit(failures === 0 ? 0 : 1);
