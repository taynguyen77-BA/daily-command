// Decision conflict detection (BUILD REQUEST V1.2 §8). This module only computes the
// deterministic PRECONDITIONS — objective facts that a decision's original context may no
// longer hold. It never says a decision is invalid; that calibrated judgment call is left
// to the AI narration layer (ai/provider.ts detectDecisionConflicts), which is required to
// use "potential conflict" / "decision may need review" language, never a flat assertion.

import { makeEvidence } from "./evidence";
import type { CommandCenterData, DecisionConflictCandidate, Evidence, EvidenceSourceType } from "./types";

const OPEN_STATUSES = new Set(["pending", "ACTIVE", "AT_RISK", "REVISIT_REQUIRED"]);

export function detectDecisionConflictCandidates(data: CommandCenterData, sourceType: EvidenceSourceType): DecisionConflictCandidate[] {
  const out: DecisionConflictCandidate[] = [];

  for (const decision of data.decisions) {
    if (!OPEN_STATUSES.has(decision.status)) continue;

    const relatedIds = decision.relatedWorkItemIds?.length
      ? new Set(decision.relatedWorkItemIds)
      : new Set(data.workItems.filter((w) => w.projectId === decision.projectId).map((w) => w.id));
    const relatedItems = data.workItems.filter((w) => relatedIds.has(w.id));
    if (relatedItems.length === 0) continue;

    const reasons: string[] = [];
    const evidence: Evidence[] = [];

    const blocked = relatedItems.filter((w) => w.blocked);
    if (blocked.length > 0) {
      reasons.push(`${blocked.length} blocker(s) on related work item(s)`);
      for (const w of blocked) evidence.push(makeEvidence(`${w.key} is blocked: ${w.blockerReason ?? "unspecified"}`, sourceType, w.id));
    }

    const withUat = relatedItems.filter((w) => w.uatCompletionPct !== undefined);
    if (withUat.length > 0) {
      const avgUat = Math.round(withUat.reduce((s, w) => s + (w.uatCompletionPct ?? 0), 0) / withUat.length);
      if (avgUat < 90) {
        reasons.push(`average UAT completion on related items is ${avgUat}%`);
        evidence.push(makeEvidence(`Average UAT completion: ${avgUat}%`, sourceType, decision.projectId));
      }
    }

    const totalScopeChanges = relatedItems.reduce((s, w) => s + w.scopeChangeCount, 0);
    if (totalScopeChanges >= 3) {
      reasons.push(`scope has changed ${totalScopeChanges} time(s) across related items`);
      evidence.push(makeEvidence(`Total scope changes on related items: ${totalScopeChanges}`, sourceType, decision.projectId));
    }

    const project = data.projects.find((p) => p.id === decision.projectId);
    if (project?.releaseDate && decision.dueDate && project.releaseDate < decision.dueDate) {
      reasons.push(`release date moved earlier (was ${decision.dueDate}, now ${project.releaseDate})`);
      evidence.push(makeEvidence(`Release date: ${decision.dueDate} → ${project.releaseDate}`, sourceType, project.id));
    }

    const relatedRiskIds = new Set(relatedItems.flatMap((w) => w.riskIds));
    const highRisksOnRelated = data.risks.filter((r) => r.status === "open" && r.level === "HIGH" && relatedRiskIds.has(r.id));
    if (highRisksOnRelated.length > 0) {
      reasons.push(`${highRisksOnRelated.length} open high-severity risk(s) on related items`);
      for (const r of highRisksOnRelated) evidence.push(makeEvidence(`Open HIGH risk: ${r.title}`, sourceType, r.id));
    }

    if (reasons.length > 0) out.push({ decision, reasons, evidence });
  }

  return out;
}
