// F6 — synthetic dataset (3,000 work items / 1,500 mention events) and the selector timings the
// performance-budget test asserts on. Each selector is the same call the page makes.

import { CommandCenterStore, getTodayIso, selectDailyCommandMaps } from "../../src/lib/command-center/store";
import { createMemoryStateStorage } from "../../src/lib/command-center/state-persistence";
import { addDays } from "../../src/lib/command-center/date-utils";
import { deriveData } from "../../src/lib/command-center/selectors";
import { computeProactiveIntelligence } from "../../src/lib/command-center/proactive";
import { computePersonalFocus, dedupeCandidatesByTicket } from "../../src/lib/command-center/personal-focus";
import { buildMyWork } from "../../src/lib/command-center/my-work";
import { buildWorkRelevanceIndex } from "../../src/lib/command-center/jira/work-relevance";
import { buildDailyReportView, buildWeeklyReportView, mondayOf } from "../../src/lib/command-center/reports";
import { emptyData, type CommandCenterData, type MentionEvent, type WorkItem } from "../../src/lib/command-center/types";

export const PERF_WORK_ITEMS = 3000;
export const PERF_MENTIONS = 1500;
const PROJECTS = 30;
const STATUSES = ["To Do", "In Progress", "In Review", "Blocked", "Done"];

export function buildPerfData(today: string): { data: CommandCenterData; mentions: MentionEvent[] } {
  const projects = Array.from({ length: PROJECTS }, (_, p) => ({ id: `jira-project-P${p}`, name: `Project ${p}`, clientId: `c-${p % 6}`, status: "on-track" as const, sourceType: "jira" as const, sourceId: `P${p}` }));
  const clients = Array.from({ length: 6 }, (_, c) => ({ id: `c-${c}`, name: `Client ${c}` }));
  const workItems: WorkItem[] = Array.from({ length: PERF_WORK_ITEMS }, (_, i) => {
    const p = i % PROJECTS;
    const key = `P${p}-${i + 1}`;
    const status = STATUSES[i % STATUSES.length];
    const mine = i % 3 === 0;
    return {
      id: `jira-${key}`,
      key,
      title: `Synthetic ticket ${i + 1}`,
      projectId: `jira-project-P${p}`,
      clientId: `c-${p % 6}`,
      type: "task",
      status: status === "Done" ? "Done" : status === "Blocked" ? "Blocked" : status === "In Progress" ? "In Progress" : status === "In Review" ? "In Review" : "Not Started",
      jiraStatusName: status,
      priority: (["P1", "P2", "P3", "P4"] as const)[i % 4],
      owner: mine ? "Tay" : `Dev ${i % 17}`,
      ownerId: mine ? "acc-tay" : `acc-dev-${i % 17}`,
      createdDate: addDays(today, -(i % 90)),
      lastUpdated: addDays(today, -(i % 20)),
      dueDate: addDays(today, (i % 40) - 10),
      blocked: status === "Blocked",
      dependencyIds: [],
      riskIds: [],
      scopeChangeCount: i % 7 === 0 ? 2 : 0,
      businessImpact: (i % 5) + 1,
      fixVersion: `2026.${(p % 4) + 1}`,
      sourceType: "jira",
      sourceId: key,
      sourceUrl: `https://jira.example.com/browse/${key}`,
      firstSeenAt: `${addDays(today, -(i % 10))}T08:00:00.000Z`,
    } as WorkItem;
  });
  const dependencies = workItems.filter((_, i) => i % 25 === 0).map((w, i) => ({ id: `dep-${i}`, workItemId: w.id, description: `Needs API ${i}`, dependsOnTeam: `Team ${i % 5}`, status: "unresolved" as const, raisedDate: addDays(today, -(i % 15)) }));
  const mentions: MentionEvent[] = Array.from({ length: PERF_MENTIONS }, (_, i) => {
    const w = workItems[(i * 2) % PERF_WORK_ITEMS];
    return { issueKey: w.key, commentId: `${w.key}:c${i}`, commentAuthor: `Dev ${i % 17}`, excerpt: `Please look at this (${i})`, mentionedAt: `${addDays(today, -(i % 14))}T09:${String(i % 60).padStart(2, "0")}:00.000Z` };
  });
  return { data: { ...emptyData(), clients, projects, workItems, dependencies } as CommandCenterData, mentions };
}

