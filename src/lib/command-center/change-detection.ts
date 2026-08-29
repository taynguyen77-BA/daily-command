// Deterministic diff engine (BUILD REQUEST §8 "WHAT CHANGED?").
// Compares current data against the last DailySnapshot and emits only meaningful changes.

import type { CommandCenterData, ChangeEvent, DailySnapshot } from "./types";

let counter = 0;
function changeId() {
  counter += 1;
  return `change-${counter}`;
}

export function detectChanges(previous: DailySnapshot | null, current: CommandCenterData, today: string): ChangeEvent[] {
  if (!previous) return [];
  const out: ChangeEvent[] = [];
  const push = (e: Omit<ChangeEvent, "id" | "detectedAt">) => out.push({ ...e, id: changeId(), detectedAt: today });

  const prevItems = new Map(previous.workItems.map((w) => [w.id, w]));
  for (const item of current.workItems) {
    const prev = prevItems.get(item.id);
    if (!prev) {
      push({
        entityType: "WorkItem",
        entityId: item.id,
        entityLabel: item.key,
        field: "new item",
        before: "—",
        after: item.title,
        impact: "New work item entered the pipeline.",
      });
      continue;
    }
    if (prev.status !== item.status) {
      push({
        entityType: "WorkItem", entityId: item.id, entityLabel: item.key, field: "Status",
        before: prev.status, after: item.status,
        impact: item.status === "Blocked" ? "New blocker — may need escalation." : item.status === "Done" ? "Completed." : "Status moved forward or backward.",
      });
    }
    if (prev.priority !== item.priority) {
      push({
        entityType: "WorkItem", entityId: item.id, entityLabel: item.key, field: "Priority",
        before: prev.priority, after: item.priority,
        impact: item.priority === "P1" ? "Now the highest priority — review today." : "Priority re-ranked.",
      });
    }
    if (prev.dueDate !== item.dueDate) {
      const pulledIn = prev.dueDate && item.dueDate && item.dueDate < prev.dueDate;
      push({
        entityType: "WorkItem", entityId: item.id, entityLabel: item.key, field: "Due date",
        before: prev.dueDate ?? "none", after: item.dueDate ?? "none",
        impact: pulledIn ? "Deadline moved earlier — higher release risk." : "Due date changed.",
      });
    }
    if (prev.owner !== item.owner) {
      push({
        entityType: "WorkItem", entityId: item.id, entityLabel: item.key, field: "Owner",
        before: prev.owner ?? "unassigned", after: item.owner ?? "unassigned",
        impact: !item.owner ? "Item now has no owner." : "Ownership reassigned.",
      });
    }
    if (prev.blocked !== item.blocked) {
      push({
        entityType: "WorkItem", entityId: item.id, entityLabel: item.key, field: "Blocked",
        before: prev.blocked ? "blocked" : "not blocked", after: item.blocked ? "blocked" : "not blocked",
        impact: item.blocked ? "New blocker introduced." : "Blocker resolved.",
      });
    }
    if (prev.scopeChangeCount !== item.scopeChangeCount) {
      push({
        entityType: "WorkItem", entityId: item.id, entityLabel: item.key, field: "Scope",
        before: `${prev.scopeChangeCount} change(s)`, after: `${item.scopeChangeCount} change(s)`,
        impact: "Scope changed since last review.",
      });
    }
  }

  const prevRisks = new Map(previous.risks.map((r) => [r.id, r]));
  for (const risk of current.risks) {
    const prev = prevRisks.get(risk.id);
    if (!prev) {
      push({
        entityType: "Risk", entityId: risk.id, entityLabel: risk.title, field: "new risk",
        before: "—", after: risk.level,
        impact: "Newly identified risk.",
      });
    } else if (prev.status !== risk.status) {
      push({
        entityType: "Risk", entityId: risk.id, entityLabel: risk.title, field: "Status",
        before: prev.status, after: risk.status,
        impact: risk.status === "closed" ? "Risk resolved." : "Risk reopened.",
      });
    }
  }
  for (const prev of previous.risks) {
    if (!current.risks.find((r) => r.id === prev.id) && prev.status === "open") {
      push({
        entityType: "Risk", entityId: prev.id, entityLabel: prev.title, field: "closed risk",
        before: "open", after: "closed", impact: "Risk no longer present in current data.",
      });
    }
  }

  const prevReqs = new Map(previous.requirements.map((r) => [r.id, r]));
  for (const req of current.requirements) {
    const prev = prevReqs.get(req.id);
    if (!prev) {
      push({
        entityType: "Requirement", entityId: req.id, entityLabel: req.title, field: "new requirement",
        before: "—", after: req.status, impact: "New requirement added.",
      });
    } else if (prev.status !== req.status) {
      push({
        entityType: "Requirement", entityId: req.id, entityLabel: req.title, field: "Status",
        before: prev.status, after: req.status,
        impact: req.status === "changed" ? "Requirement changed — re-confirm scope." : "Requirement status updated.",
      });
    }
  }

  const prevProjects = new Map(previous.projects.map((p) => [p.id, p]));
  for (const project of current.projects) {
    const prev = prevProjects.get(project.id);
    if (prev && prev.releaseDate !== project.releaseDate) {
      push({
        entityType: "Project", entityId: project.id, entityLabel: project.name, field: "Release date",
        before: prev.releaseDate ?? "none", after: project.releaseDate ?? "none",
        impact: prev.releaseDate && project.releaseDate && project.releaseDate < prev.releaseDate
          ? "Release pulled in — higher risk." : "Release date changed.",
      });
    }
  }

  return out;
}

export function toSnapshot(data: CommandCenterData, date: string): DailySnapshot {
  return {
    date,
    workItems: data.workItems,
    risks: data.risks,
    requirements: data.requirements,
    dependencies: data.dependencies,
    projects: data.projects,
  };
}
