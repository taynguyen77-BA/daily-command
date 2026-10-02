// Shared fixtures and builders used across the domain test files (hoisted verbatim from the
// former single-file suite). Pure — no checks run here.

import { buildPlan } from "../../src/lib/command-center/action-plan";
import { DATA_SCHEMA_VERSION, emptyData, type WorkItem } from "../../src/lib/command-center/types";
import { getTodayIso, ticketStateFromLegacy, type StoreState } from "../../src/lib/command-center/store";
import type { Decision, SnapshotMetrics } from "../../src/lib/command-center/types";
import { type JiraIssue } from "../../src/lib/command-center/jira/types";
import { deriveData } from "../../src/lib/command-center/selectors";
import { trendQuality } from "../../src/lib/command-center/delivery-drift";
import { computeProactiveIntelligence } from "../../src/lib/command-center/proactive";
import type { AttentionItem, Client, Dependency, DependencyRadarItem, Risk, RiskEscalation } from "../../src/lib/command-center/types";
import { computeDeliveryLoops } from "../../src/lib/command-center/delivery-loops";
import type { Action } from "../../src/lib/command-center/types";
import { computePersonalFocus } from "../../src/lib/command-center/personal-focus";
import type { JiraConnectionConfig } from "../../src/lib/command-center/jira/types";
import type { PersonalFocusCandidate } from "../../src/lib/command-center/types";
import type { Project } from "../../src/lib/command-center/types";
import { buildProjectOverrideView } from "../../src/components/command-center/use-command-center";
import type { WorkRelevance } from "../../src/lib/command-center/types";
import type { MentionEvent } from "../../src/lib/command-center/types";
import { getActiveAssignedWorkItems } from "../../src/lib/command-center/assigned-work";
import { selectRecentMentions } from "../../src/lib/command-center/recent-mentions";
import { CommandCenterStore } from "../../src/lib/command-center/store";
import type { DataSourceSyncResult } from "../../src/lib/command-center/datasource/types";
import { ok } from "./harness.mts";

export const TODAY = "2026-06-15";


export function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
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


// ================= V1.2 — PROJECT MEMORY & DECISION INTELLIGENCE =================

export function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return { id: "dec-1", projectId: "p-1", title: "Test decision", status: "ACTIVE", description: "test decision", ...overrides };
}


// ===== Today vs Yesterday delta + trend classification =====
export const yesterdayMetrics: SnapshotMetrics = {
  attentionCount: 3, criticalCount: 1, highRiskCount: 4, blockedCount: 6, overdueCount: 2,
  deliveryConfidence: 50, openDecisionsCount: 2, unresolvedDependenciesCount: 3,
  majorRiskTitles: [], unresolvedDependencyTeams: [], meaningfulChangeCount: 2,
};


// ================= V1.3 — LIVE PROJECT INTELLIGENCE (Jira) =================

export function makeJiraIssue(overrides: Partial<JiraIssue["fields"]> & { key?: string } = {}): JiraIssue {
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


// ================= V1.4 — PROACTIVE DELIVERY INTELLIGENCE =================

export function makeRisk(overrides: Partial<Risk> = {}): Risk {
  return { id: "risk-1", projectId: "p-1", title: "Test risk", level: "MEDIUM", reason: "test", evidence: ["e1"], potentialImpact: "impact", mitigation: "mitigate", status: "open", confidence: 0.7, detectedAt: TODAY, sourceWorkItemIds: [], ...overrides };
}

export function makeDependencyRadarItem(overrides: Partial<DependencyRadarItem> = {}): DependencyRadarItem {
  return { dependencyId: "dep-1", description: "test dep", dependsOnTeam: "Team", ageDays: 1, blockedItemCount: 0, blockedHighPriorityCount: 0, heat: "LOW", recommended: "Monitor.", evidence: [], ...overrides };
}

export function makeRiskEscalation(overrides: Partial<RiskEscalation> = {}): RiskEscalation {
  return { riskId: "r-1", riskTitle: "Test risk", currentSeverity: "MEDIUM", daysOpen: 1, evidenceCount: 1, trend: "stable", reopened: false, ...overrides };
}

export function makeDependency(overrides: Partial<Dependency> = {}): Dependency {
  return { id: "dep-1", workItemId: "wi-1", description: "test dependency", dependsOnTeam: "Team", status: "unresolved", raisedDate: TODAY, ...overrides };
}

export function makeAttentionItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return { id: "CAT:x", category: "RISK", severity: "MEDIUM", what: "test", why: "test", impact: "test", nowWhat: "test", evidence: [], lifecycle: "ACTIVE", firstSeenDate: TODAY, lastSeenDate: TODAY, ...overrides };
}


