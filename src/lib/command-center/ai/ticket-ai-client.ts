// V2.36 H1/H4 — browser-side calls for task-level AI: fetch one ticket's content (through the
// per-issue cache), and read today's / 7-day AI usage. Both go through the same paired-device
// auth as Sync Now. Nothing here sends ticket content to the model — that only happens via
// ClaudeProvider.checkRequirements with an input built by data-protection.ts.

import { pairedAuthHeader } from "../device-pairing";
import type { IssueContext } from "../jira/issue-context";
import type { CommandCenterStore } from "../store";
import type { AiUsageSummary } from "./usage-ledger";

const ISSUE_CONTEXT_ENDPOINT = "/api/command-center/jira/issue-context";
const USAGE_ENDPOINT = "/api/command-center/ai/usage";

/** A cached copy is used while it is at least as new as the synced ticket. The bulk sync only
 *  keeps the DAY of Jira's `updated` (WorkItem.lastUpdated), so a same-day edit after the fetch
 *  needs "Refresh"; a later day always refetches. */
export function isContextFresh(cached: IssueContext, workItemLastUpdated?: string): boolean {
  if (!workItemLastUpdated) return true;
  return cached.updated.slice(0, 10) >= workItemLastUpdated.slice(0, 10);
}

export type IssueContextLoad = { ok: true; context: IssueContext; fromCache: boolean } | { ok: false; error: string };

export async function loadIssueContext(store: CommandCenterStore, key: string, opts: { workItemLastUpdated?: string; force?: boolean } = {}): Promise<IssueContextLoad> {
  const state = store.getSnapshot();
  const cached = state.aiContextCache[key]?.context;
  if (cached && !opts.force && isContextFresh(cached, opts.workItemLastUpdated)) return { ok: true, context: cached, fromCache: true };
  const acField = state.aiDataProtection.acceptanceCriteriaFieldId;
  const params = new URLSearchParams({ key, ...(acField ? { acField } : {}) });
  try {
    const res = await fetch(`${ISSUE_CONTEXT_ENDPOINT}?${params.toString()}`, { headers: { ...pairedAuthHeader() } });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; context?: IssueContext; error?: string };
    if (!res.ok || !json.ok || !json.context) return { ok: false, error: json.error ?? `Couldn't load ${key} (HTTP ${res.status}).` };
    store.cacheIssueContext(json.context);
    return { ok: true, context: json.context, fromCache: false };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error loading the ticket." };
  }
}

export async function fetchAiUsage(): Promise<AiUsageSummary | null> {
  try {
    const res = await fetch(USAGE_ENDPOINT, { headers: { ...pairedAuthHeader() } });
    if (!res.ok) return null;
    const json = (await res.json()) as { ok?: boolean; usage?: AiUsageSummary };
    return json.ok && json.usage ? json.usage : null;
  } catch {
    return null;
  }
}
