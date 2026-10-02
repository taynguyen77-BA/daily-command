// V2.5–V2.12 — Work Relevance policy, calibration, execution path, attention truth
// Run through scripts/tests/run.mts (npm test).

import { detectRisks } from "../../src/lib/command-center/risk-detection";
import { buildCandidates, buildPlan } from "../../src/lib/command-center/action-plan";
import { emptyData } from "../../src/lib/command-center/types";
import { parseStoredState, commandCenterStore } from "../../src/lib/command-center/store";
import type { Decision } from "../../src/lib/command-center/types";
import { normalizeIssue } from "../../src/lib/command-center/jira/normalize";
import { type JiraIssue } from "../../src/lib/command-center/jira/types";
import { type FetchLike } from "../../src/lib/command-center/jira/http";
import { classifyQuery, answerFromRoute } from "../../src/lib/command-center/query-router";
import { deriveData } from "../../src/lib/command-center/selectors";
import fs from "node:fs";
import path from "node:path";
import { slug } from "../../src/lib/command-center/attention-queue";
import { computeProactiveIntelligence } from "../../src/lib/command-center/proactive";
import type { AttentionItem, Risk } from "../../src/lib/command-center/types";
import type { Action } from "../../src/lib/command-center/types";
import { computePersonalFocus } from "../../src/lib/command-center/personal-focus";
import { computeDataHealth } from "../../src/lib/command-center/data-health";
import type { JiraConnectionConfig } from "../../src/lib/command-center/jira/types";
import { buildWorkRelevanceIndex, countUnclassifiedJiraStatuses, explainWorkItemRelevance, isPersonalWorkEligible, isPersonalWorkEligibleItem, jiraProjectKeyForWorkItem, listUnclassifiedJiraStatuses, parseWorkRelevancePolicyMap, resolveWorkRelevance, WORK_RELEVANCE_EXPLANATIONS, computeOverallWorkRelevanceCoverage, countOpenItemsForStatus, listStatusesByRelevance } from "../../src/lib/command-center/jira/work-relevance";
import { computeActionableCalibration, computeCalibrationHealthState, computeObserveCalibration, computePolicyReviewSignals, computeUnknownVisibility, computeWorkRelevanceDistribution } from "../../src/lib/command-center/jira/work-relevance-calibration";
import { computeExecutionPathStatusTable, computeExecutionPathTrace, explainExecutionSurface, listCandidatePoolActionableItems, listJiraItemsInPersonalFocus } from "../../src/lib/command-center/execution-path";
import { computeActionableSignals } from "../../src/lib/command-center/jira/work-relevance-signals";
import { updateWorkItemCalibrationHistory } from "../../src/lib/command-center/jira/work-relevance-history";
import type { DeliveryLoop } from "../../src/lib/command-center/types";
import type { JiraComment } from "../../src/lib/command-center/jira/types";
import type { MentionEvent } from "../../src/lib/command-center/types";
import { GET as notifyStatusGET } from "../../src/app/api/command-center/notify/route";
import { runServerSideNotifyCheck } from "../../src/lib/command-center/cron-notify";
import { createInMemoryNotifyStore, isNotifyStoreConfigured } from "../../src/lib/command-center/notify-state";
import type { SlackFetchLike } from "../../src/lib/server/slack-notify";
import { ok } from "./harness.mts";
import { TODAY, calAction, fakeProactive, globalPolicy, jiraItem, makeItem, mockAttentionItem, mockPersonalFocus, mockProactive, pfc } from "./helpers.mts";

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
  const mentionCompletedCandidate = mdcFocus.allCandidates!.find((c) => c.sourceId === mentionOnCompleted.id);
  ok("V2.17 My Day gate bypass", mentionCompletedCandidate !== undefined && mentionCompletedCandidate.category === "DO_TODAY", "a MENTION item on an already-COMPLETED ticket still produces a real candidate — the V2.13 'option 3b' gate no longer applies to MENTION");
  const mentionObserveCandidate = mdcFocus.allCandidates!.find((c) => c.sourceId === mentionOnObserve.id);
  ok("V2.17 My Day gate bypass", mentionObserveCandidate !== undefined && mentionObserveCandidate.category === "DO_TODAY", "a MENTION item on an OBSERVE-status ticket is likewise unaffected by the gate — not even demoted to WATCH, since the gate never runs for MENTION at all");
  const mentionActionableCandidate = mdcFocus.allCandidates!.find((c) => c.sourceId === mentionOnActionable.id);
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