export async function buildPerfFixture() {
  const today = getTodayIso();
  const { data, mentions } = buildPerfData(today);
  const store = new CommandCenterStore({
    stateStorage: createMemoryStateStorage(),
    stateChannel: null,
    stateFocusTargets: [],
    jiraSyncLockManager: null,
    createJiraDataSource: () => ({ type: "jira", sync: async () => ({ ok: true, data, recordsFetched: data.workItems.length, truncated: false, syncedAt: new Date().toISOString(), warnings: [], mentionEvents: mentions }) }),
  });
  store.getSnapshot();
  store.setPersonalIdentity({ displayName: "Tay", accountId: "acc-tay" });
  for (const s of STATUSES) store.setJiraStatusRelevance(s, s === "Done" ? "DONE" : "ACTIONABLE");
  await store.syncJira();
  // Some personal state on top: statuses, plan items, reports.
  const keys = data.workItems.filter((w) => w.ownerId === "acc-tay").map((w) => w.key);
  keys.slice(0, 60).forEach((k, i) => {
    if (i % 4 === 0) store.startTicket(k, "my-work");
    else if (i % 4 === 1) store.blockTicketInDailyCommand(k, "Waiting on client decision", undefined, undefined, "my-work");
    else if (i % 4 === 2) store.skipTicketInDailyCommand(k, "Not my action", undefined, "my-work");
    else store.completeTicketInDailyCommand(k, "my-work");
  });
  for (let d = 1; d <= 10; d++) store.generateDailyReport(addDays(today, -d), true);
  store.generateDailyReport(today, true);
  return { store, today };
}

const time = (fn: () => unknown): number => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

/** The worst of 3 warm runs per selector (first, cold run discarded). */
export async function timeSelectors(env: Awaited<ReturnType<typeof buildPerfFixture>>): Promise<Record<string, number>> {
  const { store, today } = env;
  const s = store.getSnapshot();
  const idx = buildWorkRelevanceIndex(s.jiraWorkRelevancePolicy);
  const identity = { displayName: "Tay", accountId: "acc-tay" };
  const derivedOnce = deriveData(s.data, null, today, idx);
  const proactive = computeProactiveIntelligence(s.data, derivedOnce, s.snapshotHistory, null, s.attentionState, "jira", today, idx, s.mentionEvents, "acc-tay", "Tay");
  const runs: Record<string, () => unknown> = {
    "Priorities (deriveData)": () => deriveData(s.data, null, today, idx),
    "Attention queue (proactive)": () => {
      const derived = deriveData(s.data, null, today, idx);
      return computeProactiveIntelligence(s.data, derived, s.snapshotHistory, null, s.attentionState, "jira", today, idx, s.mentionEvents, "acc-tay", "Tay");
    },
    "Personal focus (My Work Today)": () => computePersonalFocus(s.data, proactive, "Tay", today, "acc-tay", idx, derivedOnce.risks, s.mentionEvents),
    "Daily Review": () => store.computeDailyReview(),
    "My Work": () => {
      const review = store.computeDailyReview();
      return buildMyWork({ workItems: s.data.workItems, identity, workRelevanceIndex: idx, ticketWorkStates: s.ticketWorkStates, today, personalPlan: s.personalPlan, review, blockerSlaBusinessDays: 2 });
    },
    "Standup (live report state)": () => store.buildLiveStandup(),
    "Daily Report view": () => buildDailyReportView(s.dailyReports[today], today, identity, store.buildLiveStandup(), { blockerSlaBusinessDays: 2, summaries: { risks: s.data.risks, decisions: s.data.decisions } }),
    "Weekly Report view": () => buildWeeklyReportView({ weekStart: mondayOf(today), dailyReports: s.dailyReports, identity, today, summaries: { risks: s.data.risks, decisions: s.data.decisions } }),
  };
  void dedupeCandidatesByTicket;
  void selectDailyCommandMaps;
  const out: Record<string, number> = {};
  for (const [name, fn] of Object.entries(runs)) {
    fn();
    out[name] = Math.max(time(fn), time(fn), time(fn));
  }
  return out;
}
