// Server-only Jira config + credential access (BUILD REQUEST V1.3 §4-5). `import
// "server-only"` makes it a build error for any client component to import this file — the
// only caller is src/app/api/command-center/jira/*.ts. Credentials live in process.env
// here and are never returned in any response, logged, or forwarded to Claude.
//
// The actual HTTP/pagination/error-classification logic lives in
// ../command-center/jira/http.ts (dependency-injected, unit-testable with fixtures) — this
// file only supplies the real fetch implementation and the real (secret) config.

import "server-only";
import { fetchIssueChangelogWith, fetchJiraIssuesWith, fetchJiraProjectsWith, type FetchIssuesOptions, type JiraFetchResult } from "../command-center/jira/http";
import type { JiraChangelogHistory, JiraConnectionConfig, JiraIssue, JiraProject } from "../command-center/jira/types";

export function getJiraConfig(): JiraConnectionConfig | null {
  const baseUrl = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;
  if (!baseUrl || !email || !apiToken) return null;
  try {
    new URL(baseUrl);
  } catch {
    return null; // invalid URL — treated the same as "not configured" by callers
  }
  return { baseUrl, email, apiToken };
}

/** Configured project keys to scope sync to (optional). Never required. */
export function getConfiguredProjectKeys(): string[] | null {
  const raw = process.env.JIRA_PROJECT_KEYS;
  if (!raw) return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** V1.7 §10 — optional operator-supplied Jira instance timezone offset (minutes from UTC,
 *  e.g. "-300" for US Eastern standard time), used only to tighten the incremental-sync
 *  cursor (see jira/http.ts buildIncrementalSinceParam). Undefined = unknown, and the sync
 *  cursor safely falls back to day-level precision rather than guessing. */
export function getJiraTimezoneOffsetMinutes(): number | undefined {
  const raw = process.env.JIRA_TIMEZONE_OFFSET_MINUTES;
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Project key -> client display name, for §8 "one client can have many projects". */
export function getProjectClientMap(): Record<string, string> | undefined {
  const raw = process.env.JIRA_PROJECT_CLIENT_MAP;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined; // malformed config — fall back to the safe default (project == client)
  }
}

export async function fetchJiraProjects(config: JiraConnectionConfig): Promise<JiraFetchResult<JiraProject[]>> {
  return fetchJiraProjectsWith(fetch, config);
}

export async function fetchJiraIssues(config: JiraConnectionConfig, options: FetchIssuesOptions): Promise<JiraFetchResult<JiraIssue[]>> {
  return fetchJiraIssuesWith(fetch, config, options);
}

/** V1.4 §32 — best-effort, called only for a small prioritized set of issue keys. */
export async function fetchJiraIssueChangelog(config: JiraConnectionConfig, issueKey: string): Promise<JiraFetchResult<JiraChangelogHistory[]>> {
  return fetchIssueChangelogWith(fetch, config, issueKey);
}
