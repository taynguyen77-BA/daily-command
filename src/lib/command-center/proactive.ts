// Proactive Intelligence orchestrator (V1.4, extended V1.5). Mirrors selectors.ts's
// deriveData() pattern — one function that composes every deterministic engine into the
// bundle every proactive UI surface needs, computed once per render via useCommandCenter().
// No AI calls happen here.

import { computeActionEffectiveness, ineffectiveActions } from "./action-effectiveness";
import { detectNewAssignments } from "./assignment-detection";
import { buildAttentionQueue } from "./attention-queue";
import { resolveAttentionEntity } from "./personal-focus";
import { classifyPersonalRelation, type PersonalRelationIdentity } from "./personal-relation";
import { computeClientAttentionMap } from "./client-attention-map";
import { computeDecisionEffectiveness } from "./decision-effectiveness";
import { computeDecisionRadar } from "./decision-radar";
import { computeDeliveryLoops } from "./delivery-loops";
import { computeDependencyRadar } from "./dependency-radar";
import { computeDeliveryDrift, computeTrajectory } from "./delivery-drift";
import { buildFirst30Minutes } from "./first-30-minutes";
import { resolveWorkRelevance, type WorkRelevanceIndex } from "./jira/work-relevance";
import { buildDailySnapshot } from "./memory";
import { computeOutcomeScorecard } from "./outcome-scorecard";
import { computeAllReleaseHealth } from "./release-health";
import { computeReleaseDrift } from "./release-drift";
import { computeRiskEscalations } from "./risk-escalation";
import { computeStakeholderAttention, rankCommunicationPriority } from "./stakeholder-radar";
import type { AttentionItem, AttentionItemState, CommandCenterData, DailySnapshot, DecisionEffectivenessResult, EvidenceSourceType, MentionEvent, WorkItem } from "./types";
import type { DerivedData } from "./selectors";

export interface ProactiveIntelligence {
  drift: ReturnType<typeof computeDeliveryDrift>;
  trajectory: ReturnType<typeof computeTrajectory>;
  releaseHealths: ReturnType<typeof computeAllReleaseHealth>;
  releaseDrift: ReturnType<typeof computeReleaseDrift>;
  riskEscalations: ReturnType<typeof computeRiskEscalations>;
  dependencyRadar: ReturnType<typeof computeDependencyRadar>;
  decisionRadar: ReturnType<typeof computeDecisionRadar>;
  decisionEffectiveness: DecisionEffectivenessResult[];
  actionEffectiveness: ReturnType<typeof computeActionEffectiveness>;
  deliveryLoops: ReturnType<typeof computeDeliveryLoops>;
  stakeholderAttention: ReturnType<typeof computeStakeholderAttention>;
  communicationPriority: ReturnType<typeof rankCommunicationPriority>;
  attentionQueue: AttentionItem[];
  nextAttentionState: Record<string, AttentionItemState>;
  clientAttentionMap: ReturnType<typeof computeClientAttentionMap>;
  first30Minutes: ReturnType<typeof buildFirst30Minutes>;
  outcomeScorecard: ReturnType<typeof computeOutcomeScorecard>;
  // V2.1 §4 — actionEffectiveness (above) covers every completed action ever; this is the
  // subset actually completed TODAY. Both the Outcome Scorecard and Close Day's ACTIONS
  // section must consume THIS array so their action counts can never disagree — see the
  // computeOutcomeScorecard() call below, which previously (accidentally) received the
  // full-history array despite its own "actionsToday" parameter name.
  actionEffectivenessToday: ReturnType<typeof computeActionEffectiveness>;
}

