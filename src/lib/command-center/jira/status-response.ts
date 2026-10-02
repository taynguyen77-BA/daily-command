// E5 — the body of GET /api/command-center/jira/status, split out of the route (which imports
// the server-only jira-client.ts) so it is testable offline, same reasoning as sync-auth.ts.
//
// The route stays reachable without auth — Data & Settings and Setup Health need "is Jira
// configured at all?" before a device is paired — but the Jira host is only returned to a
// caller that passes the same auth as every other route (checkSyncRequestAuth). An
// unauthenticated caller learns `configured` and nothing else.

export interface JiraStatusResponse {
  configured: boolean;
  baseUrlHost?: string;
}

export function buildJiraStatusResponse(config: { baseUrl: string } | null, authorized: boolean): JiraStatusResponse {
  if (!config) return { configured: false };
  if (!authorized) return { configured: true };
  let baseUrlHost: string | undefined;
  try {
    baseUrlHost = new URL(config.baseUrl).host;
  } catch {
    baseUrlHost = undefined;
  }
  return { configured: true, baseUrlHost };
}
