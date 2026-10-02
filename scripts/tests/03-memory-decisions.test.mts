// V1.2 — project memory & decision intelligence
// Run through scripts/tests/run.mts (npm test).

import { buildDemoData } from "../../src/lib/command-center/demo-data";
import { emptyData } from "../../src/lib/command-center/types";
import { trendResponseSchema, assessmentResponseSchema } from "../../src/lib/command-center/ai/schemas";
import { MockAIProvider } from "../../src/lib/command-center/ai/provider";
import { buildDailySnapshot, compareSnapshots, dailyCanonicalSnapshots } from "../../src/lib/command-center/memory";
import { detectDecisionConflictCandidates } from "../../src/lib/command-center/decision-conflicts";
import { detectRecurringPatterns } from "../../src/lib/command-center/pattern-detection";
import { buildWeeklyReviewFacts } from "../../src/lib/command-center/weekly-review";
import { parseStoredState, commandCenterStore } from "../../src/lib/command-center/store";
import type { Decision, DailySnapshot, SnapshotMetrics } from "../../src/lib/command-center/types";
import { ok } from "./harness.mts";
import { TODAY, makeDecision, makeItem, yesterdayMetrics } from "./helpers.mts";

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
