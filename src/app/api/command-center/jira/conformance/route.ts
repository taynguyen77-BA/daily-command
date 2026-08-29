// V1.7 §4-6 — runs the Jira Conformance Harness. If Jira is configured on the server, runs
// the same checks against the real API (still read-only — every check here is a GET-style
// read, never a write); otherwise runs against fixtures. The response always says which one
// happened — this route must never let a fixture run be mistaken for live validation.

import { NextResponse } from "next/server";
import { getJiraConfig } from "@/lib/server/jira-client";
import { runJiraConformance } from "@/lib/command-center/jira/conformance";

export const runtime = "nodejs";
// V2.2.1 §4 — same reasoning as jira/status/route.ts: without this, Next.js would statically
// optimize this GET handler and serve a single frozen conformance report (likely computed at
// build time, before any real Jira credentials exist) forever, defeating the entire point of
// the on-demand "Run Conformance Check" button.
export const dynamic = "force-dynamic";

export async function GET() {
  const config = getJiraConfig();
  const report = config ? await runJiraConformance({ fetchImpl: fetch, config }) : await runJiraConformance();
  return NextResponse.json(report);
}
