// V2.19–V2.26 — personal work, completion/skip/block, setup health, provenance, Daily Review
// Run through scripts/tests/run.mts (npm test).

import { detectRisks } from "../../src/lib/command-center/risk-detection";
import { detectChanges, toSnapshot } from "../../src/lib/command-center/change-detection";
import { buildCandidates, buildPlan } from "../../src/lib/command-center/action-plan";
import { buildDemoData } from "../../src/lib/command-center/demo-data";
import { emptyData } from "../../src/lib/command-center/types";
import { buildSnapshotMetrics } from "../../src/lib/command-center/memory";
import { parseStoredState, commandCenterStore, getTodayIso } from "../../src/lib/command-center/store";
import type { Decision, DailySnapshot } from "../../src/lib/command-center/types";
import { computeReleaseHealth } from "../../src/lib/command-center/release-health";
import { deriveData } from "../../src/lib/command-center/selectors";
import fs from "node:fs";
import path from "node:path";
import { computeDependencyRadar } from "../../src/lib/command-center/dependency-radar";
import { computeActionEffectiveness } from "../../src/lib/command-center/action-effectiveness";
import { computeStakeholderAttention } from "../../src/lib/command-center/stakeholder-radar";
import { computeClientAttentionMap, computeProjectAttentionMap } from "../../src/lib/command-center/client-attention-map";
import { slug } from "../../src/lib/command-center/attention-queue";
import { buildFirst30Minutes } from "../../src/lib/command-center/first-30-minutes";
import { computeProactiveIntelligence } from "../../src/lib/command-center/proactive";
import type { Client, Dependency, Risk } from "../../src/lib/command-center/types";
import { computePersonalFocus } from "../../src/lib/command-center/personal-focus";
import { computeDataHealth } from "../../src/lib/command-center/data-health";
import { buildProjectOverrideView } from "../../src/components/command-center/use-command-center";
import { buildWorkRelevanceIndex, isPersonalWorkEligibleItem, isWorkItemDoneOrExcluded, isWorkItemOperationallyOpen } from "../../src/lib/command-center/jira/work-relevance";
import type { DeliveryLoop } from "../../src/lib/command-center/types";
import { detectNewAssignments } from "../../src/lib/command-center/assignment-detection";
import type { MentionEvent } from "../../src/lib/command-center/types";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FirstSeenBadge } from "../../src/components/command-center/TicketLink";
import { formatRelativeDateTime } from "../../src/lib/command-center/relative-time";
import { getActiveAssignedWorkItems, getAssignedWorkItems, getBlockedAssignedWorkItems, getCompletedAssignedWorkItems, getSkippedAssignedWorkItems } from "../../src/lib/command-center/assigned-work";
import { TaskReferenceRowView } from "../../src/components/command-center/TaskReferenceRow";
import { formatExecutionRecord, resolveTaskExecutionState, workItemsForIds, relatedWorkItemIdsForLoop, workItemIdForDependency } from "../../src/lib/command-center/task-execution";
import { PlanCandidateRow } from "../../src/components/command-center/PlanCandidateRow";
import { buildDailyReview } from "../../src/lib/command-center/daily-review";
import { RiskCard } from "../../src/components/command-center/RiskCard";
import { DecisionCard } from "../../src/components/command-center/DecisionCard";
import { ChangeItem } from "../../src/components/command-center/ChangeItem";
import { DependencyRadarCard } from "../../src/components/command-center/DependencyRadarCard";
import { DeliveryLoopCard } from "../../src/components/command-center/DeliveryLoopCard";
import { RECENT_MENTION_WINDOW_HOURS, selectRecentMentions, computeMentionReactivations } from "../../src/lib/command-center/recent-mentions";
import { ReactivatedBadge } from "../../src/components/command-center/TaskReferenceRow";
import type { DailyCommandCompletion, DailyCommandSkip } from "../../src/lib/command-center/types";
import { initAutoJiraSync, resetAutoJiraSyncForTests } from "../../src/lib/command-center/auto-sync";
import { CommandCenterStore, type JiraSyncResult, type JiraSyncTrigger } from "../../src/lib/command-center/store";
import { defaultJiraSyncLockManager, LOCK_UNAVAILABLE, withJiraSyncLock, type JiraSyncLockManager } from "../../src/lib/command-center/sync-lock";
import type { DataSourceProvider, DataSourceSyncResult } from "../../src/lib/command-center/datasource/types";
import { buildWaitingFor } from "../../src/lib/command-center/waiting-for";
import { computeSetupHealthRows } from "../../src/components/command-center/SetupHealthBanner";
import type { SlackNotifyStatus } from "../../src/lib/command-center/notify-client";
import { ok, skip } from "./harness.mts";
import { TODAY, fakeProactive, globalPolicy, jiraItem, makeDependencyRadarItem, makeItem, makeStoreState, makeThreeProjectFixture, v226Actionable, v226ActiveSurfaces, v226ConfiguredStore, v226JiraItem, v226Store, v226Tick } from "./helpers.mts";

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


// ----- V2.21 §3 — isWorkItemOperationallyOpen: the one canonical "is this item still open,
// operationally?" gate, combining isWorkItemDoneOrExcluded with Daily Command Completion. -----
{
  const idx221 = buildWorkRelevanceIndex(globalPolicy({ "To Do": "ACTIONABLE", Resolved: "COMPLETED", "Won't Fix": "EXCLUDED" }));
  const openItem = jiraItem({ id: "wi-open-221", jiraStatusName: "To Do", status: "In Progress" });
  const jiraDoneItem = jiraItem({ id: "wi-done-221", jiraStatusName: "To Do", status: "Done" });
  const wrCompletedItem = jiraItem({ id: "wi-wrcompleted-221", jiraStatusName: "Resolved", status: "In Progress" }); // WR-COMPLETED but NOT native Jira Done
  const wrExcludedItem = jiraItem({ id: "wi-wrexcluded-221", jiraStatusName: "Won't Fix", status: "In Progress" });
  const dccCompletedItem = jiraItem({ id: "wi-dcc-221", jiraStatusName: "To Do", status: "In Progress" });
  const dccIds221 = new Set(["wi-dcc-221"]);

  ok("V2.21 isWorkItemOperationallyOpen", isWorkItemOperationallyOpen(openItem, idx221, dccIds221) === true, "an ACTIONABLE, non-completed item is open");
  ok("V2.21 isWorkItemOperationallyOpen", isWorkItemOperationallyOpen(jiraDoneItem, idx221, dccIds221) === false, "native Jira Done is not open");
  ok("V2.21 isWorkItemOperationallyOpen", isWorkItemOperationallyOpen(wrCompletedItem, idx221, dccIds221) === false, "Work-Relevance-COMPLETED is not open even though native status isn't Done — the exact gap raw `status === \"Done\"` checks missed");
  ok("V2.21 isWorkItemOperationallyOpen", isWorkItemOperationallyOpen(wrExcludedItem, idx221, dccIds221) === false, "Work-Relevance-EXCLUDED is not open");
  ok("V2.21 isWorkItemOperationallyOpen", isWorkItemOperationallyOpen(dccCompletedItem, idx221, dccIds221) === false, "a Daily-Command-completed item is not open even though Jira status is still ACTIONABLE");
  ok("V2.21 isWorkItemOperationallyOpen", isWorkItemOperationallyOpen(openItem, idx221, undefined) === true, "omitting dailyCommandCompletedWorkItemIds is a no-op for an otherwise-open item");
  ok("V2.21 isWorkItemOperationallyOpen", isWorkItemOperationallyOpen(jiraDoneItem, undefined, undefined) === false, "omitting both optional params still honors native Jira Done — same floor as isWorkItemDoneOrExcluded");
}


// ----- V2.21 §5 — action-plan.ts buildCandidates()/buildPlan(): a Daily-Command-completed
// WorkItem must not be resurfaced as a fresh auto-suggested candidate, and a valid
// reactivation (reopening it) brings it back. -----
{
  const apIdx = buildWorkRelevanceIndex(globalPolicy({ "To Do": "ACTIONABLE" }));
  const apItem = jiraItem({ id: "wi-ap-221", key: "JPMC-2210", jiraStatusName: "To Do", status: "In Progress", businessImpact: 5, dueDate: TODAY, priority: "P1", blocked: true, blockerReason: "x" });
  const apData = { ...emptyData(), workItems: [apItem] };

  const beforeCompletion = buildCandidates(apData, TODAY, apIdx);
  ok("V2.21 Action Plan completion safety", beforeCompletion.some((c) => c.item?.id === apItem.id), "sanity check — the item is a candidate before any Daily Command completion");

  const afterCompletion = buildCandidates(apData, TODAY, apIdx, new Set([apItem.id]));
  ok("V2.21 Action Plan completion safety", !afterCompletion.some((c) => c.item?.id === apItem.id), "a Daily-Command-completed WorkItem is never resurfaced as a fresh auto-suggested candidate");

  const planAfterCompletion = buildPlan(apData, TODAY, 480, apIdx, new Set([apItem.id]));
  ok("V2.21 Action Plan completion safety", !planAfterCompletion.some((c) => c.item?.id === apItem.id), "buildPlan() inherits the same suppression — even with a full-day budget, the completed item is never selected");

  // §3.4 Reactivation — Daily Command Completion is never permanent; the ONLY way back is an
  // explicit reopen (store.reopenTicketInDailyCommand), which simply means this item's id is
  // no longer in the caller-supplied set on the next recompute.
  const afterReopen = buildCandidates(apData, TODAY, apIdx, new Set()); // reopened -> no longer in the completed set
  ok("V2.21 Action Plan completion safety — reactivation", afterReopen.some((c) => c.item?.id === apItem.id), "reopening the ticket (removing it from the completed set) makes it eligible again — reactivation is explicit, never automatic");

  const omittedDcc = buildCandidates(apData, TODAY, apIdx);
  ok("V2.21 Action Plan completion safety", omittedDcc.some((c) => c.item?.id === apItem.id), "omitting the new parameter reproduces pre-V2.21 behavior exactly — every existing call site is unaffected");
}


// ----- V2.21 §3.2 — risk-detection.ts detectRisks(): a Work-Relevance-COMPLETED (not native
// Jira Done) or Daily-Command-completed item must not generate a fresh risk either. -----
{
  const riskIdx = buildWorkRelevanceIndex(globalPolicy({ "In Progress": "ACTIONABLE", Resolved: "COMPLETED" }));
  const stalledOpen = jiraItem({ id: "wi-risk-open-221", jiraStatusName: "In Progress", status: "In Progress", lastUpdated: "2026-06-05" }); // 10 days stale
  const stalledWrCompleted = jiraItem({ id: "wi-risk-wrc-221", jiraStatusName: "Resolved", status: "In Progress", lastUpdated: "2026-06-05" });
  const dccItem221 = jiraItem({ id: "wi-risk-dcc-221", jiraStatusName: "In Progress", status: "In Progress", lastUpdated: "2026-06-05" });

  const withoutIdx = detectRisks({ ...emptyData(), workItems: [stalledOpen] }, TODAY);
  ok("V2.21 risk-detection canonical gate", withoutIdx.some((r) => r.sourceWorkItemIds.includes(stalledOpen.id)), "sanity check — a stalled, open item generates a risk with no index/completion supplied at all (pre-V2.21 behavior preserved)");

  const wrCompletedRisks = detectRisks({ ...emptyData(), workItems: [stalledWrCompleted] }, TODAY, riskIdx);
  ok("V2.21 risk-detection canonical gate", !wrCompletedRisks.some((r) => r.sourceWorkItemIds.includes(stalledWrCompleted.id)), "a Work-Relevance-COMPLETED item (native status still not \"Done\") no longer generates a fresh stalled-item risk");

  const dccRisks = detectRisks({ ...emptyData(), workItems: [dccItem221] }, TODAY, riskIdx, new Set([dccItem221.id]));
  ok("V2.21 risk-detection canonical gate", !dccRisks.some((r) => r.sourceWorkItemIds.includes(dccItem221.id)), "a Daily-Command-completed item no longer generates a fresh risk either");
}


// ----- V2.21 §3.2 — selectors.ts deriveData(): the shared scores/risks/kpis every screen
// (Home, Priorities, Risks) reads must agree with the canonical gate too. -----
{
  const ddIdx = buildWorkRelevanceIndex(globalPolicy({ "In Progress": "ACTIONABLE", Resolved: "COMPLETED" }));
  const ddOverdueOpen = jiraItem({ id: "wi-dd-open-221", jiraStatusName: "In Progress", status: "In Progress", dueDate: "2026-06-01" }); // overdue
  const ddOverdueWrCompleted = jiraItem({ id: "wi-dd-wrc-221", jiraStatusName: "Resolved", status: "In Progress", dueDate: "2026-06-01" });
  const ddOverdueDcc = jiraItem({ id: "wi-dd-dcc-221", jiraStatusName: "In Progress", status: "In Progress", dueDate: "2026-06-01" });
  const ddData = { ...emptyData(), workItems: [ddOverdueOpen, ddOverdueWrCompleted, ddOverdueDcc] };

  const derivedNoGate = deriveData(ddData, null, TODAY);
  ok("V2.21 deriveData canonical gate", derivedNoGate.kpis.overdue === 3, "sanity check — with no index/completion supplied, all 3 overdue items count (pre-V2.21 behavior preserved)");

  const derivedGated = deriveData(ddData, null, TODAY, ddIdx, new Set([ddOverdueDcc.id]));
  ok("V2.21 deriveData canonical gate", derivedGated.kpis.overdue === 1, "with the canonical gate applied, only the genuinely-open item counts toward 'overdue' — the WR-COMPLETED and Daily-Command-completed items no longer inflate the KPI");
  ok("V2.21 deriveData canonical gate", !derivedGated.scores.some((s) => s.itemId === ddOverdueWrCompleted.id || s.itemId === ddOverdueDcc.id), "the same two items are excluded from the scored/open population entirely, not just from the overdue count");
}


// ----- V2.21 §3.2 — release-health.ts computeReleaseHealth(): a Work-Relevance-COMPLETED
// item counts as completed (not against readiness), matching the canonical gate. -----
{
  const rhIdx = buildWorkRelevanceIndex(globalPolicy({ "In Progress": "ACTIONABLE", Resolved: "COMPLETED" }));
  const rhOpen = jiraItem({ id: "wi-rh-open-221", jiraStatusName: "In Progress", status: "In Progress", fixVersion: "R1", priority: "P1" });
  const rhWrCompleted = jiraItem({ id: "wi-rh-wrc-221", jiraStatusName: "Resolved", status: "In Progress", fixVersion: "R1", priority: "P1", dueDate: "2026-06-01" });
  const rhData = { ...emptyData(), workItems: [rhOpen, rhWrCompleted] };

  const healthNoGate = computeReleaseHealth(rhData, "R1", TODAY);
  ok("V2.21 release-health canonical gate", healthNoGate.completedItems === 0, "sanity check — with no index supplied, the WR-COMPLETED item does not count as completed (pre-V2.21 behavior preserved)");

  const healthGated = computeReleaseHealth(rhData, "R1", TODAY, rhIdx);
  ok("V2.21 release-health canonical gate", healthGated.completedItems === 1, "with the canonical gate applied, the Work-Relevance-COMPLETED item counts toward completedItems even though its native Jira status is not \"Done\"");
  ok("V2.21 release-health canonical gate", healthGated.highPriorityIncompleteCount === 1, "the genuinely-open P1 item still counts as high-priority-incomplete, but the WR-COMPLETED P1 item no longer does — 1, not 2");
  ok("V2.21 release-health canonical gate", healthGated.overdueCount === 0, "nor as overdue, despite its past due date");
}


