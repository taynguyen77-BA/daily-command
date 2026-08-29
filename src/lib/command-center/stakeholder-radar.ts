// Stakeholder Radar + Communication Priority (V1.4 §16-17). A lightweight intelligence
// layer over ownership fields already on the model — never a CRM, never an inferred
// org hierarchy. "Owner" here always means the literal field on the record (owner /
// decision.owner / dependency.ownerId / action.owner), nothing derived.

import type {
  CommandCenterData,
  Communication,
  CommunicationPriority,
  CommunicationPriorityResult,
  DecisionRadarItem,
  DependencyRadarItem,
  RiskEscalation,
  StakeholderAttentionItem,
} from "./types";

export function computeStakeholderAttention(
  data: CommandCenterData,
  dependencyRadar: DependencyRadarItem[],
  decisionRadar: DecisionRadarItem[]
): StakeholderAttentionItem[] {
  const out: StakeholderAttentionItem[] = [];

  const unownedHighPriority = data.workItems.filter((w) => w.status !== "Done" && (w.priority === "P1" || w.priority === "P2") && !w.owner);
  for (const w of unownedHighPriority) {
    out.push({ ownerKey: "unassigned", ownerLabel: "Unassigned", role: "OWNER", reason: `${w.key} (${w.priority}) has no assigned owner.`, relatedIds: [w.id] });
  }

  for (const dep of dependencyRadar) {
    if (!dep.ownerId) {
      out.push({ ownerKey: "unassigned", ownerLabel: "Unassigned", role: "DEPENDENCY_OWNER", reason: `Dependency on ${dep.dependsOnTeam} has no clear owner.`, relatedIds: [dep.dependencyId] });
    }
  }

  for (const item of decisionRadar) {
    if (!item.decision.owner) {
      out.push({ ownerKey: "unassigned", ownerLabel: "Unassigned", role: "DECISION_MAKER", reason: `Decision "${item.decision.title}" needs review but has no owner.`, relatedIds: [item.decisionId] });
    }
  }

  // Ownership concentration across risk/dependency/decision/action — same owner appearing
  // 3+ times is worth surfacing, not because of an inferred hierarchy but because a single
  // person is the bottleneck on multiple fronts.
  const counts = new Map<string, { role: StakeholderAttentionItem["role"]; ids: string[] }[]>();
  const record = (owner: string | undefined, role: StakeholderAttentionItem["role"], id: string) => {
    if (!owner) return;
    counts.set(owner, [...(counts.get(owner) ?? []), { role, ids: [id] }]);
  };
  for (const w of data.workItems) if (w.status !== "Done") record(w.owner, "OWNER", w.id);
  for (const dep of dependencyRadar) record(dep.ownerId, "DEPENDENCY_OWNER", dep.dependencyId);
  for (const d of decisionRadar) record(d.decision.owner, "DECISION_MAKER", d.decisionId);
  for (const a of data.actions) if (a.status !== "completed") record(a.owner, "ACTION_OWNER", a.id);

  counts.forEach((entries, owner) => {
    if (entries.length >= 3) {
      out.push({
        ownerKey: owner,
        ownerLabel: owner,
        role: entries[0].role,
        reason: `${owner} appears across ${entries.length} open risk/dependency/decision/action items — a concentration risk if unavailable.`,
        relatedIds: entries.flatMap((e) => e.ids),
      });
    }
  });

  return out;
}

/** Deterministic WHO/WHY/WHAT/WHEN ranking — no AI call, this is arithmetic + templates,
 *  not interpretation (§48). */
export function rankCommunicationPriority(
  communications: Communication[],
  data: CommandCenterData,
  riskEscalations: RiskEscalation[],
  dependencyRadar: DependencyRadarItem[]
): CommunicationPriorityResult[] {
  const escalatingRiskTitles = new Set(riskEscalations.filter((r) => r.trend === "worsening").map((r) => r.riskTitle));
  const criticalDependencies = new Set(dependencyRadar.filter((d) => d.heat === "CRITICAL" || d.heat === "HIGH").map((d) => d.dependencyId));

  return communications
    .filter((c) => c.status === "open")
    .map((c) => {
      const item = c.workItemId ? data.workItems.find((w) => w.id === c.workItemId) : undefined;
      const linkedToEscalatingRisk = item ? item.riskIds.some((rid) => escalatingRiskTitles.has(data.risks.find((r) => r.id === rid)?.title ?? "")) : false;
      const linkedToCriticalDependency = item ? item.dependencyIds.some((id) => criticalDependencies.has(id)) : false;

      let priority: CommunicationPriority;
      let when: string;
      if (linkedToEscalatingRisk || linkedToCriticalDependency) {
        priority = "URGENT";
        when = "Today";
      } else if (item?.blocked || item?.priority === "P1") {
        priority = "IMPORTANT";
        when = "Within 1-2 days";
      } else if (item) {
        priority = "INFORM";
        when = "This week";
      } else {
        priority = "NO_ACTION";
        when = "No immediate action needed";
      }

      return {
        communicationId: c.id,
        priority,
        who: c.who,
        why: c.why,
        what: c.whatTheyNeedToKnow,
        when,
      } satisfies CommunicationPriorityResult;
    })
    .sort((a, b) => {
      const order: Record<CommunicationPriority, number> = { URGENT: 0, IMPORTANT: 1, INFORM: 2, NO_ACTION: 3 };
      return order[a.priority] - order[b.priority];
    });
}
