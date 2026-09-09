// V2.10 §3 — real-time delivery. `SLACK_WEBHOOK_URL` lives only in process.env on this
// server route — it is never sent to, or readable by, the browser, same "secret stays
// server-only" contract as JIRA_API_TOKEN/ANTHROPIC_API_KEY. The client (see
// components/command-center/use-command-center.ts, the one place the attention queue is
// computed) only ever POSTs already-built, non-secret signal payloads and gets back whether
// they were sent — it never talks to Slack directly and never sees the webhook URL.
//
// Non-negotiable (§3): with no SLACK_WEBHOOK_URL configured, this does nothing and reports
// so honestly — same graceful-degradation contract as every other optional env var in this
// app (see README's Environment Variables table). A single signal's delivery failure never
// throws — best-effort, matching the changelog/mention-comment fetches' own discipline.
//
// V2.11 §2 — GET returns whether Slack is configured and the (non-secret, self-declared)
// SLACK_CHANNEL_LABEL, same getJiraConfig()-style status pattern as jira/status/route.ts —
// only ever the boolean/label, never the webhook URL itself. POST also accepts `{ test:
// true }` for the Data & Settings "Send test notification" button — it reuses the exact same
// postToSlack() call as real signals (see below) so a passing test genuinely proves the real
// path works, never a second parallel implementation.
//
// V2.13 §3 — GET also reports `serverSideNotifyActive`: true iff a cron-driven server-side
// notify check (cron-notify.ts, wired into jira/sync/route.ts's GET handler) is actually
// active for this install. The client (use-command-center.ts) uses this to defer entirely to
// the server path and never double-send the same Slack message.

import { NextResponse } from "next/server";
import { renderSlackText, postToSlack, slackSignalSchema } from "@/lib/server/slack-notify";
import { isNotifyStoreConfigured } from "@/lib/command-center/notify-state";
import { checkSyncRequestAuth } from "@/lib/command-center/jira/sync-auth";
import { z } from "zod";

export const runtime = "nodejs";
// V2.2.1 §4 — this GET handler has no request-dependent input, so Next.js would otherwise
// statically optimize it: run it ONCE at `next build` time and serve that frozen response to
// every request in production. It must always reflect the server's CURRENT env-var
// configuration — force-dynamic makes it execute fresh on every request (same fix as
// jira/status/route.ts).
export const dynamic = "force-dynamic";

const TEST_NOTIFICATION_TEXT = "✅ Daily Command test notification — if you can see this, your Slack destination is correctly configured.";

const notifyRequestSchema = z.union([z.object({ test: z.literal(true) }), z.object({ signals: z.array(slackSignalSchema) })]);

/** V2.13 §3 — true iff both PERSONAL_JIRA_ACCOUNT_ID and the KV env vars are present
 *  server-side, exactly the same two conditions jira/sync/route.ts checks before calling
 *  runServerSideNotifyCheck. Reuses isNotifyStoreConfigured() (the "is KV configured" check
 *  notify-store.ts already owns) rather than duplicating it. */
function isServerSideNotifyActive(): boolean {
  return !!process.env.PERSONAL_JIRA_ACCOUNT_ID && isNotifyStoreConfigured();
}

export async function GET() {
  const configured = !!process.env.SLACK_WEBHOOK_URL;
  const channelLabel = process.env.SLACK_CHANNEL_LABEL?.trim() || undefined;
  return NextResponse.json({ configured, channelLabel, serverSideNotifyActive: isServerSideNotifyActive() });
}

export async function POST(req: Request) {
  // V2.18 §4 — this route posts to the org's real Slack webhook using an attacker-controlled
  // request body; it had no auth at all before this pass. Same gate/contract as jira/sync.
  const auth = checkSyncRequestAuth(req.headers.get("authorization"), process.env.CRON_SECRET, process.env.APP_STATE_SECRET);
  if (!auth.ok) {
    return NextResponse.json({ sent: false, reason: "unauthorized" }, { status: auth.status });
  }

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    return NextResponse.json({ sent: false, reason: "not-configured" });
  }

  let body: unknown = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ sent: false, reason: "malformed-request" }, { status: 400 });
  }
  const parsed = notifyRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ sent: false, reason: "malformed-request" }, { status: 400 });
  }

  if ("test" in parsed.data) {
    const result = await postToSlack(webhookUrl, TEST_NOTIFICATION_TEXT);
    return NextResponse.json({ sent: result.ok, reason: result.ok ? undefined : "delivery-failed", detail: result.detail });
  }

  if (parsed.data.signals.length === 0) {
    return NextResponse.json({ sent: false, reason: "no-signals" });
  }

  let delivered = 0;
  for (const signal of parsed.data.signals) {
    if ((await postToSlack(webhookUrl, renderSlackText(signal))).ok) delivered++;
  }

  return NextResponse.json({ sent: delivered > 0, delivered, total: parsed.data.signals.length });
}
