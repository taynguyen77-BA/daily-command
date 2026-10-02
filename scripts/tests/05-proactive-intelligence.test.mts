// V1.4 — proactive delivery intelligence, staleness, mentions/assignments, notify
// Run through scripts/tests/run.mts (npm test).

import { detectRisks, riskFingerprint } from "../../src/lib/command-center/risk-detection";
import { toSnapshot } from "../../src/lib/command-center/change-detection";
import { buildDemoData } from "../../src/lib/command-center/demo-data";
import { emptyData } from "../../src/lib/command-center/types";
import { MockAIProvider } from "../../src/lib/command-center/ai/provider";
import { buildDailySnapshot } from "../../src/lib/command-center/memory";
import { parseStoredState, commandCenterStore, capMentionEvents } from "../../src/lib/command-center/store";
import type { DailySnapshot, SnapshotMetrics } from "../../src/lib/command-center/types";
import { type FetchLike } from "../../src/lib/command-center/jira/http";
import { computeAllReleaseHealth } from "../../src/lib/command-center/release-health";
import { classifyQuery, answerFromRoute } from "../../src/lib/command-center/query-router";
import { deriveData, dedupeRisks } from "../../src/lib/command-center/selectors";
import fs from "node:fs";
import path from "node:path";
import { computeDeliveryDrift, computeTrajectory, trendQuality } from "../../src/lib/command-center/delivery-drift";
import { computeRiskEscalations } from "../../src/lib/command-center/risk-escalation";
import { computeDependencyRadar } from "../../src/lib/command-center/dependency-radar";
import { computeDecisionRadar } from "../../src/lib/command-center/decision-radar";
import { computeActionEffectiveness, ineffectiveActions } from "../../src/lib/command-center/action-effectiveness";
import { computeStakeholderAttention, rankCommunicationPriority } from "../../src/lib/command-center/stakeholder-radar";
import { computeReleaseDrift } from "../../src/lib/command-center/release-drift";
import { computeClientAttentionMap } from "../../src/lib/command-center/client-attention-map";
import { buildAttentionQueue, slug } from "../../src/lib/command-center/attention-queue";
import { buildFirst30Minutes } from "../../src/lib/command-center/first-30-minutes";
import { deriveMemoryEvents } from "../../src/lib/command-center/memory-events";
import { computeProactiveIntelligence } from "../../src/lib/command-center/proactive";
import { changelogToScopeSignals, selectPrioritizedIssueKeys } from "../../src/lib/command-center/jira/scope-drift";
import { proactiveAssessmentResponseSchema, projectStoryResponseSchema } from "../../src/lib/command-center/ai/schemas";
import type { AttentionItem, AttentionItemState, Client, Dependency } from "../../src/lib/command-center/types";
import type { JiraConnectionConfig } from "../../src/lib/command-center/jira/types";
import { buildWorkRelevanceIndex } from "../../src/lib/command-center/jira/work-relevance";
import { buildMentionEvents, commentMentionsAccount, extractCommentExcerpt, mentionCommentId, selectRecentMentionCandidates } from "../../src/lib/command-center/jira/mentions";
import { groupMentionAttentionItems } from "../../src/components/command-center/AttentionQueuePanel";
import { mentionGroupLabel } from "../../src/lib/command-center/mention-grouping";
import { detectNewAssignments } from "../../src/lib/command-center/assignment-detection";
import { buildSlackNotifyPayloads, computeNewPersonalSignals } from "../../src/lib/command-center/notify";
import { fetchMentionedIssuesWith, fetchIssueCommentsWith } from "../../src/lib/command-center/jira/http";
import type { JiraComment } from "../../src/lib/command-center/jira/types";
import type { MentionEvent } from "../../src/lib/command-center/types";
import { GET as notifyStatusGET, POST as notifyPOST } from "../../src/app/api/command-center/notify/route";
import { businessDaysBetween } from "../../src/lib/command-center/date-utils";
import { computeStaleAssignedTickets } from "../../src/lib/command-center/personal-staleness";
import { ok } from "./harness.mts";
import { TODAY, globalPolicy, jiraItem, makeAttentionItem, makeDecision, makeDependency, makeDependencyRadarItem, makeItem, makeJiraIssue, makeRisk, makeRiskEscalation, yesterdayMetrics } from "./helpers.mts";

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


