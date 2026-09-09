// Single source of truth for "what does this Jira sync error kind mean, and what should the
// user do about it" — shared by Data & Settings' sync status panel and Header's app-wide
// sync-failed banner (see components/command-center/Header.tsx), so the two surfaces can
// never drift into disagreeing explanations for the same JiraErrorKind.

import type { JiraErrorKind } from "../types";

export const JIRA_ERROR_HELP: Record<JiraErrorKind, string> = {
  "not-configured": "Set JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN in the server environment.",
  "invalid-url": "JIRA_BASE_URL is not a valid URL.",
  "auth-failure": "Jira rejected the configured email/API token.",
  "cron-unauthorized":
    "CRON_SECRET is configured on this deployment (the browser can't safely hold that secret). Pair this device below under Cross-Device Sync to restore the Sync Now button, unset CRON_SECRET, or rely on the scheduled cron/GitHub Action instead.",
  "permission-failure": "The configured Jira account lacks permission for this request.",
  "rate-limited": "Jira's rate limit was hit — try again shortly.",
  "network-error": "Could not reach the configured Jira base URL.",
  "malformed-response": "Jira returned a response this app didn't recognize.",
  unknown: "An unexpected error occurred.",
};
