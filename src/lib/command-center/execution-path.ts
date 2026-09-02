// V2.8 — Execution Path & Work Signal Calibration. An OBSERVABILITY layer over the existing
// pipeline, answering "what happened to this Jira work after Daily Command determined it
// was relevant?" for ONE item at a time, plus a bulk per-status extension of V2.7's
// calibration table. Nothing here classifies, scores, mutates policy, creates an Action, or
// changes what Personal Focus considers — it only reads and narrates existing state:
//
//   Jira WorkItem -> Work Relevance (jira/work-relevance.ts, unchanged)
//                 -> Candidate Evaluation (action-plan.ts buildCandidates(), unchanged)
//                 -> Action Plan (action-plan.ts buildPlan(), unchanged)
//                 -> Explicit Action (the Action model, unchanged)
//                 -> Attention / Personal Focus (attention-queue.ts + personal-focus.ts,
//                    unchanged — traced via the SAME real foreign keys those modules
//                    already use: Risk.sourceWorkItemIds, Dependency.workItemId,
//                    Decision.relatedWorkItemIds, Action.relatedWorkItemId — never status
//                    name/title/text similarity, per §18)
//                 -> Outcome (Action.outcomeStatus, unchanged)
//
// This is deliberately an observability model, not a mandatory pipeline (§1, §35): an
// OBSERVE item legitimately stops at Work Relevance, and that is never described as a
// failure or a missing stage — see NOT_APPLICABLE below.

import { buildCandidates, buildPlan } from "./action-plan";
import { jiraProjectKeyForWorkItem, resolveWorkRelevance, explainWorkItemRelevance, type EffectiveWorkRelevance, type WorkRelevanceIndex } from "./jira/work-relevance";
import type { Action, ActionStatus, AttentionItem, CommandCenterData, DeliveryLoop, PersonalFocusCandidate, WorkItem, WorkRelevance } from "./types";
import type { ProactiveIntelligence } from "./proactive";
import type { PersonalFocusResult } from "./types";

// V2.8 §5 Stage 4 — the same default budget action-plan/page.tsx itself opens with
// (`useState<TimeBudget>(30)`), used here as the one concrete, documented reference point
// for "would this candidate actually be selected into today's Action Plan?" (§5 Stage 4 —
// "if the existing architecture supports [Candidate vs Selected], show it; if not, don't
// invent false precision"). buildPlan()'s budget-based greedy fill IS a real, existing
// distinction — this just has to pick which budget to evaluate against, and 30 minutes is
// the one the product's own default already answers to.
const REFERENCE_ACTION_PLAN_BUDGET_MINUTES = 30;

// A status needs at least this many observed items before a Signal C verdict is trusted —
// same conservatism threshold V2.7's policy-review signals already use.
const MIN_ITEMS_FOR_SIGNAL = 3;

export type CandidateEvaluationState = "ELIGIBLE" | "NOT_ELIGIBLE" | "NOT_APPLICABLE";
export type ActionPlanState = "SELECTED" | "NOT_SELECTED" | "NOT_APPLICABLE";

export interface ActionRelationship {
  state: "NONE" | "EXISTS";
  activeCount: number;
  completedCount: number;
  outcomeRecordedCount: number;
  actions: { id: string; title: string; status: ActionStatus }[];
}

export interface AttentionRelationship {
  // §14 — every entry here is reached via a real foreign key already owned by
  // attention-queue.ts/personal-focus.ts (Risk.sourceWorkItemIds, Dependency.workItemId,
  // Decision.relatedWorkItemIds), never inferred from text/title similarity (§18).
  connectedAttentionItems: AttentionItem[];
  connectedLoops: DeliveryLoop[];
  presentInPersonalFocus: boolean;
  personalFocusCandidate?: PersonalFocusCandidate;
  // true once `proactive`/`personalFocus` were actually supplied — false means "not enough
  // evidence to say", never silently reported as "not present" (§4 "if evidence is
  // unavailable, say Not enough evidence").
  evidenceAvailable: boolean;
}

export interface OutcomeRelationship {
  recorded: boolean;
  count: number;
}

