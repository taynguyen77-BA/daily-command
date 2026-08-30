// V2.3 — Focus Project Scope. A scope-control layer, not a new intelligence engine: this
// module only decides WHICH already-normalized Jira-sourced records the rest of the app gets
// to see. Every deterministic engine downstream (proactive.ts, personal-focus.ts,
// query-router.ts, ai-context.ts, …) keeps consuming the same CommandCenterData shape —
// nothing about their own logic changes (§11 "enforce scope at the data boundary").
//
// Non-Jira data (Demo, Local Import) is never touched here — only records with
// sourceType === "jira" carry a stable Jira project key to filter on (see jira/normalize.ts:
// Project.sourceId is the Jira project KEY, WorkItem.projectId embeds it as
// `jira-project-${key}`). This is also why the identifier this app stores for scope is the
// Jira project KEY, not a separately-tracked internal id — it's already the one stable
// identifier every other Jira code path in this codebase uses (JIRA_PROJECT_KEYS env var,
// buildIssuesJql's `project in (...)` clause, Project.sourceId).

import type { CommandCenterData, JiraProjectScope, JiraProjectScopeMode, JiraProjectSummary } from "../types";

export const DEFAULT_JIRA_PROJECT_SCOPE: JiraProjectScope = { mode: "ALL", projectKeys: [] };

function isValidMode(v: unknown): v is JiraProjectScopeMode {
  return v === "ALL" || v === "FOCUSED";
}

/** Defensive parse for persisted state (§22) — malformed/missing/wrong-typed data always
 *  degrades to the safe default (ALL, matching pre-V2.3 behavior) rather than crashing or
 *  guessing. Never lets a non-string sneak into projectKeys, and de-duplicates. */
export function parseJiraProjectScope(raw: unknown): JiraProjectScope {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_JIRA_PROJECT_SCOPE };
  const obj = raw as Partial<JiraProjectScope>;
  const mode: JiraProjectScopeMode = isValidMode(obj.mode) ? obj.mode : "ALL";
  const projectKeys = Array.isArray(obj.projectKeys)
    ? Array.from(new Set(obj.projectKeys.filter((k): k is string => typeof k === "string" && k.trim().length > 0)))
    : [];
  const updatedAt = typeof obj.updatedAt === "string" ? obj.updatedAt : undefined;
  return { mode, projectKeys, updatedAt };
}

/** §7, §11 — the data-boundary enforcement point. In ALL mode (including the default, no
 *  scope configured) this is a no-op — identical to pre-V2.3 behavior. In FOCUSED mode,
 *  every Jira-sourced project/work item/dependency/decision/action/communication NOT tied to
 *  a focused project is excluded from the view every downstream engine consumes; Demo and
 *  Local Import records (sourceType !== "jira") are never affected. §10 — this never mutates
 *  or deletes persisted store data, only the derived view built from it (same pattern as
 *  filters.ts's applyFilters, which this composes with in use-command-center.ts). */
export function applyProjectScope(data: CommandCenterData, scope: JiraProjectScope): CommandCenterData {
  if (scope.mode !== "FOCUSED") return data;
  const focused = new Set(scope.projectKeys);

  const projects = data.projects.filter((p) => p.sourceType !== "jira" || (p.sourceId && focused.has(p.sourceId)));
  const projectIds = new Set(projects.map((p) => p.id));

  const workItems = data.workItems.filter((w) => w.sourceType !== "jira" || projectIds.has(w.projectId));
  const workItemIds = new Set(workItems.map((w) => w.id));

  // Clients derived purely from in-scope projects would drop a client that ALSO has
  // non-Jira projects under it — keep any client still referenced by a remaining project or
  // work item, drop one that's ONLY reachable through excluded Jira projects.
  const clientIds = new Set([...projects.map((p) => p.clientId), ...workItems.map((w) => w.clientId)]);
  const clients = data.clients.filter((c) => clientIds.has(c.id));

  return {
    clients,
    projects,
    workItems,
    requirements: data.requirements.filter((r) => projectIds.has(r.projectId) || data.projects.every((p) => p.id !== r.projectId)),
    risks: data.risks.filter((r) => r.sourceWorkItemIds.length === 0 || r.sourceWorkItemIds.some((id) => workItemIds.has(id))),
    dependencies: data.dependencies.filter((d) => workItemIds.has(d.workItemId)),
    decisions: data.decisions.filter((d) => projectIds.has(d.projectId) || data.projects.every((p) => p.id !== d.projectId)),
    actions: data.actions.filter((a) => !a.relatedWorkItemId || workItemIds.has(a.relatedWorkItemId)),
    communications: data.communications.filter((c) => !c.workItemId || workItemIds.has(c.workItemId)),
  };
}

/** The Jira projects this browser currently knows about locally (from the last sync,
 *  regardless of current scope — scope never deletes stored data, §10), for UI display and
 *  Command Bar out-of-scope detection when live discovery hasn't been run in this session. */
