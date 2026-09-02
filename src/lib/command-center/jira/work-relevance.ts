// V2.5 — Work Relevance & Jira Status Policy. A deterministic semantic layer over already-
// normalized Jira data: it only decides whether a Jira issue's CURRENT STATUS represents work
// the user needs to do (ACTIONABLE), work waiting on someone else (WAITING), delivery/process
// state to observe (OBSERVE), finished work (COMPLETED), work explicitly excluded (EXCLUDED),
// or a status nobody has classified yet (UNKNOWN). Nothing here is a second task system, a
// second scoring engine, or an AI call — see types.ts for the WorkRelevance/JiraStatusPolicy
// shapes this module operates on.
//
// Mirrors jira/project-scope.ts's own split: the policy is configured PER PROJECT, keyed by
// the same Jira project KEY every other Jira code path in this codebase already uses
// (JiraProjectScope.projectKeys, Project.sourceId, WorkItem.projectId's `jira-project-${key}`
// prefix) — no second identity scheme, no cross-project status normalization (§6 — the same
// status name can mean different things in different projects, so classification is always
// project-scoped, never global).
//
// CONSERVATISM (§7, §26): a status with no explicit classification is UNKNOWN, and UNKNOWN is
// NEVER treated as actionable. A non-Jira work item (demo/local-import) has no Jira status
// identity at all — the policy simply does not apply (NOT_APPLICABLE), which preserves every
// pre-V2.5 behavior for anyone not using Jira.

import type { CommandCenterData, JiraStatusPolicy, WorkItem, WorkRelevance } from "../types";

export const DEFAULT_WORK_RELEVANCE_POLICY_MAP: Record<string, JiraStatusPolicy> = {};

function isValidRelevance(v: unknown): v is WorkRelevance {
  return v === "ACTIONABLE" || v === "WAITING" || v === "OBSERVE" || v === "COMPLETED" || v === "EXCLUDED" || v === "UNKNOWN";
}

/** Defensive parse for persisted state — malformed/missing/wrong-typed data always degrades
 *  to an empty policy map (every Jira status UNKNOWN, the safe conservative default) rather
 *  than crashing or guessing (§26 backward compatibility). */
export function parseWorkRelevancePolicyMap(raw: unknown): Record<string, JiraStatusPolicy> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, JiraStatusPolicy> = {};
  for (const [projectKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof projectKey !== "string" || !projectKey.trim()) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const entry = value as Partial<JiraStatusPolicy>;
    const rawMap = typeof entry.statusMap === "object" && entry.statusMap !== null && !Array.isArray(entry.statusMap) ? (entry.statusMap as Record<string, unknown>) : {};
    const statusMap: Record<string, WorkRelevance> = {};
    for (const [status, relevance] of Object.entries(rawMap)) {
      if (typeof status === "string" && status.trim() && isValidRelevance(relevance)) statusMap[status] = relevance;
    }
    const updatedAt = typeof entry.updatedAt === "string" ? entry.updatedAt : undefined;
    out[projectKey] = { projectKey, statusMap, updatedAt };
  }
  return out;
}

/** §28 performance — Map<ProjectKey, Map<JiraStatus, WorkRelevance>>, built once per render
 *  (see use-command-center.ts) rather than re-scanned per work item inside a loop. */
export type WorkRelevanceIndex = Map<string, Map<string, WorkRelevance>>;

export function buildWorkRelevanceIndex(policyMap: Record<string, JiraStatusPolicy> | undefined | null): WorkRelevanceIndex {
  const index: WorkRelevanceIndex = new Map();
  if (!policyMap) return index;
  for (const policy of Object.values(policyMap)) {
    index.set(policy.projectKey, new Map(Object.entries(policy.statusMap)));
  }
  return index;
}

const JIRA_PROJECT_ID_PREFIX = "jira-project-";

/** The Jira project KEY a work item belongs to, derived from its own `projectId` foreign key
 *  (already `jira-project-${key}` per jira/normalize.ts) — never a second lookup table. */
