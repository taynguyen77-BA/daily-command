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

import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const SLACK_FETCH_TIMEOUT_MS = 10_000;

const signalSchema = z.object({
  issueKey: z.string(),
  summary: z.string(),
  url: z.string().optional(),
  kind: z.enum(["MENTION", "ASSIGNMENT"]),
  detail: z.string(),
});
const notifyRequestSchema = z.object({ signals: z.array(signalSchema) });

function renderSlackText(signal: z.infer<typeof signalSchema>): string {
  const link = signal.url ? ` (${signal.url})` : "";
  if (signal.kind === "ASSIGNMENT") return `📌 ${signal.issueKey} — ${signal.summary} — assigned to you.${link}`;
  return `💬 ${signal.issueKey} — ${signal.summary} — mentioned you: ${signal.detail}${link}`;
}

export async function POST(req: Request) {
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
  if (parsed.data.signals.length === 0) {
    return NextResponse.json({ sent: false, reason: "no-signals" });
  }

  let delivered = 0;
  for (const signal of parsed.data.signals) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: renderSlackText(signal) }),
        signal: AbortSignal.timeout(SLACK_FETCH_TIMEOUT_MS),
      });
      if (res.ok) delivered++;
    } catch {
      // best-effort — one signal's delivery failure never fails the others
    }
  }

  return NextResponse.json({ sent: delivered > 0, delivered, total: parsed.data.signals.length });
}
