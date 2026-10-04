// G3 — when the server's daily snapshot runs, for Setup Health: the cron hours (UTC) from
// vercel.json, Jira's configured offset, and the local hour from which a run may write the
// snapshot. Nothing secret.

import { NextResponse } from "next/server";
import vercelConfig from "../../../../../../vercel.json";
import { reportSnapshotHourLocal } from "@/lib/command-center/server-daily-report";
import { cronHoursUtc } from "@/lib/command-center/report-schedule";
import { isAuthEnabled } from "@/lib/command-center/auth/auth-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // L2 — sign-in on: signed-in members only, like every route (503 when misconfigured).
  if (isAuthEnabled(process.env)) {
    const { principalError, requestPrincipal } = await import("@/lib/server/auth");
    const p = await requestPrincipal(req, { legacyCheck: "open" });
    if (p.kind === "error") return principalError(p);
  }
  const offset = Number(process.env.JIRA_TIMEZONE_OFFSET_MINUTES);
  return NextResponse.json({
    cronHoursUtc: cronHoursUtc(vercelConfig as { crons?: { path?: string; schedule?: string }[] }),
    ...(Number.isFinite(offset) && process.env.JIRA_TIMEZONE_OFFSET_MINUTES ? { offsetMinutes: offset } : {}),
    snapshotHourLocal: reportSnapshotHourLocal(process.env),
  });
}
