// Deterministic risk-pattern engine (BUILD REQUEST §9 "WHAT MIGHT GO WRONG?").
// Every rule here is an explicit, reproducible combination of fields — no model call.

import { daysBetween } from "./scoring";
import { isWorkItemOperationallyOpen, type WorkRelevanceIndex } from "./jira/work-relevance";
import type { CommandCenterData, Risk, RiskRuleId, WorkItem } from "./types";

let counter = 0;
function riskId(prefix: string) {
  counter += 1;
  return `auto-risk-${prefix}-${counter}`;
}

/** V2.18 §7 — the single canonical identity function, reused by dedupeRisks (selectors.ts)
 *  and computeRiskEscalations (risk-escalation.ts) instead of each inventing its own key.
 *  Auto risks are identified by rule + project + a rule-scoped stable natural key — NEVER by
 *  title (title text is free-form and, for at least R6, changes daily even when the
 *  underlying condition is unchanged) and never by `id` (regenerated non-deterministically on
 *  every detectRisks() call — see the module-level counter above). Manually-logged/imported
 *  risks have no ruleId/identityKey; their own `id` is already a stable identity (import's
 *  mergeById already relies on it), so they fall back to that. */
export function riskFingerprint(risk: Risk): string {
  if (risk.auto && risk.ruleId && risk.identityKey) {
    return `auto:${risk.ruleId}:${risk.projectId}:${risk.identityKey}`;
  }
  return `manual:${risk.id}`;
}

function clientName(data: CommandCenterData, clientId: string) {
  return data.clients.find((c) => c.id === clientId)?.name ?? clientId;
}

type AutoRiskInput = Omit<Risk, "id" | "detectedAt" | "status" | "auto"> & { ruleId: RiskRuleId; identityKey: string };

/** Returns freshly-detected risks. Does not mutate stored risks — callers merge/dedupe via
 *  dedupeRisks (selectors.ts), which uses riskFingerprint above, not title.
 *
 *  V2.21 §3.2 — `workRelevanceIndex`/`dailyCommandCompletedWorkItemIds` are additive/optional
 *  trailing parameters, same no-op-when-omitted contract as scoring.ts's own extension:
 *  omitting them reproduces the pre-V2.21 raw-Jira-Done-only behavior exactly. Passing them
 *  means a Work-Relevance-COMPLETED/EXCLUDED or Daily-Command-completed item never generates
 *  a fresh deadline/stalled/owner-overload risk, matching what Personal Focus/Action Plan
 *  already treat as finished. */
