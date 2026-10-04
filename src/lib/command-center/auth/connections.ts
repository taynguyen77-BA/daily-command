// L3 — a member's own Jira connection and Slack destination.
//
// Jira: "personal" (their own Atlassian API token, verified against GET /rest/api/3/myself —
// the accountId and display name come from that response, never from the user) or, only when
// AUTH_ALLOW_SHARED_JIRA=true, "shared" (the server's token, read-only — writes are refused).
// The base URL is ALWAYS the server's JIRA_BASE_URL: a member can't point the server at a host.
//
// Slack: "personal" (their own incoming-webhook URL, encrypted), "team" (the server's
// SLACK_WEBHOOK_URL) or "none".

import { authHeader, buildUrl, JIRA_FETCH_TIMEOUT_MS, type FetchLike } from "../jira/http";
import type { JiraConnectionConfig } from "../jira/types";
import type { Env } from "./auth-config";
import { decryptSecret } from "./secret-box";
import type { UserProfile } from "./users";

export function serverJiraBaseUrl(env: Env): string | null {
  const raw = env.JIRA_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? raw : null;
  } catch {
    return null;
  }
}

export function serverJiraConfig(env: Env): JiraConnectionConfig | null {
  const baseUrl = serverJiraBaseUrl(env);
  const email = env.JIRA_EMAIL;
  const apiToken = env.JIRA_API_TOKEN;
  return baseUrl && email && apiToken ? { baseUrl, email, apiToken } : null;
}

export type JiraVerifyResult = { ok: true; accountId: string; displayName: string } | { ok: false; status: number; error: string };

/** GET {JIRA_BASE_URL}/rest/api/3/myself with the member's own email + token. */
export async function verifyJiraCredentials(fetchImpl: FetchLike, baseUrl: string, email: string, apiToken: string): Promise<JiraVerifyResult> {
  try {
    const res = await fetchImpl(buildUrl(baseUrl, "/rest/api/3/myself", {}), { headers: { Authorization: authHeader({ baseUrl, email, apiToken }), Accept: "application/json" }, signal: AbortSignal.timeout(JIRA_FETCH_TIMEOUT_MS) });
    if (res.status === 401 || res.status === 403) return { ok: false, status: 400, error: "Jira rejected this email / API token." };
    if (!res.ok) return { ok: false, status: 502, error: `Jira answered HTTP ${res.status}.` };
    const me = (await res.json()) as { accountId?: unknown; displayName?: unknown };
    if (typeof me.accountId !== "string" || !me.accountId) return { ok: false, status: 502, error: "Jira's /myself response had no accountId." };
    return { ok: true, accountId: me.accountId, displayName: typeof me.displayName === "string" ? me.displayName : me.accountId };
  } catch {
    return { ok: false, status: 502, error: "Couldn't reach Jira." };
  }
}

export type UserJiraConfig =
  | { ok: true; mode: "personal" | "shared"; config: JiraConnectionConfig; accountId?: string; displayName?: string }
  | { ok: false; status: 503; error: string; errorKind: "not-configured" };

/** The Jira connection a signed-in member's requests run with. */
export function jiraConfigForUser(uid: string, profile: UserProfile, env: Env, key: Buffer | null, allowSharedJira: boolean): UserJiraConfig {
  const notConnected = (error: string): UserJiraConfig => ({ ok: false, status: 503, error, errorKind: "not-configured" });
  if (profile.jira.mode === "personal") {
    const baseUrl = serverJiraBaseUrl(env);
    if (!baseUrl) return notConnected("Jira is not configured on the server (JIRA_BASE_URL).");
    const apiToken = decryptSecret(profile.jira.tokenEnc, key, uid);
    if (!apiToken || !profile.jira.email) return notConnected("Your Jira connection can't be used any more — reconnect it in Data & Settings → My account.");
    return { ok: true, mode: "personal", config: { baseUrl, email: profile.jira.email, apiToken }, accountId: profile.jira.accountId, displayName: profile.jira.displayName };
  }
  if (profile.jira.mode === "shared") {
    if (!allowSharedJira) return notConnected("Shared Jira access is off on this server (AUTH_ALLOW_SHARED_JIRA) — connect your own Jira in Data & Settings → My account.");
    const config = serverJiraConfig(env);
    if (!config) return notConnected("Jira is not configured on the server.");
    return { ok: true, mode: "shared", config, accountId: profile.jira.accountId, displayName: profile.jira.displayName };
  }
  return notConnected("Connect your Jira account in Data & Settings → My account.");
}

/** The Slack webhook this member's notifications go to (null: none). */
export function slackWebhookForUser(uid: string, profile: UserProfile, env: Env, key: Buffer | null): string | null {
  if (profile.slack.mode === "personal") return decryptSecret(profile.slack.webhookEnc, key, uid);
  if (profile.slack.mode === "team") return env.SLACK_WEBHOOK_URL?.trim() || null;
  return null;
}

export const SLACK_WEBHOOK_RE = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{10,200}$/;
export const JIRA_ACCOUNT_ID_RE = /^[A-Za-z0-9:_-]{1,128}$/;
