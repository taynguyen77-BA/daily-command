// V2.12 — Signal Semantics Fix. Splits the single conflated "something's off, Review
// Policy" alert into three semantically distinct signals, each answering a genuinely
// different question about a genuinely different pipeline stage:
//
//   ACTIONABLE  !=  ENTERED CANDIDATE POOL  !=  HAS PERSONAL ACTION/FOCUS
//
// - Policy Review Signal   — the classification itself may be wrong (real, time-windowed,
//   percentage-and-sample-gated evidence only). The ONLY signal allowed the "Review Policy"
//   CTA — see the V2.12 audit's confirmed bug (Candidate Evaluation was also rendering that
//   CTA, blurring the two together).
// - Candidate Evaluation Signal — informational. Zero conversion this period, but not
//   (yet) enough evidence for a policy claim. Never suggests changing the policy.
// - Execution Gap Signal — the item already passed candidate evaluation; the gap is
//   downstream (no Action/Focus linked), an item-level triage question, not a policy one.
//
// Scope: this file only covers ACTIONABLE-status signals — the ones the V2.12 audit found
// conflated. The non-ACTIONABLE "this status has repeated user Actions even though it's
// classified WAITING/OBSERVE/etc." signal (work-relevance-calibration.ts §8-11) is a
// different, already-correctly-scoped classification-risk question and is untouched here.
//
// Depends on jira/work-relevance-history.ts for the one thing raw current-state can never
// answer honestly: how long a status has been ACTIONABLE, and whether an item EVER entered
// the candidate pool (not just "currently doesn't"). Until enough history has accumulated
// (tracking starts the day this shipped — no retroactive backfill is possible), Policy
// Review Signal simply does not fire; that absence is itself honest, never papered over.

import { buildCandidates } from "../action-plan";
import { listJiraItemsInPersonalFocus, type ExecutionPathStatusRow } from "../execution-path";
import type { ProactiveIntelligence } from "../proactive";
import type { CommandCenterData, PersonalFocusResult, WorkItem } from "../types";
import { jiraProjectKeyForWorkItem, resolveWorkRelevance, type WorkRelevanceIndex } from "./work-relevance";
import { calibrationHistoryEntryFor, type WorkItemCalibrationHistory } from "./work-relevance-history";

// Requirement 1's own minimum — deliberately higher than the 3-item floor
// work-relevance-calibration.ts uses elsewhere: a claim that risks changing policy needs a
// bigger sample than a per-status informational note does.
const POLICY_REVIEW_MIN_SAMPLE_SIZE = 10;
const POLICY_REVIEW_PERCENT_THRESHOLD = 90;
// No "sprint" concept exists anywhere in this data model (confirmed in the V2.12 audit) —
// expressed in calendar days instead. ~3 sprints at a common 2-week cadence.
const POLICY_REVIEW_MIN_DAYS_ACTIONABLE = 42;
// Requirement 2 reuses the same conservative floor V2.7/V2.8 already use for "is there even
// enough evidence to say anything" — this is an informational note, not a policy claim, so
// it can afford a lower bar than Requirement 1's.
const CANDIDATE_EVALUATION_MIN_SAMPLE_SIZE = 3;
// The spec's "Y business days" approximated as calendar days — no business-calendar concept
// exists elsewhere in this codebase either.
const EXECUTION_GAP_GRACE_DAYS = 5;

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.floor((to - from) / 86_400_000));
}

function inScope(projectKey: string | undefined, projectKeys: string[] | undefined): projectKey is string {
  if (!projectKey) return false;
  return !projectKeys || projectKeys.length === 0 || projectKeys.includes(projectKey);
}

function actionableItemsInScope(data: CommandCenterData, index: WorkRelevanceIndex, projectKeys: string[] | undefined): WorkItem[] {
  return data.workItems.filter(
    (w) => w.sourceType === "jira" && w.status !== "Done" && !!w.jiraStatusName && inScope(jiraProjectKeyForWorkItem(w), projectKeys) && resolveWorkRelevance(w, index) === "ACTIONABLE"
  );
}

// ===== Requirement 1 — Policy Review Signal =====