export function detectRisks(
  data: CommandCenterData,
  today: string,
  workRelevanceIndex?: WorkRelevanceIndex,
  dailyCommandCompletedWorkItemIds?: ReadonlySet<string>
): Risk[] {
  const out: Risk[] = [];
  // V2.18 §7 — ruleId/identityKey are now part of AutoRiskInput, so every call site below is
  // compile-time required to stamp a real identity, not just documented to do so.
  const push = (r: AutoRiskInput) => out.push({ ...r, id: riskId(out.length.toString()), detectedAt: today, status: "open", auto: true });

  for (const item of data.workItems) {
    if (!isWorkItemOperationallyOpen(item, workRelevanceIndex, dailyCommandCompletedWorkItemIds)) continue;
    const client = clientName(data, item.clientId);
    const daysToDue = item.dueDate ? daysBetween(today, item.dueDate) : null;

    // R1: approaching deadline + incomplete work
    if (daysToDue !== null && daysToDue <= 3 && daysToDue >= 0) {
      push({
        projectId: item.projectId,
        title: `${client} — ${item.key} deadline at risk`,
        level: daysToDue <= 1 ? "HIGH" : "MEDIUM",
        reason: `Due ${daysToDue === 0 ? "today" : `in ${daysToDue} day(s)`} and status is still "${item.status}".`,
        evidence: [`Due date: ${item.dueDate}`, `Status: ${item.status}`, `Business impact: ${item.businessImpact}/5`],
        potentialImpact: "Deliverable may miss its committed date.",
        mitigation: "Confirm remaining scope and pull in help if needed today.",
        confidence: 0.85,
        sourceWorkItemIds: [item.id],
        ruleId: "deadline-risk",
        identityKey: item.id,
      });
    }

    // R2: blocked + unresolved dependency
    const unresolvedDeps = data.dependencies.filter((d) => item.dependencyIds.includes(d.id) && d.status === "unresolved");
    if (item.blocked && unresolvedDeps.length > 0) {
      push({
        projectId: item.projectId,
        title: `${client} — ${item.key} blocked by unresolved dependency`,
        level: "HIGH",
        reason: `Item is blocked and has ${unresolvedDeps.length} unresolved dependenc${unresolvedDeps.length === 1 ? "y" : "ies"}.`,
        evidence: [
          `Blocker: ${item.blockerReason ?? "unspecified"}`,
          ...unresolvedDeps.map((d) => `Dependency on ${d.dependsOnTeam}: ${d.description} (raised ${d.raisedDate})`),
        ],
        potentialImpact: "Work cannot progress until the dependency clears.",
        mitigation: `Escalate to ${unresolvedDeps[0].dependsOnTeam} today for a resolution date.`,
        confidence: 0.9,
        sourceWorkItemIds: [item.id],
        ruleId: "blocked-dependency",
        identityKey: item.id,
      });
    }

    // R3: high priority + no owner
    if ((item.priority === "P1" || item.priority === "P2") && !item.owner) {
      push({
        projectId: item.projectId,
        title: `${client} — ${item.key} has no owner`,
        level: "HIGH",
        reason: `Priority ${item.priority} item with no assigned owner.`,
        evidence: [`Priority: ${item.priority}`, "Owner: none"],
        potentialImpact: "Nobody is accountable for driving this to completion.",
        mitigation: "Assign an owner before end of day.",
        confidence: 0.9,
        sourceWorkItemIds: [item.id],
        ruleId: "no-owner",
        identityKey: item.id,
      });
    }

    // R4: aging + no update on in-progress work
    const agingDays = daysBetween(item.lastUpdated, today);
    if (item.status === "In Progress" && agingDays >= 5) {
      push({
        projectId: item.projectId,
        title: `${client} — ${item.key} stalled`,
        level: agingDays >= 8 ? "HIGH" : "MEDIUM",
        reason: `No update in ${agingDays} days while status is "In Progress".`,
        evidence: [`Last updated: ${item.lastUpdated}`, `Status: ${item.status}`],
        potentialImpact: "Progress may have quietly stopped without visibility.",
        mitigation: "Ping the owner for a status update today.",
        confidence: 0.75,
        sourceWorkItemIds: [item.id],
        ruleId: "stalled",
        identityKey: item.id,
      });
    }

    // R5: repeated scope changes
    if (item.scopeChangeCount >= 3) {
      push({
        projectId: item.projectId,
        title: `${client} — ${item.key} scope is unstable`,
        level: "MEDIUM",
        reason: `Scope has changed ${item.scopeChangeCount} times.`,
        evidence: [`Scope changes recorded: ${item.scopeChangeCount}`],
        potentialImpact: "Estimates and downstream planning may no longer be reliable.",
        mitigation: "Re-baseline scope and confirm with the requestor before continuing.",
        confidence: 0.7,
        sourceWorkItemIds: [item.id],
        ruleId: "scope-unstable",
        identityKey: item.id,
      });
    }

    // R9: production issue with no follow-up action
    if (item.type === "production-issue") {
      const hasFollowUp = data.actions.some((a) => a.relatedWorkItemId === item.id && a.status !== "completed");
      if (!hasFollowUp) {
        push({
          projectId: item.projectId,
          title: `${client} — ${item.key} production issue has no follow-up`,
          level: "HIGH",
          reason: "Production issue is open with no tracked follow-up action.",
          evidence: [`Type: production-issue`, `Status: ${item.status}`],
          potentialImpact: "Issue may go unresolved without an accountable next step.",
          mitigation: "Create a follow-up action and assign an owner now.",
          confidence: 0.85,
          sourceWorkItemIds: [item.id],
          ruleId: "production-no-followup",
          identityKey: item.id,
        });
      }
    }
  }

  // R6: dependency unresolved for a while (independent of blocked flag)
  for (const dep of data.dependencies) {
    if (dep.status !== "unresolved") continue;
    const age = daysBetween(dep.raisedDate, today);
    if (age >= 3) {
      const item = data.workItems.find((w) => w.dependencyIds.includes(dep.id));
      push({
        projectId: item?.projectId ?? "",
        title: `Dependency on ${dep.dependsOnTeam} unresolved for ${age} days`,
        level: age >= 6 ? "HIGH" : "MEDIUM",
        reason: `Raised ${dep.raisedDate} and still unresolved.`,
        evidence: [`Dependency: ${dep.description}`, `Raised: ${dep.raisedDate}`, `Team: ${dep.dependsOnTeam}`],
        potentialImpact: "Downstream work item(s) remain stuck.",
        mitigation: `Escalate to ${dep.dependsOnTeam} lead today.`,
        confidence: 0.8,
        sourceWorkItemIds: item ? [item.id] : [],
        // V2.18 §7 — identityKey is the DEPENDENCY's own id, not the (possibly-absent, and
        // title-embedded-age-unstable) referencing item — this is what makes the same
        // dependency recognizable day-to-day even as `age` in the title text increments, and
        // what distinguishes two different projects' dependencies on the same team (the
        // exact cross-project collision this rule's title alone would otherwise produce).
        ruleId: "dependency-unresolved",
        identityKey: dep.id,
      });
    }
  }

  // R7: high-impact requirement with low/no test coverage
  for (const req of data.requirements) {
    if (req.businessImpact >= 4 && (req.testCoveragePct === undefined || req.testCoveragePct < 50)) {
      push({
        projectId: req.projectId,
        title: `${req.title} has weak test coverage`,
        level: "HIGH",
        reason: `Business impact ${req.businessImpact}/5 with ${req.testCoveragePct ?? 0}% test coverage.`,
        evidence: [`Business impact: ${req.businessImpact}/5`, `Test coverage: ${req.testCoveragePct ?? 0}%`],
        potentialImpact: "A high-impact requirement could ship without adequate validation.",
        mitigation: "Prioritize test coverage for this requirement before release.",
        confidence: 0.8,
        sourceWorkItemIds: [],
        ruleId: "weak-test-coverage",
        identityKey: req.id,
      });
    }
  }

  // R8: release approaching + incomplete UAT (project-level)
  for (const project of data.projects) {
    if (!project.releaseDate) continue;
    const daysToRelease = daysBetween(today, project.releaseDate);
    if (daysToRelease < 0 || daysToRelease > 7) continue;
    const releaseItems = data.workItems.filter((w) => w.projectId === project.id && w.uatCompletionPct !== undefined);
    if (releaseItems.length === 0) continue;
    const avgUat = releaseItems.reduce((s, w) => s + (w.uatCompletionPct ?? 0), 0) / releaseItems.length;
    if (avgUat < 90) {
      push({
        projectId: project.id,
        title: `${project.name} release readiness risk`,
        level: "HIGH",
        reason: `Release is in ${daysToRelease} day(s) and average UAT completion is ${Math.round(avgUat)}%.`,
        evidence: [`Release date: ${project.releaseDate}`, `Average UAT completion: ${Math.round(avgUat)}%`],
        potentialImpact: "Release readiness may not be confirmed on time.",
        mitigation: "Assign a validation owner today and confirm remaining UAT scope with QA.",
        confidence: 0.85,
        sourceWorkItemIds: releaseItems.map((w) => w.id),
        // V2.18 §7 — identityKey is the project's own id, not the releaseItems set (which
        // legitimately changes membership day to day as items gain/lose uatCompletionPct
        // without the underlying "this release's readiness is at risk" condition changing).
        ruleId: "release-readiness",
        identityKey: project.id,
      });
    }
  }

  // R10: ownership concentration — one owner holding many open P1/P2 items
  const counts = new Map<string, WorkItem[]>();
  for (const item of data.workItems) {
    if (!item.owner || !isWorkItemOperationallyOpen(item, workRelevanceIndex, dailyCommandCompletedWorkItemIds)) continue;
    if (item.priority !== "P1" && item.priority !== "P2") continue;
    counts.set(item.owner, [...(counts.get(item.owner) ?? []), item]);
  }
  counts.forEach((items, owner) => {
    if (items.length >= 4) {
      push({
        projectId: items[0].projectId,
        title: `${owner} is overloaded with high-priority work`,
        level: "MEDIUM",
        reason: `${owner} owns ${items.length} open P1/P2 items concentrated on one person.`,
        evidence: items.map((i: WorkItem) => `${i.key}: ${i.title} (${i.priority})`),
        potentialImpact: "Delivery risk if this owner is unavailable or falls behind.",
        mitigation: "Rebalance ownership across the team.",
        confidence: 0.7,
        sourceWorkItemIds: items.map((i: WorkItem) => i.id),
        // V2.18 §7 — identityKey is the owner's name, not the concentrated item set (which
        // legitimately changes membership day to day as P1/P2 items are added/removed for
        // that owner without the underlying overload condition changing).
        ruleId: "owner-overload",
        identityKey: owner,
      });
    }
  });

  return out;
}

export const RISK_LEVEL_ORDER: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