// ===================================================================================
// V1.6 — Personal Delivery Copilot
// ===================================================================================

export function fakeProactive(attentionQueue: AttentionItem[], deliveryLoops: ReturnType<typeof computeDeliveryLoops> = []) {
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


// ===================================================================================
// V1.7 — Real-World Delivery Copilot Hardening
// ===================================================================================

export const FIXTURE_CONFIG: JiraConnectionConfig = { baseUrl: "https://fixture.invalid", email: "fixture@example.test", apiToken: "fixture-not-real" };


// ===== P1 — Deadline Conflict Detection =====
export function pfc(overrides: Partial<PersonalFocusCandidate> = {}): PersonalFocusCandidate {
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


// ===== V2.2 — Evidence -> Delivery Artifact =====

export const v22Clients: Client[] = [{ id: "v22-c1", name: "JPMC" }];

export const v22Projects: Project[] = [{ id: "v22-p1", name: "Core Banking", clientId: "v22-c1", status: "at-risk" }];

export const v22Blocked = makeItem({
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

export const v22Normal = makeItem({
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

export const v22Dep: Dependency = { id: "v22-dep1", workItemId: "v22-w2", description: "API contract from Platform", dependsOnTeam: "Platform", status: "unresolved", raisedDate: TODAY };

export const v22Data: CommandCenterData = { ...emptyData(), clients: v22Clients, projects: v22Projects, workItems: [v22Blocked, v22Normal], dependencies: [v22Dep] };

export const v22Derived = deriveData(v22Data, null, TODAY);

export const v22Proactive = computeProactiveIntelligence(v22Data, v22Derived, [], null, {}, "manual", TODAY);

export const v22PersonalFocus = computePersonalFocus(v22Data, v22Proactive, undefined, TODAY);


// ================= V2.4 — CONTEXT & FOCUS =================
// V2.4 makes the existing V2.3 Focus Project Scope pervasive across the rest of the app.
// No new selection state, no new intelligence engine — every function under test here is
// either an existing one (applyProjectScope, computeDeliveryConfidence, scoreAllWorkItems,
// computeDataHealth) or a small, pure composition of them (detectExplicitProjectMention,
// buildProjectOverrideView, computeProjectAttentionMap).

// A hand-built StoreState never went through parseStoredState, so the canonical
// ticketWorkStates is migrated from whatever legacy Daily Command maps the test supplied —
// exactly what loading a persisted pre-TicketWorkState blob does.
export function makeStoreState(overrides: Partial<StoreState> = {}): StoreState {
  const base = makeRawStoreState(overrides);
  return {
    ...base,
    ...ticketStateFromLegacy(
      base.ticketWorkStates ?? {},
      {
        dailyCommandCompletions: base.dailyCommandCompletions ?? {},
        dailyCommandSkips: base.dailyCommandSkips ?? {},
        dailyCommandBlocks: base.dailyCommandBlocks ?? {},
        dailyCommandTombstones: base.dailyCommandTombstones ?? { completions: {}, skips: {}, blocks: {} },
      },
      base.personalPlan ?? [],
      undefined
    ),
  };
}

export function makeRawStoreState(overrides: Partial<StoreState> = {}): StoreState {
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
export function makeThreeProjectFixture() {
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


// ===== V2.5 — Work Relevance & Jira Status Policy =====

export function jiraItem(overrides: Partial<WorkItem> = {}): WorkItem {
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
export function globalPolicy(entries: Record<string, WorkRelevance>): Record<string, WorkRelevance> {
  return entries;
}


// ===== V2.7 — Work Relevance Operational Calibration =====

export function calAction(overrides: Partial<Action> = {}): Action {
  return { id: `action-${Math.random().toString(36).slice(2)}`, title: "Test action", why: "test", status: "open", estimateMinutes: 15, createdAt: TODAY, ...overrides };
}


// ===== V2.8 — Execution Path & Work Signal Calibration =====

export function mockAttentionItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
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


export function mockProactive(attentionQueue: AttentionItem[], deliveryLoops: any[] = []): any {
  return { attentionQueue, deliveryLoops };
}


export function mockPersonalFocus(candidates: PersonalFocusCandidate[]): any {
  return { candidates, top3: candidates.slice(0, 3) };
}



// ===== V2.26 — shared helpers for the provenance / blocked / reactivation / daily-review
// suites below: a store whose Jira data source returns whatever payload the test sets. =====
export function v226JiraItem(key: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    ...makeItem({ id: `jira-${key}`, key, title: `Ticket ${key}`, projectId: "jira-project-V226", owner: "Tay", ownerId: "acc-tay", status: "In Progress", ...overrides }),
    sourceType: "jira",
    sourceId: key,
    sourceUrl: `https://jira.example.com/browse/${key}`,
  };
}

export function v226Store(extraDeps: Partial<ConstructorParameters<typeof CommandCenterStore>[0]> = {}) {
  let payload: DataSourceSyncResult = { ok: true, data: emptyData(), recordsFetched: 0, syncedAt: new Date().toISOString() };
  const store = new CommandCenterStore({
    createJiraDataSource: () => ({ type: "jira", sync: async () => payload }),
    jiraSyncLockManager: null,
    ...extraDeps,
  });
  store.getSnapshot();
  store.resetAll();
  const setJira = (workItems: WorkItem[], mentionEvents?: MentionEvent[]) => {
    payload = {
      ok: true,
      data: { ...emptyData(), projects: [{ id: "jira-project-V226", name: "V226 Project", clientId: "c-1", status: "on-track", sourceType: "jira", sourceId: "V226" } as never], workItems },
      recordsFetched: workItems.length,
      truncated: false,
      syncedAt: new Date().toISOString(),
      warnings: [],
      mentionEvents,
    };
  };
  return { store, setJira };
}

export const v226Tick = () => new Promise((r) => setTimeout(r, 5));


/** Every personal-work surface where `key` shows up as ACTIVE work (not as a labeled
 *  reactivation, not in a history bucket). Mirrors what each page renders by default. */
export function v226ActiveSurfaces(store: CommandCenterStore, key: string, nowMs: number): string[] {
  const st = store.getSnapshot();
  const today = getTodayIso();
  const view = buildProjectOverrideView(st, today, "V226");
  const keys = (m: Record<string, unknown>) => new Set(Object.keys(m));
  const tay = { accountId: "acc-tay", displayName: "Tay" };
  const item = st.data.workItems.find((w) => w.key === key);
  const out: string[] = [];
  if (getActiveAssignedWorkItems(view.filteredData.workItems, tay, view.workRelevanceIndex, keys(st.dailyCommandCompletions), keys(st.dailyCommandSkips), keys(st.dailyCommandBlocks)).some((w) => w.key === key)) out.push("My Assigned Work");
  const mention = selectRecentMentions(st.mentionEvents, st.data.workItems, st.attentionState, nowMs, st).find((m) => m.issueKey === key);
  if (mention && !mention.reactivation) out.push("Recently Mentioned (as new)");
  if (view.proactive?.attentionQueue.some((i) => i.ticketKey === key && i.lifecycle !== "RESOLVED" && i.lifecycle !== "SNOOZED" && !i.reactivation)) out.push("Attention Queue");
  if (view.personalFocus?.candidates.some((c) => c.ticketKey === key)) out.push("Your Delivery Focus");
  if (buildPlan(view.filteredData, today, 120, view.workRelevanceIndex, view.dailyCommandCompletedWorkItemIds, view.dailyCommandPausedWorkItemIds).some((p) => p.item?.key === key)) out.push("Action Plan");
  if (item && view.derived.scores.some((r) => r.itemId === item.id) && !view.dailyCommandPausedWorkItemIds.has(item.id)) out.push("Priorities");
  return out;
}

/** A store with identity + ACTIONABLE policy configured, so tickets genuinely reach every surface. */
export function v226ConfiguredStore(extraDeps: Partial<ConstructorParameters<typeof CommandCenterStore>[0]> = {}) {
  const env = v226Store(extraDeps);
  env.store.setPersonalIdentity({ displayName: "Tay", accountId: "acc-tay" });
  env.store.setJiraStatusRelevance("In Progress", "ACTIONABLE");
  return env;
}

export const v226Actionable = (key: string, overrides: Partial<WorkItem> = {}) => v226JiraItem(key, { jiraStatusName: "In Progress", priority: "P1", dueDate: "2026-01-05", businessImpact: 5, ...overrides });
