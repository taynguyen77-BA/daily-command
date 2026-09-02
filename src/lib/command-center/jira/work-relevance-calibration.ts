// V2.7 — Work Relevance Operational Calibration. Answers "is my Work Relevance Policy
// actually matching how I work over time?" with deterministic evidence over EXISTING state
// — the V2.5 policy map, the V2.5/V2.6 enforcement functions in ./work-relevance.ts, the
// existing action-plan.ts candidate pool, and the existing Action model. No new task
// system, no new scoring engine, no AI, no automatic policy mutation.
//
// Core boundary (per the spec this module implements): user behavior (an explicit Action
// linked to a work item, or its completion) is EVIDENCE for a human to review — never an
// instruction this code acts on. Nothing here writes to jiraWorkRelevancePolicy.
//
// Scope: every function takes an optional `projectKeys` filter. Undefined means "every
// Jira project observed in `data`" — callers already operating on Focus-Project-Scoped
// data (e.g. Command Bar's `filteredData`, already narrowed by applyProjectScope) pass
// nothing; callers working from the raw unscoped store (e.g. Data & Settings, which reads
// `state.data` directly) pass `state.jiraProjectScope.projectKeys` explicitly — the same
// convention V2.6's computeOverallWorkRelevanceCoverage already established.

import { buildCandidates } from "../action-plan";
import type { Action, CommandCenterData, WorkItem, WorkRelevance } from "../types";
import { WORK_RELEVANCE_VALUES } from "../types";
import { jiraProjectKeyForWorkItem, resolveWorkRelevance, type WorkRelevanceIndex } from "./work-relevance";

// A status needs at least this many OBSERVED items before any policy-review signal is
// trusted — below this, the honest answer is "not enough evidence", never a guess (§5, §11).
const MIN_ITEMS_FOR_SIGNAL = 3;
// For a non-ACTIONABLE status (OBSERVE/WAITING/COMPLETED/EXCLUDED): a single linked Action
// could be a one-off human workaround; a repeated pattern (2+) is what's worth surfacing.
const NON_ACTIONABLE_ACTION_REVIEW_THRESHOLD = 2;

function inScope(projectKey: string | undefined, projectKeys: string[] | undefined): projectKey is string {
  if (!projectKey) return false;
  return !projectKeys || projectKeys.length === 0 || projectKeys.includes(projectKey);
}

function jiraItemsInScope(data: CommandCenterData, projectKeys: string[] | undefined): WorkItem[] {
  return data.workItems.filter((w) => w.sourceType === "jira" && inScope(jiraProjectKeyForWorkItem(w), projectKeys));
}

/** One pass building Action lookup by the WorkItem it's linked to — O(1) membership checks
 *  instead of an O(items × actions) scan (§25 performance). */
function buildActionsByWorkItemId(data: CommandCenterData): Map<string, Action[]> {
  const index = new Map<string, Action[]>();
  for (const action of data.actions) {
    if (!action.relatedWorkItemId) continue;
    const list = index.get(action.relatedWorkItemId);
    if (list) list.push(action);
    else index.set(action.relatedWorkItemId, [action]);
  }
  return index;
}

// ===== §4 — Policy Effectiveness Snapshot =====
// Plain counts, never a blended "work relevance score". Always broken down per project
// (§13 isolation) — the caller decides how many projects are in scope via `projectKeys`.

export interface WorkRelevanceDistributionRow {
  projectKey: string;
  counts: Record<WorkRelevance, number>;
  totalItems: number;
}

/** Every Jira-sourced item currently in scope, including Done/closed ones — this is meant
 *  to show the full shape of synced Jira work (§4's own worked example includes a
 *  COMPLETED count), unlike the calibration functions below which look only at OPEN items
 *  (open work is what personal-work calibration is actually about). */
export function computeWorkRelevanceDistribution(data: CommandCenterData, index: WorkRelevanceIndex, projectKeys?: string[]): WorkRelevanceDistributionRow[] {
  const byProject = new Map<string, Record<WorkRelevance, number>>();
  for (const item of jiraItemsInScope(data, projectKeys)) {
    const projectKey = jiraProjectKeyForWorkItem(item)!;
    const relevance = resolveWorkRelevance(item, index);
    if (relevance === "NOT_APPLICABLE") continue; // can't happen for a Jira-sourced item with a status, defensive only
    let counts = byProject.get(projectKey);
    if (!counts) {
      counts = { ACTIONABLE: 0, WAITING: 0, OBSERVE: 0, COMPLETED: 0, EXCLUDED: 0, UNKNOWN: 0 };
      byProject.set(projectKey, counts);
    }
    counts[relevance]++;
  }
  return Array.from(byProject.entries())
    .map(([projectKey, counts]) => ({ projectKey, counts, totalItems: WORK_RELEVANCE_VALUES.reduce((sum, v) => sum + counts[v], 0) }))
    .sort((a, b) => a.projectKey.localeCompare(b.projectKey));
}

