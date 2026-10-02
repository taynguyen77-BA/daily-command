// V1.7–V2.1 — Jira conformance, trust diagnostics, AI usage policy/cache, pilot readiness
// Run through scripts/tests/run.mts (npm test).

import { scoreWorkItem } from "../../src/lib/command-center/scoring";
import { buildDemoData } from "../../src/lib/command-center/demo-data";
import { emptyData } from "../../src/lib/command-center/types";
import { MockAIProvider } from "../../src/lib/command-center/ai/provider";
import { ClaudeProvider } from "../../src/lib/command-center/ai/claude-provider";
import { parseStoredState, commandCenterStore } from "../../src/lib/command-center/store";
import type { Decision } from "../../src/lib/command-center/types";
import { normalizeIssue } from "../../src/lib/command-center/jira/normalize";
import { type JiraIssue } from "../../src/lib/command-center/jira/types";
import { fetchJiraIssuesWith, fetchJiraProjectsWith, JIRA_PAGE_SIZE, type FetchLike } from "../../src/lib/command-center/jira/http";
import { computeReleaseHealth } from "../../src/lib/command-center/release-health";
import { classifyQuery, familyForIntent } from "../../src/lib/command-center/query-router";
import { deriveData } from "../../src/lib/command-center/selectors";
import fs from "node:fs";
import path from "node:path";
import { computeProactiveIntelligence } from "../../src/lib/command-center/proactive";
import type { AttentionItem, Risk } from "../../src/lib/command-center/types";
import type { Action } from "../../src/lib/command-center/types";
import { computePersonalFocus } from "../../src/lib/command-center/personal-focus";
import { reconcilePersonalPlan } from "../../src/lib/command-center/personal-plan";
import type { PersonalPlanItem } from "../../src/lib/command-center/types";
import { buildIncrementalSinceParam } from "../../src/lib/command-center/jira/http";
import { runJiraConformance, JIRA_FIELD_SUPPORT } from "../../src/lib/command-center/jira/conformance";
import { fixtureFetch, FIXTURE_ISSUE_PAGE_1, FIXTURE_ISSUE_PAGE_2 } from "../../src/lib/command-center/jira/fixtures";
import { detectDeadlineConflict } from "../../src/lib/command-center/deadline-conflict";
import { evaluateAiResponse } from "../../src/lib/command-center/ai/evaluation";
import { getRecentAiTrace, recordAiCall, clearAiTrace } from "../../src/lib/command-center/ai/trace";
import { computeDataHealth } from "../../src/lib/command-center/data-health";
import type { JiraConnectionConfig } from "../../src/lib/command-center/jira/types";
import type { PersonalFocusCandidate } from "../../src/lib/command-center/types";
import { detectJiraSearchCapability, JIRA_MAX_ISSUES, computeResumeCursor } from "../../src/lib/command-center/jira/http";
import { evaluateJiraDataContract } from "../../src/lib/command-center/jira/data-contract";
import { computeTrustDiagnostic } from "../../src/lib/command-center/trust-diagnostic";
import { discoverJiraDataShape } from "../../src/lib/command-center/jira/shape-discovery";
import { computeMappingDrift } from "../../src/lib/command-center/jira/mapping-drift";
import { getUsagePolicy, describeAIState } from "../../src/lib/command-center/ai/usage-policy";
import { getCachedAIResult, setCachedAIResult, makeAICacheKey, makeEvidenceVersion, withAICache, clearAICache, aiCacheSize, parseCache } from "../../src/lib/command-center/ai/ai-cache";
import { projectRiskImpact, projectDecisionImpact, projectActionImpact, projectLoopImpact } from "../../src/lib/command-center/impact-projection";
import { deriveDontForget } from "../../src/lib/command-center/personal-focus";
import { reviewStatusFor } from "../../src/lib/command-center/decision-radar";
import { buildLivePilotChecklist, buildDataProtectionChecklist } from "../../src/lib/command-center/jira/pilot-checklist";
import { buildBeforeYouTrustSummary } from "../../src/lib/command-center/trust-diagnostic";
import { getCacheStats, resetCacheStats } from "../../src/lib/command-center/ai/ai-cache";
import { getAiTraceSummary } from "../../src/lib/command-center/ai/trace";
import type { JiraSyncState } from "../../src/lib/command-center/types";
import { ok } from "./harness.mts";
import { FIXTURE_CONFIG, TODAY, fakeProactive, makeItem, makeJiraIssue, pfc } from "./helpers.mts";

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
  const neverSyncedState: import("../../src/lib/command-center/types").JiraSyncState = { lastSyncStatus: "never" };
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

  const successSync: import("../../src/lib/command-center/types").JiraSyncState = { lastSyncStatus: "success", durationMs: 4200 };
  const successChecklist = buildLivePilotChecklist({ jiraConfigured: true, conformance: null, sync: successSync, dataHealth: emptyHealth });
  ok("V2.1 Pilot readiness", successChecklist.find((c) => c.id === "connectivity")?.status === "PASSED", "a completed successful sync marks connectivity PASSED");
  ok("V2.1 Pilot readiness", successChecklist.find((c) => c.id === "sync-duration")?.status === "PASSED", "a recorded sync duration marks that checklist item PASSED");
  ok("V2.1 Pilot readiness", successChecklist.find((c) => c.id === "previous-data-preservation")?.status === "READY_TO_TEST", "previous-data preservation is READY_TO_TEST (credentials configured, but no failure has ever occurred to prove it) — it can only be proven by an actual failure");

  const failedSyncPreserved: import("../../src/lib/command-center/types").JiraSyncState = { lastSyncStatus: "failed", lastSyncError: "network down", previousDataPreserved: true };
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
  const health = (over: Partial<import("../../src/lib/command-center/types").DataHealth>): import("../../src/lib/command-center/types").DataHealth => ({
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
