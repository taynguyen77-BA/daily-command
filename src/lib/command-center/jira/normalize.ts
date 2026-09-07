// Pure Jira → domain-model normalization (BUILD REQUEST V1.3 §6-7). No network calls here
// — every function takes already-fetched, already-validated data and returns plain
// CommandCenterData pieces. This is what makes it testable with fixtures and isolated from
// both the UI and the actual HTTP client (./client.ts, server-only).

import { isBlockedByHeuristic, mapPriority, mapStatus, mapWorkItemType } from "./mapping";
import type { JiraIssue, JiraProject } from "./types";
import type { Client, Dependency, Project, WorkItem } from "../types";

export interface NormalizeOptions {
  baseUrl?: string; // used only to construct sourceUrl — never fabricated if absent
  projectToClient?: Record<string, string>; // Jira project key -> client display name
  today: string; // ISO date, used only as a safe fallback when Jira omits a timestamp
}

function truncateToDate(iso: string | undefined, fallback: string): string {
  if (!iso) return fallback;
  return iso.slice(0, 10);
}

function issueUrl(baseUrl: string | undefined, key: string): string | undefined {
  if (!baseUrl) return undefined;
  return `${baseUrl.replace(/\/$/, "")}/browse/${key}`;
}

export function clientIdForProjectKey(projectKey: string, projectToClient?: Record<string, string>): string {
  return `jira-client-${(projectToClient?.[projectKey] ?? projectKey).toLowerCase().replace(/\s+/g, "-")}`;
}

export function normalizeProjects(jiraProjects: JiraProject[], options: NormalizeOptions): { projects: Project[]; clients: Client[] } {
  const clientsById = new Map<string, Client>();
  const projects: Project[] = jiraProjects.map((jp) => {
    const clientName = options.projectToClient?.[jp.key] ?? jp.name ?? jp.key;
    const clientId = clientIdForProjectKey(jp.key, options.projectToClient);
    if (!clientsById.has(clientId)) clientsById.set(clientId, { id: clientId, name: clientName });
    return {
      id: `jira-project-${jp.key}`,
      name: jp.name ?? jp.key,
      clientId,
      status: "on-track" as const,
      sourceType: "jira" as const,
      sourceId: jp.key,
      sourceUrl: options.baseUrl ? `${options.baseUrl.replace(/\/$/, "")}/projects/${jp.key}` : undefined,
    };
  });
  return { projects, clients: Array.from(clientsById.values()) };
}

/** One issue → one WorkItem + zero-or-more Dependency records (from "blocked by" links). */
export function normalizeIssue(issue: JiraIssue, options: NormalizeOptions): { workItem: WorkItem; dependencies: Dependency[] } {
  const f = issue.fields;
  const projectKey = f.project?.key ?? issue.key.split("-")[0];
  const clientId = clientIdForProjectKey(projectKey, options.projectToClient);
  const flagged = Boolean(f.flagged);
  const blocked = isBlockedByHeuristic(f.status?.name, flagged);

  const dependencies: Dependency[] = (f.issuelinks ?? [])
    .filter((link) => link.type?.name && /block/i.test(link.type.name) && link.inwardIssue)
    .map((link, i) => {
      const blocker = link.inwardIssue!;
      const resolved = blocker.fields?.status?.statusCategory?.key === "done";
      return {
        id: `jira-dep-${issue.key}-${i}`,
        workItemId: `jira-${issue.key}`,
        description: `Blocked by ${blocker.key}${blocker.fields?.summary ? `: ${blocker.fields.summary}` : ""}`,
        dependsOnTeam: blocker.key.split("-")[0],
        status: resolved ? ("resolved" as const) : ("unresolved" as const),
        // Jira's issue-search response doesn't include the link's own creation date without
        // an extra changelog expansion — the issue's own `created` date is the closest
        // honest proxy available without that extra call. Documented, not claimed as exact.
        raisedDate: truncateToDate(f.created, options.today),
      };
    });

  const workItem: WorkItem = {
    id: `jira-${issue.key}`,
    key: issue.key,
    title: f.summary ?? issue.key,
    projectId: `jira-project-${projectKey}`,
    clientId,
    type: mapWorkItemType(f.issuetype?.name, f.labels ?? []),
    status: mapStatus(f.status?.name, f.status?.statusCategory?.key, flagged),
    priority: mapPriority(f.priority?.name),
    owner: f.assignee?.displayName,
    // V2.10 §1 — the stable Jira accountId behind `owner`; preferred over the display name
    // for identity matching wherever a `PersonalIdentity.accountId` is configured.
    ownerId: f.assignee?.accountId,
    dueDate: f.duedate ?? undefined,
    createdDate: truncateToDate(f.created, options.today),
    lastUpdated: truncateToDate(f.updated, options.today),
    blocked,
    blockerReason: blocked ? (flagged ? "Flagged in Jira" : `Status: ${f.status?.name ?? "unknown"}`) : undefined,
    dependencyIds: dependencies.map((d) => d.id),
    riskIds: [],
    // Never inferred from priority (§17) — Jira has no business-impact-equivalent field.
    businessImpact: undefined,
    scopeChangeCount: 0, // requires changelog history Jira's search API doesn't return; see Known Limitations
    labels: f.labels,
    fixVersion: f.fixVersions?.[0]?.name,
    sourceType: "jira",
    sourceId: issue.key,
    sourceUrl: issueUrl(options.baseUrl, issue.key),
    // V2.5 — the raw Jira status name, never fabricated/normalized. This is what the Work
    // Relevance Policy classifies against; the collapsed `status` enum above is too coarse
    // (e.g. "Ready for UAT" and "In Progress" both map to "In Progress").
    jiraStatusName: f.status?.name,
  };

  return { workItem, dependencies };
}

export function normalizeIssues(issues: JiraIssue[], options: NormalizeOptions): { workItems: WorkItem[]; dependencies: Dependency[] } {
  const workItems: WorkItem[] = [];
  const dependencies: Dependency[] = [];
  for (const issue of issues) {
    const { workItem, dependencies: deps } = normalizeIssue(issue, options);
    workItems.push(workItem);
    dependencies.push(...deps);
  }
  return { workItems, dependencies };
}