export interface ActionablePolicyReviewSignal {
  statusName: string;
  observedItemCount: number;
  neverEnteredPoolCount: number;
  neverEnteredPoolPercent: number; // 0-100, rounded
  daysActionable: number; // lower-bound: how long we've directly observed this status as ACTIONABLE
  explanation: string;
}

// ===== Requirement 2 — Candidate Evaluation Signal (informational, never "Review Policy") =====

export interface CandidateEvaluationSignal {
  statusName: string;
  observedItemCount: number;
  explanation: string;
}

// ===== Requirement 3 — Execution Gap Signal (item-level, already a candidate) =====

export interface ExecutionGapSignal {
  itemId: string;
  itemKey: string;
  itemTitle: string;
  statusName: string;
  daysSinceCandidateEntry: number;
  explanation: string;
}

export interface ActionableSignals {
  policyReview: ActionablePolicyReviewSignal[];
  candidateEvaluation: CandidateEvaluationSignal[];
  executionGap: ExecutionGapSignal[];
}

interface StatusGroup {
  statusName: string;
  items: WorkItem[];
}

function groupByStatus(items: WorkItem[]): StatusGroup[] {
  const groups = new Map<string, WorkItem[]>();
  for (const item of items) {
    const list = groups.get(item.jiraStatusName!);
    if (list) list.push(item);
    else groups.set(item.jiraStatusName!, [item]);
  }
  return Array.from(groups.entries())
    .map(([statusName, groupItems]) => ({ statusName, items: groupItems }))
    .sort((a, b) => a.statusName.localeCompare(b.statusName));
}

/** Requirements 1 & 2 — one pass over every ACTIONABLE status, splitting each into: real
 *  policy-review evidence (Requirement 1), a softer informational note (Requirement 2), or
 *  nothing at all (healthy / not enough items to say anything). A status can only ever
 *  appear in ONE of the two — never both — per Requirement 2's own gate ("does NOT meet
 *  Requirement 1's threshold"). */
function computePolicyReviewAndCandidateEvaluationSignals(
  data: CommandCenterData,
  index: WorkRelevanceIndex,
  history: WorkItemCalibrationHistory,
  today: string,
  projectKeys: string[] | undefined
): { policyReview: ActionablePolicyReviewSignal[]; candidateEvaluation: CandidateEvaluationSignal[] } {
  const candidateIds = new Set(
    buildCandidates(data, today, index)
      .map((c) => c.item?.id)
      .filter((id): id is string => !!id)
  );

  const policyReview: ActionablePolicyReviewSignal[] = [];
  const candidateEvaluation: CandidateEvaluationSignal[] = [];

  for (const group of groupByStatus(actionableItemsInScope(data, index, projectKeys))) {
    const observedItemCount = group.items.length;
    const currentlyZeroConversion = group.items.every((item) => !candidateIds.has(item.id));

    const historyEntries = group.items.map((item) => calibrationHistoryEntryFor(history, item.id, group.statusName));
    const neverEnteredPoolCount = historyEntries.filter((h) => !h?.firstSeenInCandidatePoolAt).length;
    const neverEnteredPoolPercent = observedItemCount > 0 ? Math.round((neverEnteredPoolCount / observedItemCount) * 100) : 0;
    // A conservative lower bound: the earliest sync this status was actually observed as
    // ACTIONABLE for any currently-observed item. Never extrapolated beyond what was
    // actually recorded (§ "never fabricate evidence").
    const earliestObservedAt = historyEntries.reduce<string | undefined>((earliest, h) => {
      if (!h) return earliest;
      return !earliest || h.firstObservedAt < earliest ? h.firstObservedAt : earliest;
    }, undefined);
    const daysActionable = earliestObservedAt ? daysBetween(earliestObservedAt, today) : 0;

    const meetsPolicyReviewBar =
      observedItemCount >= POLICY_REVIEW_MIN_SAMPLE_SIZE && daysActionable >= POLICY_REVIEW_MIN_DAYS_ACTIONABLE && neverEnteredPoolPercent >= POLICY_REVIEW_PERCENT_THRESHOLD;

    if (meetsPolicyReviewBar) {
      policyReview.push({
        statusName: group.statusName,
        observedItemCount,
        neverEnteredPoolCount,
        neverEnteredPoolPercent,
        daysActionable,
        explanation: `\`${group.statusName}\` has been classified ACTIONABLE for ${daysActionable} day(s). ${neverEnteredPoolPercent}% of items never entered candidate evaluation in that time. This may indicate the ACTIONABLE classification for \`${group.statusName}\` does not match observed execution behavior.`,
      });
      continue;
    }

    if (currentlyZeroConversion && observedItemCount >= CANDIDATE_EVALUATION_MIN_SAMPLE_SIZE) {
      candidateEvaluation.push({
        statusName: group.statusName,
        observedItemCount,
        explanation: `${observedItemCount} item(s) in \`${group.statusName}\` are ACTIONABLE. None entered the candidate pool this period. This is not necessarily a problem — candidate evaluation requires additional delivery signals (risk, dependency, decision, deadline, or attention). No policy change is recommended from this signal alone.`,
      });
    }
  }

  return { policyReview, candidateEvaluation };
}

