// Client Attention Map (V1.4 §35). A lightweight prioritization view over the existing
// multi-client model — not a portfolio management system. Reuses the same per-client
// ranking that query-router.ts's "client-attention" intent already computes (extracted
// here into one reusable function so neither place duplicates the logic).

import { computeDeliveryConfidence } from "./executive";
import { scoreAllWorkItems } from "./scoring";
import type { ClientAttentionRow, CommandCenterData, DailySnapshot, DependencyRadarItem, TrendDirection } from "./types";
import type { DerivedData } from "./selectors";

const OPEN_DECISION_STATUSES = new Set(["pending", "ACTIVE", "AT_RISK", "REVISIT_REQUIRED"]);

function decisionClientId(data: CommandCenterData, decision: { clientId?: string; projectId: string }): string | undefined {
  return decision.clientId ?? data.projects.find((p) => p.id === decision.projectId)?.clientId;
}

function confidenceForClient(workItems: CommandCenterData["workItems"], risks: CommandCenterData["risks"], data: CommandCenterData, clientId: string, today: string): number {
  const clientData: CommandCenterData = { ...data, workItems: workItems.filter((w) => w.clientId === clientId) };
  const scores = scoreAllWorkItems(clientData, today);
  const clientItemIds = new Set(clientData.workItems.map((w) => w.id));
  const clientRisks = risks.filter((r) => r.status === "open" && r.sourceWorkItemIds.some((id) => clientItemIds.has(id)));
  const overdue = clientData.workItems.filter((w) => w.status !== "Done" && w.dueDate && w.dueDate < today).length;
  return computeDeliveryConfidence(scores, clientRisks, overdue);
}

export function computeClientAttentionMap(
  data: CommandCenterData,
  derived: DerivedData,
  dependencyRadar: DependencyRadarItem[],
  previousSnapshot: DailySnapshot | null,
  today: string
): ClientAttentionRow[] {
  const criticalDependencyIds = new Set(dependencyRadar.filter((d) => d.heat === "CRITICAL" || d.heat === "HIGH").map((d) => d.dependencyId));

  return data.clients
    .map((client) => {
      const clientItemIds = new Set(data.workItems.filter((w) => w.clientId === client.id).map((w) => w.id));
      const clientRisks = derived.risks.filter((r) => r.sourceWorkItemIds.some((id) => clientItemIds.has(id)));
      const topRiskTitle = clientRisks[0]?.title;

      const deliveryConfidence = confidenceForClient(data.workItems, data.risks, data, client.id, today);

      const openDecisionsCount = data.decisions.filter((d) => OPEN_DECISION_STATUSES.has(d.status) && decisionClientId(data, d) === client.id).length;

      const criticalDependenciesCount = data.dependencies.filter((dep) => {
        if (!criticalDependencyIds.has(dep.id)) return false;
        return data.workItems.some((w) => w.clientId === client.id && w.dependencyIds.includes(dep.id));
      }).length;

      let trend: TrendDirection = "stable";
      if (previousSnapshot) {
        const previousConfidence = confidenceForClient(previousSnapshot.workItems, previousSnapshot.risks, data, client.id, today);
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
