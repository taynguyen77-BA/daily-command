// F4/G2 — browser side of /api/command-center/jira/write. Writes carry this device's
// JIRA_WRITE_SECRET pairing; reading the available transitions may also use the sync pairing.

import { jiraWriteAuthHeader, pairedAuthHeader } from "./device-pairing";
import type { JiraTransition } from "./jira/jira-action-provider";
import type { JiraWriteRequest } from "./jira/write-back";
import type { JiraWriteServerLogEntry } from "./jira/write-gate";

const ENDPOINT = "/api/command-center/jira/write";

async function post<T>(body: unknown, headers: Record<string, string> | undefined): Promise<T | { ok: false; error: string }> {
  try {
    const res = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    return (await res.json()) as T;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

export function sendJiraWrite(req: JiraWriteRequest): Promise<{ ok: boolean; error?: string }> {
  return post<{ ok: boolean; error?: string }>(req, jiraWriteAuthHeader());
}

export async function loadJiraTransitions(issueKey: string): Promise<{ ok: true; transitions: JiraTransition[] } | { ok: false; error: string }> {
  const r = await post<{ ok: true; transitions?: JiraTransition[] }>({ action: "list-transitions", issueKey }, jiraWriteAuthHeader() ?? pairedAuthHeader());
  return r.ok ? { ok: true, transitions: r.transitions ?? [] } : r;
}

export interface JiraWriteServerStatus {
  enabled: boolean;
  missing: string[];
  projectKeys?: string[];
  writePaired?: boolean;
  log?: JiraWriteServerLogEntry[];
}

/** The server gate's status (null when unreachable). */
export async function checkJiraWriteServerStatus(): Promise<JiraWriteServerStatus | null> {
  try {
    const res = await fetch(ENDPOINT, { method: "GET", headers: { ...(jiraWriteAuthHeader() ?? pairedAuthHeader()) } });
    if (!res.ok) return null;
    return (await res.json()) as JiraWriteServerStatus;
  } catch {
    return null;
  }
}
