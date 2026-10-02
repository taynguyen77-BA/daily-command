// E4 — the cron-written daily standup snapshots (server-daily-report.ts), for the client to
// merge into its Daily Reports. Same auth as GET/POST /api/command-center/state (the paired
// APP_STATE_SECRET) — these describe the user's own work — and 503 when unconfigured.

import { NextResponse } from "next/server";
import { checkAppStateAuth } from "@/lib/command-center/app-state";
import { createServerReportStore } from "@/lib/server/server-report-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = checkAppStateAuth(req.headers.get("authorization"), process.env.APP_STATE_SECRET);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const state = await createServerReportStore().get();
  return NextResponse.json({ ok: true, reports: state?.reports ?? {} });
}