export function computeProactiveIntelligence(
  data: CommandCenterData,
  derived: DerivedData,
  snapshotHistory: DailySnapshot[],
  previousSnapshot: DailySnapshot | null,
  attentionState: Record<string, AttentionItemState>,
  sourceType: EvidenceSourceType,
  today: string,
  workRelevanceIndex?: WorkRelevanceIndex,
  // V2.10 §2 — both additive/optional trailing parameters: every pre-existing call site,
  // which never passes either, behaves exactly as before (no MENTION/ASSIGNMENT items ever
  // produced). `mentionEvents` is fetched during Jira sync and persisted in the store — it
  // isn't something this function can recompute from `data` alone; `identityOwnerId` is the
  // configured PersonalIdentity's accountId, used only to detect a NEW assignment (§2 task 2)
  // against `previousSnapshot`.
  mentionEvents?: MentionEvent[],
  identityOwnerId?: string,
  // V2.14 §1 — additive/optional trailing parameter, same no-op-when-omitted contract as
  // every other one above: the configured PersonalIdentity's displayName, needed alongside
  // `identityOwnerId` so AttentionItem.relation can fall back to displayName matching exactly
  // like every other identity comparison in this app (see personal-relation.ts).
  identityDisplayName?: string
): ProactiveIntelligence {
  const currentMetrics = buildDailySnapshot(data, today, derived.changes.length).metrics!;

  const drift = computeDeliveryDrift(snapshotHistory, currentMetrics);
  const trajectory = computeTrajectory(snapshotHistory, currentMetrics);
  const riskEscalations = computeRiskEscalations(derived.risks, snapshotHistory, today);
  const dependencyRadar = computeDependencyRadar(data, derived.risks, today);
  const releaseHealths = computeAllReleaseHealth(data, today);
  const releaseDrift = computeReleaseDrift(releaseHealths, previousSnapshot, today);
  const actionEffectiveness = computeActionEffectiveness(data);
  const ineffective = ineffectiveActions(actionEffectiveness, data.actions);
  const ineffectiveActionWorkItemIds = new Set(ineffective.map(({ action }) => action.relatedWorkItemId).filter((id): id is string => !!id));

  const decisionRadar = computeDecisionRadar(data, sourceType, today, { riskEscalations, dependencyRadar, releaseDrift, ineffectiveActionWorkItemIds });
  const decisionEffectiveness = data.decisions
    .filter((d) => d.date)
    .map((d) => computeDecisionEffectiveness(d, snapshotHistory, currentMetrics, actionEffectiveness.filter((r) => (d.relatedActionIds ?? []).includes(r.actionId))));
  const deliveryLoops = computeDeliveryLoops(data, decisionRadar, actionEffectiveness, today);

  const stakeholderAttention = computeStakeholderAttention(data, dependencyRadar, decisionRadar);
  const communicationPriority = rankCommunicationPriority(data.communications, data, riskEscalations, dependencyRadar);
  const clientAttentionMap = computeClientAttentionMap(data, derived, dependencyRadar, previousSnapshot, today);

  const newAssignments = detectNewAssignments(data, previousSnapshot, identityOwnerId);

  // V2.17 §1a point 5 — resolved once, before buildAttentionQueue, so a still-open MENTION
  // tied to one of these work items can auto-resolve (see attention-queue.ts's forceResolved).
  // Deliberately not threaded for ASSIGNMENT — see that task's own scope note.
  const completedOrExcludedWorkItemIds = workRelevanceIndex
    ? new Set(
        data.workItems
          .filter((w) => {
            const relevance = resolveWorkRelevance(w, workRelevanceIndex);
            return relevance === "COMPLETED" || relevance === "EXCLUDED";
          })
          .map((w) => w.id)
      )
    : undefined;

  const { items: attentionQueue, nextAttentionState } = buildAttentionQueue(
    {
      drift,
      releaseDrift,
      riskEscalations,
      openRisks: derived.risks,
      dependencyRadar,
      decisionRadar,
      ineffectiveActions: ineffective,
      stakeholderAttention,
      communicationPriority,
      mentionEvents,
      newAssignments,
      workItems: data.workItems,
      completedOrExcludedWorkItemIds,
    },
    attentionState,
    today
  );

  // V2.13 (bug fix) — the Attention Queue never consulted the Work Relevance Policy at all,
  // so a risk/dependency/decision/action tied to a ticket the user has explicitly classified
  // COMPLETED (finished work) or EXCLUDED (explicitly not relevant — e.g. "Won't Fix",
  // "Cancelled") kept surfacing here forever, as if it still needed action — the exact
  // "irrelevant items still show up" bug. Reuses resolveAttentionEntity (the same sourceRef ->
  // WorkItem logic personal-focus.ts's own gate relies on) rather than a second
  // implementation. Deliberately narrower than personal-focus.ts's gate: ACTIONABLE, OBSERVE
  // ("visible as context"), WAITING (waiting on someone else — exactly what Dependency Radar
  // and stakeholder-radar signals are already about) and UNKNOWN (a status nobody has
  // classified yet — Attention Queue must not go quiet just because the user hasn't gotten to
  // every status in Data & Settings; see V2.7's Unknown Visibility) are all still "live" for
  // this broader delivery-intelligence surface, unlike the personal-work-only My Day gate.
  // Only a genuinely finished-or-excluded ticket is dropped; an item with zero related work
  // items (e.g. overall delivery drift) is never gated at all, same as personal-focus.ts.
  // This same pass also resolves a real ticket link when the item points at exactly one work
  // item — no fabricated link (Demo/Local Import has no sourceUrl), no second implementation.
  // V2.14 §1 — built once per render, not re-scanned per item (per Task 1).
  const relationIdentity: PersonalRelationIdentity = { accountId: identityOwnerId, displayName: identityDisplayName };
  const mentionedIssueKeys = new Set((mentionEvents ?? []).map((m) => m.issueKey));

  const gatedAttentionQueue: AttentionItem[] = [];
  for (const item of attentionQueue) {
    const entity = resolveAttentionEntity(item, data, derived.risks);
    // V2.17 §1b — re-confirms the V2.12 decision: MENTION always bypasses this gate. A mention
    // is about a person waiting on a reply, not about the ticket's delivery state, so it must
    // surface here regardless of the underlying ticket's Work Relevance classification (a
    // COMPLETED/EXCLUDED ticket's mention still auto-resolves via attention-queue.ts's
    // forceResolved above — a different, lifecycle-based mechanism, not this exclusion). Not
    // extended to ASSIGNMENT — that stays gated exactly as before (V2.12 Task 1's territory).
    if (workRelevanceIndex && entity.workItemIds.length > 0 && item.category !== "MENTION") {
      const relatedItems = entity.workItemIds.map((id) => data.workItems.find((w) => w.id === id)).filter((w): w is WorkItem => !!w);
      const relevances = relatedItems.map((w) => resolveWorkRelevance(w, workRelevanceIndex));
      const stillLive = relevances.some((r) => r !== "COMPLETED" && r !== "EXCLUDED");
      if (relatedItems.length > 0 && !stillLive) continue;
    }
    if (entity.workItemIds.length === 1) {
      const workItem = data.workItems.find((w) => w.id === entity.workItemIds[0]);
      if (workItem) {
        item.ticketKey = workItem.key;
        item.ticketUrl = workItem.sourceUrl;
        // V2.14 §1 — same "only when exactly one work item is related" discipline as
        // ticketKey/ticketUrl just above; classified from the real WorkItem's own
        // ownerId/owner, independent of this item's ownershipExplicit (see AttentionItem's
        // own field comment).
        item.relation = classifyPersonalRelation(workItem, relationIdentity, mentionedIssueKeys, workItem.key);
      }
    }
    gatedAttentionQueue.push(item);
  }

  const first30Minutes = buildFirst30Minutes(gatedAttentionQueue, data, today, workRelevanceIndex);
  // V2.1 §4 — fixes a confirmed bug: this used to pass the full-history `actionEffectiveness`
  // array (every completed action ever) into a parameter literally named "actionsToday",
  // which is why the Outcome Scorecard's counts and Close Day's ACTIONS section could
  // disagree — they were built from inconsistently-filtered/bucketed views of the same
  // data. Filtering to actions genuinely completed today, once, here, is the single source
  // of truth both surfaces now share.
  const completedTodayIds = new Set(data.actions.filter((a) => a.status === "completed" && a.completedAt === today).map((a) => a.id));
  const actionEffectivenessToday = actionEffectiveness.filter((r) => completedTodayIds.has(r.actionId));
  const outcomeScorecard = computeOutcomeScorecard(currentMetrics, previousSnapshot?.metrics, actionEffectivenessToday);

  return {
    drift,
    trajectory,
    releaseHealths,
    releaseDrift,
    riskEscalations,
    dependencyRadar,
    decisionRadar,
    decisionEffectiveness,
    actionEffectiveness,
    actionEffectivenessToday,
    deliveryLoops,
    stakeholderAttention,
    communicationPriority,
    attentionQueue: gatedAttentionQueue,
    nextAttentionState,
    clientAttentionMap,
    first30Minutes,
    outcomeScorecard,
  };
}
