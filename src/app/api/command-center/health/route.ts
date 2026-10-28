// P2.2 — GET /api/command-center/health: is the server-side machinery configured and is the
// scheduled run actually running? Same auth as the other status routes (sign-in on: signed-in
// members only, 503 when misconfigured). The body is built by health-response.ts: booleans,
// numbers, the version and the cron judgement — never a secret or a URL.

import { NextResponse } from "next/server";
import vercelConfig from "../../../../../vercel.json";
import pkg from "../../../../../package.json";
import { buildHealthResponse } from "@/lib/command-center/health-response";
import { cronExpectedMinutes } from "@/lib/command-center/health";
import { checkSyncRequestAuth } from "@/lib/command-center/jira/sync-auth";
import { memoizeProbe, MINIMAL_HEALTH_BODY } from "@/lib/command-center/status-access";
import { cronHoursUtc } from "@/lib/command-center/report-schedule";
import { reportSnapshotHourLocal } from "@/lib/command-center/server-daily-report";
import { isAuthEnabled } from "@/lib/command-center/auth/auth-config";
import { isNotifyStoreConfigured } from "@/lib/command-center/notify-state";
import { getJiraConfig } from "@/lib/server/jira-client";
import { createHeartbeatStore } from "@/lib/server/heartbeat-store";
import { directoryKv } from "@/lib/server/kv-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** R4 — the KV ping is memoized for 30 s per instance, so polling this route costs no KV call per request. */
const KV_PROBE_TTL_MS = 30_000;
const probeKv = memoizeProbe(async (): Promise<boolean | null> => {
  try {
    const kv = directoryKv();
    if (!kv) return null;
    await Promise.race([kv.get("daily-command:health-ping"), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000))]);
    return true;
  } catch {
    return false;
  }
}, KV_PROBE_TTL_MS);

const kvReachable = (configured: boolean): Promise<boolean | null> => (configured ? probeKv() : Promise.resolve(null));

export async function GET(req: Request) {
  let uid: string | undefined;
  let memberJira: boolean | null = null;
  let memberSlack: boolean | null = null;
  if (isAuthEnabled(process.env)) {
    const { principalError, requestPrincipal, userProfile } = await import("@/lib/server/auth");
    const p = await requestPrincipal(req, { legacyCheck: "open" });
    if (p.kind === "error") return principalError(p);
    if (p.kind === "user") {
      uid = p.user.uid;
      const profile = await userProfile(uid);
      memberJira = profile.jira.mode !== "none";
      memberSlack = profile.slack.mode !== "none";
    }
  } else if (!checkSyncRequestAuth(req.headers.get("authorization"), process.env.CRON_SECRET, process.env.APP_STATE_SECRET).ok) {
    // R4 — sign-in off and the caller is not paired: nothing but "up".
    return NextResponse.json(MINIMAL_HEALTH_BODY);
  }
  const kvConfigured = isNotifyStoreConfigured();
  const offset = Number(process.env.JIRA_TIMEZONE_OFFSET_MINUTES);
  const heartbeat = await createHeartbeatStore(uid).get();
  return NextResponse.json(
    buildHealthResponse({
      version: pkg.version,
      kvConfigured,
      kvReachable: await kvReachable(kvConfigured),
      jiraConfigured: memberJira ?? !!getJiraConfig(),
      slackConfigured: memberSlack ?? !!process.env.SLACK_WEBHOOK_URL,
      aiAvailable: Boolean(process.env.ANTHROPIC_API_KEY),
      heartbeat,
      expectedMinutes: cronExpectedMinutes(process.env),
      now: new Date(),
      schedule: {
        cronHoursUtc: cronHoursUtc(vercelConfig as { crons?: { path?: string; schedule?: string }[] }),
        ...(Number.isFinite(offset) && process.env.JIRA_TIMEZONE_OFFSET_MINUTES ? { offsetMinutes: offset } : {}),
        snapshotHourLocal: reportSnapshotHourLocal(process.env),
      },
    })
  );
}