export function knownJiraProjects(data: CommandCenterData): JiraProjectSummary[] {
  const byKey = new Map<string, JiraProjectSummary>();
  for (const p of data.projects) {
    if (p.sourceType === "jira" && p.sourceId && !byKey.has(p.sourceId)) {
      byKey.set(p.sourceId, { key: p.sourceId, name: p.name });
    }
  }
  return Array.from(byKey.values());
}

/** V2.3 §15 — Command Bar scope integrity. Detects when a query names a Jira project the app
 *  knows about locally (from prior sync) but which the CURRENT scope excludes, so the caller
 *  can return an honest "outside your focus scope" answer instead of either (a) silently
 *  returning an empty/misleading result or (b) querying Jira for it. Only ever consulted
 *  AFTER classifyQuery() already failed to resolve a target against the (already-scoped)
 *  filtered data — see CommandBar.tsx. */
export function findOutOfScopeMention(query: string, fullData: CommandCenterData, scope: JiraProjectScope): JiraProjectSummary | undefined {
  if (scope.mode !== "FOCUSED") return undefined;
  const q = query.toLowerCase();
  const focused = new Set(scope.projectKeys);
  return knownJiraProjects(fullData).find((p) => !focused.has(p.key) && (q.includes(p.key.toLowerCase()) || (p.name && q.includes(p.name.toLowerCase()))));
}

/** V2.4 §19-21 — Command Bar / Meeting Mode explicit project override. Detects a Jira
 *  project named in free text against every project this browser knows about locally
 *  (§21 "use the existing project metadata"), independent of the CURRENT scope — an
 *  explicit mention should be answerable even when it names a project outside the active
 *  focus (that's the override itself, see CommandBar.tsx). Matching is exact-or-case-
 *  insensitive name/key only, deliberately no fuzzy matching (§21 "avoid fuzzy matching
 *  that could select the wrong project") — a query mentioning two known projects, or a
 *  substring shared by two names, is reported as ambiguous rather than guessed. */
export type ProjectMentionResult = { match: JiraProjectSummary } | { ambiguous: JiraProjectSummary[] } | undefined;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function detectExplicitProjectMention(query: string, projects: JiraProjectSummary[]): ProjectMentionResult {
  const q = query.toLowerCase();
  // Key match is whole-word (a short key like "WF" must not accidentally match inside
  // another word); name match is plain substring, matching the existing findTarget()
  // convention in query-router.ts for client/project names.
  const found = projects.filter((p) => new RegExp(`\\b${escapeRegExp(p.key.toLowerCase())}\\b`).test(q) || (p.name && q.includes(p.name.toLowerCase())));
  if (found.length === 0) return undefined;
  // De-duplicate by key first — a project matched via both its key and its name should not
  // itself read as ambiguous.
  const byKey = new Map(found.map((p) => [p.key, p]));
  const unique = Array.from(byKey.values());
  if (unique.length === 1) return { match: unique[0] };
  return { ambiguous: unique };
}

/** V2.4 §16-17 — one shared "Scope: …" label, reused verbatim by Control Tower, Executive
 *  Mode, and Meeting Mode instead of each surface formatting the same string differently.
 *  ALL -> "All Projects"; FOCUSED -> the focused projects' names (falling back to their key
 *  when a name isn't known locally), joined with " + " to match the spec's own examples
 *  ("Focus: JPMC + UBS"). Never shows a project not actually in `data`. */
export function formatScopeLabel(scope: JiraProjectScope, data: CommandCenterData): string {
  if (scope.mode !== "FOCUSED") return "All Projects";
  if (scope.projectKeys.length === 0) return "No projects selected";
  const byKey = new Map(knownJiraProjects(data).map((p) => [p.key, p]));
  return scope.projectKeys.map((k) => byKey.get(k)?.name ?? k).join(" + ");
}

/** V2.3 §7 — combines the operator-configured JIRA_PROJECT_KEYS env restriction (unchanged
 *  from pre-V2.3 behavior) with the user's Focus Project Scope. ALL mode: behavior is exactly
 *  what it was before this feature existed (env keys only, or unrestricted). FOCUSED mode:
 *  the effective set is the intersection when env keys are also configured (server-side
 *  config always wins as an outer bound), otherwise the focused keys alone. Returns an empty
 *  array (never undefined) for FOCUSED so callers can distinguish "restrict to nothing" from
 *  "no restriction" — the caller is responsible for refusing to sync on an empty result
 *  rather than treating it as unbounded (§7 "Jira query never fetches unrelated projects").
 */
export function resolveEffectiveProjectKeys(envKeys: string[] | null, scope: { mode: JiraProjectScopeMode; projectKeys: string[] }): string[] | undefined {
  if (scope.mode !== "FOCUSED") return envKeys ?? undefined;
  if (!envKeys) return scope.projectKeys;
  const focused = new Set(scope.projectKeys);
  return envKeys.filter((k) => focused.has(k));
}
