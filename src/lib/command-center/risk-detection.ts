// Deterministic risk-pattern engine (BUILD REQUEST §9 "WHAT MIGHT GO WRONG?").
// Every rule here is an explicit, reproducible combination of fields — no model call.

import { daysBetween } from "./scoring";
import type { CommandCenterData, Risk, WorkItem } from "./types";

let counter = 0;
function riskId(prefix: string) {
  counter += 1;
  return `auto-risk-${prefix}-${counter}`;
}

function clientName(data: CommandCenterData, clientId: string) {
  return data.clients.find((c) => c.id === clientId)?.name ?? clientId;
}

/** Returns freshly-detected risks. Does not mutate stored risks — callers merge/dedupe by title. */
export function detectRisks(data: CommandCenterData, today: string): Risk[] {
  const out: Risk[] = [];
  const push = (r: Omit<Risk, "id" | "detectedAt" | "status" | "auto">) =>
    out.push({ ...r, id: riskId(out.length.toString()), detectedAt: today, status: "open", auto: true });

  for (const item of data.workItems) {
    if (item.status === "Done") continue;
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
      });
    }
  }

  // R10: ownership concentration — one owner holding many open P1/P2 items
  const counts = new Map<string, WorkItem[]>();
  for (const item of data.workItems) {
    if (!item.owner || item.status === "Done") continue;
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
      });
    }
  });

  return out;
}

export const RISK_LEVEL_ORDER: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
