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

export const runtime = "nodejs";

const syncRequestSchema = z.object({ sinceIso: z.string().optional() });

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

  const syncStartedAt = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const projectKeys = getConfiguredProjectKeys() ?? undefined;

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
  });
}
