// Global context filter (BUILD REQUEST V1.3 §9). One pure function, applied once before
// the existing deterministic engines run — every screen/widget inherits the filtered view
// automatically instead of needing its own filter UI.

import { daysBetween } from "./scoring";
import type { CommandCenterData, GlobalFilters } from "./types";

export function applyFilters(data: CommandCenterData, filters: GlobalFilters, today: string): CommandCenterData {
  const hasAny = filters.clientId || filters.projectId || filters.fixVersion || filters.timeRangeDays;
  if (!hasAny) return data;

  const projectIds = new Set(
    data.projects.filter((p) => (!filters.clientId || p.clientId === filters.clientId) && (!filters.projectId || p.id === filters.projectId)).map((p) => p.id)
  );

  const workItems = data.workItems.filter((w) => {
    if (filters.clientId && w.clientId !== filters.clientId) return false;
    if (filters.projectId && w.projectId !== filters.projectId) return false;
    if (filters.fixVersion && w.fixVersion !== filters.fixVersion) return false;
    if (filters.timeRangeDays) {
      const age = daysBetween(w.lastUpdated, today);
      if (age > filters.timeRangeDays) return false;
    }
    return true;
  });
  const workItemIds = new Set(workItems.map((w) => w.id));

  return {
    clients: filters.clientId ? data.clients.filter((c) => c.id === filters.clientId) : data.clients,
    projects: data.projects.filter((p) => projectIds.has(p.id) || workItems.some((w) => w.projectId === p.id)),
    workItems,
    requirements: data.requirements.filter((r) => projectIds.size === 0 || projectIds.has(r.projectId)),
    risks: data.risks.filter((r) => r.sourceWorkItemIds.length === 0 || r.sourceWorkItemIds.some((id) => workItemIds.has(id))),
    dependencies: data.dependencies.filter((d) => workItemIds.has(d.workItemId)),
    decisions: data.decisions.filter((d) => projectIds.size === 0 || projectIds.has(d.projectId)),
    actions: data.actions.filter((a) => !a.relatedWorkItemId || workItemIds.has(a.relatedWorkItemId)),
    communications: data.communications.filter((c) => !c.workItemId || workItemIds.has(c.workItemId)),
  };
}

export function availableFixVersions(data: CommandCenterData): string[] {
  return Array.from(new Set(data.workItems.map((w) => w.fixVersion).filter((v): v is string => !!v))).sort();
}