export interface ExecutionPathTrace {
  item: WorkItem;
  projectKey?: string;
  relevance: EffectiveWorkRelevance;
  candidateEvaluation: CandidateEvaluationState;
  actionPlan: ActionPlanState;
  actions: ActionRelationship;
  attention: AttentionRelationship;
  outcome: OutcomeRelationship;
}

function actionsForWorkItem(data: CommandCenterData, itemId: string): Action[] {
  return data.actions.filter((a) => a.relatedWorkItemId === itemId);
}

function computeActionRelationship(linkedActions: Action[]): ActionRelationship {
  if (linkedActions.length === 0) return { state: "NONE", activeCount: 0, completedCount: 0, outcomeRecordedCount: 0, actions: [] };
  const completedCount = linkedActions.filter((a) => a.status === "completed").length;
  const outcomeRecordedCount = linkedActions.filter((a) => !!a.outcomeStatus).length;
  return {
    state: "EXISTS",
    activeCount: linkedActions.length - completedCount,
    completedCount,
    outcomeRecordedCount,
    actions: linkedActions.map((a) => ({ id: a.id, title: a.title, status: a.status })),
  };
}

/** §14, §18 — every entry here follows a REAL, already-existing foreign key back to this
 *  exact WorkItem; nothing is inferred from status name, title, or text similarity. This is
 *  the same relationship attention-queue.ts's own sourceRef already encodes — this function
 *  just walks it in the other direction (WorkItem -> AttentionItem) for one specific item. */
interface ConnectedAttentionResult {
  connected: AttentionItem[];
  connectedDecisionIds: Set<string>;
}

function findConnectedAttentionItems(item: WorkItem, data: CommandCenterData, attentionQueue: AttentionItem[]): ConnectedAttentionResult {
  const wanted = new Set<string>();
  for (const risk of data.risks) {
    if (risk.sourceWorkItemIds.includes(item.id)) wanted.add(`risk:${risk.title}`);
  }
  for (const dep of data.dependencies) {
    if (dep.workItemId === item.id) wanted.add(`dependency:${dep.id}`);
  }
  const connectedDecisionIds = new Set<string>();
  for (const decision of data.decisions) {
    if ((decision.relatedWorkItemIds ?? []).includes(item.id)) {
      wanted.add(`decision:${decision.id}`);
      connectedDecisionIds.add(decision.id);
    }
  }
  for (const action of data.actions) {
    if (action.relatedWorkItemId === item.id) wanted.add(`action:${action.id}`);
  }
  return { connected: attentionQueue.filter((a) => a.sourceRef && wanted.has(`${a.sourceRef.type}:${a.sourceRef.id}`)), connectedDecisionIds };
}

function findConnectedLoops(connectedDecisionIds: Set<string>, loops: DeliveryLoop[]): DeliveryLoop[] {
  if (connectedDecisionIds.size === 0) return [];
  return loops.filter((l) => l.decision?.id && connectedDecisionIds.has(l.decision.id));
}

function computeAttentionRelationship(
  item: WorkItem,
  data: CommandCenterData,
  proactive: ProactiveIntelligence | null,
  personalFocus: PersonalFocusResult | null
): AttentionRelationship {
  if (!proactive) return { connectedAttentionItems: [], connectedLoops: [], presentInPersonalFocus: false, evidenceAvailable: false };

  const { connected: connectedAttentionItems, connectedDecisionIds } = findConnectedAttentionItems(item, data, proactive.attentionQueue);
  const connectedLoops = findConnectedLoops(connectedDecisionIds, proactive.deliveryLoops);

  if (!personalFocus) {
    return { connectedAttentionItems, connectedLoops, presentInPersonalFocus: false, evidenceAvailable: false };
  }

  const attentionIds = new Set(connectedAttentionItems.map((a) => a.id));
  const loopIds = new Set(connectedLoops.map((l) => l.id));
  const personalFocusCandidate = personalFocus.candidates.find(
    (c) => (c.sourceType === "attention" && attentionIds.has(c.sourceId)) || (c.sourceType === "loop" && loopIds.has(c.sourceId))
  );

  return { connectedAttentionItems, connectedLoops, presentInPersonalFocus: !!personalFocusCandidate, personalFocusCandidate, evidenceAvailable: true };
}