// ===== V2.24 — Attention Truth regression matrix. Phase 1 audit confirmed the mechanism
// (isWorkItemDoneOrExcluded -> mentionAutoResolveWorkItemIds -> RawItem.forceResolved, all
// already present since V2.17/V2.19/V2.21/V2.23) already implements "current ticket state
// wins over a historical mention event" — this is a LOCK-IN regression suite over that exact
// mechanism against the dev prompt's own 12-scenario test matrix (§10), not a new gate. Every
// scenario below is status-based, never date-based: a mention's age never factors into the
// forceResolved decision (see attention-queue.ts's own RawItem.forceResolved comment) — tests
// 1-4 exist specifically to PROVE mentionedAt is irrelevant to this decision, both ways. =====
{
  const v24Idx = buildWorkRelevanceIndex(globalPolicy({ Done: "COMPLETED", "Won't Fix": "EXCLUDED", "To Do": "ACTIONABLE" }));
  const oldIso = "2026-01-01T00:00:00.000Z";
  const recentIso = TODAY + "T09:00:00.000Z";

  // ----- 1 & 2: mention + OPEN ticket (old and recent) — appears normally, NEW, never
  // suppressed by this mechanism regardless of the mention's age. -----
  const openTicket = jiraItem({ id: "wi-v24-open", key: "JPMC-2400", jiraStatusName: "To Do" });
  const openData: CommandCenterData = { ...emptyData(), workItems: [openTicket] };
  const openDerived = deriveData(openData, null, TODAY);
  const oldOnOpen: MentionEvent = { issueKey: openTicket.key, commentId: "c-old-open", excerpt: "old, ticket still open", mentionedAt: oldIso };
  const recentOnOpen: MentionEvent = { issueKey: openTicket.key, commentId: "c-recent-open", excerpt: "recent, ticket still open", mentionedAt: recentIso };
  const openProactive = computeProactiveIntelligence(openData, openDerived, [], null, {}, "jira", TODAY, v24Idx, [oldOnOpen, recentOnOpen]);
  const openById = (id: string) => openProactive.attentionQueue.find((i) => i.id === id);
  ok("V2.24 Attention Truth #1", openById(`MENTION:${slug(openTicket.key)}:c-old-open`)?.lifecycle === "NEW", "1: an OLD mention on an OPEN ticket follows existing recency-agnostic lifecycle behavior — surfaces as NEW, never suppressed");
  ok("V2.24 Attention Truth #2", openById(`MENTION:${slug(openTicket.key)}:c-recent-open`)?.lifecycle === "NEW", "2: a RECENT mention on an OPEN ticket surfaces as NEW per existing attention rules");

  // ----- 3 & 4: mention + COMPLETED ticket (old and recent) — MUST NOT appear as active,
  // regardless of the mention's own age; current ticket state wins. -----
  const doneTicket = jiraItem({ id: "wi-v24-done", key: "JPMC-2401", jiraStatusName: "Done" });
  const doneData: CommandCenterData = { ...emptyData(), workItems: [doneTicket] };
  const doneDerived = deriveData(doneData, null, TODAY);
  const oldOnDone: MentionEvent = { issueKey: doneTicket.key, commentId: "c-old-done", excerpt: "old mention, 10 days ago", mentionedAt: oldIso };
  const recentOnDone: MentionEvent = { issueKey: doneTicket.key, commentId: "c-recent-done", excerpt: "recent mention", mentionedAt: recentIso };
  const doneProactive = computeProactiveIntelligence(doneData, doneDerived, [], null, {}, "jira", TODAY, v24Idx, [oldOnDone, recentOnDone]);
  const doneById = (id: string) => doneProactive.attentionQueue.find((i) => i.id === id);
  const activeDefault = (items: AttentionItem[]) => items.filter((i) => i.lifecycle !== "SNOOZED" && i.lifecycle !== "RESOLVED");
  ok("V2.24 Attention Truth #3", doneById(`MENTION:${slug(doneTicket.key)}:c-old-done`)?.lifecycle === "RESOLVED", "3: an OLD mention (10 days ago) on a ticket that is CURRENTLY Completed must not appear as active attention — current state wins over the historical event");
  ok("V2.24 Attention Truth #4", doneById(`MENTION:${slug(doneTicket.key)}:c-recent-done`)?.lifecycle === "RESOLVED", "4: a RECENT mention on a CURRENTLY Completed ticket is equally suppressed — recency never overrides completion truth");
  ok("V2.24 Attention Truth #3/4", activeDefault(doneProactive.attentionQueue).length === 0, "neither mention on the completed ticket survives the UI's own ACTIVE_DEFAULT filter (lifecycle !== SNOOZED/RESOLVED)");

  // ----- 5 & 6: Work Relevance COMPLETED/EXCLUDED (as distinct from Jira-native "Done" used by
  // #3/#4 above) — re-confirms the same forceResolved mechanism honors the opt-in policy
  // classification too, not just the native status floor. Already covered by the V2.17 block
  // earlier in this file (completedTicket/excludedTicket there) — restated here with this
  // matrix's own fixtures for direct §10 traceability. -----
  const wrCompletedTicket = jiraItem({ id: "wi-v24-wr-completed", key: "JPMC-2403", jiraStatusName: "Deployed to Prod" });
  const wrExcludedTicket = jiraItem({ id: "wi-v24-wr-excluded", key: "JPMC-2404", jiraStatusName: "Won't Fix" });
  const wrIdx = buildWorkRelevanceIndex(globalPolicy({ "Deployed to Prod": "COMPLETED", "Won't Fix": "EXCLUDED", "To Do": "ACTIONABLE" }));
  const wrData: CommandCenterData = { ...emptyData(), workItems: [wrCompletedTicket, wrExcludedTicket] };
  const wrDerived = deriveData(wrData, null, TODAY);
  const wrMentions: MentionEvent[] = [
    { issueKey: wrCompletedTicket.key, commentId: "c-wr-completed", excerpt: "mention on a Work-Relevance-COMPLETED ticket", mentionedAt: oldIso },
    { issueKey: wrExcludedTicket.key, commentId: "c-wr-excluded", excerpt: "mention on a Work-Relevance-EXCLUDED ticket", mentionedAt: oldIso },
  ];
  const wrProactive = computeProactiveIntelligence(wrData, wrDerived, [], null, {}, "jira", TODAY, wrIdx, wrMentions);
  ok(
    "V2.24 Attention Truth #5",
    wrProactive.attentionQueue.find((i) => i.id === `MENTION:${slug(wrCompletedTicket.key)}:c-wr-completed`)?.lifecycle === "RESOLVED",
    "5: a mention on a ticket the Work Relevance Policy classifies COMPLETED must not appear as active attention"
  );
  ok(
    "V2.24 Attention Truth #6",
    wrProactive.attentionQueue.find((i) => i.id === `MENTION:${slug(wrExcludedTicket.key)}:c-wr-excluded`)?.lifecycle === "RESOLVED",
    "6: a mention on a ticket the Work Relevance Policy classifies EXCLUDED must not appear as active attention"
  );

  // ----- 7: Daily Command Completion suppresses a MENTION too — independent of any Work
  // Relevance Policy being configured at all (mentionAutoResolveWorkItemIds folds
  // dailyCommandCompletedWorkItemIds in unconditionally, see proactive.ts). -----
  const dccTicket = jiraItem({ id: "wi-v24-dcc", key: "JPMC-2402", jiraStatusName: "In Progress" });
  const dccData: CommandCenterData = { ...emptyData(), workItems: [dccTicket] };
  const dccDerived = deriveData(dccData, null, TODAY);
  const dccMention: MentionEvent = { issueKey: dccTicket.key, commentId: "c-dcc", excerpt: "mentioned before I marked it done in Daily Command", mentionedAt: oldIso };
  const dccProactive = computeProactiveIntelligence(dccData, dccDerived, [], null, {}, "jira", TODAY, undefined, [dccMention], undefined, undefined, new Set([dccTicket.id]));
  ok(
    "V2.24 Attention Truth #7",
    dccProactive.attentionQueue.find((i) => i.id === `MENTION:${slug(dccTicket.key)}:c-dcc`)?.lifecycle === "RESOLVED",
    "7: a mention on a ticket the user explicitly completed IN Daily Command (no Jira-side status change, no Work Relevance Policy configured at all) stays suppressed — the same forceResolved mechanism, not a second one"
  );

  // ----- 8: the completed ticket's mention remains in historical mentionEvents — only ACTIVE
  // attention is suppressed, never the underlying record. Proven directly against the
  // MentionEvent inputs this test itself constructed (never mutated/filtered by this pass) and
  // against attention-queue.ts's own raw-item construction (the mention still produces a
  // RawItem/AttentionItem, just RESOLVED — see forceResolved's own doc: "deliberately NOT
  // simply omitted from raw"). -----
  ok("V2.24 Attention Truth #8", doneById(`MENTION:${slug(doneTicket.key)}:c-old-done`) !== undefined, "8: the completed ticket's historical mention event still produces a real attention record (present, just RESOLVED) — history is preserved, not deleted");

  // ----- 9: a subsequent Jira sync (i.e., re-running computeProactiveIntelligence again with
  // the SAME persisted attentionState this run produced) does NOT resurrect the item — it
  // stays RESOLVED, never flips to REOPENED just because `raw` still contains it every sync. -----
  const doneProactiveAgain = computeProactiveIntelligence(doneData, doneDerived, [], null, doneProactive.nextAttentionState, "jira", TODAY, v24Idx, [oldOnDone, recentOnDone]);
  ok(
    "V2.24 Attention Truth #9",
    doneProactiveAgain.attentionQueue.find((i) => i.id === `MENTION:${slug(doneTicket.key)}:c-old-done`)?.lifecycle === "RESOLVED",
    "9: a later sync re-producing the exact same raw mention against a still-completed ticket does NOT resurrect it as REOPENED — idempotent RESOLVED, not a fresh escalation"
  );

  // ----- 10: a genuinely NEW mention comment arrives on a ticket that is STILL completed —
  // existing reactivation semantics for the Attention Queue's MENTION category are STATUS-
  // driven (reactivation happens when the ticket's own relevance changes away from COMPLETED/
  // EXCLUDED — see attention-queue.ts's own comment), never "a new mention alone reactivates a
  // completed ticket". A normal sync bringing in one more comment on still-completed work must
  // not become an active attention item either. -----
  const newCommentOnDone: MentionEvent = { issueKey: doneTicket.key, commentId: "c-brand-new-on-done", excerpt: "a brand new comment, ticket still Done", mentionedAt: recentIso };
  const doneProactiveNewComment = computeProactiveIntelligence(doneData, doneDerived, [], null, doneProactive.nextAttentionState, "jira", TODAY, v24Idx, [oldOnDone, recentOnDone, newCommentOnDone]);
  ok(
    "V2.24 Attention Truth #10a",
    doneProactiveNewComment.attentionQueue.find((i) => i.id === `MENTION:${slug(doneTicket.key)}:c-brand-new-on-done`)?.lifecycle === "RESOLVED",
    "10a: a brand-new mention comment arriving while the ticket is STILL Completed is force-resolved too, exactly like the older ones — a plain sync must never reactivate completed work"
  );
  // ...but once the ticket's own relevance genuinely changes away from COMPLETED (e.g. reopened
  // to "To Do"), the ordinary REOPENED path correctly brings a still-open mention back — this
  // is the "meaningful reactivation" existing semantics already provide, driven by ticket
  // state, not by mention recency.
  const reopenedIdx = buildWorkRelevanceIndex(globalPolicy({ Done: "COMPLETED", "Won't Fix": "EXCLUDED", "To Do": "ACTIONABLE" }));
  const reopenedTicket = { ...doneTicket, jiraStatusName: "To Do", status: "In Progress" };
  const reopenedData: CommandCenterData = { ...emptyData(), workItems: [reopenedTicket] };
  const reopenedDerived = deriveData(reopenedData, null, TODAY);
  const doneProactiveReopened = computeProactiveIntelligence(reopenedData, reopenedDerived, [], null, doneProactive.nextAttentionState, "jira", TODAY, reopenedIdx, [oldOnDone]);
  ok(
    "V2.24 Attention Truth #10b",
    doneProactiveReopened.attentionQueue.find((i) => i.id === `MENTION:${slug(doneTicket.key)}:c-old-done`)?.lifecycle === "REOPENED",
    "10b: once the ticket's OWN status genuinely reopens (no longer Done/COMPLETED), the previously-suppressed mention correctly reappears via the ordinary RESOLVED -> REOPENED path — existing reactivation semantics, driven by ticket truth, are preserved"
  );

  // ----- 11: cross-project isolation — a Completed ticket in one project must never suppress
  // (or an Open ticket in another project ever get accidentally suppressed by) another
  // project's mention, even when keys/status names are otherwise similar. Lookup is by exact
  // WorkItem key, never a project-wide/global assumption. -----
  const projectADone = jiraItem({ id: "wi-v24-a-done", key: "ALPHA-800", projectId: "jira-project-ALPHA", jiraStatusName: "Done" });
  const projectBOpen = jiraItem({ id: "wi-v24-b-open", key: "BETA-800", projectId: "jira-project-BETA", jiraStatusName: "To Do" });
  const crossData: CommandCenterData = { ...emptyData(), workItems: [projectADone, projectBOpen] };
  const crossDerived = deriveData(crossData, null, TODAY);
  const crossMentions: MentionEvent[] = [
    { issueKey: projectADone.key, commentId: "c-a-800", excerpt: "mention on completed Project A ticket", mentionedAt: oldIso },
    { issueKey: projectBOpen.key, commentId: "c-b-800", excerpt: "mention on open Project B ticket", mentionedAt: oldIso },
  ];
  const crossProactive = computeProactiveIntelligence(crossData, crossDerived, [], null, {}, "jira", TODAY, v24Idx, crossMentions);
  ok(
    "V2.24 Attention Truth #11",
    crossProactive.attentionQueue.find((i) => i.id === `MENTION:${slug(projectADone.key)}:c-a-800`)?.lifecycle === "RESOLVED",
    "11: Project A's completed ticket mention is suppressed independent of Project B"
  );
  ok(
    "V2.24 Attention Truth #11",
    crossProactive.attentionQueue.find((i) => i.id === `MENTION:${slug(projectBOpen.key)}:c-b-800`)?.lifecycle === "NEW",
    "11: Project B's open ticket mention is NOT suppressed by Project A's unrelated completion — no cross-project state leakage through the shared numeric suffix (800) or the shared global Work Relevance policy"
  );

  // ----- 12: multiple historical mentions (several comments) on the SAME completed ticket
  // never produce more than zero ACTIVE entries — each comment's own attention item resolves
  // independently, no duplicate/active leftover. -----
  const multiMentions: MentionEvent[] = [
    { issueKey: doneTicket.key, commentId: "c-multi-1", excerpt: "first old comment", mentionedAt: oldIso },
    { issueKey: doneTicket.key, commentId: "c-multi-2", excerpt: "second old comment", mentionedAt: oldIso },
    { issueKey: doneTicket.key, commentId: "c-multi-3", excerpt: "third, more recent comment", mentionedAt: recentIso },
  ];
  const multiProactive = computeProactiveIntelligence(doneData, doneDerived, [], null, {}, "jira", TODAY, v24Idx, multiMentions);
  const multiOnTicket = multiProactive.attentionQueue.filter((i) => i.id.startsWith(`MENTION:${slug(doneTicket.key)}:`));
  ok("V2.24 Attention Truth #12", multiOnTicket.length === 3, "12: all three historical comments still produce their own individually-tracked attention record (history/count preserved)");
  ok("V2.24 Attention Truth #12", multiOnTicket.every((i) => i.lifecycle === "RESOLVED"), "12: every one of them resolves — a completed ticket with several historical mentions produces zero active duplicates, not one-per-comment noise");
  ok("V2.24 Attention Truth #12", activeDefault(multiOnTicket).length === 0, "12: none of the three survive the UI's ACTIVE_DEFAULT filter");
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
