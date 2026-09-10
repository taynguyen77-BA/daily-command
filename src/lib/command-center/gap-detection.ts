// Deterministic gap-detection engine (BUILD REQUEST V1.1 §13 "What Did We Forget?").
// Same discipline as risk-detection.ts: explicit, reproducible rules over existing data,
// no AI call, no guessing. Every gap carries Evidence so the claim is traceable.

import { daysBetween } from "./scoring";
import { makeEvidence } from "./evidence";
import { isWorkItemOperationallyOpen, type WorkRelevanceIndex } from "./jira/work-relevance";
import type { CommandCenterData, Evidence, EvidenceSourceType } from "./types";

export interface Gap {
  id: string;
  title: string;
  evidence: Evidence[];
  why: string;
  recommendedAction: string;
  confidence: number;
}

let counter = 0;
function gapId(): string {
  counter += 1;
  return `gap-${counter}`;
}

/** V2.21 §3.2 — `workRelevanceIndex`/`dailyCommandCompletedWorkItemIds` are additive/optional
 *  trailing parameters, same no-op-when-omitted contract as every other V2.21 extension:
 *  omitting them reproduces the pre-V2.21 raw-Jira-Done-only behavior exactly. */
export function detectGaps(
  data: CommandCenterData,
  today: string,
  sourceType: EvidenceSourceType,
  workRelevanceIndex?: WorkRelevanceIndex,
  dailyCommandCompletedWorkItemIds?: ReadonlySet<string>
): Gap[] {
  const out: Gap[] = [];
  const push = (g: Omit<Gap, "id">) => out.push({ ...g, id: gapId() });

  // Requirement without any test coverage tracked at all.
  for (const req of data.requirements) {
    if (req.testCoveragePct === undefined) {
      push({
        title: `${req.title} has no test coverage tracked`,
        evidence: [makeEvidence(`Requirement "${req.title}" — test coverage: not tracked`, sourceType, req.id)],
        why: "A requirement with untracked coverage could ship without anyone confirming it was tested.",
        recommendedAction: "Ask QA to record test coverage for this requirement.",
        confidence: 0.7,
      });
    }
  }

  // High-priority work item with no owner (reframed as a planning gap, not just a risk).
  for (const item of data.workItems) {
    if (!isWorkItemOperationallyOpen(item, workRelevanceIndex, dailyCommandCompletedWorkItemIds)) continue;
    if ((item.priority === "P1" || item.priority === "P2") && !item.owner) {
      push({
        title: `${item.key} has no owner assigned`,
        evidence: [makeEvidence(`${item.key} — priority ${item.priority}, owner: unassigned`, sourceType, item.id)],
        why: "Nobody is accountable for driving a high-priority item forward.",
        recommendedAction: "Assign an owner before end of day.",
        confidence: 0.85,
      });
    }
  }

  // Unresolved dependency — the data model has no target/expected-resolution date field
  // at all, so every unresolved dependency is, by definition, missing one.
  for (const dep of data.dependencies) {
    if (dep.status !== "unresolved") continue;
    push({
      title: `Dependency on ${dep.dependsOnTeam} has no target resolution date`,
      evidence: [makeEvidence(`Dependency "${dep.description}" raised ${dep.raisedDate}, no target date on record`, sourceType, dep.id)],
      why: "An unresolved dependency without a target date is easy to lose track of.",
      recommendedAction: `Ask ${dep.dependsOnTeam} to commit to a resolution date.`,
      confidence: 0.7,
    });
  }

  // Release approaching without any readiness evidence (no work item tracking UAT at all).
  for (const project of data.projects) {
    if (!project.releaseDate) continue;
    const daysToRelease = daysBetween(today, project.releaseDate);
    if (daysToRelease < 0 || daysToRelease > 14) continue;
    const hasReadinessEvidence = data.workItems.some((w) => w.projectId === project.id && w.uatCompletionPct !== undefined);
    if (!hasReadinessEvidence) {
      push({
        title: `${project.name} has no release readiness evidence`,
        evidence: [makeEvidence(`Release date ${project.releaseDate}, no work item tracks UAT completion`, sourceType, project.id)],
        why: "A release within two weeks with zero UAT tracking means readiness can't be confirmed.",
        recommendedAction: "Start tracking UAT completion for this release now.",
        confidence: 0.75,
      });
    }
  }

  // Risk without a mitigation.
  for (const risk of data.risks) {
    if (risk.status !== "open") continue;
    if (!risk.mitigation || !risk.mitigation.trim()) {
      push({
        title: `Risk "${risk.title}" has no mitigation on record`,
        evidence: [makeEvidence(`Risk "${risk.title}" — mitigation: (empty)`, sourceType, risk.id)],
        why: "An open risk with no mitigation plan is easy to forget until it becomes an issue.",
        recommendedAction: "Add a mitigation plan to this risk.",
        confidence: 0.7,
      });
    }
  }

  // Action without an owner.
  for (const action of data.actions) {
    if (action.status !== "open") continue;
    if (!action.owner) {
      push({
        title: `Action "${action.title}" has no owner`,
        evidence: [makeEvidence(`Action "${action.title}" — owner: unassigned`, sourceType, action.id)],
        why: "An action with no owner is unlikely to get done.",
        recommendedAction: "Assign this action to someone before adding it to a plan.",
        confidence: 0.65,
      });
    }
  }

  // Production issue with no follow-up action tracked.
  for (const item of data.workItems) {
    if (item.type !== "production-issue" || !isWorkItemOperationallyOpen(item, workRelevanceIndex, dailyCommandCompletedWorkItemIds)) continue;
    const hasFollowUp = data.actions.some((a) => a.relatedWorkItemId === item.id && a.status !== "completed");
    if (!hasFollowUp) {
      push({
        title: `${item.key} (production issue) has no follow-up action`,
        evidence: [makeEvidence(`${item.key} — type: production-issue, status: ${item.status}, no linked action`, sourceType, item.id)],
        why: "A production issue with no tracked follow-up can quietly stall.",
        recommendedAction: "Create a follow-up action and assign an owner now.",
        confidence: 0.8,
      });
    }
  }

  // Decisions still pending past their own due date.
  for (const decision of data.decisions) {
    if (decision.status !== "pending" || !decision.dueDate) continue;
    if (daysBetween(decision.dueDate, today) > 0) {
      push({
        title: `Decision "${decision.title}" is overdue and still pending`,
        evidence: [makeEvidence(`Decision "${decision.title}" — due ${decision.dueDate}, status: pending`, sourceType, decision.id)],
        why: "A decision sitting past its due date can block downstream work without anyone noticing.",
        recommendedAction: "Escalate this decision for a resolution today.",
        confidence: 0.75,
      });
    }
  }

  return out;
}