/** Requirement 3 — per-item, not per-status. Only items that already have a recorded
 *  candidate-pool entry date (a real historical fact, not "currently still a live
 *  candidate" — score/eligibility can legitimately drift after entry) and have gone at
 *  least the grace period with no Action AND no Personal Focus presence. An Action always
 *  implies "no Outcome without an Action" is impossible, so checking for a linked Action
 *  already covers the Outcome case too. */
function computeExecutionGapSignals(
  data: CommandCenterData,
  index: WorkRelevanceIndex,
  history: WorkItemCalibrationHistory,
  today: string,
  projectKeys: string[] | undefined,
  proactive: ProactiveIntelligence | null,
  personalFocus: PersonalFocusResult | null
): ExecutionGapSignal[] {
  const itemIdsWithAction = new Set(data.actions.filter((a) => a.relatedWorkItemId).map((a) => a.relatedWorkItemId!));
  const focusedItemIds = new Set(listJiraItemsInPersonalFocus(data, proactive, personalFocus).map((x) => x.item.id));

  const signals: ExecutionGapSignal[] = [];
  for (const item of actionableItemsInScope(data, index, projectKeys)) {
    if (itemIdsWithAction.has(item.id) || focusedItemIds.has(item.id)) continue;
    const entry = calibrationHistoryEntryFor(history, item.id, item.jiraStatusName!);
    if (!entry?.firstSeenInCandidatePoolAt) continue; // never (yet) entered the pool — a candidate-evaluation matter, not execution
    const daysSinceCandidateEntry = daysBetween(entry.firstSeenInCandidatePoolAt, today);
    if (daysSinceCandidateEntry < EXECUTION_GAP_GRACE_DAYS) continue; // still inside the grace period

    signals.push({
      itemId: item.id,
      itemKey: item.key,
      itemTitle: item.title,
      statusName: item.jiraStatusName!,
      daysSinceCandidateEntry,
      explanation: `${item.key} in \`${item.jiraStatusName}\` has had no linked Action or Focus for ${daysSinceCandidateEntry}+ days. Because it already passed candidate evaluation, this may represent an execution gap.`,
    });
  }
  return signals.sort((a, b) => b.daysSinceCandidateEntry - a.daysSinceCandidateEntry);
}

export function computeActionableSignals(
  data: CommandCenterData,
  index: WorkRelevanceIndex,
  history: WorkItemCalibrationHistory,
  today: string,
  projectKeys: string[] | undefined,
  proactive: ProactiveIntelligence | null,
  personalFocus: PersonalFocusResult | null
): ActionableSignals {
  const { policyReview, candidateEvaluation } = computePolicyReviewAndCandidateEvaluationSignals(data, index, history, today, projectKeys);
  const executionGap = computeExecutionGapSignals(data, index, history, today, projectKeys, proactive, personalFocus);
  return { policyReview, candidateEvaluation, executionGap };
}

// Re-exported so callers building the Requirement 4 mini-funnel don't need a second import
// from execution-path.ts just for the row shape.
export type { ExecutionPathStatusRow };
