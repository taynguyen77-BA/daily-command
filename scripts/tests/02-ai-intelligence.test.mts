// V1.1 — AI intelligence hardening: evidence, schemas, fallbacks, gap detection, executive view
// Run through scripts/tests/run.mts (npm test).

import { scoreWorkItem } from "../../src/lib/command-center/scoring";
import { detectRisks } from "../../src/lib/command-center/risk-detection";
import { emptyData } from "../../src/lib/command-center/types";
import { evidenceForRisk, evidenceForScore, factsForWorkItem, makeEvidence } from "../../src/lib/command-center/evidence";
import { detectGaps } from "../../src/lib/command-center/gap-detection";
import { computeDeliveryConfidence, buildExecutiveView } from "../../src/lib/command-center/executive";
import { reasoningResponseSchema, textResponseSchema, aiStructuredRequestSchema } from "../../src/lib/command-center/ai/schemas";
import { MockAIProvider } from "../../src/lib/command-center/ai/provider";
import { ClaudeProvider, checkClaudeAvailability } from "../../src/lib/command-center/ai/claude-provider";
import { ok } from "./harness.mts";
import { TODAY, makeItem } from "./helpers.mts";

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

  ok("AI schema validation", aiStructuredRequestSchema.safeParse({ task: "detectRisks", input: {} }).success, "a valid task name is accepted");
  ok("AI schema validation", !aiStructuredRequestSchema.safeParse({ task: "deleteEverything", input: {} }).success, "an unrecognized task name is rejected");
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
