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
  const store = createServerReportStore(scopeOf(p));
  // V2.53 — `?since=YYYY-MM-DD` returns only days from that date on (inclusive, so a day that grew since the client's
  // last pull refreshes). No/invalid `since` = everything, exactly as before; the response shape never changes.
  const since = new URL(req.url).searchParams.get("since");
  const validSince = since && /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : undefined;
  if (store.getSince) return NextResponse.json({ ok: true, reports: await store.getSince(validSince) });
  const state = await store.get();
  const all = state?.reports ?? {};
  return NextResponse.json({ ok: true, reports: validSince ? Object.fromEntries(Object.entries(all).filter(([d]) => d >= validSince)) : all });
}
