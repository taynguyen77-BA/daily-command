// F4 — the only route that writes to Jira. Called solely by the write-back confirmation dialog
// (feature off by default, per-project allow-list, preview + explicit confirm — see
// jira/write-back.ts). Same auth as every other route (a paired device or the cron secret);
// strict body validation; one write per request.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getJiraConfig } from "@/lib/server/jira-client";
import { checkSyncRequestAuth } from "@/lib/command-center/jira/sync-auth";
import { HttpJiraActionProvider } from "@/lib/command-center/jira/jira-action-provider";
import { performJiraWrite } from "@/lib/command-center/jira/write-back";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const issueKey = z.string().regex(/^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/);
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("comment"), issueKey, text: z.string().min(1).max(2000) }),
  z.object({ action: z.literal("flag"), issueKey, fieldId: z.string().regex(/^customfield_\d{1,9}$/) }),
  z.object({ action: z.literal("transition"), issueKey, transitionId: z.string().regex(/^\d{1,9}$/) }),
  z.object({ action: z.literal("list-transitions"), issueKey }),
]);

export async function POST(req: Request) {
  const auth = checkSyncRequestAuth(req.headers.get("authorization"), process.env.CRON_SECRET, process.env.APP_STATE_SECRET);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const config = getJiraConfig();
  if (!config) return NextResponse.json({ ok: false, error: "Jira is not configured on the server." }, { status: 503 });
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Malformed request body." }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Request did not match the expected shape." }, { status: 400 });
  const result = await performJiraWrite(new HttpJiraActionProvider(fetch, config), parsed.data);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
