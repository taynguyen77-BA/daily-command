// G3 — when the server's daily snapshot runs, for Setup Health: the cron hours (UTC) from
// vercel.json, Jira's configured offset, and the local hour from which a run may write the
// snapshot. Nothing secret.

import { NextResponse } from "next/server";
import vercelConfig from "../../../../../../vercel.json";
import { reportSnapshotHourLocal } from "@/lib/command-center/server-daily-report";
import { cronHoursUtc } from "@/lib/command-center/report-schedule";
import { zoneOffsetMinutesAt } from "@/lib/command-center/jira/http";
import { resolveTimeZoneInUse } from "@/lib/command-center/time-zone-source";
import { getJiraTimeZone } from "@/lib/server/jira-client";
import { isNotifyStoreConfigured } from "@/lib/command-center/notify-state";
import { createNotifyStore } from "@/lib/server/notify-store";
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
  let learnedZone: string | undefined;
  try {
    learnedZone = isNotifyStoreConfigured() ? (await createNotifyStore().get())?.jiraTimeZone : undefined;
  } catch {
    // best-effort — an unreachable KV only means the zone is not shown
  }
  const timeZone = resolveTimeZoneInUse({ envZone: getJiraTimeZone(), learnedZone, envOffsetMinutes: process.env.JIRA_TIMEZONE_OFFSET_MINUTES ? offset : undefined });
  return NextResponse.json({
    timeZone,
    cronHoursUtc: cronHoursUtc(vercelConfig as { crons?: { path?: string; schedule?: string }[] }),
    // the zone wins over the fixed offset; its offset is evaluated now (DST-aware)
    ...(timeZone.zone && zoneOffsetMinutesAt(timeZone.zone, Date.now()) !== undefined ? { offsetMinutes: zoneOffsetMinutesAt(timeZone.zone, Date.now()) } : Number.isFinite(offset) && process.env.JIRA_TIMEZONE_OFFSET_MINUTES ? { offsetMinutes: offset } : {}),
    snapshotHourLocal: reportSnapshotHourLocal(process.env),
  });
}
