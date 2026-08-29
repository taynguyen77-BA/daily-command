// Proactive Intelligence orchestrator (V1.4, extended V1.5). Mirrors selectors.ts's
// deriveData() pattern — one function that composes every deterministic engine into the
// bundle every proactive UI surface needs, computed once per render via useCommandCenter().
// No AI calls happen here.

import { computeActionEffectiveness, ineffectiveActions } from "./action-effectiveness";
import { buildAttentionQueue } from "./attention-queue";
import { computeClientAttentionMap } from "./client-attention-map";
import { computeDecisionEffectiveness } from "./decision-effectiveness";
import { computeDecisionRadar } from "./decision-radar";
import { computeDeliveryLoops } from "./delivery-loops";
import { computeDependencyRadar } from "./dependency-radar";
import { computeDeliveryDrift, computeTrajectory } from "./delivery-drift";
import { buildFirst30Minutes } from "./first-30-minutes";
import { buildDailySnapshot } from "./memory";
import { computeOutcomeScorecard } from "./outcome-scorecard";
import { computeAllReleaseHealth } from "./release-health";
import { computeReleaseDrift } from "./release-drift";
import { computeRiskEscalations } from "./risk-escalation";
import { computeStakeholderAttention, rankCommunicationPriority } from "./stakeholder-radar";
import type { AttentionItem, AttentionItemState, CommandCenterData, DailySnapshot, DecisionEffectivenessResult, EvidenceSourceType } from "./types";
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
  today: string
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
    },
    attentionState,
    today
  );

  const first30Minutes = buildFirst30Minutes(attentionQueue, data, today);
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
    attentionQueue,
    nextAttentionState,
    clientAttentionMap,
    first30Minutes,
    outcomeScorecard,
  };
}
