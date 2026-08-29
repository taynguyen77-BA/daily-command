// V1.7 §4-6 — runs the Jira Conformance Harness. If Jira is configured on the server, runs
// the same checks against the real API (still read-only — every check here is a GET-style
// read, never a write); otherwise runs against fixtures. The response always says which one
// happened — this route must never let a fixture run be mistaken for live validation.

import { NextResponse } from "next/server";
import { getJiraConfig } from "@/lib/server/jira-client";
import { runJiraConformance } from "@/lib/command-center/jira/conformance";

export const runtime = "nodejs";

export async function GET() {
  const config = getJiraConfig();
  const report = config ? await runJiraConformance({ fetchImpl: fetch, config }) : await runJiraConformance();
  return NextResponse.json(report);
}