export function jiraProjectKeyForWorkItem(item: Pick<WorkItem, "sourceType" | "projectId">): string | undefined {
  if (item.sourceType !== "jira") return undefined;
  return item.projectId.startsWith(JIRA_PROJECT_ID_PREFIX) ? item.projectId.slice(JIRA_PROJECT_ID_PREFIX.length) : undefined;
}

/** A work item's effective Work Relevance. `"NOT_APPLICABLE"` means the concept simply
 *  doesn't apply — a demo/local-import item with no Jira status identity (§27) — and is
 *  handled as "unaffected by this policy", distinct from `"UNKNOWN"` (a real Jira status
 *  nobody has classified yet, §4, always conservative). */
export type EffectiveWorkRelevance = WorkRelevance | "NOT_APPLICABLE";

export function resolveWorkRelevance(item: Pick<WorkItem, "sourceType" | "projectId" | "jiraStatusName">, index: WorkRelevanceIndex): EffectiveWorkRelevance {
  const projectKey = jiraProjectKeyForWorkItem(item);
  if (!projectKey || !item.jiraStatusName) return "NOT_APPLICABLE";
  return index.get(projectKey)?.get(item.jiraStatusName) ?? "UNKNOWN";
}

/** §10 — the ONLY gate personal-work surfaces apply: ACTIONABLE is eligible, and so is a
 *  non-Jira item (the policy never applies to it). Every other classification — WAITING,
 *  OBSERVE, COMPLETED, EXCLUDED, UNKNOWN — is never automatically personal work, regardless
 *  of ownership/priority/anything else (§11 "assignment/ownership must not override this"). */
export function isPersonalWorkEligible(relevance: EffectiveWorkRelevance): boolean {
  return relevance === "ACTIONABLE" || relevance === "NOT_APPLICABLE";
}

export function isPersonalWorkEligibleItem(item: Pick<WorkItem, "sourceType" | "projectId" | "jiraStatusName">, index: WorkRelevanceIndex): boolean {
  return isPersonalWorkEligible(resolveWorkRelevance(item, index));
}

/** §9 — the exact, deterministic explanation text for each classification, reused verbatim
 *  by Data & Settings, the "why isn't this on my list?" trust flow, and Command Bar. */
export const WORK_RELEVANCE_EXPLANATIONS: Record<WorkRelevance, string> = {
  ACTIONABLE: "Daily Command may consider this status as work requiring action, subject to ownership and existing intelligence rules.",
  WAITING: "The item is waiting on another party or process. It is not automatically treated as work for you.",
  OBSERVE: "This status represents delivery/process state. It remains visible as context but is not treated as personal work.",
  COMPLETED: "Completed work is excluded from active work surfaces.",
  EXCLUDED: "This status is intentionally excluded from Daily Command's actionable work interpretation.",
  UNKNOWN: "This status has not been classified. Daily Command will not treat it as actionable.",
};

/** §18 — "Why isn't this on my list?" for one work item, deterministic, no AI call. */
export interface WorkRelevanceExplanation {
  isApplicable: boolean;
  relevance: EffectiveWorkRelevance;
  answer: string;
}

export function explainWorkItemRelevance(item: WorkItem, index: WorkRelevanceIndex): WorkRelevanceExplanation {
  const relevance = resolveWorkRelevance(item, index);
  if (relevance === "NOT_APPLICABLE") {
    return { isApplicable: false, relevance, answer: "This item has no Jira status identity — Work Relevance Policy does not apply to it." };
  }
  if (relevance === "UNKNOWN") {
    return {
      isApplicable: true,
      relevance,
      answer: `${item.key} is currently "${item.jiraStatusName}". This Jira status has not been classified yet for this project. Daily Command does not treat unclassified statuses as actionable.`,
    };
  }
  const projectKey = jiraProjectKeyForWorkItem(item);
  return {
    isApplicable: true,
    relevance,
    answer: `${item.key} is currently "${item.jiraStatusName}". This status is classified as ${relevance}${projectKey ? ` for ${projectKey}` : ""}. ${WORK_RELEVANCE_EXPLANATIONS[relevance]}`,
  };
}

