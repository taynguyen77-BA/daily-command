// V2.11 §2 — thin fetch wrappers for the Slack notification status/test-send UI in Data &
// Settings. Mirrors datasource/jira-source.ts's checkJiraConfigured()/getJiraConfig() split:
// this file is the only place the browser talks to /api/command-center/notify's GET/test
// paths — the real webhook URL is never sent to, or seen by, the client (see the route's own
// header comment).

const NOTIFY_ENDPOINT = "/api/command-center/notify";

export interface SlackNotifyStatus {
  configured: boolean;
  channelLabel?: string;
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

export interface SlackTestNotificationResult {
  sent: boolean;
  reason?: string;
}

/** §2 — the client-side gate on `configured` is a UI convenience only; this always sends
 *  the request regardless, so the server's honest response wins if the two ever disagree
 *  (same graceful-degradation contract as every other status check in this app). */
export async function sendTestSlackNotification(): Promise<SlackTestNotificationResult> {
  try {
    const res = await fetch(NOTIFY_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ test: true }) });
    return (await res.json()) as SlackTestNotificationResult;
  } catch {
    return { sent: false, reason: "network-error" };
  }
}