// ===== V2.25 Task 3 — date-utils.ts: businessDaysBetween pure math. =====
{
  ok("V2.25 businessDaysBetween", businessDaysBetween("2026-06-15", "2026-06-16") === 1, "one weekday apart is 1 business day");
  // 2026-06-15 is a Monday; 6 calendar days later (2026-06-21) is the following Sunday —
  // 5 weekdays (Tue/Wed/Thu/Fri + the following Mon is NOT included, since 06-21 is a Sunday).
  ok("V2.25 businessDaysBetween", businessDaysBetween("2026-06-15", "2026-06-21") === 4, "a Mon -> Sun span counts only the weekdays in between (Tue/Wed/Thu/Fri), never the weekend itself");
  ok("V2.25 businessDaysBetween", businessDaysBetween("2026-06-15", "2026-06-15") === 0, "the same date is 0 business days apart");
  ok("V2.25 businessDaysBetween", businessDaysBetween("2026-06-16", "2026-06-15") === 0, "a 'to' date on or before 'from' returns 0, never a negative count");
  // A full calendar week (Mon -> next Mon) is exactly 5 business days, regardless of weekend length.
  ok("V2.25 businessDaysBetween", businessDaysBetween("2026-06-15", "2026-06-22") === 5, "a full Mon -> Mon week is exactly 5 business days");
}


// ===== V2.25 Task 3 — personal-staleness.ts: computeStaleAssignedTickets pure detection. =====
{
  // TODAY is 2026-06-15 (a Monday, per the file's own TODAY constant).
  const sixBusinessDaysAgo = "2026-06-05"; // the Friday of the week before — 6 business days before TODAY
  const yesterday = "2026-06-12"; // the Friday just before the weekend — 1 business day before TODAY

  const staleItem = makeItem({ id: "stale-wi-1", key: "STALE-1", lastUpdated: sixBusinessDaysAgo });
  const freshItem = makeItem({ id: "fresh-wi-1", key: "FRESH-1", lastUpdated: yesterday });

  const results = computeStaleAssignedTickets([staleItem, freshItem], TODAY);
  ok("V2.25 personal-staleness", results.length === 1 && results[0].workItemId === "stale-wi-1", "an item updated 6 business days ago is flagged; an item updated yesterday (1 business day ago) is not — using the default 3/5 business-day thresholds");
  ok("V2.25 personal-staleness", results[0].severity === "ESCALATE", "6 business days is past the default 5-day escalate threshold");

  const warnOnlyItem = makeItem({ id: "warn-wi-1", key: "WARN-1", lastUpdated: "2026-06-10" }); // 3 business days before TODAY
  const warnResults = computeStaleAssignedTickets([warnOnlyItem], TODAY);
  ok("V2.25 personal-staleness", warnResults.length === 1 && warnResults[0].severity === "WARN", "3 business days (at the warn threshold, below escalate) classifies as WARN, not ESCALATE");

  const belowThresholdItem = makeItem({ id: "below-wi-1", key: "BELOW-1", lastUpdated: "2026-06-11" }); // 2 business days before TODAY
  ok("V2.25 personal-staleness", computeStaleAssignedTickets([belowThresholdItem], TODAY).length === 0, "2 business days (below the warn threshold) is not flagged at all");

  // User-configurable thresholds (never hardcoded) — a tighter 1/2-day threshold flags the
  // otherwise-unflagged 2-business-day item too.
  const tightThresholds = { warnBusinessDays: 1, escalateBusinessDays: 2 };
  const tightResults = computeStaleAssignedTickets([belowThresholdItem], TODAY, tightThresholds);
  ok("V2.25 personal-staleness", tightResults.length === 1 && tightResults[0].severity === "ESCALATE", "custom (tighter) thresholds are honored, not hardcoded — the same item now flags ESCALATE under a 1/2-day configuration");

  const noLastUpdated = { ...makeItem({ id: "no-updated-wi-1", key: "NOUPD-1" }), lastUpdated: undefined as unknown as string };
  ok("V2.25 personal-staleness", computeStaleAssignedTickets([noLastUpdated], TODAY).length === 0, "an item with no lastUpdated at all is never treated as infinitely stale — skipped rather than guessed");
}


