// First 30 Minutes (V1.4 §19). A deterministic action-priority recommendation — reuses the
// Attention Queue (already priority-ordered per §21) as the primary source, and falls back
// to the existing 30-minute action-plan budget (action-plan.ts) when there aren't enough
// attention items to fill a short list. These are recommendations, never automatic actions.

import { buildPlan } from "./action-plan";
import type { WorkRelevanceIndex } from "./jira/work-relevance";
import type { AttentionItem, CommandCenterData } from "./types";

export interface First30MinutesItem {
  text: string;
  attentionItemId?: string;
}

export function buildFirst30Minutes(
  attentionQueue: AttentionItem[],
  data: CommandCenterData,
  today: string,
  workRelevanceIndex?: WorkRelevanceIndex,
  dailyCommandCompletedWorkItemIds?: ReadonlySet<string>,
  // V2.23 — same additive/optional-trailing-parameter, no-op-when-omitted contract: threaded
  // through to buildPlan's own fallback below, so a Daily-Command-skipped ticket never fills
  // one of these recommendation slots either. `attentionQueue` here is already the
  // proactive.ts-gated queue (skipped items already excluded), so this only matters for the
  // action-plan.ts fallback path.
  dailyCommandSkippedWorkItemIds?: ReadonlySet<string>
): First30MinutesItem[] {
  const eligible = attentionQueue.filter((i) => i.lifecycle !== "SNOOZED" && i.lifecycle !== "RESOLVED");
  const top = eligible.slice(0, 5).map((i) => ({ text: `${i.nowWhat} (${i.what})`, attentionItemId: i.id }));

  if (top.length >= 3) return top;

  const plan = buildPlan(data, today, 30, workRelevanceIndex, dailyCommandCompletedWorkItemIds, dailyCommandSkippedWorkItemIds);
  const fromPlan = plan.slice(0, 5 - top.length).map((c) => ({ text: c.title }));
  return [...top, ...fromPlan];
}
