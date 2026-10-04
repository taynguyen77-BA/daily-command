// H1 — GET /api/command-center/jira/issue-context?key=ABC-123[&acField=customfield_10050]
// One ticket's content, on demand — never part of the bulk sync. Same auth gate as jira/sync
// (paired device or cron secret, see sync-auth.ts). The response goes to the browser only;
// nothing here talks to the model. Credentials never leave server/jira-client.ts.
//
// K4 — AI_ALLOWED_PROJECT_KEYS (server AI data policy) is enforced before any Jira call; the
// checks themselves live in jira/issue-context-handler.ts (tested offline).

import { NextResponse } from "next/server";
import { fetchIssueContext, getConfiguredProjectKeys, getJiraConfig } from "@/lib/server/jira-client";
import { checkSyncRequestAuth } from "@/lib/command-center/jira/sync-auth";
import { handleIssueContextRequest } from "@/lib/command-center/jira/issue-context-handler";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = checkSyncRequestAuth(req.headers.get("authorization"), process.env.CRON_SECRET, process.env.APP_STATE_SECRET);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error, errorKind: "cron-unauthorized" }, { status: auth.status });

  const config = getJiraConfig();
  const result = await handleIssueContextRequest(new URL(req.url), {
    configured: !!config,
    jiraProjectKeys: getConfiguredProjectKeys(),
    aiAllowedProjectKeys: process.env.AI_ALLOWED_PROJECT_KEYS,
    fetchIssueContext: (key, opts) => fetchIssueContext(config!, key, opts),
  });
  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}
