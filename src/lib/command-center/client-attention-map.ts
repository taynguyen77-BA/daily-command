// Client Attention Map (V1.4 §35). A lightweight prioritization view over the existing
// multi-client model — not a portfolio management system. Reuses the same per-client
// ranking that query-router.ts's "client-attention" intent already computes (extracted
// here into one reusable function so neither place duplicates the logic).
//
// V2.4 §17 adds computeProjectAttentionMap below — the identical formula, grouped by
// Project instead of Client, for Executive Mode's Portfolio View. Not a second engine.
//
// V2.25 — audit fix: both `overdue` computations below used a raw `w.status !== "Done"`
// check (Delivery Confidence's own overdue-count input), ignoring Work Relevance Policy
// COMPLETED/EXCLUDED and Daily Command Completion — so a client/project whose finished-but-
// not-native-Done tickets carried a past-due date had its Delivery Confidence dragged down
// forever. Now isWorkItemOperationallyOpen, additive/optional trailing parameters threaded
// through confidenceForClient/computeClientAttentionMap/computeProjectAttentionMap, same
// no-op-when-omitted contract as every other engine using this gate.

import { computeDeliveryConfidence, deliveryConfidenceBand } from "./executive";
import { scoreAllWorkItems } from "./scoring";
import { isWorkItemOperationallyOpen, type WorkRelevanceIndex } from "./jira/work-relevance";
import type { ClientAttentionRow, CommandCenterData, DailySnapshot, DependencyRadarItem, ProjectAttentionRow, TrendDirection } from "./types";
import type { DerivedData } from "./selectors";

const OPEN_DECISION_STATUSES = new Set(["pending", "ACTIVE", "AT_RISK", "REVISIT_REQUIRED"]);

function decisionClientId(data: CommandCenterData, decision: { clientId?: string; projectId: string }): string | undefined {
  return decision.clientId ?? data.projects.find((p) => p.id === decision.projectId)?.clientId;
}

function confidenceForClient(
  workItems: CommandCenterData["workItems"],
  risks: CommandCenterData["risks"],
  data: CommandCenterData,
  clientId: string,
  today: string,
  workRelevanceIndex?: WorkRelevanceIndex,
  dailyCommandCompletedWorkItemIds?: ReadonlySet<string>
): number {
  const clientData: CommandCenterData = { ...data, workItems: workItems.filter((w) => w.clientId === clientId) };
  const scores = scoreAllWorkItems(clientData, today);
  const clientItemIds = new Set(clientData.workItems.map((w) => w.id));
  const clientRisks = risks.filter((r) => r.status === "open" && r.sourceWorkItemIds.some((id) => clientItemIds.has(id)));
  const overdue = clientData.workItems.filter(
    (w) => isWorkItemOperationallyOpen(w, workRelevanceIndex, dailyCommandCompletedWorkItemIds) && w.dueDate && w.dueDate < today
  ).length;
  return computeDeliveryConfidence(scores, clientRisks, overdue);
}

export function computeClientAttentionMap(
  data: CommandCenterData,
  derived: DerivedData,
  dependencyRadar: DependencyRadarItem[],
  previousSnapshot: DailySnapshot | null,
  today: string,
  workRelevanceIndex?: WorkRelevanceIndex,
  dailyCommandCompletedWorkItemIds?: ReadonlySet<string>
): ClientAttentionRow[] {
  const criticalDependencyIds = new Set(dependencyRadar.filter((d) => d.heat === "CRITICAL" || d.heat === "HIGH").map((d) => d.dependencyId));

  return data.clients
    .map((client) => {
      const clientItemIds = new Set(data.workItems.filter((w) => w.clientId === client.id).map((w) => w.id));
      const clientRisks = derived.risks.filter((r) => r.sourceWorkItemIds.some((id) => clientItemIds.has(id)));
      const topRiskTitle = clientRisks[0]?.title;

      const deliveryConfidence = confidenceForClient(data.workItems, data.risks, data, client.id, today, workRelevanceIndex, dailyCommandCompletedWorkItemIds);

      const openDecisionsCount = data.decisions.filter((d) => OPEN_DECISION_STATUSES.has(d.status) && decisionClientId(data, d) === client.id).length;

      const criticalDependenciesCount = data.dependencies.filter((dep) => {
        if (!criticalDependencyIds.has(dep.id)) return false;
        return data.workItems.some((w) => w.clientId === client.id && w.dependencyIds.includes(dep.id));
      }).length;

      let trend: TrendDirection = "stable";
      if (previousSnapshot) {
        const previousConfidence = confidenceForClient(previousSnapshot.workItems, previousSnapshot.risks, data, client.id, today, workRelevanceIndex, dailyCommandCompletedWorkItemIds);
        trend = deliveryConfidence > previousConfidence ? "improving" : deliveryConfidence < previousConfidence ? "deteriorating" : "stable";
      }

      return {
        clientId: client.id,
        clientName: client.name,
        deliveryConfidence,
        trend,
        topRiskTitle,
        openDecisionsCount,
        criticalDependenciesCount,
      } satisfies ClientAttentionRow;
    })
    .sort((a, b) => a.deliveryConfidence - b.deliveryConfidence);
}

/** V2.4 §17 — Executive Mode Portfolio View. Same deliveryConfidence formula as
 *  confidenceForClient above (scoreAllWorkItems + computeDeliveryConfidence, both already
 *  existing), just grouped by Project instead of Client — no new scoring logic. `data` is
 *  expected to already be the caller's SCOPED view (filteredData), so this only ever
 *  produces one row per project currently in scope; the caller is responsible for listing
 *  any excluded-by-scope project separately (see knownJiraProjects in jira/project-scope.ts). */
export function computeProjectAttentionMap(
  data: CommandCenterData,
  today: string,
  workRelevanceIndex?: WorkRelevanceIndex,
  dailyCommandCompletedWorkItemIds?: ReadonlySet<string>
): ProjectAttentionRow[] {
  return data.projects
    .filter((p) => p.sourceType === "jira" && p.sourceId)
    .map((project) => {
      const projectItems = data.workItems.filter((w) => w.projectId === project.id);
      const projectItemIds = new Set(projectItems.map((w) => w.id));
      const scores = scoreAllWorkItems({ ...data, workItems: projectItems }, today);
      const projectRisks = data.risks.filter((r) => r.status === "open" && r.sourceWorkItemIds.some((id) => projectItemIds.has(id)));
      const overdue = projectItems.filter(
        (w) => isWorkItemOperationallyOpen(w, workRelevanceIndex, dailyCommandCompletedWorkItemIds) && w.dueDate && w.dueDate < today
      ).length;
      const deliveryConfidence = computeDeliveryConfidence(scores, projectRisks, overdue);

      return {
        projectId: project.id,
        projectName: project.name,
        jiraKey: project.sourceId!,
        deliveryConfidence,
        status: deliveryConfidenceBand(deliveryConfidence),
      } satisfies ProjectAttentionRow;
    })
    .sort((a, b) => a.deliveryConfidence - b.deliveryConfidence);
}