/** §6 — statuses the settings UI can offer to classify, derived from OBSERVED Jira data for
 *  one project rather than a hard-coded list. Sorted for a stable UI. */
export function collectObservedStatuses(data: CommandCenterData, projectKey: string): string[] {
  const seen = new Set<string>();
  for (const item of data.workItems) {
    if (jiraProjectKeyForWorkItem(item) === projectKey && item.jiraStatusName) seen.add(item.jiraStatusName);
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

/** §19 Data Health / Trust signal — count of distinct (project, status) pairs currently
 *  UNKNOWN among open Jira work items in `data`. A dimension of its own, never blended into
 *  Delivery Confidence or any other score. */
export function countUnclassifiedJiraStatuses(data: CommandCenterData, index: WorkRelevanceIndex): number {
  const unclassified = new Set<string>();
  for (const item of data.workItems) {
    if (item.status === "Done") continue;
    const projectKey = jiraProjectKeyForWorkItem(item);
    if (!projectKey || !item.jiraStatusName) continue;
    if (resolveWorkRelevance(item, index) === "UNKNOWN") unclassified.add(`${projectKey}::${item.jiraStatusName}`);
  }
  return unclassified.size;
}

/** One row per unclassified (project, status) pair — used by the Command Bar's "which Jira
 *  statuses are not classified?" intent and the Data & Settings unclassified list. */
export interface UnclassifiedStatusRow {
  projectKey: string;
  status: string;
}

export function listUnclassifiedJiraStatuses(data: CommandCenterData, index: WorkRelevanceIndex): UnclassifiedStatusRow[] {
  return listStatusesByRelevance(data, index, "UNKNOWN");
}

/** V2.6 §17 — generalized (project, status) rows currently classified as `relevance`, e.g.
 *  for the Command Bar's "which statuses are actionable?" intent. `listUnclassifiedJiraStatuses`
 *  above is the UNKNOWN special case, kept as its own export since it's the one V2.5 already
 *  wired everywhere (Data & Settings, Command Bar) — this is purely additive. */
export function listStatusesByRelevance(data: CommandCenterData, index: WorkRelevanceIndex, relevance: WorkRelevance): UnclassifiedStatusRow[] {
  const seen = new Map<string, UnclassifiedStatusRow>();
  for (const item of data.workItems) {
    const projectKey = jiraProjectKeyForWorkItem(item);
    if (!projectKey || !item.jiraStatusName) continue;
    if (resolveWorkRelevance(item, index) !== relevance) continue;
    const key = `${projectKey}::${item.jiraStatusName}`;
    if (!seen.has(key)) seen.set(key, { projectKey, status: item.jiraStatusName });
  }
  return Array.from(seen.values()).sort((a, b) => a.projectKey.localeCompare(b.projectKey) || a.status.localeCompare(b.status));
}

/** Work items whose CURRENT effective relevance matches `relevance` exactly — used by the
 *  Command Bar's "what is in UAT?" (OBSERVE) / "what is waiting?" (WAITING) intents. Never
 *  matches NOT_APPLICABLE items (a demo/local-import item can't be "OBSERVE" or "WAITING"). */
export function workItemsByRelevance(data: CommandCenterData, index: WorkRelevanceIndex, relevance: WorkRelevance): WorkItem[] {
  return data.workItems.filter((w) => resolveWorkRelevance(w, index) === relevance);
}

/** Pure updater for one (project, status) classification — store.ts's setJiraStatusRelevance
 *  delegates here, same split as jira/project-scope.ts's parse/apply functions vs store.ts's
 *  thin setJiraProjectScope wrapper. */
export function withStatusRelevance(policyMap: Record<string, JiraStatusPolicy>, projectKey: string, status: string, relevance: WorkRelevance): Record<string, JiraStatusPolicy> {
  const existing = policyMap[projectKey];
  const nextStatusMap = { ...(existing?.statusMap ?? {}), [status]: relevance };
  return { ...policyMap, [projectKey]: { projectKey, statusMap: nextStatusMap, updatedAt: new Date().toISOString() } };
}

// ===== V2.6 — Work Policy Intelligence & Operational Calibration =====
// Additive calibration layer on top of V2.5 above: status coverage arithmetic and a
// deterministic policy-change impact count. No new classification logic — every function
// below is a read over the SAME index/policy map V2.5 already builds and enforces.

/** §4 — deterministic coverage state for one project's (or the whole scope's) observed
 *  Jira status vocabulary. Plain arithmetic, never a blended score (§4). */
export type WorkRelevanceCoverageState = "FULLY_CLASSIFIED" | "PARTIALLY_CLASSIFIED" | "NOT_CLASSIFIED" | "NO_JIRA_DATA";

export interface WorkRelevanceCoverage {
  observedStatusCount: number;
  classifiedStatusCount: number;
  unclassifiedStatusCount: number;
  coveragePct: number;
  state: WorkRelevanceCoverageState;
}

function pctOf(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 100);
}

function coverageFrom(observedCount: number, classifiedCount: number): WorkRelevanceCoverage {
  const state: WorkRelevanceCoverageState = observedCount === 0 ? "NO_JIRA_DATA" : classifiedCount === 0 ? "NOT_CLASSIFIED" : classifiedCount === observedCount ? "FULLY_CLASSIFIED" : "PARTIALLY_CLASSIFIED";
  return { observedStatusCount: observedCount, classifiedStatusCount: classifiedCount, unclassifiedStatusCount: observedCount - classifiedCount, coveragePct: pctOf(classifiedCount, observedCount), state };
}

/** §4 — per-project status coverage, computed from OBSERVED Jira data (never invented). */
export function computeStatusCoverage(data: CommandCenterData, index: WorkRelevanceIndex, projectKey: string): WorkRelevanceCoverage {
  const observed = collectObservedStatuses(data, projectKey);
  const statusMap = index.get(projectKey);
  const classifiedCount = observed.filter((s) => !!statusMap?.get(s)).length;
  return coverageFrom(observed.length, classifiedCount);
}

/** §4, §10 — coverage across every OBSERVED (project, status) pair currently in scope, for
 *  the single "X% classified" figure the Data Health panel shows (§10 "do not create a
 *  second status-management page"). `projectKeys` narrows to Focused Projects when
 *  supplied; omitted/empty means every project observed in `data` (ALL scope). */
export function computeOverallWorkRelevanceCoverage(data: CommandCenterData, index: WorkRelevanceIndex, projectKeys?: string[]): WorkRelevanceCoverage {
  const scope = projectKeys && projectKeys.length > 0 ? new Set(projectKeys) : undefined;
  const seen = new Set<string>();
  let observedCount = 0;
  let classifiedCount = 0;
  for (const item of data.workItems) {
    const projectKey = jiraProjectKeyForWorkItem(item);
    if (!projectKey || !item.jiraStatusName) continue;
    if (scope && !scope.has(projectKey)) continue;
    const pairKey = `${projectKey}::${item.jiraStatusName}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    observedCount++;
    if (index.get(projectKey)?.get(item.jiraStatusName)) classifiedCount++;
  }
  return coverageFrom(observedCount, classifiedCount);
}

/** §8-9 — deterministic policy-change impact: how many currently-open work items carry
 *  this exact (project, raw status) pair right now. Used to preview "+N personal work
 *  items" BEFORE a classification change is applied — never a guess, always a live count
 *  over `data` (§8 "the impact calculation must use actual current data"). */
export function countOpenItemsForProjectStatus(data: CommandCenterData, projectKey: string, status: string): number {
  let count = 0;
  for (const item of data.workItems) {
    if (item.status === "Done") continue;
    if (jiraProjectKeyForWorkItem(item) === projectKey && item.jiraStatusName === status) count++;
  }
  return count;
}
