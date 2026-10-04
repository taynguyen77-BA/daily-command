// E4 — the cron-written daily standup snapshots (server-daily-report.ts), for the client to
// merge into its Daily Reports. Same auth as GET/POST /api/command-center/state (the paired
// APP_STATE_SECRET) — these describe the user's own work — and 503 when unconfigured.

import { NextResponse } from "next/server";
import { checkAppStateAuth } from "@/lib/command-center/app-state";
import { createServerReportStore } from "@/lib/server/server-report-store";
import { principalError, requestPrincipal, scopeOf } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = checkAppStateAuth(req.headers.get("authorization"), process.env.APP_STATE_SECRET);
  // L2/L4 — sign-in on: the signed-in member's own snapshots.
  const p = await requestPrincipal(req, { legacy: auth });
  if (p.kind === "error") return principalError(p);
  const state = await createServerReportStore(scopeOf(p)).get();
  return NextResponse.json({ ok: true, reports: state?.reports ?? {} });
}
