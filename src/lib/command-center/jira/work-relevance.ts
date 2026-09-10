// V2.5 — Work Relevance & Jira Status Policy. A deterministic semantic layer over already-
// normalized Jira data: it only decides whether a Jira issue's CURRENT STATUS represents work
// the user needs to do (ACTIONABLE), work waiting on someone else (WAITING), delivery/process
// state to observe (OBSERVE), finished work (COMPLETED), work explicitly excluded (EXCLUDED),
// or a status nobody has classified yet (UNKNOWN). Nothing here is a second task system, a
// second scoring engine, or an AI call — see types.ts for the WorkRelevance/JiraWorkRelevancePolicyMap
// shapes this module operates on.
//
// V2.11 §1 — GLOBAL policy (explicit product decision, overriding the V2.6/V2.7 per-project
// design): the same raw Jira status name means the same thing everywhere it's observed, across
// every synced project/site. The policy map is keyed directly by status name — no project
// dimension in the key at all. `jiraProjectKeyForWorkItem` below is unchanged and still used
// elsewhere (labeling which project a WorkItem belongs to, e.g. the per-project Distribution
// panel) — it's just no longer part of a policy's identity.
//
// CONSERVATISM (§7, §26): a status with no explicit classification is UNKNOWN, and UNKNOWN is
// NEVER treated as actionable. A non-Jira work item (demo/local-import) has no Jira status
// identity at all — the policy simply does not apply (NOT_APPLICABLE), which preserves every
// pre-V2.5 behavior for anyone not using Jira.

import type { CommandCenterData, JiraWorkRelevancePolicyMap, WorkItem, WorkRelevance, WorkRelevancePolicyMigrationNotice } from "../types";

export const DEFAULT_WORK_RELEVANCE_POLICY_MAP: JiraWorkRelevancePolicyMap = {};

