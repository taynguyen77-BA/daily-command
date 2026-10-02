// V2.3–V2.4 — Focus Project Scope, context & focus, daily report snapshots
// Run through scripts/tests/run.mts (npm test).

import { emptyData } from "../../src/lib/command-center/types";
import { parseStoredState, commandCenterStore, getTodayIso } from "../../src/lib/command-center/store";
import type { DailySnapshot } from "../../src/lib/command-center/types";
import { fetchJiraIssuesWith, fetchJiraProjectsWith, buildIssuesJql, JIRA_PROJECT_PAGE_SIZE, type FetchLike } from "../../src/lib/command-center/jira/http";
import { classifyQuery } from "../../src/lib/command-center/query-router";
import { deriveData } from "../../src/lib/command-center/selectors";
import fs from "node:fs";
import path from "node:path";
import { computeClientAttentionMap, computeProjectAttentionMap } from "../../src/lib/command-center/client-attention-map";
import { computeDataHealth } from "../../src/lib/command-center/data-health";
import type { JiraConnectionConfig } from "../../src/lib/command-center/jira/types";
import { JIRA_MAX_ISSUES } from "../../src/lib/command-center/jira/http";
import { computeTrustDiagnostic } from "../../src/lib/command-center/trust-diagnostic";
import { buildStakeholderUpdateDraft } from "../../src/lib/command-center/communicate";
import { applyProjectScope, DEFAULT_JIRA_PROJECT_SCOPE, detectExplicitProjectMention, findOutOfScopeMention, formatScopeLabel, knownJiraProjects, parseJiraProjectScope, resolveEffectiveProjectKeys, scopeMentionEvents } from "../../src/lib/command-center/jira/project-scope";
import { buildProjectOverrideView } from "../../src/components/command-center/use-command-center";
import type { JiraProjectScope } from "../../src/lib/command-center/types";
import { buildWorkRelevanceIndex } from "../../src/lib/command-center/jira/work-relevance";
import type { MentionEvent } from "../../src/lib/command-center/types";
import type { MemoryEvent, DailyReportSnapshot } from "../../src/lib/command-center/types";
import { summarizeDailyReport, dailyReportToMarkdown, buildWeeklyReportSummary, last7DaysEnding, weeklyReportToMarkdown } from "../../src/lib/command-center/daily-report";
import { detectJiraStatusCompletions } from "../../src/lib/command-center/jira-completion-detection";
import { ok } from "./harness.mts";
import { TODAY, globalPolicy, jiraItem, makeItem, makeJiraIssue, makeStoreState, makeThreeProjectFixture } from "./helpers.mts";

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

  // (AI context scope checks removed with ai-context.ts in C1 — AI prompts are built from the
  // same scope-filtered data every page uses.)
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


