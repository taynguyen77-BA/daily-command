// P3.1-P3.3 — the ONE place a store state becomes a ScoringOptions: the model (absent = v2), the
// "waiting on me" signal (mentions + conversation state) and, for v2, the personal learning loop.
// Used by the hook, the project-override view and the store's own snapshots, so they cannot drift.

import { buildAwaitingMe } from "./awaiting-me";
import { asLearnedMode, collectAppearances, computeLearnedAdjustments, groupKeyOf, signalKindForTicket, type LearnedAdjustment, type LearnedMode, type SignalKind } from "./learned-adjustments";
import type { ConversationState } from "./conversation-state";
import type { ScoreModel, ScoringOptions } from "./scoring";
import { nbaSignals } from "./nba-feedback";
import type { MemoryEvent, MentionEvent, MentionReply, PersonalPlanItem, TicketWorkState, WorkItem } from "./types";

export interface ScoringContextState {
  scoringModel?: ScoreModel;
  mentionReplies?: Record<string, MentionReply>;
  conversationByTicket?: Record<string, ConversationState>;
  learnedPriority?: LearnedMode;
  learningResetAt?: string;
  personalPlan?: PersonalPlanItem[];
  ticketWorkStates?: Record<string, TicketWorkState>;
  memoryEvents?: MemoryEvent[];
  data: { workItems: WorkItem[] };
}

// One-entry memo: the adjustments only depend on these inputs (a handful of plan items and histories), but the hook,
// the override view and every TaskRow chip ask for them per render.
let memo: { deps: unknown[]; value: LearnedAdjustment[] } | null = null;
export function learnedAdjustmentsFor(state: Pick<ScoringContextState, "personalPlan" | "ticketWorkStates" | "learningResetAt" | "memoryEvents"> & { data: { workItems: WorkItem[] } }, today: string): LearnedAdjustment[] {
  const deps = [state.personalPlan, state.ticketWorkStates, state.data.workItems, state.learningResetAt, state.memoryEvents, today];
  if (memo && memo.deps.length === deps.length && memo.deps.every((d, i) => Object.is(d, deps[i]))) return memo.value;
  const value = computeLearnedAdjustments(collectAppearances({ today, planItems: state.personalPlan ?? [], ticketWorkStates: state.ticketWorkStates ?? {}, workItems: state.data.workItems, resetAt: state.learningResetAt, nbaSignals: nbaSignals(state.memoryEvents ?? []) }), today);
  memo = { deps, value };
  return value;
}

export function buildScoringOptions(state: ScoringContextState, mentionEvents: readonly MentionEvent[] | undefined, today: string): ScoringOptions {
  const model = state.scoringModel ?? "v2";
  const awaitingMeByKey = buildAwaitingMe(mentionEvents, state.mentionReplies, state.conversationByTicket);
  const base: ScoringOptions = { model, awaitingMeByKey };
  const mode = asLearnedMode(state.learnedPriority);
  if (model !== "v2" || mode === "off") return base;
  const adjustments = learnedAdjustmentsFor(state, today);
  if (adjustments.length === 0) return { ...base, learned: { mode, adjustments } };
  // Only tickets in a group that has an adjustment need a kind; everything else defaults to OTHER.
  const groups = new Set(adjustments.map((a) => a.groupKey));
  const signalKindByKey: Record<string, SignalKind> = {};
  for (const w of state.data.workItems) {
    const kind = signalKindForTicket(w.key, awaitingMeByKey);
    if (kind !== "OTHER" && groups.has(groupKeyOf({ projectId: w.projectId, issueType: w.type, priority: w.priority, kind }))) signalKindByKey[w.key] = kind;
  }
  return { ...base, learned: { mode, adjustments, signalKindByKey } };
}
