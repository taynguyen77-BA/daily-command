// V1.3 §31 — Jira configuration status. Never returns the token or email, only whether
// credentials exist. E5 — the configured host is returned only to an authorized caller (same
// auth as every other route — see jira/status-response.ts); an unauthenticated caller gets
// `{ configured }` alone.

import { NextResponse } from "next/server";
import { getJiraConfig } from "@/lib/server/jira-client";
import { checkSyncRequestAuth } from "@/lib/command-center/jira/sync-auth";
import { buildJiraStatusResponse } from "@/lib/command-center/jira/status-response";

export const runtime = "nodejs";
// V2.2.1 §4 — this GET handler has no request-dependent input, so Next.js would otherwise
// statically optimize it: run it ONCE at `next build` time and serve that frozen response
// to every request in production. That's a real deployment bug for this route specifically
// — it must always reflect the server's CURRENT env-var configuration, not whatever was (or
// wasn't) present at build time. force-dynamic makes it execute fresh on every request.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = checkSyncRequestAuth(req.headers.get("authorization"), process.env.CRON_SECRET, process.env.APP_STATE_SECRET);
  return NextResponse.json(buildJiraStatusResponse(getJiraConfig(), auth.ok));
}