// ----- V2.21 §4 (bug fix) — use-command-center.ts buildProjectOverrideView(): Daily Command
// Completion must propagate into a project-scoped Command Bar/Meeting Mode override the exact
// same way it does into the main dashboard's global scope. Before this fix, the override
// pipeline never resolved or passed dailyCommandCompletedWorkItemIds at all. -----
{
  const povFixture = makeThreeProjectFixture();
  // UBS-900 (wi-ubs-x) is "Blocked"/P1 in the shared fixture — reclassify it ACTIONABLE and
  // make it stalled so it's a real Personal Focus candidate via the risk/attention pipeline.
  povFixture.workItems = povFixture.workItems.map((w) =>
    w.key === "UBS-900" ? { ...w, status: "In Progress" as const, blocked: false, jiraStatusName: "In Progress", lastUpdated: "2026-06-05", owner: "Alice", ownerId: "acc-alice" } : w
  );
  const povState = makeStoreState({
    data: povFixture,
    jiraProjectScope: { mode: "FOCUSED", projectKeys: ["JPMC"] },
    jiraWorkRelevancePolicy: { "In Progress": "ACTIONABLE" },
    ownerName: "Alice",
    personalIdentity: { accountId: "acc-alice" },
  });

  const overrideBefore = buildProjectOverrideView(povState, TODAY, "UBS");
  ok(
    "V2.21 project override completion propagation",
    !!overrideBefore.personalFocus?.candidates.some((c) => c.ticketKey === "UBS-900"),
    "sanity check — UBS-900's stalled-item risk is a real Personal Focus candidate in the override BEFORE any Daily Command completion"
  );

  const povStateCompleted = makeStoreState({
    ...povState,
    dailyCommandCompletions: { "UBS-900": { ticketKey: "UBS-900", completedAt: `${TODAY}T09:00:00.000Z` } },
  });
  const overrideAfter = buildProjectOverrideView(povStateCompleted, TODAY, "UBS");
  ok(
    "V2.21 project override completion propagation",
    overrideAfter.dailyCommandCompletedWorkItemIds?.has("wi-ubs-x") === true,
    "the override resolves the ticket-key-keyed completion to the correct WorkItem id, scoped to the override's own data"
  );
  ok(
    "V2.21 project override completion propagation",
    !overrideAfter.personalFocus?.candidates.some((c) => c.ticketKey === "UBS-900"),
    "a Daily-Command-completed ticket is suppressed from Personal Focus in a project-scoped override the same way it is in the global scope — this was the confirmed §4 bug: the override never threaded completion through at all"
  );

  // Cross-project isolation: completing UBS-900 must never affect a JPMC-scoped override.
  const overrideOtherProject = buildProjectOverrideView(povStateCompleted, TODAY, "JPMC");
  ok(
    "V2.21 project override completion propagation",
    overrideOtherProject.dailyCommandCompletedWorkItemIds?.has("wi-ubs-x") !== true,
    "completion resolution is scoped to each override's own data — a JPMC override never carries a UBS ticket's WorkItem id, even though the completion set is global by ticket key"
  );
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
  // My Assigned Work was absorbed into My Work (every assigned ticket is in one of its views);
  // Command Center carries My Work's compact summary instead.
  ok("V2.19 UI wiring", /<MyWorkSummary \/>/.test(pageSrc2), "My Work's summary (which absorbs My Assigned Work) is rendered on the main Command Center page");
  ok("V2.19 UI wiring", /<RecentlyMentioned \/>/.test(pageSrc2), "Recently Mentioned is rendered on the main Command Center page");

  const myWorkLibSrc = fs.readFileSync(path.join(repoRoot, "src/lib/command-center/my-work.ts"), "utf8");
  const myWorkPageSrc = fs.readFileSync(path.join(repoRoot, "src/app/my-work/page.tsx"), "utf8");
  ok("V2.19 UI wiring", /Nothing here\./.test(myWorkPageSrc) && /Your identity is not set/.test(myWorkPageSrc), "My Work has documented empty / no-identity states, not a silent 'nothing happened' implication");
  ok("V2.19 UI wiring", /getAssignedWorkItems/.test(myWorkLibSrc) && /isWorkItemDoneOrExcluded/.test(myWorkLibSrc) && /getTicketView/.test(myWorkLibSrc), "My Work reuses the shared assigned-work selector and the one ticket selector, not a second inline ownership/completion check");

  const recentMentionedSrc = fs.readFileSync(path.join(repoRoot, "src/components/command-center/RecentlyMentioned.tsx"), "utf8");
  ok("V2.19 UI wiring", /No Jira mentions in the last 24 hours/.test(recentMentionedSrc), "Recently Mentioned has the documented empty state");
  ok("V2.19 UI wiring", /selectRecentMentions/.test(recentMentionedSrc), "the component reuses the shared selector, not a second inline window/dedupe implementation");
}


// ----- V2.22 §13 — data-health.ts computeDataHealth(): a Work-Relevance-COMPLETED or
// Daily-Command-completed item must not count against ownership/due-date/release coverage,
// nor trigger a "review these items" remediation nudge for a ticket the user already
// considers finished. Confirmed real defect found during the V2.22 pilot audit. -----
{
  const dhIdx = buildWorkRelevanceIndex(globalPolicy({ "In Progress": "ACTIONABLE", Resolved: "COMPLETED" }));
  const dhOpenUnowned = jiraItem({ id: "wi-dh-open-222", key: "JPMC-2220", jiraStatusName: "In Progress", status: "In Progress", owner: undefined });
  const dhWrCompletedUnowned = jiraItem({ id: "wi-dh-wrc-222", key: "JPMC-2221", jiraStatusName: "Resolved", status: "In Progress", owner: undefined });
  const dhDccUnowned = jiraItem({ id: "wi-dh-dcc-222", key: "JPMC-2222", jiraStatusName: "In Progress", status: "In Progress", owner: undefined });
  const dhData = { ...emptyData(), workItems: [dhOpenUnowned, dhWrCompletedUnowned, dhDccUnowned] };

  const healthNoGate = computeDataHealth(dhData, "jira", undefined);
  ok("V2.22 data-health canonical gate", healthNoGate.totalWorkItems === 3, "sanity check — with no index/completion supplied, all 3 unowned items count as open (pre-V2.22 behavior preserved)");

  const healthGated = computeDataHealth(dhData, "jira", undefined, undefined, dhIdx, new Set([dhDccUnowned.id]));
  ok("V2.22 data-health canonical gate", healthGated.totalWorkItems === 1, "with the canonical gate applied, only the genuinely-open unowned item counts — the WR-COMPLETED and Daily-Command-completed items are excluded from the open population entirely");
  ok("V2.22 data-health canonical gate", healthGated.ownershipCoveragePct === 0, "coverage math still runs correctly over the smaller, correct open population (0 of 1 owned)");
  const ownershipRemediation222 = healthGated.remediation.find((r) => r.dimension === "Ownership coverage");
  ok("V2.22 data-health canonical gate", !!ownershipRemediation222 && ownershipRemediation222.affectedItemIds.length === 1 && ownershipRemediation222.affectedItemIds[0] === dhOpenUnowned.id, "the ownership remediation nudge names only the genuinely-open unowned item, never the two finished ones");
}


// ----- V2.22 §13 — "Data confidence" was a confirmed real mislabel: the ControlTower tile
// and data-health.ts's own remediation text both used this exact phrase for what is actually
// a FRESHNESS signal (Live/Aging/Stale/Unknown), not a confidence measure. -----
{
  const repoRoot222 = path.resolve(process.cwd());
  const controlTowerSrc = fs.readFileSync(path.join(repoRoot222, "src/components/command-center/ControlTower.tsx"), "utf8");
  ok("V2.22 Data Trust UX wording", !/label="Data confidence"/.test(controlTowerSrc), "ControlTower no longer labels the freshness tile \"Data confidence\"");
  ok("V2.22 Data Trust UX wording", /label="Data freshness"/.test(controlTowerSrc), "ControlTower now labels it \"Data freshness\", naming what it actually shows");

  const dataHealthSrc = fs.readFileSync(path.join(repoRoot222, "src/lib/command-center/data-health.ts"), "utf8");
  ok("V2.22 Data Trust UX wording", !/DATA CONFIDENCE/.test(dataHealthSrc), "data-health.ts's own remediation text no longer calls freshness \"DATA CONFIDENCE\" either");
}


// ----- V2.22 §12 Case 11 — Unknown Work Relevance: isWorkItemOperationallyOpen must follow
// EXISTING policy (UNKNOWN is conservative — never personal-work-eligible, per V2.5 — but
// still counts as operationally OPEN for delivery-risk/scoring purposes, since nobody has
// said it's finished), never silently reinterpreted into either "done" or "eligible". -----
{
  const unknownIdx = buildWorkRelevanceIndex(globalPolicy({ "To Do": "ACTIONABLE" })); // "Some Custom Status" deliberately left unclassified
  const unknownItem = jiraItem({ id: "wi-unknown-222", jiraStatusName: "Some Custom Status", status: "In Progress" });
  ok("V2.22 completion regression — Case 11 (UNKNOWN)", isWorkItemOperationallyOpen(unknownItem, unknownIdx) === true, "an UNKNOWN-relevance item is still counted as operationally OPEN (existing conservative default — nobody has classified it as finished)");
  ok("V2.22 completion regression — Case 11 (UNKNOWN)", isPersonalWorkEligibleItem(unknownItem, unknownIdx) === false, "...but it is NOT personal-work-eligible — UNKNOWN is never actionable (V2.5's own conservatism, unchanged and unreinterpreted by V2.22)");
}


// ----- V2.22 §3 — Pilot Trust Model: store.submitPilotFeedback() + persistence. -----
{
  commandCenterStore.resetAll();
  ok("V2.22 Pilot feedback", commandCenterStore.getSnapshot().pilotFeedback.length === 0, "starts empty — nothing recorded by default");

  const context222 = {
    freshness: "fresh" as const,
    projectScopeMode: "ALL" as const,
    assignedWorkActiveCount: 3,
    recentMentionsCount: 1,
    waitingForCount: 2,
    attentionQueueActiveCount: 5,
  };
  commandCenterStore.submitPilotFeedback({ date: TODAY, usefulness: 2, nextActionClarity: 1, trust: 2, note: "Waiting For was genuinely useful today.", context: context222 });
  const afterSubmit = commandCenterStore.getSnapshot().pilotFeedback;
  ok("V2.22 Pilot feedback", afterSubmit.length === 1, "submitPilotFeedback records one entry");
  ok("V2.22 Pilot feedback", afterSubmit[0].date === TODAY && afterSubmit[0].usefulness === 2 && afterSubmit[0].nextActionClarity === 1 && afterSubmit[0].trust === 2, "the three 0-2 scores round-trip exactly as submitted");
  ok("V2.22 Pilot feedback", typeof afterSubmit[0].id === "string" && afterSubmit[0].id.length > 0 && typeof afterSubmit[0].submittedAt === "string" && afterSubmit[0].submittedAt.length > 0, "a real id and submittedAt timestamp are stamped, never left for the caller to invent");
  ok("V2.22 Pilot feedback", afterSubmit[0].context.assignedWorkActiveCount === 3 && afterSubmit[0].context.waitingForCount === 2, "the deterministic context snapshot (§4 pilot observability) is stored verbatim, not re-derived later");
  commandCenterStore.resetAll();
}


// ----- V2.22 §3 — Pilot feedback: parseStoredState round-trip + defensive parsing, same
// discipline as every other persisted field (V2.19 Daily Command Completion, etc). -----
{
  const validPilotBlob = JSON.stringify({
    loaded: true,
    pilotFeedback: [
      {
        id: "pilot-1",
        date: "2026-06-15",
        submittedAt: "2026-06-15T18:00:00.000Z",
        usefulness: 2,
        nextActionClarity: 0,
        trust: 1,
        note: "Missing a risk on JPMC-9.",
        context: { freshness: "aging", projectScopeMode: "FOCUSED", focusedProjectCount: 2, assignedWorkActiveCount: 4, recentMentionsCount: 0, waitingForCount: 1, attentionQueueActiveCount: 6 },
      },
    ],
  });
  const parsedPilot = parseStoredState(validPilotBlob);
  ok("V2.22 Pilot feedback parsing", parsedPilot.pilotFeedback.length === 1 && parsedPilot.pilotFeedback[0].note === "Missing a risk on JPMC-9.", "a well-formed persisted pilot feedback entry round-trips through parseStoredState");

  const malformedPilotBlob = JSON.stringify({
    loaded: true,
    pilotFeedback: [
      { id: "p-1", date: "2026-06-15", submittedAt: "2026-06-15T18:00:00.000Z", usefulness: 2, nextActionClarity: 1, trust: 2, context: { freshness: "fresh", projectScopeMode: "ALL", assignedWorkActiveCount: 1, recentMentionsCount: 0, waitingForCount: 0, attentionQueueActiveCount: 0 } }, // valid
      { id: "p-2", date: "2026-06-15", usefulness: 3, nextActionClarity: 1, trust: 2, context: {} }, // usefulness out of range, malformed context — dropped
      "not-an-object", // dropped
      null, // dropped
    ],
  });
  const parsedMalformedPilot = parseStoredState(malformedPilotBlob);
  ok("V2.22 Pilot feedback parsing", parsedMalformedPilot.pilotFeedback.length === 1 && parsedMalformedPilot.pilotFeedback[0].id === "p-1", "a malformed entry (out-of-range score, missing context fields, or a non-object) is dropped rather than trusted or crashing the parse");

  const noPilotFieldAtAll = parseStoredState(JSON.stringify({ loaded: true }));
  ok("V2.22 Pilot feedback parsing", noPilotFieldAtAll.pilotFeedback.length === 0, "a pre-V2.22 persisted blob with no pilotFeedback field at all degrades to empty, never a crash");
}


// ===== V2.23 — Skipped Work & Personal Execution Boundary =====
// Daily Command Skip: "this work is relevant, but I am intentionally not executing it right
// now" — a PERSONAL EXECUTION STATE, distinct from Work Relevance EXCLUDED (project truth)
// and Daily Command Completion (finished responsibility). Mirrors V2.19/V2.21's own
// DailyCommandCompletion architecture (see types.ts's DailyCommandSkip for the full mapping).

