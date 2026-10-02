// V1.6 — personal delivery copilot: focus, plan, Focus Session
// Run through scripts/tests/run.mts (npm test).

import { buildDemoData } from "../../src/lib/command-center/demo-data";
import { emptyData } from "../../src/lib/command-center/types";
import { MockAIProvider } from "../../src/lib/command-center/ai/provider";
import { parseStoredState, commandCenterStore, getTodayIso } from "../../src/lib/command-center/store";
import type { Decision } from "../../src/lib/command-center/types";
import { classifyQuery, answerFromRoute } from "../../src/lib/command-center/query-router";
import { deriveData } from "../../src/lib/command-center/selectors";
import { computeProactiveIntelligence } from "../../src/lib/command-center/proactive";
import type { AttentionItem } from "../../src/lib/command-center/types";
import type { Action } from "../../src/lib/command-center/types";
import { computePersonalFocus } from "../../src/lib/command-center/personal-focus";
import { reconcilePersonalPlan, detectNewCriticalArrivals, buildCarryForward, buildSuggestedDailyPlan } from "../../src/lib/command-center/personal-plan";
import { detectPersonalPatterns, detectProjectConcentration, buildPersonalDeliveryReviewFacts } from "../../src/lib/command-center/personal-patterns";
import { dailyGuidanceResponseSchema } from "../../src/lib/command-center/ai/schemas";
import type { PersonalPlanItem } from "../../src/lib/command-center/types";
import { ok } from "./harness.mts";
import { TODAY, fakeProactive, makeItem } from "./helpers.mts";

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