// ===== §5 — Actionable Work Calibration =====
// The real, honestly-derivable pipeline for a raw Jira WorkItem (Personal Focus itself is
// built from Attention Queue / Delivery Loops, NOT raw work items — see the architecture
// audit in the V2.7 final report — so "appeared in Personal Focus" is not a claim this
// module can honestly make for a bare WorkItem; "entered the candidate pool" via the
// existing action-plan.ts buildCandidates() is the real, reused equivalent).

export interface ActionableCalibrationResult {
  actionableItemCount: number;
  candidatePoolCount: number; // reused from action-plan.ts buildCandidates() — not reimplemented
  actedOnCount: number; // has at least one linked, explicitly user/system-created Action
  completedCount: number; // has at least one linked Action with status "completed"
}

export function computeActionableCalibration(data: CommandCenterData, index: WorkRelevanceIndex, today: string, projectKeys?: string[]): ActionableCalibrationResult {
  const actionableItems = jiraItemsInScope(data, projectKeys).filter((w) => w.status !== "Done" && resolveWorkRelevance(w, index) === "ACTIONABLE");
  const actionableIds = new Set(actionableItems.map((w) => w.id));

  const candidatePoolIds = new Set(buildCandidates(data, today, index).map((c) => c.item?.id).filter((id): id is string => !!id && actionableIds.has(id)));

  const actionsByWorkItemId = buildActionsByWorkItemId(data);
  let actedOnCount = 0;
  let completedCount = 0;
  for (const item of actionableItems) {
    const linked = actionsByWorkItemId.get(item.id);
    if (!linked || linked.length === 0) continue;
    actedOnCount++;
    if (linked.some((a) => a.status === "completed")) completedCount++;
  }

  return { actionableItemCount: actionableItems.length, candidatePoolCount: candidatePoolIds.size, actedOnCount, completedCount };
}

// ===== §6 — Observe Calibration =====
// Verifies (over REAL data, not just structurally assumed) that OBSERVE items stay out of
// the automatic candidate pool. §22 — an explicit user-created Action on an OBSERVE item is
// untouched by this check; it's evidence for §8 Signal A, not a "violation".

export interface ObserveCalibrationResult {
  observeItemCount: number;
  outsidePersonalWorkCount: number;
  policyViolationCount: number; // structurally always 0 — see jira/work-relevance.ts's isPersonalWorkEligible gate; computed for real, not assumed
}

export function computeObserveCalibration(data: CommandCenterData, index: WorkRelevanceIndex, today: string, projectKeys?: string[]): ObserveCalibrationResult {
  const observeItems = jiraItemsInScope(data, projectKeys).filter((w) => w.status !== "Done" && resolveWorkRelevance(w, index) === "OBSERVE");
  const observeIds = new Set(observeItems.map((w) => w.id));
  // §22 — an explicit user-created Action linked to an OBSERVE item legitimately produces a
  // PlanCandidate too (action-plan.ts's own, deliberate V2.5 behavior: "the gate only stops
  // AUTOMATIC WorkItem-to-candidate inference, never a user's own explicit Action"). Only an
  // AUTO-SUGGESTED candidate (no `.action` — action-plan.ts's `plan-${item.id}` slot) is the
  // real automatic-inference gate this check verifies; an explicit Action is evidence for a
  // Policy Review Signal (§8), never a "violation".
  const autoSuggestedIds = new Set(
    buildCandidates(data, today, index)
      .filter((c) => !c.action && c.item)
      .map((c) => c.item!.id)
  );
  const violatingCount = observeItems.filter((w) => autoSuggestedIds.has(w.id)).length;
  return { observeItemCount: observeItems.length, outsidePersonalWorkCount: observeIds.size - violatingCount, policyViolationCount: violatingCount };
}

// ===== §7 — Unknown Visibility =====

export interface UnknownVisibilitySummary {
  statusCount: number; // distinct (project, status) pairs currently UNKNOWN
  affectedItemCount: number; // open items carrying one of those statuses
}

export function computeUnknownVisibility(data: CommandCenterData, index: WorkRelevanceIndex, projectKeys?: string[]): UnknownVisibilitySummary {
  const pairs = new Set<string>();
  let affectedItemCount = 0;
  for (const item of jiraItemsInScope(data, projectKeys)) {
    if (item.status === "Done" || !item.jiraStatusName) continue;
    if (resolveWorkRelevance(item, index) !== "UNKNOWN") continue;
    pairs.add(`${jiraProjectKeyForWorkItem(item)}::${item.jiraStatusName}`);
    affectedItemCount++;
  }
  return { statusCount: pairs.size, affectedItemCount };
}