// ----- store.ts: skipTicketInDailyCommand / reactivateSkippedTicket + mutual exclusion with
// Daily Command Completion (§7-9, §11 — no Active+Skipped or Completed+Skipped ambiguity). -----
{
  commandCenterStore.resetAll();
  ok("V2.23 Daily Command Skip", Object.keys(commandCenterStore.getSnapshot().dailyCommandSkips).length === 0, "starts empty — nothing skipped by default");

  commandCenterStore.skipTicketInDailyCommand("JPMC-2300", "Team is handling it");
  const afterSkip = commandCenterStore.getSnapshot().dailyCommandSkips;
  ok("V2.23 Daily Command Skip", !!afterSkip["JPMC-2300"], "skipTicketInDailyCommand records a skip, keyed by ticket key");
  ok("V2.23 Daily Command Skip", typeof afterSkip["JPMC-2300"].skippedAt === "string" && afterSkip["JPMC-2300"].skippedAt.length > 0, "records a real skippedAt timestamp");
  ok("V2.23 Daily Command Skip", afterSkip["JPMC-2300"].reason === "Team is handling it", "the optional reason is recorded verbatim");

  commandCenterStore.skipTicketInDailyCommand("JPMC-2301"); // no reason — never required (§7)
  ok("V2.23 Daily Command Skip", commandCenterStore.getSnapshot().dailyCommandSkips["JPMC-2301"]?.reason === undefined, "a reason is never required to skip an item");

  commandCenterStore.reactivateSkippedTicket("JPMC-2300");
  ok("V2.23 Daily Command Skip", !commandCenterStore.getSnapshot().dailyCommandSkips["JPMC-2300"], "reactivateSkippedTicket clears the skip — the only way back, and it's always explicit (§9)");

  // Reactivating something never skipped is a safe no-op.
  commandCenterStore.reactivateSkippedTicket("JPMC-NEVER-SKIPPED");
  ok("V2.23 Daily Command Skip", Object.keys(commandCenterStore.getSnapshot().dailyCommandSkips).length === 1, "reactivating a ticket with no recorded skip is a no-op, not a crash (only JPMC-2301 remains)");

  // Mutual exclusion (§11): skip clears any prior completion; complete clears any prior skip —
  // a ticketKey is never simultaneously Completed and Skipped, in either direction.
  commandCenterStore.completeTicketInDailyCommand("JPMC-2302");
  ok("V2.23 mutual exclusion", !!commandCenterStore.getSnapshot().dailyCommandCompletions["JPMC-2302"], "sanity check — JPMC-2302 is completed");
  // TicketWorkState transition table: DONE only goes back to TODO (explicit Reopen), so skipping
  // a completed ticket is refused — it stays Completed and is never also Skipped.
  commandCenterStore.skipTicketInDailyCommand("JPMC-2302", "Not my action");
  ok("V2.23 mutual exclusion", !commandCenterStore.getSnapshot().dailyCommandSkips["JPMC-2302"], "skipping a completed ticket is refused (DONE → SKIPPED is not in the transition table)...");
  ok("V2.23 mutual exclusion", !!commandCenterStore.getSnapshot().dailyCommandCompletions["JPMC-2302"], "...so it stays Completed — never simultaneously Completed and Skipped (§11)");
  commandCenterStore.reopenTicketInDailyCommand("JPMC-2302");
  commandCenterStore.skipTicketInDailyCommand("JPMC-2302", "Not my action");
  ok("V2.23 mutual exclusion", !!commandCenterStore.getSnapshot().dailyCommandSkips["JPMC-2302"] && !commandCenterStore.getSnapshot().dailyCommandCompletions["JPMC-2302"], "after an explicit Reopen it can be skipped, and the completion is gone");

  commandCenterStore.completeTicketInDailyCommand("JPMC-2302"); // the one defined SKIPPED -> COMPLETED transition (§11)
  ok("V2.23 mutual exclusion", !!commandCenterStore.getSnapshot().dailyCommandCompletions["JPMC-2302"], "completing a skipped ticket is the defined SKIPPED -> COMPLETED transition...");
  ok("V2.23 mutual exclusion", !commandCenterStore.getSnapshot().dailyCommandSkips["JPMC-2302"], "...and clears the skip in the other direction too");
  commandCenterStore.resetAll();
}


// ----- Daily Command Skip — parseStoredState round-trip + defensive parsing (§ refresh/sync
// preserve Skipped, malformed data never trusted). -----
{
  const validSkipBlob = JSON.stringify({ loaded: true, dailyCommandSkips: { "JPMC-1": { ticketKey: "JPMC-1", skippedAt: "2026-06-15T10:00:00.000Z", skippedBy: "Alice", reason: "Waiting on another team" } } });
  const parsedSkip = parseStoredState(validSkipBlob);
  ok("V2.23 Daily Command Skip parsing", parsedSkip.dailyCommandSkips["JPMC-1"]?.reason === "Waiting on another team", "a well-formed persisted skip round-trips through parseStoredState");

  const malformedSkipBlob = JSON.stringify({
    loaded: true,
    dailyCommandSkips: {
      "JPMC-1": { ticketKey: "JPMC-1", skippedAt: "2026-06-15T10:00:00.000Z" }, // valid, no reason
      "JPMC-2": { ticketKey: "JPMC-2" }, // missing skippedAt — dropped
      "JPMC-3": { ticketKey: "JPMC-3", skippedAt: "2026-06-15T10:00:00.000Z", reason: "Not a real reason" }, // invalid reason value — dropped
      "JPMC-4": "not-an-object", // dropped
      "JPMC-5": null, // dropped
    },
  });
  const parsedMalformedSkip = parseStoredState(malformedSkipBlob);
  ok("V2.23 Daily Command Skip parsing", Object.keys(parsedMalformedSkip.dailyCommandSkips).length === 1 && !!parsedMalformedSkip.dailyCommandSkips["JPMC-1"], "a malformed entry is dropped rather than trusted or crashing the parse — same discipline as every other persisted field");

  const noSkipFieldAtAll = parseStoredState(JSON.stringify({ loaded: true }));
  ok("V2.23 Daily Command Skip parsing", Object.keys(noSkipFieldAtAll.dailyCommandSkips).length === 0, "a pre-V2.23 persisted blob with no dailyCommandSkips field at all degrades to empty, never a crash");
}


// ----- personal-focus.ts's evaluateWorkRelevanceGate now also excludes a Daily-Command-
// SKIPPED ticket — independent of the ticket's own Jira status (even ACTIONABLE). This is the
// enforcement point for "not in My Day / Personal Focus" (§5), with explicit reactivation. -----
{
  const skipWorkItem = jiraItem({ id: "wi-skip-focus", key: "JPMC-2310", jiraStatusName: "To Do" });
  const skipIdx = buildWorkRelevanceIndex(globalPolicy({ "To Do": "ACTIONABLE" }));
  const skipDrift = { id: "DRIFT:skip-focus-item", category: "DRIFT" as const, severity: "HIGH" as const, what: "x", why: "x", impact: "x", nowWhat: "x", evidence: [], lifecycle: "ACTIVE" as const, firstSeenDate: TODAY, lastSeenDate: TODAY, sourceRef: { type: "workItem" as const, id: skipWorkItem.id } };
  const skipData: CommandCenterData = { ...emptyData(), workItems: [skipWorkItem] };
  const skipProactive = fakeProactive([skipDrift]);

  const withoutSkip = computePersonalFocus(skipData, skipProactive, "Alice", TODAY, undefined, skipIdx);
  ok("V2.23 Daily Command Skip gate", withoutSkip.candidates.some((c) => c.sourceId === skipDrift.id), "sanity check — the candidate exists before any skip is recorded");

  const withSkip = computePersonalFocus(skipData, skipProactive, "Alice", TODAY, undefined, skipIdx, undefined, undefined, undefined, new Set([skipWorkItem.id]));
  ok("V2.23 Daily Command Skip gate", !withSkip.candidates.some((c) => c.sourceId === skipDrift.id), "a Daily-Command-skipped ticket's DRIFT candidate is excluded — even though its Jira status is still ACTIONABLE");

  const omittedSkipParam = computePersonalFocus(skipData, skipProactive, "Alice", TODAY, undefined, skipIdx);
  ok("V2.23 Daily Command Skip gate", omittedSkipParam.candidates.some((c) => c.sourceId === skipDrift.id), "omitting the new trailing parameter reproduces pre-V2.23 behavior exactly — every existing call site is unaffected");

  // §9, §13 Reactivation — removing the ticket from the caller-supplied set (never automatic)
  // brings the candidate back.
  const reactivated = computePersonalFocus(skipData, skipProactive, "Alice", TODAY, undefined, skipIdx, undefined, undefined, undefined, new Set());
  ok("V2.23 Daily Command Skip gate — reactivation", reactivated.candidates.some((c) => c.sourceId === skipDrift.id), "reactivating the ticket (removing it from the skipped set) makes it a candidate again — reactivation is explicit, never automatic");

  // Completion and Skip are independent sets — an unrelated Daily Command Completion never
  // affects this ticket's skip suppression (no cross-contamination between the two maps).
  const withUnrelatedCompletion = computePersonalFocus(skipData, skipProactive, "Alice", TODAY, undefined, skipIdx, undefined, undefined, new Set(["some-other-wi"]), new Set([skipWorkItem.id]));
  ok("V2.23 Daily Command Skip gate", !withUnrelatedCompletion.candidates.some((c) => c.sourceId === skipDrift.id), "skip suppression composes correctly alongside an unrelated Daily Command Completion set");
}


// ----- action-plan.ts buildCandidates()/buildPlan(): a Daily-Command-SKIPPED WorkItem must
// not be resurfaced as a fresh auto-suggested Today's Action Plan candidate, and First 30
// Minutes' own fallback inherits the same suppression (§5, §10). -----
{
  const apSkipIdx = buildWorkRelevanceIndex(globalPolicy({ "To Do": "ACTIONABLE" }));
  const apSkipItem = jiraItem({ id: "wi-ap-skip-230", key: "JPMC-2320", jiraStatusName: "To Do", status: "In Progress", businessImpact: 5, dueDate: TODAY, priority: "P1", blocked: true, blockerReason: "x" });
  const apSkipData = { ...emptyData(), workItems: [apSkipItem] };

  const beforeSkip230 = buildCandidates(apSkipData, TODAY, apSkipIdx);
  ok("V2.23 Action Plan skip safety", beforeSkip230.some((c) => c.item?.id === apSkipItem.id), "sanity check — the item is a candidate before any Daily Command skip");

  const afterSkip230 = buildCandidates(apSkipData, TODAY, apSkipIdx, undefined, new Set([apSkipItem.id]));
  ok("V2.23 Action Plan skip safety", !afterSkip230.some((c) => c.item?.id === apSkipItem.id), "a Daily-Command-skipped WorkItem is never resurfaced as a fresh auto-suggested candidate");

  const planAfterSkip230 = buildPlan(apSkipData, TODAY, 480, apSkipIdx, undefined, new Set([apSkipItem.id]));
  ok("V2.23 Action Plan skip safety", !planAfterSkip230.some((c) => c.item?.id === apSkipItem.id), "buildPlan() inherits the same suppression — even with a full-day budget, the skipped item is never selected");

  const afterReactivate230 = buildCandidates(apSkipData, TODAY, apSkipIdx, undefined, new Set());
  ok("V2.23 Action Plan skip safety — reactivation", afterReactivate230.some((c) => c.item?.id === apSkipItem.id), "reactivating the ticket (removing it from the skipped set) makes it eligible again");

  const omittedSkip230 = buildCandidates(apSkipData, TODAY, apSkipIdx, undefined);
  ok("V2.23 Action Plan skip safety", omittedSkip230.some((c) => c.item?.id === apSkipItem.id), "omitting the new parameter reproduces pre-V2.23 behavior exactly");

  const first30Skipped = buildFirst30Minutes([], apSkipData, TODAY, apSkipIdx, undefined, new Set([apSkipItem.id]));
  ok("V2.23 First 30 Minutes skip safety", !first30Skipped.some((f) => f.text.includes("JPMC-2320")), "First 30 Minutes' action-plan fallback never fills a slot with a Daily-Command-skipped item");
}


// ----- assigned-work.ts — three-way Active/Completed/Skipped partition (V2.23), never mixing
// skip into the completed bucket or vice versa. -----
{
  const bob = { displayName: "Bob", accountId: "acc-bob-230" };
  const bobActive = jiraItem({ id: "wi-aw230-active", key: "JPMC-2330", status: "In Progress", jiraStatusName: "In Progress", ownerId: "acc-bob-230", owner: "Bob" });
  const bobSkipped = jiraItem({ id: "wi-aw230-skip", key: "JPMC-2331", status: "In Progress", jiraStatusName: "In Progress", ownerId: "acc-bob-230", owner: "Bob" });
  const bobDone = jiraItem({ id: "wi-aw230-done", key: "JPMC-2332", status: "Done", jiraStatusName: "Done", ownerId: "acc-bob-230", owner: "Bob" });
  const bobItems = [bobActive, bobSkipped, bobDone];
  const skipKeys230 = new Set(["JPMC-2331"]);

  const activeBucket230 = getActiveAssignedWorkItems(bobItems, bob, undefined, new Set(), skipKeys230);
  ok("V2.23 assigned-work partition", activeBucket230.length === 1 && activeBucket230[0].key === "JPMC-2330", "the active bucket contains exactly the non-finished, non-skipped item");

  const skippedBucket230 = getSkippedAssignedWorkItems(bobItems, bob, undefined, skipKeys230);
  ok("V2.23 assigned-work partition", skippedBucket230.length === 1 && skippedBucket230[0].key === "JPMC-2331", "the skipped bucket contains exactly the skipped item");

  const completedBucket230 = getCompletedAssignedWorkItems(bobItems, bob, undefined);
  ok("V2.23 assigned-work partition", completedBucket230.length === 1 && completedBucket230[0].key === "JPMC-2332", "the completed bucket contains exactly the Jira-Done item — skip never leaks into it");

  // A ticket that's BOTH Jira-native-Done AND carries a stale skip record (e.g. Jira finished
  // it after the user skipped it, with no explicit reactivation) displays as Completed, not
  // Skipped — native/policy truth wins the display bucket over a possibly-stale skip record.
  const staleSkipButDone = jiraItem({ id: "wi-aw230-stale", key: "JPMC-2333", status: "Done", jiraStatusName: "Done", ownerId: "acc-bob-230", owner: "Bob" });
  const staleSkipKeys = new Set(["JPMC-2333"]);
  ok("V2.23 assigned-work partition", getCompletedAssignedWorkItems([staleSkipButDone], bob, undefined).some((w) => w.key === "JPMC-2333"), "a ticket that's since gone Jira-Done shows as Completed even with a stale skip record present");
  ok("V2.23 assigned-work partition", getSkippedAssignedWorkItems([staleSkipButDone], bob, undefined, staleSkipKeys).length === 0, "...and is correctly excluded from the Skipped bucket once Jira truth says it's finished");
}


// ----- recent-mentions.ts — Daily Command Skip suppression + reactivation-by-mention (§8's
// Scenario D), mirroring the V2.19 Daily Command Completion behavior exactly. -----
{
  const nowMs230 = new Date("2026-06-15T18:00:00.000Z").getTime();
  const skippedAt230 = new Date(nowMs230 - 5 * 60 * 60 * 1000).toISOString();
  const oldMentionBeforeSkip = new Date(nowMs230 - 6 * 60 * 60 * 1000).toISOString();
  const newMentionAfterSkip = new Date(nowMs230 - 1 * 60 * 60 * 1000).toISOString();
  const skips230: Record<string, DailyCommandSkip> = { "JPMC-2340": { ticketKey: "JPMC-2340", skippedAt: skippedAt230 } };

  const beforeReactivation230 = selectRecentMentions([{ issueKey: "JPMC-2340", commentId: "c-old", excerpt: "old", mentionedAt: oldMentionBeforeSkip }], [], {}, nowMs230, { dailyCommandSkips: skips230 });
  ok("V2.23 recent-mentions — skip suppression", beforeReactivation230.length === 0, "a mention from BEFORE the Daily Command skip stays suppressed");

  const afterReactivation230 = selectRecentMentions([{ issueKey: "JPMC-2340", commentId: "c-new", excerpt: "new", mentionedAt: newMentionAfterSkip }], [], {}, nowMs230, { dailyCommandSkips: skips230 });
  ok("V2.23 recent-mentions — reactivation via mention", afterReactivation230.length === 1 && afterReactivation230[0].commentId === "c-new", "a genuinely NEW mention strictly after the skip timestamp reactivates the ticket into Recently Mentioned — one card, no duplicates (§8 Scenario D)");
}


