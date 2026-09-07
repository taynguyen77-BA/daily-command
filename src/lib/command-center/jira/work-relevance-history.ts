// V2.12 — Work Item Calibration History. The one persisted time-series record needed to
// honestly answer "how long has this status been ACTIONABLE" and "did this item ever enter
// the candidate pool" — neither question is answerable from any existing structure (a bare
// WorkItem, the jiraWorkRelevancePolicy map, or the daily-close-only snapshotHistory) since
// none of them carry a per-status-entry timestamp or a historical record of candidate-pool
// membership (see the V2.12 signal-semantics audit). This module only APPENDS
// first-observed timestamps; it never scores, classifies, or mutates policy — same
// discipline as jira/work-relevance-calibration.ts.
//
// Honesty constraint: there is no way to backfill history for items already ACTIONABLE
// before this shipped — every entry's `firstObservedAt` is, at the earliest, the day this
// tracking went live. Signals built on top of this (see jira/work-relevance-signals.ts) must
// report "not enough evidence yet" rather than fabricate a "since" date for pre-existing
// data.

import { buildCandidates } from "../action-plan";
import type { CommandCenterData } from "../types";
import { resolveWorkRelevance, type WorkRelevanceIndex } from "./work-relevance";

export interface WorkItemCalibrationHistoryEntry {
  itemId: string;
  statusName: string;
  firstObservedAt: string; // ISO date — first sync this item was observed in this status
  firstSeenInCandidatePoolAt?: string; // ISO date — first sync it was observed in the candidate pool while in this status
}

export type WorkItemCalibrationHistory = Record<string, WorkItemCalibrationHistoryEntry>;

function historyKey(itemId: string, statusName: string): string {
  return `${itemId}::${statusName}`;
}

/** Pure, additive update — called once per real Jira sync. For every open, classified Jira
 *  item, records the first day it was observed in its CURRENT status, and the first day (if
 *  any) it was observed inside the candidate pool while in that status. An entry for a
 *  status/item pair no longer present (item moved on, was completed, or dropped out of
 *  scope) is simply not carried into `next` — re-entering a status later honestly restarts
 *  the clock for that occurrence rather than resurrecting old evidence. */
export function updateWorkItemCalibrationHistory(previous: WorkItemCalibrationHistory, data: CommandCenterData, index: WorkRelevanceIndex, today: string): WorkItemCalibrationHistory {
  const candidateIds = new Set(
    buildCandidates(data, today, index)
      .map((c) => c.item?.id)
      .filter((id): id is string => !!id)
  );

  const next: WorkItemCalibrationHistory = {};
  for (const item of data.workItems) {
    if (item.sourceType !== "jira" || item.status === "Done" || !item.jiraStatusName) continue;
    const relevance = resolveWorkRelevance(item, index);
    if (relevance === "NOT_APPLICABLE" || relevance === "UNKNOWN") continue;

    const key = historyKey(item.id, item.jiraStatusName);
    const prior = previous[key];
    const firstObservedAt = prior?.firstObservedAt ?? today;
    const firstSeenInCandidatePoolAt = prior?.firstSeenInCandidatePoolAt ?? (candidateIds.has(item.id) ? today : undefined);

    next[key] = { itemId: item.id, statusName: item.jiraStatusName, firstObservedAt, firstSeenInCandidatePoolAt };
  }
  return next;
}

export function calibrationHistoryEntryFor(history: WorkItemCalibrationHistory, itemId: string, statusName: string): WorkItemCalibrationHistoryEntry | undefined {
  return history[historyKey(itemId, statusName)];
}