// ===== V2.25 Task 3 (bug fix) — proactive.ts's activeAssignedForStaleness must exclude a
// WAITING-classified ticket before it ever reaches computeStaleAssignedTickets: a ticket
// blocked on someone else going quiet is not a "possible miss" signal, unlike an ACTIONABLE
// ticket with the identical staleness profile. The exclusion lives in proactive.ts (relevance-
// aware), never inside personal-staleness.ts itself (which stays a pure "is this old"
// function) — this test exercises the real composed pipeline via computeProactiveIntelligence,
// not a hand-rolled reproduction of the filter. =====
{
  const waitingPolicyIdx = buildWorkRelevanceIndex(globalPolicy({ "Blocked on Client": "WAITING", "To Do": "ACTIONABLE" }));
  const tenBusinessDaysAgo = "2026-06-01"; // 10 business days before TODAY (2026-06-15, a Monday)

  const waitingStaleItem = jiraItem({ id: "wsl-waiting-1", key: "WSL-WAIT-1", owner: "Alice", ownerId: "acc-alice-wsl", jiraStatusName: "Blocked on Client", status: "In Progress", lastUpdated: tenBusinessDaysAgo });
  const actionableStaleItem = jiraItem({ id: "wsl-actionable-1", key: "WSL-ACT-1", owner: "Alice", ownerId: "acc-alice-wsl", jiraStatusName: "To Do", status: "In Progress", lastUpdated: tenBusinessDaysAgo });
  const wslData = { ...emptyData(), workItems: [waitingStaleItem, actionableStaleItem] };
  const wslDerived = deriveData(wslData, null, TODAY, waitingPolicyIdx);
  const wslProactive = computeProactiveIntelligence(wslData, wslDerived, [], null, {}, "jira", TODAY, waitingPolicyIdx, undefined, "acc-alice-wsl", "Alice");

  ok(
    "V2.25 Stale WAITING exclusion",
    !wslProactive.attentionQueue.some((i) => i.category === "STALE" && i.sourceRef?.id === "wsl-waiting-1"),
    "a WAITING-classified ticket with a 10-business-day-stale profile is NOT flagged STALE — it's blocked on someone else, not a signal about the assignee"
  );
  ok(
    "V2.25 Stale WAITING exclusion",
    wslProactive.attentionQueue.some((i) => i.category === "STALE" && i.sourceRef?.id === "wsl-actionable-1"),
    "an ACTIONABLE ticket with the IDENTICAL staleness profile still gets flagged STALE — proves the fix is scoped to WAITING specifically, not a broad staleness suppression"
  );
}