// ----- proactive.ts computeProactiveIntelligence(): a Daily-Command-SKIPPED ticket's RISK
// attention item is excluded from the active Attention Queue (§5, §10 — this goes further
// than Daily Command Completion's own pre-existing MENTION-only Attention Queue scope, per
// this spec's explicit requirement; that asymmetry is intentional, not a defect), and a
// still-open MENTION on a skipped ticket auto-resolves the same way a completed ticket's does,
// with correct reactivation. -----
{
  const skipFixture = makeThreeProjectFixture(); // JPMC-900 (wi-jpmc-x) is blocked, with a HIGH risk "JPMC critical risk" explicitly tied to it
  const skipDerived = deriveData(skipFixture, null, TODAY);

  const beforeQueueSkip = computeProactiveIntelligence(skipFixture, skipDerived, [], null, {}, "demo", TODAY);
  ok("V2.23 Attention Queue skip suppression", beforeQueueSkip.attentionQueue.some((i) => i.category === "RISK" && i.sourceRef?.id === "JPMC critical risk"), "sanity check — JPMC's blocked-item risk is a real Attention Queue item before any skip");

  const afterQueueSkip = computeProactiveIntelligence(skipFixture, skipDerived, [], null, {}, "demo", TODAY, undefined, undefined, undefined, undefined, undefined, new Set(["wi-jpmc-x"]));
  ok("V2.23 Attention Queue skip suppression", !afterQueueSkip.attentionQueue.some((i) => i.category === "RISK" && i.sourceRef?.id === "JPMC critical risk"), "a Daily-Command-skipped ticket's RISK item is excluded from the Attention Queue entirely — not just demoted");

  const afterQueueReactivate = computeProactiveIntelligence(skipFixture, skipDerived, [], null, {}, "demo", TODAY, undefined, undefined, undefined, undefined, undefined, new Set());
  ok("V2.23 Attention Queue skip suppression — reactivation", afterQueueReactivate.attentionQueue.some((i) => i.category === "RISK" && i.sourceRef?.id === "JPMC critical risk"), "reactivating the ticket (removing it from the skipped set) restores its RISK item to the Attention Queue");

  // MENTION forceResolve via skip — mirrors V2.17/V2.19's own completion mechanism exactly.
  const mentionSkipWorkItem = jiraItem({ id: "wi-mention-skip-230", key: "JPMC-2350", jiraStatusName: "To Do" });
  const mentionSkipData = { ...emptyData(), workItems: [mentionSkipWorkItem] };
  const mentionSkipDerived = deriveData(mentionSkipData, null, TODAY);
  const mentionSkipEvents = [{ issueKey: "JPMC-2350", commentId: "c-1", commentAuthor: "Bob", excerpt: "any update?", mentionedAt: `${TODAY}T09:00:00.000Z` }];

  const beforeMentionSkip = computeProactiveIntelligence(mentionSkipData, mentionSkipDerived, [], null, {}, "demo", TODAY, undefined, mentionSkipEvents);
  const mentionItemBefore = beforeMentionSkip.attentionQueue.find((i) => i.category === "MENTION");
  ok("V2.23 MENTION forceResolve via skip", mentionItemBefore?.lifecycle === "NEW", "sanity check — the mention is a fresh NEW attention item before any skip");

  const afterMentionSkip = computeProactiveIntelligence(mentionSkipData, mentionSkipDerived, [], null, {}, "demo", TODAY, undefined, mentionSkipEvents, undefined, undefined, undefined, new Set([mentionSkipWorkItem.id]));
  const mentionItemAfter = afterMentionSkip.attentionQueue.find((i) => i.category === "MENTION");
  ok("V2.23 MENTION forceResolve via skip", mentionItemAfter?.lifecycle === "RESOLVED", "the SAME still-open mention auto-resolves once its ticket is Daily-Command-skipped — no duplicate attention item, same mechanism as completion");

  // Reactivation: un-skipping (removing from the set) lets the still-open mention correctly
  // transition RESOLVED -> REOPENED via the ordinary lifecycle path, never stuck RESOLVED.
  const afterReactivateMention = computeProactiveIntelligence(mentionSkipData, mentionSkipDerived, [], null, afterMentionSkip.nextAttentionState, "demo", TODAY, undefined, mentionSkipEvents, undefined, undefined, undefined, new Set());
  const mentionItemReactivated = afterReactivateMention.attentionQueue.find((i) => i.category === "MENTION");
  ok("V2.23 MENTION forceResolve via skip — reactivation", mentionItemReactivated?.lifecycle === "REOPENED", "reactivating the ticket correctly reopens the still-live mention");
}


// ----- use-command-center.ts buildProjectOverrideView(): Daily Command Skip must propagate
// into a project-scoped Command Bar/Meeting Mode override the exact same way Daily Command
// Completion does (V2.21 §4), with correct cross-project isolation (§12 — no leakage). -----
{
  const povFixture230 = makeThreeProjectFixture();
  povFixture230.workItems = povFixture230.workItems.map((w) =>
    w.key === "UBS-900" ? { ...w, status: "In Progress" as const, blocked: false, jiraStatusName: "In Progress", lastUpdated: "2026-06-05", owner: "Alice", ownerId: "acc-alice" } : w
  );
  const povState230 = makeStoreState({
    data: povFixture230,
    jiraProjectScope: { mode: "FOCUSED", projectKeys: ["JPMC"] },
    jiraWorkRelevancePolicy: { "In Progress": "ACTIONABLE" },
    ownerName: "Alice",
    personalIdentity: { accountId: "acc-alice" },
  });

  const overrideBefore230 = buildProjectOverrideView(povState230, TODAY, "UBS");
  ok(
    "V2.23 project override skip propagation",
    !!overrideBefore230.personalFocus?.candidates.some((c) => c.ticketKey === "UBS-900"),
    "sanity check — UBS-900's stalled-item risk is a real Personal Focus candidate in the override BEFORE any Daily Command skip"
  );

  const povStateSkipped = makeStoreState({
    ...povState230,
    dailyCommandSkips: { "UBS-900": { ticketKey: "UBS-900", skippedAt: `${TODAY}T09:00:00.000Z` } },
  });
  const overrideAfter230 = buildProjectOverrideView(povStateSkipped, TODAY, "UBS");
  ok(
    "V2.23 project override skip propagation",
    overrideAfter230.dailyCommandSkippedWorkItemIds?.has("wi-ubs-x") === true,
    "the override resolves the ticket-key-keyed skip to the correct WorkItem id, scoped to the override's own data"
  );
  ok(
    "V2.23 project override skip propagation",
    !overrideAfter230.personalFocus?.candidates.some((c) => c.ticketKey === "UBS-900"),
    "a Daily-Command-skipped ticket is suppressed from Personal Focus in a project-scoped override the same way it is in the global scope"
  );

  // Cross-project isolation (§12): skipping UBS-900 must never affect a JPMC-scoped override.
  const overrideOtherProject230 = buildProjectOverrideView(povStateSkipped, TODAY, "JPMC");
  ok(
    "V2.23 project override skip propagation",
    overrideOtherProject230.dailyCommandSkippedWorkItemIds?.has("wi-ubs-x") !== true,
    "skip resolution is scoped to each override's own data — a JPMC override never carries a UBS ticket's WorkItem id, even though the skip set is global by ticket key"
  );
}


// ----- V2.23 UI wiring — confirms Skip/Reactivate are actually wired into real surfaces, not
// stranded as dead code only this test file exercises. -----
{
  const repoRoot230 = path.resolve(process.cwd());
  const myWorkSrc230 = fs.readFileSync(path.join(repoRoot230, "src/lib/command-center/my-work.ts"), "utf8");
  ok("V2.23 UI wiring", /ticketBucket|view\.bucket === "SKIPPED_DEFERRED"/.test(myWorkSrc230), "My Work's Skipped/Deferred view comes from the shared ticket bucket, not a second inline check");
  // V2.26 — the Skip/Reactivate wiring moved into the shared TaskReferenceRow, which My
  // Assigned Work now renders for every row.
  const taskRowSrc230 = fs.readFileSync(path.join(repoRoot230, "src/components/command-center/TaskReferenceRow.tsx"), "utf8");
  ok("V2.23 UI wiring", /<TaskRow\b/.test(fs.readFileSync(path.join(repoRoot230, "src/app/my-work/page.tsx"), "utf8")) && /skipTicketInDailyCommand/.test(taskRowSrc230) && /reactivateSkippedTicket/.test(taskRowSrc230), "My Work wires Skip and Reactivate to the real store actions (via the shared TaskRow)");

  const priorityCardSrc230 = fs.readFileSync(path.join(repoRoot230, "src/components/command-center/PriorityCard.tsx"), "utf8");
  ok("V2.23 UI wiring", /<TaskRow\b/.test(priorityCardSrc230), "PriorityCard exposes Skip/Reactivate (and Block/Done) through the shared TaskRow");

  const prioritiesPageSrc230 = fs.readFileSync(path.join(repoRoot230, "src/app/priorities/page.tsx"), "utf8");
  ok("V2.23 UI wiring", /"SKIPPED"/.test(prioritiesPageSrc230), "Priorities has an explicit Skipped filter tab — the §6 discoverability entry point");
  ok("V2.23 UI wiring", /surface="priorities"/.test(prioritiesPageSrc230), "Priorities wires Skip/Reactivate to the real store actions (TaskRow, recorded as the priorities surface)");

  const personalFocusCardSrc230 = fs.readFileSync(path.join(repoRoot230, "src/components/command-center/PersonalFocusCard.tsx"), "utf8");
  ok("V2.23 UI wiring", /<TaskRow\b/.test(personalFocusCardSrc230), "My Day / Your Delivery Focus's card exposes a Skip control (through the shared TaskRow)");

  const pageSrc230 = fs.readFileSync(path.join(repoRoot230, "src/app/page.tsx"), "utf8");
  ok("V2.23 UI wiring", /dailyCommandPausedWorkItemIds/.test(pageSrc230), "the main dashboard's Top Priorities preview also excludes skipped items (V2.26: via the skipped ∪ blocked 'paused' set), not just the full Priorities page");
}


// ===== V2.25 — "is this ticket done?" consistency audit (Task 1) =====
// Closes out the remaining part of work-relevance.ts's own isWorkItemDoneOrExcluded "confirmed
// bug" note: dependency-radar.ts, waiting-for.ts, client-attention-map.ts, stakeholder-radar.ts,
// memory.ts, action-effectiveness.ts, and change-detection.ts all used a raw `status !== "Done"`
// / `status === "Done"` check, ignoring the Work Relevance Policy's COMPLETED/EXCLUDED
// classification (and, where relevant, Daily Command Completion). Each block below builds one
// work item whose native WorkItemStatus enum is NOT "Done" but whose real Jira status name is
// classified COMPLETED in the policy, and confirms the engine now agrees with that
// classification once the Work Relevance index is passed — while still reproducing the old
// (pre-fix) behavior when the index is omitted, confirming the parameter is truly additive.
{
  const v25Policy = buildWorkRelevanceIndex(globalPolicy({ "Deployed to Prod": "COMPLETED", "To Do": "ACTIONABLE" }));

  // ----- dependency-radar.ts: computeDependencyRadar's blockedItems -----
  {
    const item = jiraItem({ id: "v25-dep-wi", key: "V25-DEP-1", status: "In Progress", jiraStatusName: "Deployed to Prod", priority: "P1", dependencyIds: ["v25-dep-1"] });
    const dep: Dependency = { id: "v25-dep-1", workItemId: "v25-dep-wi", description: "x", dependsOnTeam: "Team", status: "unresolved", raisedDate: "2026-06-05" };
    const data = { ...emptyData(), workItems: [item], dependencies: [dep] };

    const withoutIndex = computeDependencyRadar(data, [], TODAY);
    ok("V2.25 dependency-radar", withoutIndex[0].blockedItemCount === 1, "omitting the Work Relevance index reproduces the old raw-status-only behavior (native status still governs)");

    const withIndex = computeDependencyRadar(data, [], TODAY, v25Policy);
    ok("V2.25 dependency-radar", withIndex[0].blockedItemCount === 0, "a policy-COMPLETED (but not native-Done) work item is excluded from blockedItemCount once the index is passed");
    ok(
      "V2.25 dependency-radar",
      withoutIndex[0].heat === "HIGH" && withIndex[0].heat === "MEDIUM",
      `with its only blocked item excluded, heat drops from HIGH to MEDIUM (age alone) rather than staying inflated by a finished item (got ${withoutIndex[0].heat} -> ${withIndex[0].heat})`
    );
  }

  // ----- waiting-for.ts: buildWaitingFor's own local blockedItems (projectNames) -----
  {
    const item = jiraItem({ id: "v25-wait-wi", key: "V25-WAIT-1", status: "In Progress", jiraStatusName: "Deployed to Prod", dependencyIds: ["v25-wait-dep"] });
    const dep: Dependency = { id: "v25-wait-dep", workItemId: "v25-wait-wi", description: "x", dependsOnTeam: "Team", status: "unresolved", raisedDate: "2026-06-05" };
    const data = { ...emptyData(), workItems: [item], dependencies: [dep] };

    const radarWithoutIndex = computeDependencyRadar(data, [], TODAY);
    const waitingWithoutIndex = buildWaitingFor(data, radarWithoutIndex);
    ok("V2.25 waiting-for", waitingWithoutIndex[0].projectNames.length === 1, "omitting the index reproduces the old behavior — the project still shows as blocking");

    const radarWithIndex = computeDependencyRadar(data, [], TODAY, v25Policy);
    const waitingWithIndex = buildWaitingFor(data, radarWithIndex, v25Policy);
    ok("V2.25 waiting-for", waitingWithIndex[0].projectNames.length === 0, "a policy-COMPLETED work item's project no longer appears in Waiting For's own project list once the index is passed");
  }

  // ----- client-attention-map.ts: confidenceForClient/computeProjectAttentionMap's overdue -----
  {
    const clientItem = jiraItem({ id: "v25-client-wi", key: "V25-CLIENT-1", status: "In Progress", jiraStatusName: "Deployed to Prod", clientId: "v25-client", dueDate: "2026-06-01" }); // 14 days overdue
    const clientData = { ...emptyData(), clients: [{ id: "v25-client", name: "V25 Client" } as Client], workItems: [clientItem] };
    const derivedForV25 = deriveData(clientData, null, TODAY);

    const rowsWithoutIndex = computeClientAttentionMap(clientData, derivedForV25, [], null, TODAY);
    const rowsWithIndex = computeClientAttentionMap(clientData, derivedForV25, [], null, TODAY, v25Policy);
    ok(
      "V2.25 client-attention-map",
      rowsWithIndex[0].deliveryConfidence > rowsWithoutIndex[0].deliveryConfidence,
      "a policy-COMPLETED (but not native-Done) overdue item stops dragging down Delivery Confidence once the index is passed"
    );

    const projectItem = jiraItem({ id: "v25-proj-wi", key: "V25-PROJ-1", status: "In Progress", jiraStatusName: "Deployed to Prod", projectId: "jira-project-V25PROJ", dueDate: "2026-06-01" });
    const projectData = { ...emptyData(), projects: [{ id: "jira-project-V25PROJ", name: "V25 Project", clientId: "v25-client", sourceType: "jira" as const, sourceId: "V25PROJ" }], workItems: [projectItem] };
    const portfolioWithoutIndex = computeProjectAttentionMap(projectData, TODAY);
    const portfolioWithIndex = computeProjectAttentionMap(projectData, TODAY, v25Policy);
    ok(
      "V2.25 client-attention-map",
      portfolioWithIndex[0].deliveryConfidence > portfolioWithoutIndex[0].deliveryConfidence,
      "computeProjectAttentionMap's own overdue count is equally fixed for Executive Mode's Portfolio View"
    );
  }

  // ----- stakeholder-radar.ts: computeStakeholderAttention's unowned/concentration scans -----
  {
    const item = jiraItem({ id: "v25-stk-wi", key: "V25-STK-1", status: "In Progress", jiraStatusName: "Deployed to Prod", priority: "P1", owner: undefined });
    const data = { ...emptyData(), workItems: [item] };

    const withoutIndex = computeStakeholderAttention(data, [], []);
    ok("V2.25 stakeholder-radar", withoutIndex.some((s) => s.role === "OWNER" && s.relatedIds.includes("v25-stk-wi")), "omitting the index reproduces the old behavior — the unowned item is still flagged");

    const withIndex = computeStakeholderAttention(data, [], [], v25Policy);
    ok("V2.25 stakeholder-radar", !withIndex.some((s) => s.role === "OWNER" && s.relatedIds.includes("v25-stk-wi")), "a policy-COMPLETED (but not native-Done) unowned P1 item is no longer flagged as needing an owner once the index is passed");
  }

  // ----- memory.ts: buildSnapshotMetrics' openItems (blockedCount/overdueCount/deliveryConfidence) -----
  {
    const item = jiraItem({ id: "v25-mem-wi", key: "V25-MEM-1", status: "In Progress", jiraStatusName: "Deployed to Prod", blocked: true, blockerReason: "x", dueDate: "2026-06-01" });
    const data = { ...emptyData(), workItems: [item] };

    const metricsWithoutIndex = buildSnapshotMetrics(data, TODAY, 0);
    ok("V2.25 memory", metricsWithoutIndex.blockedCount === 1 && metricsWithoutIndex.overdueCount === 1, "omitting the index reproduces the old behavior — the item still counts as blocked/overdue");

    const metricsWithIndex = buildSnapshotMetrics(data, TODAY, 0, undefined, v25Policy);
    ok("V2.25 memory", metricsWithIndex.blockedCount === 0 && metricsWithIndex.overdueCount === 0, "a policy-COMPLETED (but not native-Done) item no longer inflates blockedCount/overdueCount in the persisted DailySnapshot metrics once the index is passed");
  }

  // ----- action-effectiveness.ts: the fallback heuristic's `isDone` -----
  {
    const relatedItem = jiraItem({ id: "v25-act-wi", key: "V25-ACT-1", status: "In Progress", jiraStatusName: "Deployed to Prod", blocked: false });
    const action = { id: "v25-act-1", title: "Follow up", why: "x", relatedWorkItemId: "v25-act-wi", status: "completed" as const, estimateMinutes: 15, createdAt: "2026-06-10", completedAt: "2026-06-11" };
    const data = { ...emptyData(), workItems: [relatedItem], actions: [action] };

    const withoutIndex = computeActionEffectiveness(data);
    ok("V2.25 action-effectiveness", withoutIndex[0].classification === "PARTIALLY_EFFECTIVE", "omitting the index reproduces the old behavior — a native-non-Done item classifies as only PARTIALLY_EFFECTIVE");

    const withIndex = computeActionEffectiveness(data, v25Policy);
    ok("V2.25 action-effectiveness", withIndex[0].classification === "EFFECTIVE", "an action targeting a policy-COMPLETED (but not native-Done) item now classifies as EFFECTIVE once the index is passed — the action loop no longer looks stuck");
  }

  // ----- change-detection.ts: the Status-change impact text -----
  {
    const before = jiraItem({ id: "v25-cd-wi", key: "V25-CD-1", status: "In Progress", jiraStatusName: "To Do" });
    const prevSnapshot: DailySnapshot = { date: "2026-06-14", workItems: [before], risks: [], requirements: [], dependencies: [], projects: [] };
    const after = jiraItem({ id: "v25-cd-wi", key: "V25-CD-1", status: "In Review", jiraStatusName: "Deployed to Prod" });
    const currentData = { ...emptyData(), workItems: [after] };

    const changesWithoutIndex = detectChanges(prevSnapshot, currentData, TODAY);
    const statusChangeWithoutIndex = changesWithoutIndex.find((c) => c.field === "Status");
    ok("V2.25 change-detection", statusChangeWithoutIndex?.impact === "Status moved forward or backward.", "omitting the index reproduces the old behavior — a policy-COMPLETED-but-not-native-Done transition gets the generic impact text");

    const changesWithIndex = detectChanges(prevSnapshot, currentData, TODAY, undefined, v25Policy);
    const statusChangeWithIndex = changesWithIndex.find((c) => c.field === "Status");
    ok("V2.25 change-detection", statusChangeWithIndex?.impact === "Completed.", "a status transition into a policy-COMPLETED (but not native-Done) status is now described as 'Completed.' once the index is passed");
  }
}