function isValidRelevance(v: unknown): v is WorkRelevance {
  return v === "ACTIONABLE" || v === "WAITING" || v === "OBSERVE" || v === "COMPLETED" || v === "EXCLUDED" || v === "UNKNOWN";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** V2.11 §1 migration — the pre-V2.11 shape was `{ [projectKey]: { projectKey, statusMap,
 *  updatedAt } }`; the new shape is a flat `{ [status]: WorkRelevance }`. Old-shape entries are
 *  objects carrying a `statusMap` field — a shape a valid new-shape value (a plain
 *  WorkRelevance string) can never take, so this detection is unambiguous. */
function looksLikeOldPerProjectShape(raw: Record<string, unknown>): boolean {
  return Object.values(raw).some((v) => isPlainObject(v) && "statusMap" in v);
}

function parseOldShapeProjectStatusMap(value: unknown): Record<string, WorkRelevance> {
  if (!isPlainObject(value)) return {};
  const rawMap = isPlainObject(value.statusMap) ? value.statusMap : {};
  const statusMap: Record<string, WorkRelevance> = {};
  for (const [status, relevance] of Object.entries(rawMap)) {
    if (typeof status === "string" && status.trim() && isValidRelevance(relevance)) statusMap[status] = relevance;
  }
  return statusMap;
}

export interface ParsedWorkRelevancePolicy {
  policy: JiraWorkRelevancePolicyMap;
  migration?: WorkRelevancePolicyMigrationNotice;
}

/** V2.11 §1 — for a status classified differently by different pre-upgrade projects, prefer
 *  the value from whichever project had the most statuses classified overall (a proxy for "the
 *  most deliberately-calibrated project's judgment"), tie-broken alphabetically by projectKey
 *  for full determinism. Every collapsed status is reported so Data & Settings can show a
 *  one-time "consolidated from N per-project settings — review below" notice. */
function migrateOldShape(raw: Record<string, unknown>): ParsedWorkRelevancePolicy {
  const projects: { projectKey: string; statusMap: Record<string, WorkRelevance> }[] = [];
  for (const [projectKey, value] of Object.entries(raw)) {
    if (typeof projectKey !== "string" || !projectKey.trim()) continue;
    if (!isPlainObject(value)) continue;
    projects.push({ projectKey, statusMap: parseOldShapeProjectStatusMap(value) });
  }

  const projectsRanked = [...projects].sort((a, b) => Object.keys(b.statusMap).length - Object.keys(a.statusMap).length || a.projectKey.localeCompare(b.projectKey));

  const valuesByStatus = new Map<string, Set<WorkRelevance>>();
  for (const p of projects) {
    for (const [status, relevance] of Object.entries(p.statusMap)) {
      const set = valuesByStatus.get(status) ?? new Set<WorkRelevance>();
      set.add(relevance);
      valuesByStatus.set(status, set);
    }
  }

  const policy: JiraWorkRelevancePolicyMap = {};
  const collapsedStatuses: string[] = [];
  for (const [status, values] of Array.from(valuesByStatus.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (values.size === 1) {
      policy[status] = Array.from(values)[0];
      continue;
    }
    const winner = projectsRanked.find((p) => status in p.statusMap)!;
    policy[status] = winner.statusMap[status];
    collapsedStatuses.push(status);
  }

  return {
    policy,
    migration: { fromProjectCount: projects.length, collapsedStatuses, migratedAt: new Date().toISOString() },
  };
}

/** Defensive parse for persisted state — malformed/missing/wrong-typed data always degrades
 *  to an empty policy map (every Jira status UNKNOWN, the safe conservative default) rather
 *  than crashing or guessing (§26 backward compatibility). V2.11 §1 additionally migrates a
 *  pre-V2.11 per-project blob into the new global shape — see migrateOldShape above. */
export function parseWorkRelevancePolicyMap(raw: unknown): ParsedWorkRelevancePolicy {
  if (!isPlainObject(raw)) return { policy: {} };

  if (looksLikeOldPerProjectShape(raw)) return migrateOldShape(raw);

  const policy: JiraWorkRelevancePolicyMap = {};
  for (const [status, relevance] of Object.entries(raw)) {
    if (typeof status === "string" && status.trim() && isValidRelevance(relevance)) policy[status] = relevance;
  }
  return { policy };
}

/** §28 performance — Map<JiraStatus, WorkRelevance>, built once per render (see
 *  use-command-center.ts) rather than re-scanned per work item inside a loop. */
export type WorkRelevanceIndex = Map<string, WorkRelevance>;

export function buildWorkRelevanceIndex(policyMap: JiraWorkRelevancePolicyMap | undefined | null): WorkRelevanceIndex {
  return new Map(Object.entries(policyMap ?? {}));
}

const JIRA_PROJECT_ID_PREFIX = "jira-project-";

/** The Jira project KEY a work item belongs to, derived from its own `projectId` foreign key
 *  (already `jira-project-${key}` per jira/normalize.ts) — never a second lookup table. Still
 *  used for per-project labeling/grouping (e.g. the Distribution panel, Focus Project Scope) —
 *  the policy itself is global (§1), but a WorkItem's own project identity is not. */
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
  if (!jiraProjectKeyForWorkItem(item) || !item.jiraStatusName) return "NOT_APPLICABLE";
  return index.get(item.jiraStatusName) ?? "UNKNOWN";
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

/** V2.19 (bug fix) — the ONE canonical "is this ticket finished?" check, combining two
 *  independent completion signals: Jira's own statusCategory (`WorkItem.status === "Done"` —
 *  always available, zero configuration, derived in jira/mapping.ts's mapStatus from Jira's
 *  own `statusCategory.key === "done"`, and already the exact signal action-plan.ts's
 *  buildCandidates() uses to hard-exclude a finished item) OR the Work Relevance Policy's
 *  explicit COMPLETED/EXCLUDED classification of the exact raw status name (opt-in, requires
 *  the user to have classified that status in Data & Settings).
 *
 *  Confirmed bug this closes: every personal-work surface EXCEPT one already treats an
 *  unclassified status conservatively (UNKNOWN is never eligible — see isPersonalWorkEligible
 *  above), so a Jira-Done-but-not-yet-classified ticket was already excluded from My Day/
 *  Action Plan by construction. The one exception is a MENTION attention item: it
 *  deliberately bypasses the Work Relevance gate entirely (a mention is a personal signal
 *  regardless of ticket status — see personal-focus.ts/proactive.ts's own "§1b" comments), so
 *  its own safety net for "the ticket this mention lives on is actually finished" needs an
 *  explicit check — and that check previously consulted ONLY the opt-in policy, so a mention
 *  on a genuinely Jira-Done ticket kept surfacing in Your Delivery Focus/the Attention Queue
 *  forever on any install where the user hadn't yet visited Data & Settings to classify that
 *  exact status name. This function gives that one call site (see proactive.ts's
 *  completedOrExcludedWorkItemIds) the same zero-config floor every other surface already had.
 *  Never the reverse: an item whose native status is NOT "Done" and whose exact status name is
 *  still UNKNOWN in the policy is correctly NOT reported finished here — conservatism (§26) is
 *  preserved, this only adds a floor under it, never removes it. */
export function isWorkItemDoneOrExcluded(item: Pick<WorkItem, "status" | "sourceType" | "projectId" | "jiraStatusName">, index: WorkRelevanceIndex | undefined): boolean {
  if (item.status === "Done") return true;
  if (!index) return false;
  const relevance = resolveWorkRelevance(item, index);
  return relevance === "COMPLETED" || relevance === "EXCLUDED";
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
      answer: `${item.key} is currently "${item.jiraStatusName}". This Jira status has not been classified yet. Daily Command does not treat unclassified statuses as actionable.`,
    };
  }
  return {
    isApplicable: true,
    relevance,
    // V2.11 §1 — no longer "... for {projectKey}": the classification is global, so naming a
    // project here would misleadingly imply it could differ elsewhere.
    answer: `${item.key} is currently "${item.jiraStatusName}". This status is classified as ${relevance}. ${WORK_RELEVANCE_EXPLANATIONS[relevance]}`,
  };
}