// ===== V2.25 Task 3 — Attention Queue: STALE category wiring (attention-queue.ts). =====
{
  const stableDriftForStale = computeDeliveryDrift([], yesterdayMetrics);
  const staleInputsBase = {
    drift: stableDriftForStale, releaseDrift: [], riskEscalations: [], openRisks: [], dependencyRadar: [],
    decisionRadar: [], ineffectiveActions: [], stakeholderAttention: [], communicationPriority: [],
  };
  const staleTicket = { workItemId: "stale-aq-1", issueKey: "STALEAQ-1", title: "Untouched ticket", projectId: "p-1", businessDaysSinceUpdate: 6, severity: "ESCALATE" as const };
  const warnTicket = { workItemId: "stale-aq-2", issueKey: "STALEAQ-2", title: "Slowing down", projectId: "p-1", businessDaysSinceUpdate: 3, severity: "WARN" as const };

  const staleQueue = buildAttentionQueue({ ...staleInputsBase, staleAssignedTickets: [staleTicket, warnTicket] }, {}, TODAY);
  ok("V2.25 Attention Queue STALE", staleQueue.items.some((i) => i.category === "STALE" && i.id === "STALE:stale-aq-1"), "a stale assigned ticket produces a real STALE attention item with a deterministic id");
  ok("V2.25 Attention Queue STALE", staleQueue.items.find((i) => i.id === "STALE:stale-aq-1")?.severity === "HIGH", "ESCALATE maps to HIGH severity");
  ok("V2.25 Attention Queue STALE", staleQueue.items.find((i) => i.id === "STALE:stale-aq-2")?.severity === "MEDIUM", "WARN maps to MEDIUM severity — proportionate to a possible-miss safety net, not a proven risk");
  ok("V2.25 Attention Queue STALE", staleQueue.items.find((i) => i.id === "STALE:stale-aq-1")?.lifecycle === "NEW", "a first-seen STALE item reuses the existing NEW lifecycle — no second lifecycle mechanism introduced");

  const staleQueueDay2 = buildAttentionQueue({ ...staleInputsBase, staleAssignedTickets: [staleTicket, warnTicket] }, staleQueue.nextAttentionState, "2026-06-16");
  ok("V2.25 Attention Queue STALE", staleQueueDay2.items.find((i) => i.id === "STALE:stale-aq-1")?.lifecycle === "ACTIVE", "seen again the next day, it transitions NEW -> ACTIVE via the existing lifecycle machinery, same as every other category");

  const noStaleQueue = buildAttentionQueue(staleInputsBase, {}, TODAY);
  ok("V2.25 Attention Queue STALE", noStaleQueue.items.length === 0, "omitting staleAssignedTickets entirely (every pre-existing caller) produces zero STALE items — additive/optional, no-op-when-omitted");
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


// ===== V2.25 Task 3 — staleAssignedTicketThresholds: default, store setter, clamp,
// persistence. Never hardcoded — user-configurable in Data & Settings. =====
{
  commandCenterStore.resetAll();
  const defaults = commandCenterStore.getSnapshot().staleAssignedTicketThresholds;
  ok("V2.25 Stale thresholds", defaults.warnBusinessDays === 3 && defaults.escalateBusinessDays === 5, "defaults to warn at 3 business days, escalate at 5 — matching this task's own spec");

  commandCenterStore.setStaleAssignedTicketThresholds(2, 4);
  ok("V2.25 Stale thresholds", commandCenterStore.getSnapshot().staleAssignedTicketThresholds.warnBusinessDays === 2 && commandCenterStore.getSnapshot().staleAssignedTicketThresholds.escalateBusinessDays === 4, "setStaleAssignedTicketThresholds persists an explicit custom configuration");

  commandCenterStore.setStaleAssignedTicketThresholds(5, 2);
  ok("V2.25 Stale thresholds", commandCenterStore.getSnapshot().staleAssignedTicketThresholds.escalateBusinessDays === 5, "escalateBusinessDays is never allowed below warnBusinessDays — an out-of-order value is raised to match, never silently accepted as an inverted severity order");

  commandCenterStore.setStaleAssignedTicketThresholds(0, -1);
  ok("V2.25 Stale thresholds", commandCenterStore.getSnapshot().staleAssignedTicketThresholds.warnBusinessDays === 5, "a non-positive value is rejected — the previous valid value is kept, never a nonsensical 0-or-negative threshold");

  const roundTrip = parseStoredState(JSON.stringify(commandCenterStore.getSnapshot()));
  ok("V2.25 Stale thresholds", roundTrip.staleAssignedTicketThresholds.warnBusinessDays === 5 && roundTrip.staleAssignedTicketThresholds.escalateBusinessDays === 5, "the configured thresholds round-trip through JSON serialization/parseStoredState unchanged");

  const fallback = parseStoredState("not valid json");
  ok("V2.25 Stale thresholds", fallback.staleAssignedTicketThresholds.warnBusinessDays === 3 && fallback.staleAssignedTicketThresholds.escalateBusinessDays === 5, "malformed stored state falls back to the safe 3/5 default, never a crash");

  const malformed = parseStoredState(JSON.stringify({ staleAssignedTicketThresholds: { warnBusinessDays: "not a number", escalateBusinessDays: -5 } }));
  ok("V2.25 Stale thresholds", malformed.staleAssignedTicketThresholds.warnBusinessDays === 3 && malformed.staleAssignedTicketThresholds.escalateBusinessDays === 5, "a malformed persisted value (wrong type / negative) falls back to the safe default per-field, never trusted as-is");

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