// ===== V2.25 Task 4 — Setup Health checklist: computeSetupHealthRows' pure show/hide logic
// for each condition, and their combination. Never a static list — every row's presence is
// derived live from the same store/derived facts every other trust surface already reads. =====
{
  const idx = buildWorkRelevanceIndex(globalPolicy({ "To Do": "ACTIONABLE", Done: "COMPLETED" }));
  const notConfigured: SlackNotifyStatus = { configured: false };
  const configuredNoServerSide: SlackNotifyStatus = { configured: true, serverSideNotifyActive: false };
  const fullyConfigured: SlackNotifyStatus = { configured: true, serverSideNotifyActive: true };

  // ----- Personal Identity row -----
  ok(
    "V2.25 Setup Health",
    computeSetupHealthRows(undefined, "jira", emptyData(), idx, fullyConfigured).some((r) => r.id === "identity") && !computeSetupHealthRows(undefined, "demo", emptyData(), idx, fullyConfigured).some((r) => r.id === "identity"),
    "no personalIdentity at all — the identity row is shown on a Jira install (C4: never on demo/local data)"
  );
  ok(
    "V2.25 Setup Health",
    computeSetupHealthRows({ displayName: "Alice" }, "jira", emptyData(), idx, fullyConfigured).some((r) => r.id === "identity"),
    "a personalIdentity with a displayName but no accountId still shows the identity row — accountId specifically is what mention/assignment matching needs"
  );
  ok(
    "V2.25 Setup Health",
    !computeSetupHealthRows({ displayName: "Alice", accountId: "acc-1" }, "demo", emptyData(), idx, fullyConfigured).some((r) => r.id === "identity"),
    "once accountId is configured, the identity row disappears — resolved conditions are never shown"
  );

  // ----- Unclassified Jira status row -----
  const unclassifiedItem = jiraItem({ id: "sh-wi-1", key: "SH-1", jiraStatusName: "Some Custom Status", status: "In Progress" });
  const unclassifiedData = { ...emptyData(), workItems: [unclassifiedItem] };
  const withUnclassified = computeSetupHealthRows({ accountId: "acc-1" }, "jira", unclassifiedData, idx, fullyConfigured);
  ok("V2.25 Setup Health", withUnclassified.some((r) => r.id === "unclassified-status" && r.text.includes("Some Custom Status")), "an unclassified Jira status on dataSource 'jira' shows the row, naming the actual status");
  ok(
    "V2.25 Setup Health",
    !computeSetupHealthRows({ accountId: "acc-1" }, "demo", unclassifiedData, idx, fullyConfigured).some((r) => r.id === "unclassified-status"),
    "the SAME unclassified status data never shows this row on Demo/Local Import — the Work Relevance Policy only ever applies to Jira-sourced data"
  );
  const classifiedItem = jiraItem({ id: "sh-wi-2", key: "SH-2", jiraStatusName: "To Do", status: "In Progress" });
  ok(
    "V2.25 Setup Health",
    !computeSetupHealthRows({ accountId: "acc-1" }, "jira", { ...emptyData(), workItems: [classifiedItem] }, idx, fullyConfigured).some((r) => r.id === "unclassified-status"),
    "every status already classified — the row disappears"
  );
  const manyUnclassified = { ...emptyData(), workItems: Array.from({ length: 7 }, (_, i) => jiraItem({ id: `sh-many-${i}`, key: `SH-M${i}`, jiraStatusName: `Custom Status ${i}`, status: "In Progress" })) };
  const manyRow = computeSetupHealthRows({ accountId: "acc-1" }, "jira", manyUnclassified, idx, fullyConfigured).find((r) => r.id === "unclassified-status");
  ok("V2.25 Setup Health", manyRow?.text.includes("7 Jira statuses"), "the row reports the real total count even when it exceeds the display cap");
  ok("V2.25 Setup Health", (manyRow?.text.match(/Custom Status/g) ?? []).length === 5, "at most 5 status names are actually listed, per this task's own spec, even though 7 are unclassified");
  ok("V2.25 Setup Health", manyRow?.text.includes("…"), "the row honestly indicates there are more beyond the 5 listed, never silently truncating without a signal");

  // ----- Real-time notify row -----
  ok("V2.25 Setup Health", computeSetupHealthRows({ accountId: "acc-1" }, "demo", emptyData(), idx, null).every((r) => r.id !== "notify"), "notifyStatus still loading (null) never shows a false-positive 'not configured' row");
  const notConfiguredRow = computeSetupHealthRows({ accountId: "acc-1" }, "demo", emptyData(), idx, notConfigured).find((r) => r.id === "notify");
  ok("V2.25 Setup Health", notConfiguredRow?.text.includes("aren't configured at all"), "SLACK_WEBHOOK_URL entirely missing gets the strongest wording — zero notifications will ever be sent");
  const tabOnlyRow = computeSetupHealthRows({ accountId: "acc-1" }, "demo", emptyData(), idx, configuredNoServerSide).find((r) => r.id === "notify");
  ok("V2.25 Setup Health", tabOnlyRow?.text.includes("only works while a browser tab is open"), "Slack configured but no server-side path gets the narrower 'tab-dependent' wording, not the 'nothing at all' one");
  ok(
    "V2.25 Setup Health",
    computeSetupHealthRows({ accountId: "acc-1" }, "demo", emptyData(), idx, fullyConfigured).every((r) => r.id !== "notify"),
    "both SLACK_WEBHOOK_URL and the server-side path (PERSONAL_JIRA_ACCOUNT_ID + KV) configured — the row disappears"
  );

  // ----- Combination: everything resolved means zero rows, never a static list -----
  ok(
    "V2.25 Setup Health",
    computeSetupHealthRows({ accountId: "acc-1" }, "jira", { ...emptyData(), workItems: [classifiedItem] }, idx, fullyConfigured).length === 0,
    "when every condition is resolved, the banner has zero rows to show at all"
  );
  ok(
    "V2.25 Setup Health",
    computeSetupHealthRows(undefined, "jira", unclassifiedData, idx, notConfigured).length === 3,
    "when nothing is configured, all three independent rows appear together — not mutually exclusive"
  );
}



