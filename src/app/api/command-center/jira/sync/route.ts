// V1.3 §4, §10-12 — the only route that ever talks to Jira. Credentials never leave this
// file. Returns the freshly normalized dataset; the client (store.ts syncJira()) is
// responsible for diffing it against existing local state and merging — this route is
// stateless per request, same pattern as the AI route.

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  fetchIssueComments,
  fetchJiraIssueChangelog,
  fetchJiraIssues,
  fetchJiraProjects,
  fetchMentionedIssues,
  getConfiguredProjectKeys,
  getJiraConfig,
  getJiraTimezoneOffsetMinutes,
  getProjectClientMap,
} from "@/lib/server/jira-client";
import { createNotifyStore } from "@/lib/server/notify-store";
import { isNotifyStoreConfigured } from "@/lib/command-center/notify-state";
import { runServerSideNotifyCheck } from "@/lib/command-center/cron-notify";
import { normalizeIssues, normalizeProjects } from "@/lib/command-center/jira/normalize";
import { buildMentionEvents } from "@/lib/command-center/jira/mentions";
import { changelogToScopeSignals, selectPrioritizedIssueKeys } from "@/lib/command-center/jira/scope-drift";
import { buildIncrementalSinceParam, JIRA_MAX_ISSUES, JIRA_PAGE_SIZE } from "@/lib/command-center/jira/http";
import { resolveEffectiveProjectKeys } from "@/lib/command-center/jira/project-scope";
import type { MentionEvent } from "@/lib/command-center/types";

export const runtime = "nodejs";

const syncRequestSchema = z.object({
  sinceIso: z.string().optional(),
  // V2.3 §7 — Focus Project Scope, enforced BEFORE issue ingestion (never fetch-then-filter).
  scopeMode: z.enum(["ALL", "FOCUSED"]).optional(),
  projectKeys: z.array(z.string()).optional(),
  // V2.10 §2 — the configured PersonalIdentity's Jira accountId, sent by the client only
  // when one is set (see store.ts syncJira). Optional: absent means "mention tracking is not
  // configured for this installation", never an error — same contract as every other
  // optional Jira capability in this app.
  accountId: z.string().optional(),
});

/**
 * V2.10 §4 — automated cron requests (see vercel.json / .github/workflows/sync.yml) carry
 * `Authorization: Bearer <CRON_SECRET>`. When CRON_SECRET is configured, a request without a
 * matching header is rejected; when it isn't configured, this route stays exactly as open as
 * it was before this change — same "safe when unconfigured" contract as every other env var
 * here. Note: the in-app "Sync Now" button (Data & Settings) calls this same route from the
 * browser with no such header — configuring CRON_SECRET is an explicit operator trade-off
 * that hardens the automated path at the cost of that manual button (the browser cannot
 * safely hold a server secret) until it's called with the header some other way.
 */
function isAuthorizedCronRequest(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true;
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

export async function POST(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json(
      {
        ok: false,
        error: "This server requires a CRON_SECRET header that the browser cannot send. Sync Now is disabled while CRON_SECRET is configured — call this route via the scheduled cron or GitHub Action instead, or unset CRON_SECRET to restore the button.",
        errorKind: "cron-unauthorized",
      },
      { status: 401 }
    );
  }

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

  // V2.10 §2 — "who mentioned me in a comment?" A second, separate search — never bulk
  // comment fetching (see jira/http.ts's own comment on why). Best-effort: a failure here
  // never fails the sync, same discipline as the changelog enrichment above; the client
  // simply keeps whatever mentionEvents it already had from the previous sync.
  let mentionEvents: MentionEvent[] | undefined;
  const accountId = parsedRequest.data.accountId;
  if (accountId) {
    try {
      const mentionedResult = await fetchMentionedIssues(config, accountId, jqlSinceIso);
      if (mentionedResult.ok) {
        const events: MentionEvent[] = [];
        await Promise.all(
          mentionedResult.data.map(async (issue) => {
            try {
              const commentsResult = await fetchIssueComments(config, issue.key);
              if (commentsResult.ok) {
                events.push(...buildMentionEvents(issue.key, commentsResult.data, accountId, { baseUrl: config.baseUrl, today }));
              }
            } catch {
              // best-effort — a single issue's comment fetch failure never fails the sync
            }
          })
        );
        mentionEvents = events;
      }
    } catch {
      // best-effort — mention tracking never fails the sync
    }
  }

  return NextResponse.json({
    ok: true,
    data: { clients, projects, workItems: enrichedWorkItems, dependencies },
    recordsFetched: issuesResult.recordsFetched,
    syncedAt: new Date().toISOString(),
    durationMs: Date.now() - syncStartedAt,
    scopeChangesDetected,
    projectsDiscovered: jiraProjects.length,
    mentionEvents,
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

/**
 * V2.10 §4 — Vercel Cron Jobs (see vercel.json) always issue a GET request, never POST; this
 * re-dispatches to the exact same POST handler above (an unscoped, full sync — a cron
 * invocation has no browser-persisted `lastSyncCompletedAt`/accountId/focus-scope to send, so
 * it can only ever request everything this server is configured to see) rather than
 * duplicating any sync logic.
 *
 * V2.13 §2 — this app's "no server-side persistence" limitation (see types.ts's own
 * "Local-only V1: no auth, no multi-tenant, no backend") was, until this pass, a real gap for
 * an unattended cron GET specifically: there was no accountId to search mentions for and
 * nowhere server-side to merge/store a result or fire a Slack notification from. That gap is
 * now closed for the narrow slice of state a personal-notify check needs (see notify-state.ts/
 * notify-store.ts) — when PERSONAL_JIRA_ACCOUNT_ID and Vercel KV are both configured, this GET
 * additionally runs runServerSideNotifyCheck AFTER the existing full sync above completes,
 * using the real Jira config and the real KV-backed store. Everything else about this app
 * remains exactly as local-only as before — see the dev prompt this pass implements. When
 * either PERSONAL_JIRA_ACCOUNT_ID or KV is absent, this is a complete no-op (the sync response
 * is returned completely unchanged) — same graceful-degradation contract as every optional
 * capability in this app.
 */
export async function GET(req: Request) {
  const forwarded = new Request(req.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: req.headers.get("authorization") ?? "" },
    body: "{}",
  });
  const response = await POST(forwarded);

  const accountId = process.env.PERSONAL_JIRA_ACCOUNT_ID;
  const config = getJiraConfig();
  if (!accountId || !config || !isNotifyStoreConfigured()) return response;

  // §2 Task 2 point 3 — a connectivity failure inside the notify check must never corrupt
  // persisted state (cron-notify.ts already guarantees `store.set` is never called on a fetch
  // failure) AND must never fail this response — the sync above already succeeded or failed
  // on its own terms; this is a genuinely separate, best-effort concern layered on top.
  try {
    const result = await runServerSideNotifyCheck(fetch, config, accountId, createNotifyStore());
    if (!result.error) return response;
    const body = (await response.clone().json()) as Record<string, unknown>;
    const warnings = Array.isArray(body.warnings) ? [...body.warnings] : [];
    warnings.push(`Server-side notify check failed: ${result.error}`);
    return NextResponse.json({ ...body, warnings }, { status: response.status });
  } catch (err) {
    const body = (await response.clone().json()) as Record<string, unknown>;
    const warnings = Array.isArray(body.warnings) ? [...body.warnings] : [];
    warnings.push(`Server-side notify check failed: ${err instanceof Error ? err.message : "unknown error"}`);
    return NextResponse.json({ ...body, warnings }, { status: response.status });
  }
}
