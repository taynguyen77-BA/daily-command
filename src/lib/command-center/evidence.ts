// Evidence helpers (V1.1 §3-4). These are pure converters: they turn data the
// deterministic engines already computed (scoring factors, risk evidence strings,
// change diffs) into Evidence records — no new data is invented here, and nothing
// here talks to an AI provider. Keeps every AI explanation traceable back to source facts.

import type {
  ChangeEvent,
  CommandCenterData,
  Evidence,
  EvidenceSourceType,
  PriorityScoreResult,
  Risk,
  WorkItem,
} from "./types";

let counter = 0;
function evidenceId(): string {
  counter += 1;
  return `evidence-${counter}`;
}

export function makeEvidence(
  content: string,
  sourceType: EvidenceSourceType,
  sourceId?: string,
  metadata?: Record<string, unknown>
): Evidence {
  return { id: evidenceId(), sourceType, sourceId, content, metadata };
}

/** Evidence for a scored work item — one entry per non-zero contributing factor. */
export function evidenceForScore(
  item: WorkItem,
  result: PriorityScoreResult,
  sourceType: EvidenceSourceType
): Evidence[] {
  return result.factors
    .filter((f) => f.contribution > 0)
    .map((f) => makeEvidence(`${f.name}: ${f.detail}`, sourceType, item.id, { factor: f.name, contribution: f.contribution }));
}

/** Evidence already carried on a Risk (the strings the risk engine attached). */
export function evidenceForRisk(risk: Risk, sourceType: EvidenceSourceType): Evidence[] {
  return risk.evidence.map((e) => makeEvidence(e, sourceType, risk.sourceWorkItemIds[0]));
}

/** Evidence for a single detected change (before/after is itself the fact). */
export function evidenceForChange(change: ChangeEvent, sourceType: EvidenceSourceType): Evidence[] {
  return [makeEvidence(`${change.field}: "${change.before}" → "${change.after}"`, sourceType, change.entityId)];
}

/** Plain facts (as strings) about a work item — used to ground AI prompts and traces. */
export function factsForWorkItem(item: WorkItem, data: CommandCenterData): string[] {
  const facts = [
    `Status: ${item.status}`,
    `Priority: ${item.priority}`,
    item.businessImpact !== undefined ? `Business impact: ${item.businessImpact}/5` : "Business impact: not provided",
    item.dueDate ? `Due date: ${item.dueDate}` : "Due date: none set",
    item.owner ? `Owner: ${item.owner}` : "Owner: unassigned",
    `Blocked: ${item.blocked ? "yes" : "no"}`,
  ];
  if (item.uatCompletionPct !== undefined) facts.push(`UAT completion: ${item.uatCompletionPct}%`);
  const unresolvedDeps = data.dependencies.filter((d) => item.dependencyIds.includes(d.id) && d.status === "unresolved");
  if (unresolvedDeps.length > 0) facts.push(`Unresolved dependencies: ${unresolvedDeps.length}`);
  facts.push(`Last updated: ${item.lastUpdated}`);
  return facts;
}