// ===== syncJira mutual exclusion — overlapping syncs must never silently discard each other's
// commits. Before the store-level lock, two overlapping calls both ran and whichever fetch
// resolved LAST overwrote the other with a full this.set(), which could drop a freshly-detected
// JIRA_STATUS_COMPLETED event ("a completed ticket reappears as open between syncs"). =====
{
  const LOCK_TICKET = "LOCK-1";
  const lockProject = { id: "jira-project-LOCK", name: "Lock Project", clientId: undefined, status: "on-track", sourceType: "jira", sourceId: "LOCK" };
  const lockItem = (status: string) => ({ ...makeItem({ id: "lock-wi", key: LOCK_TICKET, projectId: "jira-project-LOCK", status }), sourceType: "jira", sourceId: LOCK_TICKET });
  const syncPayload = (status: string, syncedAt: string): DataSourceSyncResult =>
    ({
      ok: true,
      data: { ...emptyData(), projects: [lockProject], workItems: [lockItem(status)] },
      recordsFetched: 1,
      truncated: false,
      syncedAt,
      warnings: [],
    }) as unknown as DataSourceSyncResult;

  // A fake JiraDataSource whose every sync() call stays pending until the test settles it,
  // so the test controls the exact interleaving of overlapping syncs.
  interface PendingSync { resolve: (r: DataSourceSyncResult) => void; reject: (e: unknown) => void }
  function makeControllableSource() {
    const pending: PendingSync[] = [];
    let autoResult: DataSourceSyncResult | null = null;
    const source: DataSourceProvider = {
      type: "jira",
      sync: () => (autoResult ? Promise.resolve(autoResult) : new Promise<DataSourceSyncResult>((resolve, reject) => pending.push({ resolve, reject }))),
    };
    return { source, pending, setAutoResult: (r: DataSourceSyncResult | null) => { autoResult = r; } };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  // Seeds a fresh store (one "tab") with LOCK-1 still open, via a real first sync whose cursor
  // is 2h old — stale enough that auto-sync's eligibility check actually fires a tick.
  async function seededStore(lockManager: JiraSyncLockManager | null) {
    const ctl = makeControllableSource();
    const store = new CommandCenterStore({ createJiraDataSource: () => ctl.source, jiraSyncLockManager: lockManager });
    store.getSnapshot();
    store.resetAll();
    ctl.setAutoResult(syncPayload("In Progress", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()));
    await store.syncJira();
    ctl.setAutoResult(null);
    return { store, ctl };
  }

  // Starts a sync through the given trigger path. "auto" goes through the real auto-sync.ts
  // tick (initAutoJiraSync fires one immediately); "header"/"settings" make the exact call
  // Nav.tsx's and data-settings/page.tsx's buttons make.
  function startSync(store: CommandCenterStore, trigger: JiraSyncTrigger): Promise<JiraSyncResult | "auto-tick"> {
    if (trigger === "auto") {
      resetAutoJiraSyncForTests();
      initAutoJiraSync(store);
      resetAutoJiraSyncForTests(); // stop the interval timer; the immediate tick is already running
      return Promise.resolve("auto-tick");
    }
    return store.syncJira({ full: false, trigger });
  }

  const combos: [JiraSyncTrigger, JiraSyncTrigger][] = [
    ["auto", "header"],
    ["auto", "settings"],
    ["header", "settings"],
  ];
  // A faithful in-test implementation of the Web Locks `ifAvailable` contract, so lock
  // semantics are proven identically on every Node version — whether or not the host ships
  // navigator.locks. The first request() for a name is granted and held until its callback's
  // promise settles (resolve OR reject); a request for a held name gets its callback called
  // with `lock: null` immediately — never queued. As with the real API, the callback runs
  // asynchronously and request() resolves/rejects with the callback's own outcome.
  class FakeLockManager implements JiraSyncLockManager {
    private readonly held = new Set<string>();
    async request<T>(name: string, _options: { ifAvailable: true }, callback: (lock: unknown) => Promise<T> | T): Promise<T> {
      const granted = !this.held.has(name);
      if (granted) this.held.add(name); // claimed synchronously, so request order decides the winner
      await Promise.resolve();
      if (!granted) return callback(null);
      try {
        return await callback({ name, mode: "exclusive" });
      } finally {
        this.held.delete(name);
      }
    }
  }

  const realLocks = defaultJiraSyncLockManager();
  const NO_WEB_LOCKS_NOTICE = "navigator.locks not available in this runtime — Web Locks-specific coverage skipped, running fallback-path coverage only (fake-LockManager contract coverage still runs)";

  // Smoke test — the ONLY check that depends on the host runtime: confirms detection picks
  // up navigator.locks when the environment has it. Allowed to skip, never to fail.
  if (realLocks) ok("Sync lock (real navigator.locks) smoke", typeof realLocks.request === "function", `defaultJiraSyncLockManager() detects navigator.locks on Node ${process.version}`);
  else skip("Sync lock (real navigator.locks) smoke", `${NO_WEB_LOCKS_NOTICE} (Node ${process.version})`);

  // withJiraSyncLock's ifAvailable semantics, proven directly against the fake on every
  // runtime — and against the real navigator.locks too when present, which doubles as a check
  // that the fake behaves like the real thing.
  async function checkIfAvailableSemantics(group: string, locks: JiraSyncLockManager) {
    let releaseFirst!: (v: string) => void;
    let secondRan = false;
    const first = withJiraSyncLock(() => new Promise<string>((r) => (releaseFirst = r)), locks);
    await flush();
    const second = await withJiraSyncLock(async () => { secondRan = true; return "second"; }, locks);
    ok(group, second === LOCK_UNAVAILABLE && !secondRan, "a second caller while the lock is held is refused immediately — its task never runs, and it is not queued behind the first");
    releaseFirst("first");
    ok(group, (await first) === "first", "the first caller holds the lock until its own task settles, then gets its task's result");
    ok(group, (await withJiraSyncLock(async () => "third", locks)) === "third", "once the holder settles, the next caller is granted the lock");
    const rejected = await withJiraSyncLock(async () => { throw new Error("fetch failed"); }, locks).then(() => "resolved", () => "rejected");
    ok(group, rejected === "rejected", "a task that rejects propagates its rejection");
    ok(group, (await withJiraSyncLock(async () => "after-reject", locks)) === "after-reject", "and the lock is released after a rejected task — never left permanently held");
  }
  await checkIfAvailableSemantics("Sync lock (fake LockManager) ifAvailable", new FakeLockManager());
  if (realLocks) await checkIfAvailableSemantics("Sync lock (real navigator.locks) ifAvailable", realLocks);
  else skip("Sync lock (real navigator.locks) ifAvailable", NO_WEB_LOCKS_NOTICE);

  // Trigger-pair suite. The fake-LockManager and fallback modes always run; the real
  // navigator.locks mode runs only where the runtime has it, and is visibly skipped otherwise
  // — never silently replaced by the fallback under a "Web Locks" label.
  const lockModes: [string, () => JiraSyncLockManager | null][] = [["Web Locks, fake LockManager", () => new FakeLockManager()]];
  if (realLocks) lockModes.push(["Web Locks, real navigator.locks", () => realLocks]);
  else skip("Sync lock (Web Locks, real navigator.locks) trigger pairs", NO_WEB_LOCKS_NOTICE);
  lockModes.push(["fallback", () => null]);

  for (const [modeLabel, makeLockManager] of lockModes) {
    for (const [first, second] of combos) {
      const group = `Sync lock (${modeLabel}) ${first} vs ${second}`;
      const { store, ctl } = await seededStore(makeLockManager());

      const firstPromise = startSync(store, first);
      await flush();
      ok(group, ctl.pending.length === 1, `the first-started sync (${first}) is in flight`);
      ok(group, store.getJiraSyncActivity().inProgress && store.getJiraSyncActivity().trigger === first, `the store itself reports a sync in progress, started by '${first}' — so the other button can show "started elsewhere"`);
      const eventsBefore = store.getSnapshot().memoryEvents.length;

      // Not awaited yet: without a lock this call would sit on its own pending fetch, and the
      // test must report that as a failure rather than hang.
      const secondPromise = startSync(store, second);
      await flush();
      ok(group, ctl.pending.length === 1, `the second-started sync (${second}) never reached the data source — only one sync executes the merge`);
      ok(group, store.getSnapshot().memoryEvents.length === eventsBefore && store.getSnapshot().jiraSync.lastSyncStatus === "success", "the refused call changed no state and recorded no failure");

      // The problematic interleaving: resolve the SECOND-started sync first (if it started at
      // all), then the FIRST-started one.
      const [firstPending, secondPending] = ctl.pending;
      secondPending?.resolve(syncPayload("In Progress", new Date().toISOString()));
      await flush();
      firstPending.resolve(syncPayload("Done", new Date().toISOString()));
      const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
      await flush();
      ok(group, secondResult !== "auto-tick" && secondResult.ok === false && secondResult.errorKind === "sync-in-progress", `the second-started call (${second}) is refused with errorKind "sync-in-progress"`);
      ok(group, firstResult === "auto-tick" || firstResult.ok === true, "the winning sync commits successfully");

      const after = store.getSnapshot();
      const completion = after.memoryEvents.filter((ev) => ev.kind === "JIRA_STATUS_COMPLETED" && ev.ticketKey === LOCK_TICKET);
      ok(group, completion.length === 1, "the winning sync's JIRA_STATUS_COMPLETED event is still in state after both calls settle");
      ok(group, after.data.workItems.find((w) => w.key === LOCK_TICKET)?.status === "Done", "the completed ticket stays Done — it does not reappear as open");
      ok(group, !store.getJiraSyncActivity().inProgress, "the lock is released once the winning sync settles");
    }

    // A failed sync (rejected fetch) must release the lock, or every future sync is locked out.
    {
      const group = `Sync lock (${modeLabel}) failure release`;
      const { store, ctl } = await seededStore(makeLockManager());
      const failing = store.syncJira({ trigger: "header" });
      await flush();
      ctl.pending[0].reject(new Error("fetch failed: ECONNRESET"));
      const failed = await failing;
      ok(group, failed.ok === false && failed.errorKind !== "sync-in-progress", "a rejected fetch surfaces as an ordinary sync failure, not a thrown error");
      ok(group, store.getSnapshot().jiraSync.lastSyncStatus === "failed" && store.getSnapshot().jiraSync.previousDataPreserved === true, "the failure is recorded in jiraSync bookkeeping and existing data is preserved");
      ok(group, !store.getJiraSyncActivity().inProgress, "the store no longer reports a sync in progress after the failure");

      ctl.setAutoResult(syncPayload("Done", new Date().toISOString()));
      const retry = await store.syncJira({ trigger: "settings" });
      ok(group, retry.ok === true, "the very next sync acquires the lock and runs — the failed sync did not leave the store locked out");
      ok(group, store.getSnapshot().memoryEvents.some((ev) => ev.kind === "JIRA_STATUS_COMPLETED" && ev.ticketKey === LOCK_TICKET), "and that retry commits normally");
    }
  }

  // Two tabs of the same origin: two independent store instances (separate in-memory state,
  // separate per-store in-progress flags) arbitrated only by ONE shared LockManager — the one
  // thing real browser tabs actually share. Injecting the same fake into both makes this
  // deterministic on every runtime, and keeps the fallback module boolean (process-wide here,
  // but never shared by real tabs) out of the picture entirely.
  {
    const group = "Sync lock (Web Locks, fake LockManager) cross-tab";
    const sharedLocks = new FakeLockManager();
    const tabA = await seededStore(sharedLocks);
    const tabB = await seededStore(sharedLocks);
    const aPromise = tabA.store.syncJira({ trigger: "auto" });
    await flush();
    const bPromise = tabB.store.syncJira({ trigger: "header" });
    await flush();
    ok(group, tabB.ctl.pending.length === 0, "the second tab never sent its own request");
    ok(group, !tabB.store.getJiraSyncActivity().inProgress, "the refused tab is immediately idle again");
    tabB.ctl.pending[0]?.resolve(syncPayload("In Progress", new Date().toISOString()));
    tabA.ctl.pending[0].resolve(syncPayload("Done", new Date().toISOString()));
    const [, bResult] = await Promise.all([aPromise, bPromise]);
    ok(group, bResult.ok === false && bResult.errorKind === "sync-in-progress" && /another tab/.test(bResult.error ?? ""), "a sync in another tab is refused while the first tab holds the shared lock, and says why");
    tabB.ctl.setAutoResult(syncPayload("Done", new Date().toISOString()));
    ok(group, (await tabB.store.syncJira({ trigger: "header" })).ok === true, "once the first tab's sync settles, the other tab can sync again");

    // Control: the refusal above comes from the SHARED lock manager, not from anything else
    // two store instances in one process happen to share. Two stores with separate lock
    // managers (no common arbiter) both proceed.
    const control = "Sync lock (Web Locks, fake LockManager) cross-tab control";
    const tabC = await seededStore(new FakeLockManager());
    const tabD = await seededStore(new FakeLockManager());
    const cPromise = tabC.store.syncJira({ trigger: "auto" });
    const dPromise = tabD.store.syncJira({ trigger: "header" });
    await flush();
    ok(control, tabC.ctl.pending.length === 1 && tabD.ctl.pending.length === 1, "with no shared lock manager, both stores reach their data source — so the cross-tab refusal above is genuinely the shared lock's doing");
    tabC.ctl.pending[0].resolve(syncPayload("Done", new Date().toISOString()));
    tabD.ctl.pending[0].resolve(syncPayload("Done", new Date().toISOString()));
    await Promise.all([cPromise, dPromise]);
  }
  resetAutoJiraSyncForTests();
}


// ===== V2.26 Phần 1 — sync provenance per work item (firstSeenAt) + Sync Log =====
{
  const group = "V2.26 Sync provenance";
  const { store, setJira } = v226Store();
  const keys = ["PROV-1", "PROV-2", "PROV-3", "PROV-4", "PROV-5"];
  setJira(keys.map((k) => v226JiraItem(k)));
  await store.syncJira();
  const afterFirst = store.getSnapshot();
  const firstEntry = afterFirst.syncLog[afterFirst.syncLog.length - 1];
  ok(group, afterFirst.syncLog.length === 1 && firstEntry.recordsCreated === 5, "sync #1 creating 5 new tickets records a syncLog entry with recordsCreated=5");
  ok(group, JSON.stringify([...firstEntry.newTicketKeys].sort()) === JSON.stringify(keys), "that entry's newTicketKeys is exactly those 5 keys");
  ok(group, afterFirst.data.workItems.every((w) => w.firstSeenAt === firstEntry.completedAt), "every newly-created ticket is stamped firstSeenAt = that sync's completion time");
  const firstSeenBefore = new Map(afterFirst.data.workItems.map((w) => [w.key, w.firstSeenAt]));

  await v226Tick();
  setJira(keys.map((k) => v226JiraItem(k)));
  await store.syncJira();
  const afterSecond = store.getSnapshot();
  const secondEntry = afterSecond.syncLog[afterSecond.syncLog.length - 1];
  ok(group, afterSecond.syncLog.length === 2 && secondEntry.recordsCreated === 0 && secondEntry.newTicketKeys.length === 0, "sync #2 with nothing new records recordsCreated=0 and no newTicketKeys");
  ok(group, secondEntry.recordsUpdated === 0, "carrying firstSeenAt forward never makes an unchanged ticket count as 'updated'");
  ok(group, afterSecond.data.workItems.every((w) => w.firstSeenAt === firstSeenBefore.get(w.key)), "tickets unchanged between the two syncs keep sync #1's firstSeenAt — never overwritten by sync #2");

  await v226Tick();
  setJira([...keys.map((k) => v226JiraItem(k, k === "PROV-1" ? { status: "Done" } : {})), v226JiraItem("PROV-6")]);
  await store.syncJira();
  const afterThird = store.getSnapshot();
  const thirdEntry = afterThird.syncLog[afterThird.syncLog.length - 1];
  ok(group, thirdEntry.recordsCreated === 1 && thirdEntry.newTicketKeys[0] === "PROV-6" && thirdEntry.recordsUpdated === 1, "sync #3 reuses runJiraSync's own counts: 1 created (PROV-6), 1 updated (PROV-1)");
  ok(group, afterThird.data.workItems.find((w) => w.key === "PROV-1")?.firstSeenAt === firstSeenBefore.get("PROV-1"), "an UPDATED ticket still keeps its original firstSeenAt");
  ok(group, afterThird.data.workItems.find((w) => w.key === "PROV-6")?.firstSeenAt === thirdEntry.completedAt, "the newly-created ticket gets sync #3's timestamp");

  // Pre-existing data without firstSeenAt: never back-filled, never throws.
  const legacy = parseStoredState(JSON.stringify({ data: { ...emptyData(), workItems: [v226JiraItem("OLD-1")] }, loaded: true }));
  ok(group, legacy.data.workItems[0].firstSeenAt === undefined && Array.isArray(legacy.syncLog) && legacy.syncLog.length === 0, "a stored state from before this field parses safely: firstSeenAt undefined, syncLog empty");
  ok(group, parseStoredState(JSON.stringify({ syncLog: [{ startedAt: "x" }, "junk", { startedAt: "a", completedAt: "b", recordsCreated: 1, recordsUpdated: 0, newTicketKeys: ["K-1"] }] })).syncLog.length === 1, "malformed syncLog entries are dropped, valid ones kept");
  const capped = parseStoredState(JSON.stringify({ syncLog: Array.from({ length: 45 }, (_, i) => ({ startedAt: `s${i}`, completedAt: `c${i}`, recordsCreated: 0, recordsUpdated: 0, newTicketKeys: [] })) })).syncLog;
  ok(group, capped.length === 30 && capped[29].completedAt === "c44", "syncLog is capped at 30 entries, keeping the most recent");

  // Badge: a ticket first seen yesterday vs one first seen today (same sync) must look clearly different.
  const now = new Date(2026, 8, 26, 15, 0);
  const todayIso = new Date(2026, 8, 26, 9, 14).toISOString();
  const yesterdayIso = new Date(2026, 8, 25, 16, 2).toISOString();
  const todayBadge = renderToStaticMarkup(React.createElement(FirstSeenBadge, { firstSeenAt: todayIso, now }));
  const yesterdayBadge = renderToStaticMarkup(React.createElement(FirstSeenBadge, { firstSeenAt: yesterdayIso, now }));
  ok(group, todayBadge.includes("First seen: today 9:14 AM") && todayBadge.includes('data-first-seen="today"'), "today's ticket reads 'First seen: today 9:14 AM' with the 'today' style");
  ok(group, yesterdayBadge.includes("First seen: yesterday 4:02 PM") && yesterdayBadge.includes('data-first-seen="earlier"'), "yesterday's ticket reads 'First seen: yesterday 4:02 PM' with the neutral style");
  ok(group, todayBadge !== yesterdayBadge, "the two badges render visibly differently");
  ok(group, renderToStaticMarkup(React.createElement(FirstSeenBadge, {})) === "", "no firstSeenAt (legacy data) renders no badge at all — unknown is never shown as new");
  ok(group, formatRelativeDateTime(new Date(2026, 8, 23, 10, 0).toISOString(), now) === "3 days ago" && formatRelativeDateTime("not-a-date", now) === undefined, "relative formatting: '3 days ago' for older, undefined (never 'Invalid Date') for garbage");
}



// ===== V2.26 Phần 2 — Blocked as a universal per-ticket state, peer of Complete/Skip =====
{
  const group = "V2.26 Blocked state";
  const { store, setJira } = v226Store();
  const tay = { accountId: "acc-tay", displayName: "Tay" };
  // High-signal, ACTIONABLE tickets so the Action Plan control below genuinely proposes them.
  store.setJiraStatusRelevance("In Progress", "ACTIONABLE");
  setJira(["BLK-1", "BLK-2", "BLK-3"].map((k) => v226JiraItem(k, { jiraStatusName: "In Progress", priority: "P1", dueDate: "2026-01-05", businessImpact: 5 })));
  await store.syncJira();
  const keySet = (m: Record<string, unknown>) => new Set(Object.keys(m));
  const buckets = () => {
    const st = store.getSnapshot();
    const items = st.data.workItems;
    return {
      st,
      active: getActiveAssignedWorkItems(items, tay, undefined, keySet(st.dailyCommandCompletions), keySet(st.dailyCommandSkips), keySet(st.dailyCommandBlocks)).map((w) => w.key),
      blocked: getBlockedAssignedWorkItems(items, tay, undefined, keySet(st.dailyCommandBlocks)).map((w) => w.key),
      completed: getCompletedAssignedWorkItems(items, tay, undefined, keySet(st.dailyCommandCompletions)).map((w) => w.key),
      skipped: getSkippedAssignedWorkItems(items, tay, undefined, keySet(st.dailyCommandSkips)).map((w) => w.key),
    };
  };

  const beforeBlock = Date.now();
  store.blockTicketInDailyCommand("BLK-1", "  Waiting for Anna's API answer  ");
  let b = buckets();
  const blockRecord = b.st.dailyCommandBlocks["BLK-1"];
  ok(group, !b.active.includes("BLK-1"), "a blocked ticket leaves the Active list");
  ok(group, b.blocked.length === 1 && b.blocked[0] === "BLK-1", "...and appears in getBlockedAssignedWorkItems — not hidden, its own bucket");
  ok(group, blockRecord?.reason === "Waiting for Anna's API answer" && Date.parse(blockRecord.blockedAt) >= beforeBlock, "the block record carries the (trimmed) reason and a real blockedAt timestamp");
  ok(group, !b.completed.includes("BLK-1") && !b.skipped.includes("BLK-1"), "blocked is not completed and not skipped");
  const blockedItem = b.st.data.workItems.find((w) => w.key === "BLK-1")!;
  ok(group, isWorkItemOperationallyOpen(blockedItem, undefined, new Set()), "isWorkItemOperationallyOpen is untouched: a blocked ticket is still operationally OPEN (paused, not done/excluded)");

  store.completeTicketInDailyCommand("BLK-1");
  b = buckets();
  ok(group, b.completed.includes("BLK-1") && !b.blocked.includes("BLK-1"), "completing the blocked ticket moves it to Completed and out of Blocked — never in both");
  ok(group, !("BLK-1" in b.st.dailyCommandBlocks), "the block record itself is cleared by completion");

  // Three-state mutual exclusion — every setter clears the other two maps for that key.
  const setters: [string, (k: string) => void][] = [
    ["complete", (k) => store.completeTicketInDailyCommand(k)],
    ["skip", (k) => store.skipTicketInDailyCommand(k, "Not my action")],
    ["block", (k) => store.blockTicketInDailyCommand(k, "Depends on another ticket")],
  ];
  const membership = (k: string) => {
    const st = store.getSnapshot();
    return [k in st.dailyCommandCompletions, k in st.dailyCommandSkips, k in st.dailyCommandBlocks].filter(Boolean).length;
  };
  let exclusive = true;
  for (const [, first] of setters) {
    for (const [, second] of setters) {
      first("BLK-2");
      second("BLK-2");
      if (membership("BLK-2") !== 1) exclusive = false;
    }
  }
  ok(group, exclusive, "for every ordered pair of complete/skip/block, the ticket ends up in exactly ONE of the three maps");
  store.blockTicketInDailyCommand("BLK-2");
  ok(group, store.getSnapshot().dailyCommandBlocks["BLK-2"]?.reason === undefined, "blocking without a reason is allowed (reason stays undefined, never an empty string)");
  store.blockTicketInDailyCommand("BLK-3", "   ");
  ok(group, store.getSnapshot().dailyCommandBlocks["BLK-3"]?.reason === undefined, "a whitespace-only reason is treated as no reason");
  store.unblockTicketInDailyCommand("BLK-3");
  ok(group, !("BLK-3" in store.getSnapshot().dailyCommandBlocks) && buckets().active.includes("BLK-3"), "Unblock returns the ticket to Active");

  // Blocked leaves every active personal-execution surface through the same path skip uses.
  store.blockTicketInDailyCommand("BLK-3", "Waiting for a reply");
  const view = buildProjectOverrideView(store.getSnapshot(), getTodayIso(), "V226");
  const blk3Id = store.getSnapshot().data.workItems.find((w) => w.key === "BLK-3")!.id;
  ok(group, view.dailyCommandBlockedWorkItemIds.has(blk3Id) && view.dailyCommandPausedWorkItemIds.has(blk3Id) && !view.dailyCommandSkippedWorkItemIds.has(blk3Id), "the blocked ticket is in the blocked set and the skipped∪blocked 'paused' set, but NOT in the skipped set — the two stay distinct for display");
  const planWith = buildPlan(view.filteredData, getTodayIso(), 60, view.workRelevanceIndex, view.dailyCommandCompletedWorkItemIds, view.dailyCommandPausedWorkItemIds);
  const planWithout = buildPlan(view.filteredData, getTodayIso(), 60, view.workRelevanceIndex, view.dailyCommandCompletedWorkItemIds);
  ok(group, planWithout.some((p) => p.item?.id === blk3Id), "control: without the paused set, the Action Plan WOULD propose BLK-3 (so the next check isn't vacuous)");
  ok(group, !planWith.some((p) => p.item?.id === blk3Id), "with the paused set, the Action Plan never proposes the blocked ticket");

  const parsedBlocks = parseStoredState(JSON.stringify({ dailyCommandBlocks: { "OK-1": { ticketKey: "OK-1", blockedAt: "2026-09-25T10:00:00.000Z", reason: "x" }, "BAD-1": { ticketKey: "BAD-1" }, "BAD-2": "junk" } })).dailyCommandBlocks;
  ok(group, Object.keys(parsedBlocks).join(",") === "OK-1", "stored blocks parse with the same drop-malformed discipline as skips");
  ok(group, Object.keys(parseStoredState(JSON.stringify({})).dailyCommandBlocks).length === 0, "state from before this field parses to an empty blocks map");
}


// ===== V2.26 Phần 3 — the recorded timestamp + reason is shown next to each history row =====
{
  const group = "V2.26 History labels";
  const now = new Date(2026, 8, 26, 15, 0);
  const at = new Date(2026, 8, 26, 9, 14).toISOString();
  const maps = {
    dailyCommandCompletions: { "H-1": { ticketKey: "H-1", completedAt: at, completedBy: "Tay" }, "H-EMPTY": { ticketKey: "H-EMPTY", completedAt: "", completedBy: "Tay" } },
    dailyCommandSkips: { "H-2": { ticketKey: "H-2", skippedAt: new Date(2026, 8, 25, 16, 2).toISOString(), reason: "Team is handling it" as const } },
    dailyCommandBlocks: { "H-3": { ticketKey: "H-3", blockedAt: at, reason: "Waiting for a reply" }, "H-4": { ticketKey: "H-4", blockedAt: new Date(2026, 8, 23, 10, 0).toISOString() } },
  };
  const row = (key: string, finishedInJira = false) =>
    renderToStaticMarkup(React.createElement(TaskReferenceRowView, { ticketKey: key, url: `https://jira.example.com/browse/${key}`, title: key, execution: resolveTaskExecutionState(key, maps, finishedInJira), now, actions: undefined }));
  ok(group, row("H-1").includes("Completed, today 9:14 AM"), "a completion row shows 'Completed, today 9:14 AM' (no reason recorded → the state's own label)");
  // A4 — skipped/blocked rows now lead with their age: "<State> <age> — <reason> · since <when>".
  ok(group, row("H-2").includes("Skipped under 1 business day — Team is handling it · since yesterday 4:02 PM"), "a skip row shows its age, reason and when (Fri → Sat: under 1 business day)");
  ok(group, row("H-3").includes("Blocked today — Waiting for a reply · since today 9:14 AM"), "a block row shows its age, reason and when");
  ok(group, row("H-4").includes("Blocked 2 business days · since 3 days ago"), "a block with no reason shows its age and when (Wed → Sat: 2 business days)");
  const emptyRow = row("H-EMPTY");
  ok(group, emptyRow.includes(">Completed<") && !/undefined|null|Invalid Date/.test(emptyRow), "a completion with completedBy but an empty completedAt still renders 'Completed' — no 'undefined', no 'Invalid Date', no throw");
  ok(group, formatExecutionRecord({ kind: "completed", by: "Tay" }, now) === "Completed", "a completion record with no timestamp at all formats as plain 'Completed'");
  ok(group, formatExecutionRecord({ kind: "active" }, now) === undefined && !row("H-NONE").includes("data-task-record"), "an active ticket has no history label at all");
  ok(group, row("H-1").includes('href="https://jira.example.com/browse/H-1"'), "every history row still links to the ticket in Jira");
}



// ===== V2.26 Phần 4 — a ticket coming back after Completed/Skipped/Blocked says WHY =====
{
  const group = "V2.26 Reactivation";
  const { store, setJira } = v226ConfiguredStore();
  const items = ["RE-A", "RE-B", "RE-C", "RE-S", "RE-K"].map((k) => v226Actionable(k));
  setJira(items);
  await store.syncJira(); // "yesterday": first sync
  store.completeTicketInDailyCommand("RE-A");
  store.completeTicketInDailyCommand("RE-B");
  store.skipTicketInDailyCommand("RE-S", "Not my action");
  store.blockTicketInDailyCommand("RE-K", "Waiting for a reply");
  await v226Tick();

  // "Today": a new comment lands on RE-B, RE-S, RE-K (after the user's records); RE-A and RE-C get nothing.
  const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const nowMs = Date.now() + 2 * 60 * 60 * 1000;
  const mention = (k: string): MentionEvent => ({ issueKey: k, commentId: `c-${k}`, commentAuthor: "Anna", excerpt: "any update?", mentionedAt: later });
  setJira(items, [mention("RE-B"), mention("RE-S"), mention("RE-K")]);
  await store.syncJira();
  const st = store.getSnapshot();

  ok(group, v226ActiveSurfaces(store, "RE-C", nowMs).length >= 3, `control: an untouched active ticket genuinely reaches the active surfaces (${v226ActiveSurfaces(store, "RE-C", nowMs).join(", ")}) — so an empty list below is meaningful`);
  ok(group, v226ActiveSurfaces(store, "RE-A", nowMs).length === 0, "ticket A (completed, nothing new) appears on NO active surface after today's sync");
  ok(group, getCompletedAssignedWorkItems(st.data.workItems, { accountId: "acc-tay" }, undefined, new Set(Object.keys(st.dailyCommandCompletions))).some((w) => w.key === "RE-A"), "...only in the Completed bucket");
  const reactivations = computeMentionReactivations(st.mentionEvents, st, st.attentionState);
  ok(group, !reactivations.has("RE-A"), "...and with no reactivation label");

  const recent = selectRecentMentions(st.mentionEvents, st.data.workItems, st.attentionState, nowMs, st);
  const bCard = recent.find((m) => m.issueKey === "RE-B");
  ok(group, bCard?.reactivation?.reason === "new-mention-after-completion" && bCard.reactivation.reactivatedAt === later, "ticket B (completed, new comment today) comes back in Recently Mentioned carrying reactivatedReason 'new-mention-after-completion' + reactivatedAt");
  ok(group, v226ActiveSurfaces(store, "RE-B", nowMs).length === 0, "...and never as plain new/active work anywhere (it stays out of My Assigned Work active, Focus, Action Plan, Priorities)");
  ok(group, reactivations.get("RE-B")?.reason === "new-mention-after-completion", "the Completed bucket gets the same label for B");
  ok(group, recent.find((m) => m.issueKey === "RE-S")?.reactivation?.reason === "new-mention-after-skip", "a skipped ticket with a new comment: 'new-mention-after-skip'");
  ok(group, recent.find((m) => m.issueKey === "RE-K")?.reactivation?.reason === "new-mention-after-block", "a blocked ticket with a new comment: 'new-mention-after-block'");
  ok(group, !recent.some((m) => m.issueKey === "RE-A") && !recent.some((m) => m.issueKey === "RE-C"), "tickets with no new mention don't appear in Recently Mentioned at all");

  // An OLD mention (before the record) stays suppressed and unlabeled.
  const before = new Date(Date.parse(st.dailyCommandBlocks["RE-K"].blockedAt) - 60_000).toISOString();
  const oldOnly = selectRecentMentions([{ ...mention("RE-K"), mentionedAt: before }], st.data.workItems, {}, nowMs, st);
  ok(group, oldOnly.length === 0, "a mention from BEFORE the block stays suppressed (blocks now follow the same rule as completions/skips)");

  // Badge: clearly different from a plain "New"/first-seen badge.
  const badge = renderToStaticMarkup(React.createElement(ReactivatedBadge, { reactivation: bCard!.reactivation! }));
  const newBadge = renderToStaticMarkup(React.createElement(FirstSeenBadge, { firstSeenAt: new Date().toISOString() }));
  ok(group, badge.includes("↺ Reactivated — new comment after you marked this done"), "the badge reads '↺ Reactivated — new comment after you marked this done'");
  ok(group, /text-orange/.test(badge) && /text-accent2/.test(newBadge) && !/text-orange/.test(newBadge), "...in a different color (orange) from the 'new today' badge (accent)");
  const bRow = renderToStaticMarkup(React.createElement(TaskReferenceRowView, { ticketKey: "RE-B", execution: resolveTaskExecutionState("RE-B", st), reactivation: reactivations.get("RE-B") }));
  ok(group, bRow.includes('data-reactivated="new-mention-after-completion"') && bRow.includes('data-task-state="completed"'), "a history row renders the reactivation badge while staying in its Completed state");

  // Reassignment audit (assignment-detection.ts): completed, reassigned away, then back to me.
  setJira(items.map((w) => (w.key === "RE-A" ? { ...w, owner: "Other", ownerId: "acc-other" } : w)));
  await store.syncJira();
  setJira(items);
  await store.syncJira();
  const reassignView = buildProjectOverrideView(store.getSnapshot(), getTodayIso(), "V226");
  const reassigned = reassignView.proactive?.attentionQueue.find((i) => i.category === "ASSIGNMENT" && i.ticketKey === "RE-A");
  ok(group, reassigned?.reactivation?.reason === "reassigned-after-completion", "a completed ticket reassigned back to me surfaces in the Attention Queue labeled 'reassigned-after-completion', not as a brand-new assignment");
  ok(group, reassigned?.reactivation?.reactivatedAt === undefined, "no reassignment timestamp is invented (detection only knows it changed between two snapshots)");
  const fresh = detectNewAssignments({ ...emptyData(), workItems: [v226JiraItem("NEW-1")] }, toSnapshot({ ...emptyData(), workItems: [v226JiraItem("NEW-1", { ownerId: "acc-other" })] }, "2026-09-25"), "acc-tay", new Set(["jira-RE-A"]));
  ok(group, fresh.length === 1 && fresh[0].reactivation === undefined, "a genuinely new assignment (never completed) carries no reactivation label");
}



// ===== V2.26 Phần 5 — Jira link + Complete/Skip/Block, consistent on every page that
// references a concrete work item (rendered through the shared TaskReferenceRow) =====
{
  const group = "V2.26 TaskReferenceRow everywhere";
  const ticket = v226JiraItem("PAGE-42", { title: "Checkout totals wrong" });
  const href = 'href="https://jira.example.com/browse/PAGE-42"';
  const html = (el: React.ReactElement) => renderToStaticMarkup(el);
  const hasRow = (markup: string) => markup.includes(href) && markup.includes('data-task-row="PAGE-42"') && markup.includes(">Done<") && markup.includes("Skip…") && markup.includes("Block…");

  const planHtml = html(React.createElement(PlanCandidateRow, { candidate: { id: "plan-x", title: "PAGE-42 — Checkout totals wrong", estimateMinutes: 15, priorityScore: 70, reason: "Overdue", item: ticket } }));
  ok(group, planHtml.includes(href) && planHtml.includes('data-task-row="PAGE-42"') && ["Mark ticket done", "Skip ticket…", "Block ticket…", "Defer ticket…", "Start ticket"].every((l) => planHtml.includes(`>${l}<`)), "Action Plan: a ticket-backed candidate renders TaskReferenceRow with the ticket's Jira URL and 'Mark ticket done / Skip ticket… / Block ticket… / Defer ticket… / Start ticket'");
  ok(group, ["Complete action", "Defer action", "Snooze action", "Mark action blocked"].every((l) => planHtml.includes(`>${l}<`)), "Action Plan: the action-level cluster is labeled '… action', so the two clusters are never confusable");
  ok(group, !/>Mark completed<|>Complete<|>Mark blocked<|>Block…</.test(planHtml), "Action Plan: no unqualified 'Complete'/'Mark completed'/'Mark blocked'/'Block…' label remains on the card");
  ok(group, hasRow(html(React.createElement(TaskReferenceRowView, { ticketKey: "PAGE-42", url: "https://jira.example.com/browse/PAGE-42", execution: { kind: "active" }, actions: { onComplete() {}, onSkip() {}, onBlock() {}, onReopen() {}, onReactivateSkip() {}, onUnblock() {} } }))), "other pages keep the plain labels (Done / Skip… / Block…) — ticketScoped is opt-in");
  const actionOnly = html(React.createElement(PlanCandidateRow, { candidate: { id: "a-1", title: "Call the vendor", estimateMinutes: 15, priorityScore: 55, reason: "Follow-up" } }));
  ok(group, actionOnly.includes("Call the vendor") && !actionOnly.includes("data-task-row"), "Action Plan: a candidate with no ticket keeps its plain title — no invented ticket row");

  const risk = { id: "r-1", projectId: "p-1", title: "Release at risk", level: "HIGH", reason: "Blocked P1", evidence: [], potentialImpact: "Slip", mitigation: "Escalate", status: "open", confidence: 0.8, detectedAt: TODAY, sourceWorkItemIds: [ticket.id], auto: true } as Risk;
  ok(group, hasRow(html(React.createElement(RiskCard, { risk, isDemo: false, relatedWorkItems: workItemsForIds([ticket], risk.sourceWorkItemIds) }))), "Risks: RiskCard renders each source work item as a TaskReferenceRow linking to Jira");

  const decision = { ...buildDemoData(TODAY).current.decisions[0], relatedWorkItemIds: [ticket.id] } as Decision;
  const decisionHtml = html(React.createElement(DecisionCard, { decision, relatedWorkItems: workItemsForIds([ticket], decision.relatedWorkItemIds) }));
  ok(group, hasRow(decisionHtml) && !decisionHtml.includes("Related items: 1"), "Decisions: DecisionCard lists the related ticket (with link) instead of only a bare count");

  const change = { id: "ch-1", entityType: "WorkItem", entityId: ticket.id, entityLabel: ticket.title, field: "status", before: "In Progress", after: "Blocked", detectedAt: TODAY, impact: "Now blocked" } as const;
  ok(group, hasRow(html(React.createElement(ChangeItem, { change, workItem: workItemsForIds([ticket], [change.entityId])[0] }))), "Changes: a WorkItem change renders its ticket as a TaskReferenceRow");
  ok(group, !html(React.createElement(ChangeItem, { change: { ...change, entityType: "Risk" as const, entityId: "r-1" } })).includes("data-task-row"), "Changes: a non-WorkItem change gets no ticket row");

  const deps = [{ id: "dep-1", workItemId: ticket.id }];
  const depItem = makeDependencyRadarItem({ dependencyId: "dep-1", description: "API contract", dependsOnTeam: "Payments" });
  ok(group, hasRow(html(React.createElement(DependencyRadarCard, { item: depItem, relatedWorkItems: workItemsForIds([ticket], [workItemIdForDependency("dep-1", deps)]) }))), "Dependencies: the Dependency Radar card renders the blocked ticket (via Dependency.workItemId) as a TaskReferenceRow");

  const loop = { id: "loop-1", issue: "Totals bug", decision: { id: decision.id, title: decision.title, status: "Decided" }, action: undefined, health: "STALLED", why: "No action", nowWhat: "Create one" } as unknown as DeliveryLoop;
  const loopIds = relatedWorkItemIdsForLoop(loop, { decisions: [decision], actions: [] });
  ok(group, loopIds.length === 1 && loopIds[0] === ticket.id, "Loops: a loop's tickets resolve through its Decision's explicit relatedWorkItemIds");
  ok(group, hasRow(html(React.createElement(DeliveryLoopCard, { loop, relatedWorkItems: workItemsForIds([ticket], loopIds) }))), "Loops: DeliveryLoopCard renders the resolved ticket as a TaskReferenceRow");
  ok(group, relatedWorkItemIdsForLoop({ ...loop, decision: undefined, action: undefined }, { decisions: [], actions: [] }).length === 0, "Loops: a loop with no decision/action links has no ticket — never guessed");
  ok(group, workItemsForIds([ticket], ["missing", ticket.id, ticket.id]).length === 1, "resolution drops unknown ids and dedupes — never fabricates a ticket");

  // Each page actually wires the resolved tickets into its card (not just the card supporting it).
  const pageSrc = (p: string) => fs.readFileSync(path.join(process.cwd(), "src/app", p, "page.tsx"), "utf8");
  ok(group, /<PlanCandidateRow\b/.test(pageSrc("action-plan")), "action-plan/page.tsx renders PlanCandidateRow");
  ok(group, /relatedWorkItems=\{workItemsForIds\(filteredData\.workItems, r\.sourceWorkItemIds\)\}/.test(pageSrc("risks")), "risks/page.tsx passes each risk's resolved source tickets");
  ok(group, (pageSrc("decisions").match(/relatedWorkItems=\{workItemsForIds\(filteredData\.workItems, d\.relatedWorkItemIds\)\}/g) ?? []).length === 2, "decisions/page.tsx passes resolved tickets to BOTH DecisionCard usages");
  ok(group, /workItem=\{c\.entityType === "WorkItem"/.test(pageSrc("changes")), "changes/page.tsx passes the resolved ticket for WorkItem changes");
  ok(group, /workItemIdForDependency\(d\.dependencyId/.test(pageSrc("dependencies")), "dependencies/page.tsx resolves each radar item's blocked ticket");
  ok(group, /relatedWorkItemIdsForLoop\(loop, filteredData\)/.test(pageSrc("loops")), "loops/page.tsx resolves each loop's tickets");
}



// ===== V2.26 Phần 6 — Daily Review, replaying the real multi-sync working loop =====
{
  const group = "V2.26 Daily Review scenario";
  const { store, setJira } = v226ConfiguredStore();
  const tay = { accountId: "acc-tay", displayName: "Tay" };
  const review = (lastVisitAt?: string) => {
    const st = store.getSnapshot();
    const view = buildProjectOverrideView(st, getTodayIso(), "V226");
    return buildDailyReview({
      workItems: view.filteredData.workItems,
      identity: tay,
      workRelevanceIndex: view.workRelevanceIndex,
      dailyCommandCompletions: st.dailyCommandCompletions,
      dailyCommandSkips: st.dailyCommandSkips,
      dailyCommandBlocks: st.dailyCommandBlocks,
      memoryEvents: st.memoryEvents,
      mentionEvents: st.mentionEvents,
      attentionState: st.attentionState,
      syncLog: st.syncLog,
      lastVisitAt,
      now: new Date(),
    });
  };
  const keys = ["DR-1", "DR-2", "DR-3", "DR-4", "DR-5"];
  const day1 = keys.map((k) => v226Actionable(k));

  // Day 1: sync creates 5 tickets; the morning review lists all 5 as new.
  setJira(day1);
  await store.syncJira();
  const firstReview = review(store.getSnapshot().dailyReviewLastVisitAt);
  ok(group, firstReview.baseline.kind === "first-sync" && JSON.stringify(firstReview.newSinceLastVisit.map((w) => w.key).sort()) === JSON.stringify(keys), "day 1: with no previous visit and a single sync, all 5 tickets that sync created are 'New'");
  store.markDailyReviewVisited();
  await v226Tick();

  // During day 1: complete 2, skip 1, block 1.
  store.completeTicketInDailyCommand("DR-1");
  store.completeTicketInDailyCommand("DR-2");
  store.skipTicketInDailyCommand("DR-3", "Team is handling it");
  store.blockTicketInDailyCommand("DR-4", "Waiting for a reply");
  const recorded = structuredClone({ c: store.getSnapshot().dailyCommandCompletions, s: store.getSnapshot().dailyCommandSkips, b: store.getSnapshot().dailyCommandBlocks });
  await v226Tick();

  // Day 2: Jira hasn't changed at all.
  setJira(day1);
  await store.syncJira();
  const lastVisit = store.getSnapshot().dailyReviewLastVisitAt;
  const day2 = review(lastVisit);
  const nowMs = Date.now();
  const touched = ["DR-1", "DR-2", "DR-3", "DR-4"];
  ok(group, day2.baseline.kind === "last-visit" && day2.baseline.at === lastVisit, "day 2: 'New' is measured against the previous Daily Review visit");
  ok(group, day2.newSinceLastVisit.length === 0, "(a) nothing is 'New' on day 2 — Jira didn't change, and none of the 4 handled tickets comes back as new");
  const leaked = touched.flatMap((k) => v226ActiveSurfaces(store, k, nowMs).map((surface) => `${k}@${surface}`));
  ok(group, leaked.length === 0, `(a) none of the 4 handled tickets appears as active on any page${leaked.length ? ` — leaked: ${leaked.join(", ")}` : ""}`);
  ok(group, v226ActiveSurfaces(store, "DR-5", nowMs).length >= 3, "control: the untouched DR-5 is still active across the surfaces (so the empty result above is meaningful)");

  const st2 = store.getSnapshot();
  const completedKeys = day2.completedRecently.map((r) => r.ticketKey).sort();
  ok(group, JSON.stringify(completedKeys) === JSON.stringify(["DR-1", "DR-2"]) && day2.completedRecently.every((r) => r.sources.includes("daily-command") && r.at === recorded.c[r.ticketKey].completedAt), "(b) DR-1/DR-2 are in 'Completed recently' (source: Daily Command) with their original completedAt intact");
  ok(group, day2.skipped.length === 1 && day2.skipped[0].ticketKey === "DR-3" && day2.skipped[0].at === recorded.s["DR-3"].skippedAt && st2.dailyCommandSkips["DR-3"].reason === "Team is handling it", "(b) DR-3 is in 'Skipped' with its original reason + timestamp");
  ok(group, day2.blocked.length === 1 && day2.blocked[0].ticketKey === "DR-4" && day2.blocked[0].at === recorded.b["DR-4"].blockedAt && st2.dailyCommandBlocks["DR-4"].reason === "Waiting for a reply", "(b) DR-4 is in 'Blocked' with its original reason + timestamp");
  ok(group, JSON.stringify({ c: st2.dailyCommandCompletions, s: st2.dailyCommandSkips, b: st2.dailyCommandBlocks }) === JSON.stringify(recorded), "(b) the day-2 sync left every Daily Command record byte-for-byte untouched");
  const skippedRow = renderToStaticMarkup(React.createElement(TaskReferenceRowView, { ticketKey: "DR-3", url: "https://jira.example.com/browse/DR-3", execution: resolveTaskExecutionState("DR-3", st2) }));
  ok(group, skippedRow.includes("Skipped today — Team is handling it · since today"), "(b) the Skipped row renders its age, recorded reason and time");

  // A new mention lands on the skipped ticket.
  store.markDailyReviewVisited();
  await v226Tick();
  const mentionAt = new Date(Date.now() + 60_000).toISOString();
  setJira(day1, [{ issueKey: "DR-3", commentId: "c-dr3", commentAuthor: "Anna", excerpt: "can you take this back?", mentionedAt: mentionAt }]);
  await store.syncJira();
  const day2b = review(store.getSnapshot().dailyReviewLastVisitAt);
  ok(group, day2b.skipped[0]?.ticketKey === "DR-3" && day2b.skipped[0].reactivation?.reason === "new-mention-after-skip", "after a new mention, the skipped ticket comes back labeled 'new-mention-after-skip' in the Skipped block");
  ok(group, !day2b.newSinceLastVisit.some((w) => w.key === "DR-3"), "...and is NOT mixed into 'New'");
  const recentDr3 = selectRecentMentions(store.getSnapshot().mentionEvents, store.getSnapshot().data.workItems, store.getSnapshot().attentionState, Date.now() + 120_000, store.getSnapshot()).find((m) => m.issueKey === "DR-3");
  ok(group, recentDr3?.reactivation?.reason === "new-mention-after-skip", "...and Recently Mentioned shows it with the same reactivation label, not as a plain new mention");

  // Control for 'New': a genuinely new ticket on day 3 IS listed.
  store.markDailyReviewVisited();
  await v226Tick();
  setJira([...day1, v226Actionable("DR-6")]);
  await store.syncJira();
  const day3 = review(store.getSnapshot().dailyReviewLastVisitAt);
  ok(group, day3.newSinceLastVisit.map((w) => w.key).join(",") === "DR-6", "control: a ticket first seen after the last visit (DR-6) is the one and only 'New' item");

  // Jira-side completion shows up with source "Jira".
  setJira([...day1, v226Actionable("DR-6", { status: "Done" })]);
  await store.syncJira();
  const day3b = review(store.getSnapshot().dailyReviewLastVisitAt);
  const dr6 = day3b.completedRecently.find((r) => r.ticketKey === "DR-6");
  ok(group, dr6?.sources.join(",") === "jira" && dr6.day === getTodayIso(), "a ticket closed directly in Jira appears in 'Completed recently' with source Jira (from the JIRA_STATUS_COMPLETED memory event)");

  // Boundary: "new" is strictly after the baseline. A ticket stamped at exactly the previous
  // sync's completedAt (which is how store.ts stamps it) or at exactly the last visit is not new.
  const stNow = store.getSnapshot();
  const prevSyncEntry = stNow.syncLog[stNow.syncLog.length - 2];
  const firstSeenOfDr1 = stNow.data.workItems.find((w) => w.key === "DR-1")!.firstSeenAt!;
  const noVisit = buildDailyReview({ ...review(undefined), workItems: stNow.data.workItems, identity: tay, dailyCommandCompletions: {}, dailyCommandSkips: {}, dailyCommandBlocks: {}, memoryEvents: [], mentionEvents: [], syncLog: [{ ...prevSyncEntry, completedAt: firstSeenOfDr1 }, stNow.syncLog[stNow.syncLog.length - 1]], now: new Date() });
  ok(group, noVisit.baseline.kind === "previous-sync" && !noVisit.newSinceLastVisit.some((w) => w.key === "DR-1"), "boundary: a ticket whose firstSeenAt equals the previous sync's completedAt is NOT new (strictly-after comparison)");
  const sameInstant = buildDailyReview({ ...noVisit, workItems: stNow.data.workItems, identity: tay, dailyCommandCompletions: {}, dailyCommandSkips: {}, dailyCommandBlocks: {}, memoryEvents: [], mentionEvents: [], syncLog: stNow.syncLog, lastVisitAt: firstSeenOfDr1, now: new Date() } as never);
  ok(group, !sameInstant.newSinceLastVisit.some((w) => w.key === "DR-1"), "boundary: a ticket first seen at exactly the last-visit instant is NOT new");

  // Daily Review moved into My Work (New view + its Blocked/Skipped/Done views); /daily-review
  // redirects there.
  const reviewPageSrc = fs.readFileSync(path.join(process.cwd(), "src/components/command-center/use-my-work.ts"), "utf8") + fs.readFileSync(path.join(process.cwd(), "src/app/my-work/page.tsx"), "utf8");
  const navSrc = fs.readFileSync(path.join(process.cwd(), "src/components/command-center/Nav.tsx"), "utf8");
  ok(group, /href: "\/my-work"/.test(navSrc) && /buildDailyReview/.test(reviewPageSrc) && (reviewPageSrc.match(/<TaskRow\b/g) ?? []).length >= 2 && /redirect\(DAILY_REVIEW_REDIRECT\)/.test(fs.readFileSync(path.join(process.cwd(), "src/app/daily-review/page.tsx"), "utf8")), "Daily Review lives in My Work (in the nav), uses buildDailyReview, renders every row through TaskRow, and /daily-review redirects there");
  // A3 — superseded: the page no longer records a visit at all (a refresh emptied "New");
  // see the "A3 Daily Review New" group for the explicit-acknowledgment replacement.
  ok(group, !/store\.markDailyReviewVisited\(\)/.test(reviewPageSrc) && /baselineAt: state\.dailyReviewBaselineAt/.test(reviewPageSrc), "the page passes the pinned baseline and never records a visit on mount");
}
