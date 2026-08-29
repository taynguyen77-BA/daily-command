// Weekly Review (BUILD REQUEST V1.2 §14). Every fact here is computed deterministically
// from data the app already has — the AI provider only narrates these facts into the
// required section headers; it is never given room to invent an achievement or a metric.

import { compareSnapshots } from "./memory";
import { detectRecurringPatterns } from "./pattern-detection";
import { scoreAllWorkItems } from "./scoring";
import { daysBetween } from "./scoring";
import type { Action, CommandCenterData, DailySnapshot, Decision, EvidenceSourceType, PriorityScoreResult, RecurringPattern, WorkItem } from "./types";

export interface WeeklyReviewFacts {
  hasEnoughHistory: boolean;
  windowDays: number;
  currentConfidence: number;
  confidenceDelta: number | null;
  gettingBetter: string[];
  gettingWorse: string[];
  recurringRisks: RecurringPattern[];
  decisionsMade: Decision[];
  decisionsUnresolved: Decision[];
  actionsCompleted: Action[];
  actionsThatDidNotResolveTheIssue: Action[];
  carryOverRisks: string[];
  nextWeekPriorities: { item: WorkItem; result: PriorityScoreResult }[];
}

const OPEN_DECISION_STATUSES = new Set(["pending", "ACTIVE", "AT_RISK", "REVISIT_REQUIRED"]);

export function buildWeeklyReviewFacts(
  data: CommandCenterData,
  history: DailySnapshot[],
  today: string,
  sourceType: EvidenceSourceType
): WeeklyReviewFacts {
  const window = history.slice(-7); // up to the last 7 persisted snapshots, oldest→newest
  const oldest = window[0];
  const latest = window[window.length - 1];

  const scores = scoreAllWorkItems(data, today);
  const currentConfidence =
    latest?.metrics?.deliveryConfidence ?? 0; // if no history at all, we still report today via memory.buildSnapshotMetrics at the call site

  const trend = oldest?.metrics && latest?.metrics ? compareSnapshots(latest.metrics, oldest.metrics) : null;

  const decisionsMade = data.decisions.filter((d) => {
    if (d.status !== "made" && d.status !== "SUPERSEDED") return false;
    if (!d.date && !d.dueDate) return true;
    const refDate = d.date ?? d.dueDate!;
    return oldest ? refDate >= oldest.date : true;
  });
  const decisionsUnresolved = data.decisions.filter((d) => OPEN_DECISION_STATUSES.has(d.status));

  const windowStartIso = oldest?.date ?? today;
  const actionsCompleted = data.actions.filter(
    (a) => a.status === "completed" && a.completedAt && a.completedAt >= windowStartIso
  );
  const actionsThatDidNotResolveTheIssue = actionsCompleted.filter((a) => {
    if (!a.relatedWorkItemId) return false;
    const item = data.workItems.find((w) => w.id === a.relatedWorkItemId);
    return !!item && (item.blocked || item.status === "Blocked");
  });

  const carryOverRisks = oldest?.metrics?.majorRiskTitles.filter((title) => data.risks.some((r) => r.status === "open" && r.title === title)) ?? [];

  const patterns = detectRecurringPatterns(window, data, today, sourceType);
  const recurringRisks = patterns.filter((p) => p.kind === "risk");

  const nextWeekPriorities = scores
    .slice(0, 5)
    .map((result) => ({ item: data.workItems.find((w) => w.id === result.itemId)!, result }))
    .filter((x) => !!x.item);

  return {
    hasEnoughHistory: window.length >= 2,
    windowDays: window.length > 0 && oldest ? Math.max(1, daysBetween(oldest.date, latest.date) + 1) : 0,
    currentConfidence: latest?.metrics ? currentConfidence : 0,
    confidenceDelta: trend ? latest!.metrics!.deliveryConfidence - oldest!.metrics!.deliveryConfidence : null,
    gettingBetter: trend?.gettingBetter ?? [],
    gettingWorse: trend?.gettingWorse ?? [],
    recurringRisks,
    decisionsMade,
    decisionsUnresolved,
    actionsCompleted,
    actionsThatDidNotResolveTheIssue,
    carryOverRisks,
    nextWeekPriorities,
  };
}
