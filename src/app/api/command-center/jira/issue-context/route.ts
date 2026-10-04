// H1 — GET /api/command-center/jira/issue-context?key=ABC-123[&acField=customfield_10050]
// One ticket's content, on demand — never part of the bulk sync. Same auth gate as jira/sync
// (paired device or cron secret, see sync-auth.ts). The response goes to the browser only;
// nothing here talks to the model. Credentials never leave server/jira-client.ts.

import { NextResponse } from "next/server";
import { fetchIssueContext, getConfiguredProjectKeys, getJiraConfig } from "@/lib/server/jira-client";
import { checkSyncRequestAuth } from "@/lib/command-center/jira/sync-auth";
import { ISSUE_KEY_RE } from "@/lib/command-center/jira/issue-context";
import { isValidCustomFieldId } from "@/lib/command-center/jira/http";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = checkSyncRequestAuth(req.headers.get("authorization"), process.env.CRON_SECRET, process.env.APP_STATE_SECRET);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error, errorKind: "cron-unauthorized" }, { status: auth.status });

  const config = getJiraConfig();
  if (!config) return NextResponse.json({ ok: false, error: "Jira is not configured on the server.", errorKind: "not-configured" }, { status: 503 });

  const url = new URL(req.url);
  const key = (url.searchParams.get("key") ?? "").trim().toUpperCase();
  if (!ISSUE_KEY_RE.test(key)) return NextResponse.json({ ok: false, error: "Pass a valid Jira issue key, e.g. ?key=ABC-123.", errorKind: "malformed-response" }, { status: 400 });
  const acField = url.searchParams.get("acField") ?? undefined;
  if (acField && !isValidCustomFieldId(acField)) {
    return NextResponse.json({ ok: false, error: "acField must be a Jira custom field id like customfield_10050.", errorKind: "malformed-response" }, { status: 400 });
  }
  // The server's own JIRA_PROJECT_KEYS restriction applies here exactly as it does to sync.
  const allowedProjects = getConfiguredProjectKeys();
  if (allowedProjects && !allowedProjects.includes(key.split("-")[0])) {
    return NextResponse.json({ ok: false, error: "This project is outside the server's configured JIRA_PROJECT_KEYS.", errorKind: "permission-failure" }, { status: 403 });
  }

  const result = await fetchIssueContext(config, key, { acceptanceCriteriaFieldId: acField });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error, errorKind: result.errorKind }, { status: 502 });
  return NextResponse.json({ ok: true, context: result.data }, { headers: { "Cache-Control": "no-store" } });
}
