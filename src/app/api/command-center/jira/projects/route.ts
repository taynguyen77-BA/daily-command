// V2.3 §5 — Focus Project Scope project discovery. Returns the Jira project catalog
// (key/name/id only) WITHOUT fetching any issues — this is what makes the project picker
// usable against a Jira environment with hundreds/thousands of projects without downloading
// their issue data just to populate a selector (§21). Reuses the exact same
// fetchJiraProjectsWith connector code the sync route and Conformance harness use — no
// second Jira client.

import { NextResponse } from "next/server";
import { fetchJiraProjects, getJiraConfig } from "@/lib/server/jira-client";
import { checkSyncRequestAuth } from "@/lib/command-center/jira/sync-auth";

export const runtime = "nodejs";
// V2.2.1 §4 precedent — a parameter-less GET route must not be statically frozen at build
// time; it has to reflect the server's current Jira configuration on every request.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // V2.18 §4 — this route makes a real, credentialed Jira API call and returns this Jira
  // instance's real project catalog; it had no auth at all before this pass. Same
  // gate/contract as jira/sync (see sync-auth.ts).
  const auth = checkSyncRequestAuth(req.headers.get("authorization"), process.env.CRON_SECRET, process.env.APP_STATE_SECRET);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error, errorKind: "cron-unauthorized" }, { status: auth.status });
  }

  const config = getJiraConfig();
  if (!config) {
    return NextResponse.json({ ok: false, error: "Jira is not configured on the server.", errorKind: "not-configured" }, { status: 503 });
  }
  const result = await fetchJiraProjects(config);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error, errorKind: result.errorKind }, { status: 502 });
  }
  return NextResponse.json({
    ok: true,
    projects: result.data.map((p) => ({ id: p.id, key: p.key, name: p.name ?? p.key })),
  });
}
