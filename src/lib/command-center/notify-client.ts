// V2.11 §2 — thin fetch wrappers for the Slack notification status/test-send UI in Data &
// Settings. Mirrors datasource/jira-source.ts's checkJiraConfigured()/getJiraConfig() split:
// this file is the only place the browser talks to /api/command-center/notify's GET/test
// paths — the real webhook URL is never sent to, or seen by, the client (see the route's own
// header comment).

import { pairedAuthHeader } from "./device-pairing";

const NOTIFY_ENDPOINT = "/api/command-center/notify";

export interface SlackNotifyStatus {
  configured: boolean;
  channelLabel?: string;
  // V2.13 §3 — true iff a cron-driven server-side notify check is active for this install
  // (both PERSONAL_JIRA_ACCOUNT_ID and Vercel KV configured). use-command-center.ts's notify
  // effect uses this to defer entirely to the server path rather than double-sending.
  serverSideNotifyActive?: boolean;
}

export async function checkSlackNotifyStatus(): Promise<SlackNotifyStatus> {
  try {
    const res = await fetch(NOTIFY_ENDPOINT, { method: "GET" });
    if (!res.ok) return { configured: false };
    return (await res.json()) as SlackNotifyStatus;
  } catch {
    return { configured: false };
  }
}

/** V2.13 §3 — fetched once per page session (it doesn't change during a session — see
 *  use-command-center.ts's own comment), cached at module scope so the many components that
 *  call useCommandCenter() never trigger more than one real GET between them. */
let serverSideNotifyActiveCache: Promise<boolean> | null = null;
export function getServerSideNotifyActiveCached(): Promise<boolean> {
  if (!serverSideNotifyActiveCache) {
    serverSideNotifyActiveCache = checkSlackNotifyStatus().then((s) => s.serverSideNotifyActive === true);
  }
  return serverSideNotifyActiveCache;
}

export interface SlackTestNotificationResult {
  sent: boolean;
  reason?: string;
  // V2.13 (bug fix) — Slack's real HTTP status/body on a non-ok response, or the network
  // error's message, so a failed test notification is actually debuggable (a revoked/mistyped
  // webhook vs. a network timeout look identical without this).
  detail?: string;
}

/** §2 — the client-side gate on `configured` is a UI convenience only; this always sends
 *  the request regardless, so the server's honest response wins if the two ever disagree
 *  (same graceful-degradation contract as every other status check in this app). */
export async function sendTestSlackNotification(): Promise<SlackTestNotificationResult> {
  try {
    const res = await fetch(NOTIFY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...pairedAuthHeader() },
      body: JSON.stringify({ test: true }),
    });
    return (await res.json()) as SlackTestNotificationResult;
  } catch {
    return { sent: false, reason: "network-error" };
  }
}
