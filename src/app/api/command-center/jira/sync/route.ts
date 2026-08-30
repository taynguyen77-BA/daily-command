// V1.3 §4, §10-12 — the only route that ever talks to Jira. Credentials never leave this
// file. Returns the freshly normalized dataset; the client (store.ts syncJira()) is
// responsible for diffing it against existing local state and merging — this route is
// stateless per request, same pattern as the AI route.

import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchJiraIssueChangelog, fetchJiraIssues, fetchJiraProjects, getConfiguredProjectKeys, getJiraConfig, getJiraTimezoneOffsetMinutes, getProjectClientMap } from "@/lib/server/jira-client";
import { normalizeIssues, normalizeProjects } from "@/lib/command-center/jira/normalize";
import { changelogToScopeSignals, selectPrioritizedIssueKeys } from "@/lib/command-center/jira/scope-drift";
import { buildIncrementalSinceParam, JIRA_MAX_ISSUES, JIRA_PAGE_SIZE } from "@/lib/command-center/jira/http";
import { resolveEffectiveProjectKeys } from "@/lib/command-center/jira/project-scope";

export const runtime = "nodejs";

const syncRequestSchema = z.object({
  sinceIso: z.string().optional(),
  // V2.3 §7 — Focus Project Scope, enforced BEFORE issue ingestion (never fetch-then-filter).
  scopeMode: z.enum(["ALL", "FOCUSED"]).optional(),
  projectKeys: z.array(z.string()).optional(),
});