/** §4-6 — the single-item execution trace. Every stage is computed from EXISTING engines
 *  (jira/work-relevance.ts, action-plan.ts, the Action model, attention-queue.ts,
 *  personal-focus.ts) — nothing here duplicates their logic. */
export function computeExecutionPathTrace(
  item: WorkItem,
  data: CommandCenterData,
  today: string,
  workRelevanceIndex: WorkRelevanceIndex,
  proactive: ProactiveIntelligence | null,
  personalFocus: PersonalFocusResult | null
): ExecutionPathTrace {
  const relevance = resolveWorkRelevance(item, workRelevanceIndex);
  const isOpen = item.status !== "Done";

  // Stage 3 — Candidate Evaluation (§5 Stage 3): reuses buildCandidates() verbatim, the
  // same score >= 40 threshold action-plan.ts already enforces — never reimplemented here.
  let candidateEvaluation: CandidateEvaluationState = "NOT_APPLICABLE";
  let candidateIds: Set<string> | undefined;
  if (relevance === "ACTIONABLE" && isOpen) {
    candidateIds = new Set(buildCandidates(data, today, workRelevanceIndex).map((c) => c.item?.id).filter(Boolean) as string[]);
    candidateEvaluation = candidateIds.has(item.id) ? "ELIGIBLE" : "NOT_ELIGIBLE";
  }

  // Stage 4 — Action Plan (§5 Stage 4): of the real candidates, would this one actually be
  // selected within the product's own default 30-minute Action Plan budget?
  let actionPlan: ActionPlanState = "NOT_APPLICABLE";
  if (candidateEvaluation === "ELIGIBLE") {
    const planIds = new Set(buildPlan(data, today, REFERENCE_ACTION_PLAN_BUDGET_MINUTES, workRelevanceIndex).map((c) => c.item?.id).filter(Boolean));
    actionPlan = planIds.has(item.id) ? "SELECTED" : "NOT_SELECTED";
  } else if (candidateEvaluation === "NOT_ELIGIBLE") {
    actionPlan = "NOT_SELECTED";
  }

  // Stage 5 — Explicit Action (§5 Stage 5): the real, existing Action model.
  const linkedActions = actionsForWorkItem(data, item.id);
  const actions = computeActionRelationship(linkedActions);

  // Stage 6 — Focus / Attention (§5 Stage 6, §14): real FK-based traceability, never
  // inferred from ownership/status similarity.
  const attention = computeAttentionRelationship(item, data, proactive, personalFocus);

  // Stage 7 — Outcome (§5 Stage 7): reuses Action.outcomeStatus — no new outcome model.
  const outcome: OutcomeRelationship = { recorded: actions.outcomeRecordedCount > 0, count: actions.outcomeRecordedCount };

  return { item, projectKey: jiraProjectKeyForWorkItem(item), relevance, candidateEvaluation, actionPlan, actions, attention, outcome };
}

// ===== §7-8 — Why is/isn't this here? One reusable explanation model, not three engines. =====

export type ExecutionSurface = "ACTION_PLAN" | "PERSONAL_FOCUS" | "EXPLICIT_ACTION";

export interface ExecutionSurfaceExplanation {
  surface: ExecutionSurface;
  present: boolean;
  explanation: string;
}

/** §7-8 — deterministic, reuses explainWorkItemRelevance() (V2.5/V2.6) for the underlying
 *  policy reasoning rather than re-deriving it, and every other sentence cites a real field
 *  already on `trace` — never a new causal claim (§7 "use actual evidence"). */
