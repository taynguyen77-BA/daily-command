// F4 — browser side of /api/command-center/jira/write. Sends the paired device's auth.

import { pairedAuthHeader } from "./device-pairing";
import type { JiraTransition } from "./jira/jira-action-provider";
import type { JiraWriteRequest } from "./jira/write-back";

const ENDPOINT = "/api/command-center/jira/write";

async function post<T>(body: unknown): Promise<T | { ok: false; error: string }> {
  try {
    const res = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", ...pairedAuthHeader() }, body: JSON.stringify(body) });
    return (await res.json()) as T;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

export function sendJiraWrite(req: JiraWriteRequest): Promise<{ ok: boolean; error?: string }> {
  return post<{ ok: boolean; error?: string }>(req);
}

export async function loadJiraTransitions(issueKey: string): Promise<{ ok: true; transitions: JiraTransition[] } | { ok: false; error: string }> {
  const r = await post<{ ok: true; transitions?: JiraTransition[] }>({ action: "list-transitions", issueKey });
  return r.ok ? { ok: true, transitions: r.transitions ?? [] } : r;
}