export async function POST(req: Request) {
  const config = getJiraConfig();
  if (!config) {
    return NextResponse.json({ ok: false, error: "Jira is not configured on the server.", errorKind: "not-configured" }, { status: 503 });
  }

  let body: unknown = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: "Malformed request body.", errorKind: "malformed-response" }, { status: 400 });
  }
  const parsedRequest = syncRequestSchema.safeParse(body);
  if (!parsedRequest.success) {
    return NextResponse.json({ ok: false, error: "Request did not match the expected shape.", errorKind: "malformed-response" }, { status: 400 });
  }

  const scopeMode = parsedRequest.data.scopeMode ?? "ALL";
  // §23 — a FOCUSED request with zero project keys must never be reinterpreted as
  // unrestricted. The client (store.ts syncJira) already refuses to call this route in that
  // state, but the route itself must not trust that — an empty `project in ()` clause would
  // be invalid JQL anyway, so this is refused explicitly with an honest error rather than
  // silently falling through to an unbounded sync.
  if (scopeMode === "FOCUSED" && (!parsedRequest.data.projectKeys || parsedRequest.data.projectKeys.length === 0)) {
    return NextResponse.json(
      { ok: false, error: "No Focus Projects selected. Select at least one project in Data & Settings before syncing.", errorKind: "not-configured" },
      { status: 400 }
    );
  }

  const syncStartedAt = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const projectKeys = resolveEffectiveProjectKeys(getConfiguredProjectKeys(), { mode: scopeMode, projectKeys: parsedRequest.data.projectKeys ?? [] });
  // §7 — the same "never send an unbounded query when a real restriction was intended" logic
  // as above, this time for the merged (env ∩ focus) case: an operator-configured
  // JIRA_PROJECT_KEYS with zero overlap against the user's focus selection is a real,
  // reportable misconfiguration, not silently treated as "no restriction".
  if (scopeMode === "FOCUSED" && projectKeys && projectKeys.length === 0) {
    return NextResponse.json(
      { ok: false, error: "The selected Focus Projects have no overlap with this server's configured JIRA_PROJECT_KEYS restriction.", errorKind: "not-configured" },
      { status: 400 }
    );
  }

  const projectsResult = await fetchJiraProjects(config);
  if (!projectsResult.ok) {
    return NextResponse.json({ ok: false, error: projectsResult.error, errorKind: projectsResult.errorKind }, { status: 502 });
  }

  // V1.7 §10 — the client sends the raw lastSyncCompletedAt ISO datetime; only this route
  // knows any configured JIRA_TIMEZONE_OFFSET_MINUTES, so the actual JQL cursor is computed
  // here. See jira/http.ts buildIncrementalSinceParam for the safety reasoning.
  const jqlSinceIso = parsedRequest.data.sinceIso ? buildIncrementalSinceParam(parsedRequest.data.sinceIso, getJiraTimezoneOffsetMinutes()) : undefined;

  const issuesResult = await fetchJiraIssues(config, { sinceIso: jqlSinceIso, projectKeys });
  if (!issuesResult.ok) {
    return NextResponse.json({ ok: false, error: issuesResult.error, errorKind: issuesResult.errorKind }, { status: 502 });
  }

  // V1.7 §3, §7 — the fixed safety cap in jira/http.ts is silent by design (it's a
  // per-request loop guard, not a diagnostic); this is the one place that knows enough to
  // turn "we stopped fetching at the cap" into a visible warning rather than hiding it.
  const warnings: string[] = [];
  if (issuesResult.recordsFetched >= JIRA_MAX_ISSUES) {
    warnings.push(`Result set reached the ${JIRA_MAX_ISSUES}-issue safety cap — some matching issues may not have been fetched this sync.`);
  }

  const options = { baseUrl: config.baseUrl, projectToClient: getProjectClientMap(), today };
  const jiraProjects = projectKeys ? projectsResult.data.filter((p) => projectKeys.includes(p.key)) : projectsResult.data;
  const { projects, clients } = normalizeProjects(jiraProjects, options);
  const { workItems, dependencies } = normalizeIssues(issuesResult.data, options);

  // V1.4 §32-33 — best-effort Scope Drift: changelog is fetched only for a small
  // prioritized set of issues, never all of them. A per-issue failure here never fails
  // the sync — those items simply keep the documented scopeChangeCount: 0 limitation.
  const prioritizedKeys = selectPrioritizedIssueKeys(workItems.map((w) => ({ key: w.key, priority: w.priority, blocked: w.blocked, dueDate: w.dueDate, fixVersion: w.fixVersion })));
  const scopeChangeCounts = new Map<string, number>();
  await Promise.all(
    prioritizedKeys.map(async (key) => {
      try {
        const result = await fetchJiraIssueChangelog(config, key);
        if (result.ok) scopeChangeCounts.set(key, changelogToScopeSignals(`jira-${key}`, result.data).length);
      } catch {
        // best-effort — a changelog failure never fails the sync
      }
    })
  );
  const enrichedWorkItems = scopeChangeCounts.size === 0 ? workItems : workItems.map((w) => (scopeChangeCounts.has(w.key) ? { ...w, scopeChangeCount: scopeChangeCounts.get(w.key)! } : w));
  const scopeChangesDetected = Array.from(scopeChangeCounts.values()).reduce((s, n) => s + n, 0);

  return NextResponse.json({
    ok: true,
    data: { clients, projects, workItems: enrichedWorkItems, dependencies },
    recordsFetched: issuesResult.recordsFetched,
    syncedAt: new Date().toISOString(),
    durationMs: Date.now() - syncStartedAt,
    scopeChangesDetected,
    projectsDiscovered: jiraProjects.length,
    warnings,
    // V1.8 §17 — pages is derived from the same page size the connector actually used
    // (jira/http.ts), never a separately-tracked/duplicated counter.
    pages: Math.ceil(issuesResult.recordsFetched / JIRA_PAGE_SIZE) || (issuesResult.recordsFetched === 0 ? 0 : 1),
    changelogRequests: prioritizedKeys.length,
    // V2.3 §9, §20 — honest scope diagnostics: exactly what this sync actually requested,
    // never implying every discovered project was fetched when scope narrowed it.
    scopeMode,
    focusedProjectCount: scopeMode === "FOCUSED" ? projectKeys?.length ?? 0 : undefined,
    focusedProjects: scopeMode === "FOCUSED" ? projectKeys : undefined,
  });
}