export function explainExecutionSurface(item: WorkItem, trace: ExecutionPathTrace, surface: ExecutionSurface, workRelevanceIndex: WorkRelevanceIndex): ExecutionSurfaceExplanation {
  if (surface === "ACTION_PLAN") {
    if (trace.candidateEvaluation === "NOT_APPLICABLE") {
      const policy = explainWorkItemRelevance(item, workRelevanceIndex);
      return { surface, present: false, explanation: `This Jira status is classified ${trace.relevance === "NOT_APPLICABLE" ? "N/A" : trace.relevance}. ${policy.answer}` };
    }
    if (trace.actionPlan === "SELECTED") {
      return { surface, present: true, explanation: "This Jira status is classified ACTIONABLE. The item passed candidate evaluation and was selected into the Action Plan." };
    }
    if (trace.candidateEvaluation === "NOT_ELIGIBLE") {
      return { surface, present: false, explanation: "This Jira status is classified ACTIONABLE, but the item did not enter the existing candidate pool (score below the evaluation threshold, and no explicit Action is linked)." };
    }
    return { surface, present: false, explanation: "This item entered the candidate pool but was not selected within the current Action Plan time budget." };
  }

  if (surface === "PERSONAL_FOCUS") {
    if (!trace.attention.evidenceAvailable) {
      return { surface, present: false, explanation: "Not enough evidence — Personal Focus / Attention data was not available for this check." };
    }
    if (trace.attention.presentInPersonalFocus && trace.attention.personalFocusCandidate) {
      return { surface, present: true, explanation: trace.attention.personalFocusCandidate.whyOnMyList || trace.attention.personalFocusCandidate.why };
    }
    if (trace.attention.connectedAttentionItems.length > 0 || trace.attention.connectedLoops.length > 0) {
      return {
        surface,
        present: false,
        explanation: "This item is connected to an existing Attention Queue / Delivery Loop signal, but that signal is not currently ranked into Personal Focus.",
      };
    }
    return {
      surface,
      present: false,
      explanation: "Not currently in Personal Focus. Personal Focus is built from Attention Queue and Delivery Loop signals (risks, dependencies, decisions, ineffective actions) — this item has no such signal right now. This is not an error: an ACTIONABLE Jira status does not automatically enter Personal Focus.",
    };
  }

  // EXPLICIT_ACTION
  if (trace.actions.state === "EXISTS") {
    return {
      surface,
      present: true,
      explanation: `${trace.actions.actions.length} explicit Action(s) exist for this item (${trace.actions.activeCount} active, ${trace.actions.completedCount} completed). These are user- or system-created records, never inferred from Jira status alone.`,
    };
  }
  return { surface, present: false, explanation: "No explicit Action has been created for this item. Daily Command never creates an Action automatically." };
}

// ===== §10 — Status-level Execution Path Calibration (extends V2.7's status table) =====

export interface ExecutionPathStatusRow {
  projectKey: string;
  statusName: string;
  relevance: WorkRelevance;
  candidateCount?: number; // undefined = "N/A" (not ACTIONABLE — candidate evaluation doesn't apply)
  outcomeCount: number;
}

/** §10, §23 — one pass building per-(project,status) rows with real, indexed counts.
 *  candidateCount is ONLY meaningful for ACTIONABLE rows (§10's own worked example shows
 *  "N/A" for OBSERVE/WAITING) — computed via a single buildCandidates() call, not a
 *  per-item rescan. */
