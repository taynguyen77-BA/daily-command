// V2.13 §2 — extracted from what was app/api/command-center/notify/route.ts's own module
// scope, so the new server-side (cron-driven) notify check (cron-notify.ts) sends signals
// through the EXACT SAME rendering + webhook-call code the browser-triggered path already
// used, rather than a second, forkable implementation.
//
// Deliberately NOT `import "server-only"`, unlike jira-client.ts/notify-store.ts: this module
// never reads a secret from process.env itself (the webhook URL is always passed in by a
// caller that already resolved it server-side) and cron-notify.ts — which must stay directly
// importable by the offline test suite — depends on it. A `fetchImpl` can be injected for
// tests; every real caller omits it and gets the real global `fetch`.

import { z } from "zod";

const SLACK_FETCH_TIMEOUT_MS = 10_000;

export const slackSignalSchema = z.object({
  issueKey: z.string(),
  summary: z.string(),
  url: z.string().optional(),
  kind: z.enum(["MENTION", "ASSIGNMENT"]),
  detail: z.string(),
});
export type SlackSignal = z.infer<typeof slackSignalSchema>;

export function renderSlackText(signal: SlackSignal): string {
  const link = signal.url ? ` (${signal.url})` : "";
  if (signal.kind === "ASSIGNMENT") return `📌 ${signal.issueKey} — ${signal.summary} — assigned to you.${link}`;
  return `💬 ${signal.issueKey} — ${signal.summary} — mentioned you: ${signal.detail}${link}`;
}

/** V2.13 (bug fix) — a delivery failure used to collapse to a bare boolean, so "Send test
 *  notification" could only ever report the generic "delivery failed" — no way to tell a
 *  revoked/mistyped webhook URL (Slack's own 404/410 "no_service"/"channel_not_found") apart
 *  from a network timeout, which is exactly the information someone actually debugging a
 *  misconfigured webhook needs. `detail` carries Slack's real HTTP status + response body
 *  (truncated) on a non-ok response, or the caught error's message on a network failure —
 *  never fabricated, always the real value from the one real call this function makes. */
export interface SlackDeliveryResult {
  ok: boolean;
  detail?: string;
}

export type SlackFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** The one real webhook-call code path — used by the browser-triggered route (real signals
 *  and "Send test notification") and the cron-driven server-side check alike, so a passing
 *  test genuinely proves the real path works for both. */
export async function postToSlack(webhookUrl: string, text: string, fetchImpl: SlackFetchLike = fetch as unknown as SlackFetchLike): Promise<SlackDeliveryResult> {
  try {
    const res = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(SLACK_FETCH_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    const body = await res.text().catch(() => "");
    return { ok: false, detail: `Slack responded ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "network error" }; // best-effort — never throws
  }
}
