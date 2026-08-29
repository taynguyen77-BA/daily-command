// V1.3 §31 — Jira configuration status. Never returns the token or email, only whether
// credentials exist and the configured host (public information, useful for the UI to
// show "Base URL: acme.atlassian.net" without exposing anything secret).

import { NextResponse } from "next/server";
import { getJiraConfig } from "@/lib/server/jira-client";

export const runtime = "nodejs";

export async function GET() {
  const config = getJiraConfig();
  if (!config) return NextResponse.json({ configured: false });
  let baseUrlHost: string | undefined;
  try {
    baseUrlHost = new URL(config.baseUrl).host;
  } catch {
    baseUrlHost = undefined;
  }
  return NextResponse.json({ configured: true, baseUrlHost });
}