// ===== V2.25 Task 2 — Jira-side completion detection (jira-completion-detection.ts): pure
// diff-against-previous-snapshot, same pattern as detectNewAssignments. =====
{
  const openThenDone = jiraItem({ id: "v25-jc-1", key: "V25-JC-1", status: "In Progress", sourceType: "jira" });
  const prevSnapshotOpen: DailySnapshot = { date: "2026-06-14", workItems: [openThenDone], risks: [], requirements: [], dependencies: [], projects: [] };
  const nowDone = { ...openThenDone, status: "Done" as const };

  ok("V2.25 jira-completion-detection", detectJiraStatusCompletions({ ...emptyData(), workItems: [nowDone] }, prevSnapshotOpen, undefined).length === 1, "an item that transitioned open -> Done since the last snapshot is detected");
  ok("V2.25 jira-completion-detection", detectJiraStatusCompletions({ ...emptyData(), workItems: [openThenDone] }, prevSnapshotOpen, undefined).length === 0, "an item that hasn't changed status at all produces no completion event");
  ok("V2.25 jira-completion-detection", detectJiraStatusCompletions({ ...emptyData(), workItems: [nowDone] }, null, undefined).length === 0, "no previous snapshot (first-ever sync) means nothing can be honestly compared — never guesses a completion from a single observation");

  const alreadyDonePrev: DailySnapshot = { date: "2026-06-14", workItems: [{ ...openThenDone, status: "Done" as const }], risks: [], requirements: [], dependencies: [], projects: [] };
  ok("V2.25 jira-completion-detection", detectJiraStatusCompletions({ ...emptyData(), workItems: [nowDone] }, alreadyDonePrev, undefined).length === 0, "an item already Done as of the last snapshot is not reported again — only the transition itself counts");

  const localItem = { ...makeItem({ id: "v25-jc-2", key: "V25-JC-2", status: "In Progress" }), sourceType: "local-import" as const };
  const localPrev: DailySnapshot = { date: "2026-06-14", workItems: [localItem], risks: [], requirements: [], dependencies: [], projects: [] };
  ok("V2.25 jira-completion-detection", detectJiraStatusCompletions({ ...emptyData(), workItems: [{ ...localItem, status: "Done" }] }, localPrev, undefined).length === 0, "a non-Jira (local-import/demo) item's completion is never reported here — this is Jira-side detection only");

  // A policy-COMPLETED (but not native-Done) transition counts too — reuses isWorkItemDoneOrExcluded, not a second completion concept.
  const policyIdx = buildWorkRelevanceIndex(globalPolicy({ "Deployed to Prod": "COMPLETED", "To Do": "ACTIONABLE" }));
  const policyBefore = jiraItem({ id: "v25-jc-3", key: "V25-JC-3", status: "In Progress", jiraStatusName: "To Do" });
  const policyPrev: DailySnapshot = { date: "2026-06-14", workItems: [policyBefore], risks: [], requirements: [], dependencies: [], projects: [] };
  const policyAfter = { ...policyBefore, jiraStatusName: "Deployed to Prod" };
  ok("V2.25 jira-completion-detection", detectJiraStatusCompletions({ ...emptyData(), workItems: [policyAfter] }, policyPrev, policyIdx).length === 1, "a status transition into a policy-COMPLETED (but not native-Done) status is detected once the Work Relevance index is passed");
  ok("V2.25 jira-completion-detection", detectJiraStatusCompletions({ ...emptyData(), workItems: [policyAfter] }, policyPrev, undefined).length === 0, "omitting the index reproduces the old (native-Done-only) behavior — the same transition is not detected without it");
}


// ===== V2.25 Task 2 — daily-report.ts: "Completed via Daily Command" vs "Completed in Jira"
// label split, never blended into one undifferentiated list. =====
{
  const e = (overrides: Partial<MemoryEvent>): MemoryEvent => ({ id: `e-${Math.random()}`, date: "2026-06-10", kind: "ACTION_COMPLETED", title: "x", impact: "x", evidence: [], ...overrides });
  const snapshot: DailyReportSnapshot = {
    date: "2026-06-10",
    generatedAt: "2026-06-10T20:00:00.000Z",
    events: [
      e({ kind: "ACTION_COMPLETED", title: "Shipped via app", ticketKey: "JPMC-1" }),
      e({ kind: "JIRA_STATUS_COMPLETED", title: "Completed in Jira: Closed by QA", ticketKey: "JPMC-2" }),
    ],
  };
  const summary = summarizeDailyReport(snapshot);
  ok("V2.25 daily-report label split", summary.completedInApp.length === 1 && summary.completedInApp[0].ticketKey === "JPMC-1", "an ACTION_COMPLETED event is bucketed as completedInApp");
  ok("V2.25 daily-report label split", summary.completedInJira.length === 1 && summary.completedInJira[0].ticketKey === "JPMC-2", "a JIRA_STATUS_COMPLETED event is bucketed as completedInJira, never blended into completedInApp");
  ok("V2.25 daily-report label split", summary.completed.length === 2, "the combined `completed` total still includes both sources, for any caller that only needs a count");

  const markdown = dailyReportToMarkdown(snapshot);
  ok("V2.25 daily-report label split", markdown.includes("Completed via Daily Command") && markdown.includes("Completed in Jira"), "the markdown export labels the two sources separately, so a reader never mistakes one for the other");
  ok("V2.25 daily-report label split", markdown.indexOf("Shipped via app") < markdown.indexOf("Completed in Jira"), "the in-app section is listed before the Jira-detected section");

  const weeklyDailyReports: Record<string, DailyReportSnapshot> = { "2026-06-10": snapshot };
  const weekly = buildWeeklyReportSummary(["2026-06-10"], weeklyDailyReports);
  ok("V2.25 daily-report label split", weekly.totalCompletedInApp === 1 && weekly.totalCompletedInJira === 1, "the weekly rollup carries the same in-app/Jira split");
  const weeklyMarkdown = weeklyReportToMarkdown(weekly);
  ok("V2.25 daily-report label split", weeklyMarkdown.includes("1 via Daily Command") && weeklyMarkdown.includes("1 in Jira"), "the weekly markdown's Totals line breaks the Completed count down by source");
}