/** §6 — statuses the settings UI can offer to classify, derived from OBSERVED Jira data
 *  rather than a hard-coded list. V2.11 §1 — global by default (every synced project);
 *  `projectKeys` optionally narrows to a subset (e.g. Focus Project Scope), same convention as
 *  computeOverallWorkRelevanceCoverage below. Sorted for a stable UI. */
export function collectObservedStatuses(data: CommandCenterData, projectKeys?: string[]): string[] {
  const scope = projectKeys && projectKeys.length > 0 ? new Set(projectKeys) : undefined;
  const seen = new Set<string>();
  for (const item of data.workItems) {
    const projectKey = jiraProjectKeyForWorkItem(item);
    if (!projectKey || !item.jiraStatusName) continue;
    if (scope && !scope.has(projectKey)) continue;
    seen.add(item.jiraStatusName);
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

/** §19 Data Health / Trust signal — count of distinct statuses currently UNKNOWN among open
 *  Jira work items in `data`. V2.11 §1 — deduped by STATUS NAME alone: since the policy is
 *  global, classifying a status once fixes it everywhere it's observed, so it's one
 *  remediation action, not one per project. A dimension of its own, never blended into
 *  Delivery Confidence or any other score. */
export function countUnclassifiedJiraStatuses(data: CommandCenterData, index: WorkRelevanceIndex): number {
  const unclassified = new Set<string>();
  for (const item of data.workItems) {
    if (item.status === "Done") continue;
    const projectKey = jiraProjectKeyForWorkItem(item);
    if (!projectKey || !item.jiraStatusName) continue;
    if (resolveWorkRelevance(item, index) === "UNKNOWN") unclassified.add(item.jiraStatusName);
  }
  return unclassified.size;
}

/** One row per unclassified status — used by the Command Bar's "which Jira statuses are not
 *  classified?" intent and the Data & Settings unclassified list. V2.11 §1 — global, one row
 *  per distinct status name (no project dimension; see countUnclassifiedJiraStatuses above). */
export interface UnclassifiedStatusRow {
  status: string;
}

export function listUnclassifiedJiraStatuses(data: CommandCenterData, index: WorkRelevanceIndex): UnclassifiedStatusRow[] {
  return listStatusesByRelevance(data, index, "UNKNOWN");
}

/** V2.6 §17 — generalized status rows currently classified as `relevance`, e.g. for the
 *  Command Bar's "which statuses are actionable?" intent. `listUnclassifiedJiraStatuses` above
 *  is the UNKNOWN special case, kept as its own export since it's the one V2.5 already wired
 *  everywhere (Data & Settings, Command Bar) — this is purely additive. V2.11 §1 — global,
 *  deduped by status name alone. */
export function listStatusesByRelevance(data: CommandCenterData, index: WorkRelevanceIndex, relevance: WorkRelevance): UnclassifiedStatusRow[] {
  const seen = new Set<string>();
  for (const item of data.workItems) {
    if (!jiraProjectKeyForWorkItem(item) || !item.jiraStatusName) continue;
    if (resolveWorkRelevance(item, index) !== relevance) continue;
    seen.add(item.jiraStatusName);
  }
  return Array.from(seen)
    .sort((a, b) => a.localeCompare(b))
    .map((status) => ({ status }));
}

/** Work items whose CURRENT effective relevance matches `relevance` exactly — used by the
 *  Command Bar's "what is in UAT?" (OBSERVE) / "what is waiting?" (WAITING) intents. Never
 *  matches NOT_APPLICABLE items (a demo/local-import item can't be "OBSERVE" or "WAITING"). */
export function workItemsByRelevance(data: CommandCenterData, index: WorkRelevanceIndex, relevance: WorkRelevance): WorkItem[] {
  return data.workItems.filter((w) => resolveWorkRelevance(w, index) === relevance);
}

/** Pure updater for one status's classification — store.ts's setJiraStatusRelevance delegates
 *  here. V2.11 §1 — global: no projectKey parameter at all, since a classification now applies
 *  to every project at once. */
export function withStatusRelevance(policyMap: JiraWorkRelevancePolicyMap, status: string, relevance: WorkRelevance): JiraWorkRelevancePolicyMap {
  return { ...policyMap, [status]: relevance };
}

// ===== V2.6 — Work Policy Intelligence & Operational Calibration =====
// Additive calibration layer on top of V2.5 above: status coverage arithmetic and a
// deterministic policy-change impact count. No new classification logic — every function
// below is a read over the SAME index/policy map V2.5 already builds and enforces.

/** §4 — deterministic coverage state for the observed Jira status vocabulary (optionally
 *  scoped to a subset of projects). Plain arithmetic, never a blended score (§4). */
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

/** §4, §10 — coverage across every OBSERVED status currently in scope, for the single "X%
 *  classified" figure the Data Health panel (and, since V2.11 §1, the single global Work
 *  Relevance Policy panel) shows (§10 "do not create a second status-management page").
 *  V2.11 §1 — deduped by status name alone, matching the now-global policy: `projectKeys`
 *  still narrows which projects' OBSERVED vocabulary counts (e.g. Focus Projects), but the
 *  classification itself is the same regardless of which project asks. Supersedes the old
 *  per-project `computeStatusCoverage` (identical arithmetic once policy is global — a single
 *  project is just `projectKeys: [thatKey]`). */
export function computeOverallWorkRelevanceCoverage(data: CommandCenterData, index: WorkRelevanceIndex, projectKeys?: string[]): WorkRelevanceCoverage {
  const scope = projectKeys && projectKeys.length > 0 ? new Set(projectKeys) : undefined;
  const seen = new Set<string>();
  let observedCount = 0;
  let classifiedCount = 0;
  for (const item of data.workItems) {
    const projectKey = jiraProjectKeyForWorkItem(item);
    if (!projectKey || !item.jiraStatusName) continue;
    if (scope && !scope.has(projectKey)) continue;
    if (seen.has(item.jiraStatusName)) continue;
    seen.add(item.jiraStatusName);
    observedCount++;
    if (index.get(item.jiraStatusName)) classifiedCount++;
  }
  return coverageFrom(observedCount, classifiedCount);
}

/** §8-9 — deterministic policy-change impact: how many currently-open work items across ALL
 *  projects carry this exact raw status right now. Used to preview "+N personal work items"
 *  BEFORE a classification change is applied — never a guess, always a live count over `data`
 *  (§8 "the impact calculation must use actual current data"). V2.11 §1 — global: a status
 *  change now affects every project's items in that status, so the count is no longer scoped
 *  to one project. */
export function countOpenItemsForStatus(data: CommandCenterData, status: string): number {
  let count = 0;
  for (const item of data.workItems) {
    if (item.status === "Done") continue;
    if (jiraProjectKeyForWorkItem(item) && item.jiraStatusName === status) count++;
  }
  return count;
}
