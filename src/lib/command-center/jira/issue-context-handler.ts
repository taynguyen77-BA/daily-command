// The body of GET /api/command-center/jira/issue-context, split out of the route (which imports
// the server-only jira-client.ts) so every refusal is tested offline with a counting fake —
// same reasoning as sync-auth.ts / status-response.ts. The route only wires env, auth and the
// real Jira fetch in.

import { aiServerPolicyAllows, AI_SERVER_POLICY_DENIED, parseAiAllowedProjectKeys } from "../ai/server-policy";
import { isValidCustomFieldId, type JiraFetchResult } from "./http";
import { ISSUE_KEY_RE, type IssueContext } from "./issue-context";

export interface IssueContextDeps {
  configured: boolean;
  /** JIRA_PROJECT_KEYS (null = unrestricted). */
  jiraProjectKeys: string[] | null;
  /** AI_ALLOWED_PROJECT_KEYS, raw. */
  aiAllowedProjectKeys: string | undefined;
  fetchIssueContext: (key: string, opts: { acceptanceCriteriaFieldId?: string }) => Promise<JiraFetchResult<IssueContext>>;
}

export type IssueContextHandlerResult = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

const fail = (status: number, error: string, errorKind: string): IssueContextHandlerResult => ({ status, body: { ok: false, error, errorKind } });

export async function handleIssueContextRequest(url: URL, deps: IssueContextDeps): Promise<IssueContextHandlerResult> {
  if (!deps.configured) return fail(503, "Jira is not configured on the server.", "not-configured");
  const key = (url.searchParams.get("key") ?? "").trim().toUpperCase();
  if (!ISSUE_KEY_RE.test(key)) return fail(400, "Pass a valid Jira issue key, e.g. ?key=ABC-123.", "malformed-response");
  const acField = url.searchParams.get("acField") ?? undefined;
  if (acField && !isValidCustomFieldId(acField)) return fail(400, "acField must be a Jira custom field id like customfield_10050.", "malformed-response");
  const projectKey = key.split("-")[0];
  // The server's own JIRA_PROJECT_KEYS restriction applies here exactly as it does to sync.
  if (deps.jiraProjectKeys && !deps.jiraProjectKeys.includes(projectKey)) return fail(403, "This project is outside the server's configured JIRA_PROJECT_KEYS.", "permission-failure");
  // K4 — and the server's AI data policy, before anything is fetched.
  if (!aiServerPolicyAllows(projectKey, parseAiAllowedProjectKeys(deps.aiAllowedProjectKeys))) return fail(403, AI_SERVER_POLICY_DENIED, "permission-failure");

  const result = await deps.fetchIssueContext(key, { acceptanceCriteriaFieldId: acField });
  if (!result.ok) return fail(502, result.error, result.errorKind);
  return { status: 200, body: { ok: true, context: result.data }, headers: { "Cache-Control": "no-store" } };
}
