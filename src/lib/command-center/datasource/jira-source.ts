// Client-side Jira data source (BUILD REQUEST V1.3 §3-5). This is the ONLY place on the
// client that knows the Jira sync endpoint exists — it never imports the server-only Jira
// client or touches credentials. Same "dumb caller, server does the real work" pattern as
// ClaudeProvider (see ../ai/claude-provider.ts).

import type { CommandCenterData, JiraErrorKind } from "../types";
import type { DataSourceProvider, DataSourceSyncResult } from "./types";

const SYNC_ENDPOINT = "/api/command-center/jira/sync";
const STATUS_ENDPOINT = "/api/command-center/jira/status";

export class JiraDataSource implements DataSourceProvider {
  readonly type = "jira" as const;

  async sync(options?: { sinceIso?: string }): Promise<DataSourceSyncResult> {
    try {
      const res = await fetch(SYNC_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
