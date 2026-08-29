// V1.3 §31 — Jira configuration status. Never returns the token or email, only whether
// credentials exist and the configured host (public information, useful for the UI to
// show "Base URL: acme.atlassian.net" without exposing anything secret).

import { NextResponse } from "next/server";
import { getJiraConfig } from "@/lib/server/jira-client";

export const runtime = "nodejs";
// V2.2.1 §4 — this GET handler has no request-dependent input, so Next.js would otherwise
// statically optimize it: run it ONCE at `next build` time and serve that frozen response
// to every request in production. That's a real deployment bug for this route specifically
// — it must always reflect the server's CURRENT env-var configuration, not whatever was (or
// wasn't) present at build time. force-dynamic makes it execute fresh on every request.
export const dynamic = "force-dynamic";

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