// ===== V2.25 Task 2 — end-to-end: a ticket closed directly in Jira between two syncs (no
// in-app action at all) is automatically reflected in that day's Daily Report, with no Close
// Day modal ever opened. =====
{
  commandCenterStore.resetAll();
  const originalFetch = globalThis.fetch;
  const todayForE2E = getTodayIso();

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    if (String(url).includes("/api/command-center/jira/sync")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: {
            clients: [],
            projects: [{ id: "jira-project-V25E2E", name: "V25 E2E Project", clientId: undefined, status: "on-track", sourceType: "jira", sourceId: "V25E2E" }],
            workItems: [{ ...makeItem({ id: "v25-e2e-wi", key: "V25E2E-1", projectId: "jira-project-V25E2E", status: "In Progress" }), sourceType: "jira", sourceId: "V25E2E-1" }],
            dependencies: [],
          },
          recordsFetched: 1,
          truncated: false,
          syncedAt: new Date().toISOString(),
          warnings: [],
        }),
      } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }) as typeof fetch;

  await commandCenterStore.syncJira(); // sync #1 — item is still open
  ok("V2.25 Daily Report e2e", commandCenterStore.getSnapshot().dailyReports[todayForE2E] !== undefined, "a Daily Report for today exists after the very first sync, with no Close Day modal ever opened");
  ok(
    "V2.25 Daily Report e2e",
    !commandCenterStore.getSnapshot().memoryEvents.some((ev) => ev.kind === "JIRA_STATUS_COMPLETED"),
    "sanity check — no completion is reported yet while the ticket is still open"
  );

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    if (String(url).includes("/api/command-center/jira/sync")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: {
            clients: [],
            projects: [{ id: "jira-project-V25E2E", name: "V25 E2E Project", clientId: undefined, status: "on-track", sourceType: "jira", sourceId: "V25E2E" }],
            workItems: [{ ...makeItem({ id: "v25-e2e-wi", key: "V25E2E-1", projectId: "jira-project-V25E2E", status: "Done" }), sourceType: "jira", sourceId: "V25E2E-1" }],
            dependencies: [],
          },
          recordsFetched: 1,
          truncated: false,
          syncedAt: new Date().toISOString(),
          warnings: [],
        }),
      } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }) as typeof fetch;

  await commandCenterStore.syncJira(); // sync #2 — the SAME ticket is now Done, no in-app action taken at all
  const afterSecondSync = commandCenterStore.getSnapshot();
  const jiraCompletionEvent = afterSecondSync.memoryEvents.find((ev) => ev.kind === "JIRA_STATUS_COMPLETED" && ev.ticketKey === "V25E2E-1");
  ok("V2.25 Daily Report e2e", !!jiraCompletionEvent, "the second sync's status transition (open -> Done) is detected and recorded as a JIRA_STATUS_COMPLETED memoryEvent, with no in-app action involved");
  ok("V2.25 Daily Report e2e", jiraCompletionEvent?.projectName === "V25 E2E Project", "the memory event captures real point-in-time project context, not a placeholder");

  const todaysReport = afterSecondSync.dailyReports[todayForE2E];
  ok("V2.25 Daily Report e2e", !!todaysReport, "today's Daily Report still exists after the second sync");
  ok(
    "V2.25 Daily Report e2e",
    todaysReport?.events.some((ev) => ev.kind === "JIRA_STATUS_COMPLETED" && ev.ticketKey === "V25E2E-1"),
    "the automatically-updated Daily Report lists the Jira-closed ticket under Completed — this is the whole point of Task 2: nobody opened Close Day, nobody clicked anything in this app"
  );
  const finalSummary = summarizeDailyReport(todaysReport!);
  ok("V2.25 Daily Report e2e", finalSummary.completedInJira.some((ev) => ev.ticketKey === "V25E2E-1"), "and it's correctly labeled 'Completed in Jira', not conflated with an in-app completion");

  globalThis.fetch = originalFetch;
  commandCenterStore.resetAll();
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
