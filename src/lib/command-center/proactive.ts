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
import { isWorkItemDoneOrExcluded, resolveWorkRelevance, type WorkRelevanceIndex } from "./jira/work-relevance";
import { buildDailySnapshot, dailyCanonicalSnapshots } from "./memory";
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
  identityDisplayName?: string,
  // V2.19 — additive/optional trailing parameter, same no-op-when-omitted contract as every
  // parameter above: work item ids the user has explicitly marked completed IN DAILY COMMAND
  // (see store.ts's dailyCommandCompletions, keyed by ticket key there and resolved to
  // WorkItem ids by the caller — use-command-center.ts) — a fact distinct from the Jira
  // issue's own status. Folded into the same forceResolved/exclusion mechanisms as a
  // Jira-COMPLETED/EXCLUDED ticket below, never a second suppression system.
  dailyCommandCompletedWorkItemIds?: ReadonlySet<string>,
  // V2.23 — same additive/optional-trailing-parameter, no-op-when-omitted contract: work item
  // ids the user has explicitly SKIPPED in Daily Command (types.ts's DailyCommandSkip). Folded
  // into the SAME mentionAutoResolveWorkItemIds set below as completion — from a MENTION
  // attention item's perspective, both mean "nothing currently needs your attention on this
  // ticket", and both correctly un-suppress (RESOLVED -> REOPENED) the moment the ticket is
  // reactivated (removed from the caller-supplied set) — never a second lifecycle mechanism.
  dailyCommandSkippedWorkItemIds?: ReadonlySet<string>
): ProactiveIntelligence {
  const currentMetrics = buildDailySnapshot(data, today, derived.changes.length).metrics!;

  // V2.18 §10 — snapshotHistory is the raw, frequent operational record (appended to on
  // every sync/import/close-day, possibly several times per day). Genuine day-over-day
  // comparison must read the canonicalized (one-entry-per-calendar-date) view instead, or a
  // same-day noise delta from repeated syncing gets reported as if it were a real trend — see
  // dailyCanonicalSnapshots' own comment.
  const dailyHistory = dailyCanonicalSnapshots(snapshotHistory);

  const drift = computeDeliveryDrift(dailyHistory, currentMetrics);
  const trajectory = computeTrajectory(dailyHistory, currentMetrics);
  const riskEscalations = computeRiskEscalations(derived.risks, dailyHistory, today);
  const dependencyRadar = computeDependencyRadar(data, derived.risks, today);
  const releaseHealths = computeAllReleaseHealth(data, today, workRelevanceIndex, dailyCommandCompletedWorkItemIds);
  const releaseDrift = computeReleaseDrift(releaseHealths, previousSnapshot, today);
  const actionEffectiveness = computeActionEffectiveness(data);
  const ineffective = ineffectiveActions(actionEffectiveness, data.actions);
  const ineffectiveActionWorkItemIds = new Set(ineffective.map(({ action }) => action.relatedWorkItemId).filter((id): id is string => !!id));

  const decisionRadar = computeDecisionRadar(data, sourceType, today, { riskEscalations, dependencyRadar, releaseDrift, ineffectiveActionWorkItemIds });
  const decisionEffectiveness = data.decisions
    .filter((d) => d.date)
    .map((d) => computeDecisionEffectiveness(d, dailyHistory, currentMetrics, actionEffectiveness.filter((r) => (d.relatedActionIds ?? []).includes(r.actionId))));
  const deliveryLoops = computeDeliveryLoops(data, decisionRadar, actionEffectiveness, today);

  const stakeholderAttention = computeStakeholderAttention(data, dependencyRadar, decisionRadar);
  const communicationPriority = rankCommunicationPriority(data.communications, data, riskEscalations, dependencyRadar);
  const clientAttentionMap = computeClientAttentionMap(data, derived, dependencyRadar, previousSnapshot, today);

  const newAssignments = detectNewAssignments(data, previousSnapshot, identityOwnerId);

  // V2.17 §1a point 5 — resolved once, before buildAttentionQueue, so a still-open MENTION
  // tied to one of these work items can auto-resolve (see attention-queue.ts's forceResolved).
  // Deliberately not threaded for ASSIGNMENT — see that task's own scope note.
  // V2.19 (bug fix) — now built unconditionally (never gated behind `workRelevanceIndex`
  // existing at all): isWorkItemDoneOrExcluded's native-status floor works even with no policy
  // configured, closing the exact gap where a MENTION on a genuinely Jira-Done ticket used to
  // linger forever on an install where the user hadn't classified that status name yet (see
  // that function's own comment). A Daily-Command-completed ticket (§ Daily Command
  // Completion) is folded into the same set — from the ticket's perspective, both are "there
  // is nothing left to do here", so both use the identical forceResolved mechanism.
  // V2.23 — a Daily-Command-SKIPPED ticket is folded in too: renamed from
  // completedOrExcludedWorkItemIds to reflect that this set now also drives skip suppression
  // (this is purely a local-variable rename for accuracy — attention-queue.ts's own field name
  // is unchanged, see that file's comment). Skip and completion are mutually exclusive by
  // construction (store.ts), so no ticket is ever double-counted here.
  const mentionAutoResolveWorkItemIds = new Set(
    data.workItems.filter((w) => isWorkItemDoneOrExcluded(w, workRelevanceIndex) || dailyCommandCompletedWorkItemIds?.has(w.id) || dailyCommandSkippedWorkItemIds?.has(w.id)).map((w) => w.id)
  );

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
      completedOrExcludedWorkItemIds: mentionAutoResolveWorkItemIds,
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
    // V2.23 — a Daily-Command-SKIPPED ticket's RISK/DEPENDENCY/DECISION/ACTION/COMMUNICATION
    // item must not surface in the active Attention Queue either (§5, §10). Independent of
    // `workRelevanceIndex` existing at all (same zero-config-floor discipline as
    // isWorkItemDoneOrExcluded elsewhere), and — like the Work Relevance check just above —
    // deliberately NOT extended to MENTION here: a skipped ticket's mention is instead handled
    // by the SAME forceResolved/RESOLVED-lifecycle mechanism as completion (see
    // mentionAutoResolveWorkItemIds above), so it stays out of the default (ACTIVE_DEFAULT)
    // Attention Queue view without a second exclusion path. This intentionally goes further
    // than Daily Command Completion's own pre-existing Attention Queue scope (MENTION-only,
    // unchanged here, out of scope for V2.23) — Skip's suppression is broader per this spec's
    // explicit "active Attention Queue" requirement.
    if (item.category !== "MENTION" && entity.workItemIds.length > 0 && dailyCommandSkippedWorkItemIds && entity.workItemIds.every((id) => dailyCommandSkippedWorkItemIds.has(id))) continue;
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

  const first30Minutes = buildFirst30Minutes(gatedAttentionQueue, data, today, workRelevanceIndex, dailyCommandCompletedWorkItemIds, dailyCommandSkippedWorkItemIds);
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