export function computeExecutionPathStatusTable(data: CommandCenterData, index: WorkRelevanceIndex, today: string, projectKeys?: string[]): ExecutionPathStatusRow[] {
  const scope = projectKeys && projectKeys.length > 0 ? new Set(projectKeys) : undefined;
  const actionsByWorkItemId = new Map<string, Action[]>();
  for (const action of data.actions) {
    if (!action.relatedWorkItemId) continue;
    const list = actionsByWorkItemId.get(action.relatedWorkItemId);
    if (list) list.push(action);
    else actionsByWorkItemId.set(action.relatedWorkItemId, [action]);
  }
  const candidateIds = new Set(buildCandidates(data, today, index).map((c) => c.item?.id).filter(Boolean));

  const groups = new Map<string, { projectKey: string; statusName: string; relevance: WorkRelevance; items: WorkItem[] }>();
  for (const item of data.workItems) {
    if (item.sourceType !== "jira" || item.status === "Done" || !item.jiraStatusName) continue;
    const projectKey = jiraProjectKeyForWorkItem(item);
    if (!projectKey || (scope && !scope.has(projectKey))) continue;
    const relevance = resolveWorkRelevance(item, index);
    if (relevance === "NOT_APPLICABLE" || relevance === "UNKNOWN") continue;
    const key = `${projectKey}::${item.jiraStatusName}`;
    let group = groups.get(key);
    if (!group) {
      group = { projectKey, statusName: item.jiraStatusName, relevance, items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }

  const rows: ExecutionPathStatusRow[] = [];
  for (const group of Array.from(groups.values())) {
    const outcomeCount = group.items.reduce((sum, item) => sum + (actionsByWorkItemId.get(item.id) ?? []).filter((a) => !!a.outcomeStatus).length, 0);
    rows.push({
      projectKey: group.projectKey,
      statusName: group.statusName,
      relevance: group.relevance,
      candidateCount: group.relevance === "ACTIONABLE" ? group.items.filter((item) => candidateIds.has(item.id)).length : undefined,
      outcomeCount,
    });
  }
  return rows.sort((a, b) => a.projectKey.localeCompare(b.projectKey) || a.statusName.localeCompare(b.statusName));
}

// ===== §11 Signal C — ACTIONABLE but no items entered the candidate pool =====

export interface CandidateGapSignal {
  projectKey: string;
  statusName: string;
  observedItemCount: number;
  explanation: string;
}

/** §11 Signal C — deliberately separate from V2.7's PolicyReviewSignal (which is about
 *  Action EVIDENCE); this is specifically about CANDIDATE EVALUATION, an earlier pipeline
 *  stage. Never claims "policy is too broad" — states the observation only (§11). */
export function computeCandidateGapSignals(data: CommandCenterData, index: WorkRelevanceIndex, today: string, projectKeys?: string[]): CandidateGapSignal[] {
  return computeExecutionPathStatusTable(data, index, today, projectKeys)
    .filter((r) => r.relevance === "ACTIONABLE" && r.candidateCount === 0)
    .map((r) => {
      const observedItemCount = data.workItems.filter(
        (w) => w.sourceType === "jira" && w.status !== "Done" && w.jiraStatusName === r.statusName && jiraProjectKeyForWorkItem(w) === r.projectKey
      ).length;
      return { projectKey: r.projectKey, statusName: r.statusName, observedItemCount };
    })
    .filter((r) => r.observedItemCount >= MIN_ITEMS_FOR_SIGNAL)
    .map((r) => ({
      ...r,
      explanation: `Current policy allows this status to be ACTIONABLE, but none of the ${r.observedItemCount} observed item(s) entered the existing candidate pool.`,
    }));
}

// ===== §17 Command Bar helpers =====

/** "Which actionable items entered the candidate pool?" */
export function listCandidatePoolActionableItems(data: CommandCenterData, index: WorkRelevanceIndex, today: string): WorkItem[] {
  const candidates = buildCandidates(data, today, index);
  const actionableIds = new Set(data.workItems.filter((w) => w.sourceType === "jira" && w.status !== "Done" && resolveWorkRelevance(w, index) === "ACTIONABLE").map((w) => w.id));
  const seen = new Set<string>();
  const out: WorkItem[] = [];
  for (const c of candidates) {
    if (!c.item || !actionableIds.has(c.item.id) || seen.has(c.item.id)) continue;
    seen.add(c.item.id);
    out.push(c.item);
  }
  return out;
}

/** "Which items are in Personal Focus because of Jira work?" — every Jira WorkItem whose
 *  connected Attention/Loop evidence is currently ranked into Personal Focus. */
export function listJiraItemsInPersonalFocus(data: CommandCenterData, proactive: ProactiveIntelligence | null, personalFocus: PersonalFocusResult | null): { item: WorkItem; candidate: PersonalFocusCandidate }[] {
  if (!proactive || !personalFocus) return [];
  const out: { item: WorkItem; candidate: PersonalFocusCandidate }[] = [];
  for (const item of data.workItems) {
    if (item.sourceType !== "jira") continue;
    const { connected, connectedDecisionIds } = findConnectedAttentionItems(item, data, proactive.attentionQueue);
    const connectedLoops = findConnectedLoops(connectedDecisionIds, proactive.deliveryLoops);
    const attentionIds = new Set(connected.map((a) => a.id));
    const loopIds = new Set(connectedLoops.map((l) => l.id));
    const candidate = personalFocus.candidates.find((c) => (c.sourceType === "attention" && attentionIds.has(c.sourceId)) || (c.sourceType === "loop" && loopIds.has(c.sourceId)));
    if (candidate) out.push({ item, candidate });
  }
  return out;
}