// ===== §8-11 — Policy Review Signals / Status-Level Calibration Table =====
// One PolicyReviewSignal row per observed (project, status) pair — doubles as both the
// §10 status-level table and the §11 "PolicyReviewSignal" concept; there is no separate
// architecture for these, by design (§37 scope discipline — one structure, two views).

export type PolicySignalType = "REVIEW" | "NONE" | "INSUFFICIENT_EVIDENCE";

export interface PolicyReviewSignal {
  projectKey: string;
  statusName: string;
  currentRelevance: WorkRelevance;
  observedItemCount: number;
  actionEvidenceCount: number; // count of Actions linked to items in this (project, status) — not distinct items
  completionEvidenceCount: number; // of those linked Actions, how many are completed
  signalType: PolicySignalType;
  explanation: string;
}

function explainSignal(relevance: WorkRelevance, signalType: PolicySignalType, observedItemCount: number, actionEvidenceCount: number): string {
  if (signalType === "INSUFFICIENT_EVIDENCE") {
    return `Only ${observedItemCount} observed item(s) — not enough evidence yet for a reliable calibration signal.`;
  }
  if (relevance === "ACTIONABLE") {
    return signalType === "REVIEW"
      ? `${observedItemCount} item(s) are classified ACTIONABLE, but none have a linked personal Action yet. This may be worth reviewing.`
      : `${observedItemCount} item(s) classified ACTIONABLE; ${actionEvidenceCount} linked Action(s) observed.`;
  }
  return signalType === "REVIEW"
    ? `${actionEvidenceCount} explicit user Action(s) are linked to items in this status, even though it is classified ${relevance}. This may be worth reviewing.`
    : `Current policy: ${relevance}. ${actionEvidenceCount} linked Action(s) observed — no notable calibration signal.`;
}

/** Excludes UNKNOWN statuses — those are covered by computeUnknownVisibility (§7) as their
 *  own safety category, not folded into "review" language here. */
export function computePolicyReviewSignals(data: CommandCenterData, index: WorkRelevanceIndex, projectKeys?: string[]): PolicyReviewSignal[] {
  const actionsByWorkItemId = buildActionsByWorkItemId(data);
  const groups = new Map<string, { projectKey: string; statusName: string; relevance: WorkRelevance; items: WorkItem[] }>();

  for (const item of jiraItemsInScope(data, projectKeys)) {
    if (item.status === "Done" || !item.jiraStatusName) continue;
    const relevance = resolveWorkRelevance(item, index);
    if (relevance === "NOT_APPLICABLE" || relevance === "UNKNOWN") continue;
    const projectKey = jiraProjectKeyForWorkItem(item)!;
    const key = `${projectKey}::${item.jiraStatusName}`;
    let group = groups.get(key);
    if (!group) {
      group = { projectKey, statusName: item.jiraStatusName, relevance, items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }

  const rows: PolicyReviewSignal[] = [];
  for (const group of Array.from(groups.values())) {
    const linkedActions = group.items.flatMap((item) => actionsByWorkItemId.get(item.id) ?? []);
    const actionEvidenceCount = linkedActions.length;
    const completionEvidenceCount = linkedActions.filter((a) => a.status === "completed").length;
    const observedItemCount = group.items.length;

    let signalType: PolicySignalType;
    if (observedItemCount < MIN_ITEMS_FOR_SIGNAL) {
      signalType = "INSUFFICIENT_EVIDENCE";
    } else if (group.relevance === "ACTIONABLE") {
      signalType = actionEvidenceCount === 0 ? "REVIEW" : "NONE";
    } else {
      signalType = actionEvidenceCount >= NON_ACTIONABLE_ACTION_REVIEW_THRESHOLD ? "REVIEW" : "NONE";
    }

    rows.push({
      projectKey: group.projectKey,
      statusName: group.statusName,
      currentRelevance: group.relevance,
      observedItemCount,
      actionEvidenceCount,
      completionEvidenceCount,
      signalType,
      explanation: explainSignal(group.relevance, signalType, observedItemCount, actionEvidenceCount),
    });
  }

  return rows.sort((a, b) => a.projectKey.localeCompare(b.projectKey) || a.statusName.localeCompare(b.statusName));
}

// ===== §12 — Data Health integration state =====

export type CalibrationHealthState = "HEALTHY" | "REVIEW" | "INSUFFICIENT_EVIDENCE";

export function computeCalibrationHealthState(signals: PolicyReviewSignal[]): CalibrationHealthState {
  if (signals.length === 0) return "INSUFFICIENT_EVIDENCE";
  if (signals.some((s) => s.signalType === "REVIEW")) return "REVIEW";
  if (signals.every((s) => s.signalType === "INSUFFICIENT_EVIDENCE")) return "INSUFFICIENT_EVIDENCE";
  return "HEALTHY";
}
