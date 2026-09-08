// Client-side Jira data source (BUILD REQUEST V1.3 §3-5). This is the ONLY place on the
// client that knows the Jira sync endpoint exists — it never imports the server-only Jira
// client or touches credentials. Same "dumb caller, server does the real work" pattern as
// ClaudeProvider (see ../ai/claude-provider.ts).

import type { CommandCenterData, JiraErrorKind, JiraProjectScopeMode, JiraProjectSummary, MentionEvent } from "../types";
import type { DataSourceProvider, DataSourceSyncResult } from "./types";
import { pairedAuthHeader } from "../device-pairing";

const SYNC_ENDPOINT = "/api/command-center/jira/sync";
const STATUS_ENDPOINT = "/api/command-center/jira/status";
const PROJECTS_ENDPOINT = "/api/command-center/jira/projects";

export class JiraDataSource implements DataSourceProvider {
  readonly type = "jira" as const;

  async sync(options?: { sinceIso?: string; scopeMode?: JiraProjectScopeMode; projectKeys?: string[]; accountId?: string }): Promise<DataSourceSyncResult> {
    try {
      // V2.15 §2 — when this device is paired for Cross-Device Sync, its paired secret is
      // also accepted by jira/sync/route.ts's POST auth gate (see sync-auth.ts), so a manual
      // Sync Now click keeps working even when the deployment locks the route down with
      // CRON_SECRET. Absent on an unpaired device — identical request to before this pass.
      const res = await fetch(SYNC_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...pairedAuthHeader() },
        body: JSON.stringify(options ?? {}),
      });
      const json = (await res.json()) as {
        ok: boolean;
        data?: CommandCenterData;
        recordsFetched?: number;
        syncedAt?: string;
        error?: string;
        errorKind?: JiraErrorKind;
        durationMs?: number;
        scopeChangesDetected?: number;
        projectsDiscovered?: number;
        warnings?: string[];
        pages?: number;
        changelogRequests?: number;
        scopeMode?: JiraProjectScopeMode;
        focusedProjectCount?: number;
        focusedProjects?: string[];
        mentionEvents?: MentionEvent[];
      };
      if (!res.ok || !json.ok) {
        return { ok: false, error: json.error ?? `Jira sync failed (${res.status}).`, errorKind: json.errorKind ?? "unknown" };
      }
      return {
        ok: true,
        data: json.data,
        recordsFetched: json.recordsFetched,
        syncedAt: json.syncedAt,
        durationMs: json.durationMs,
        scopeChangesDetected: json.scopeChangesDetected,
        projectsDiscovered: json.projectsDiscovered,
        warnings: json.warnings,
        pages: json.pages,
        changelogRequests: json.changelogRequests,
        scopeMode: json.scopeMode,
        focusedProjectCount: json.focusedProjectCount,
        focusedProjects: json.focusedProjects,
        mentionEvents: json.mentionEvents,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Network error contacting the sync endpoint.", errorKind: "network-error" };
    }
  }
}

export async function checkJiraConfigured(): Promise<{ configured: boolean; baseUrlHost?: string }> {
  try {
    const res = await fetch(STATUS_ENDPOINT, { method: "GET" });
    if (!res.ok) return { configured: false };
    return (await res.json()) as { configured: boolean; baseUrlHost?: string };
  } catch {
    return { configured: false };
  }
}

/** V2.3 §5 — Focus Project Scope project discovery. Never fetches issues — see the
 *  /api/command-center/jira/projects route. */
export async function discoverJiraProjects(): Promise<{ ok: boolean; projects?: JiraProjectSummary[]; error?: string }> {
  try {
    const res = await fetch(PROJECTS_ENDPOINT, { method: "GET" });
    const json = (await res.json()) as { ok: boolean; projects?: JiraProjectSummary[]; error?: string };
    if (!res.ok || !json.ok) return { ok: false, error: json.error ?? `Project discovery failed (${res.status}).` };
    return { ok: true, projects: json.projects ?? [] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error contacting the project discovery endpoint." };
  }
}
