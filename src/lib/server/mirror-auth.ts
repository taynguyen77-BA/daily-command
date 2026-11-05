// D4 / W1 — who is calling a client-mirror route (reminders index, briefing snapshot): paired bearer (sign-in off) or a signed-in member,
// plus whether SERVER-side delivery is active for them. Shared so both routes authenticate identically.

import "server-only";
import { NextResponse } from "next/server";
import { checkSyncRequestAuth } from "../command-center/jira/sync-auth";
import { isAuthEnabled } from "../command-center/auth/auth-config";
import { isNotifyStoreConfigured } from "../command-center/notify-state";

export const noStore = { "Cache-Control": "no-store" };

export type Who = { ok: true; uid?: string; active: boolean } | { ok: false; res: NextResponse };

export async function mirrorWho(req: Request): Promise<Who> {
  const auth = checkSyncRequestAuth(req.headers.get("authorization"), process.env.CRON_SECRET, process.env.APP_STATE_SECRET);
  if (isAuthEnabled(process.env)) {
    const { principalError, requestPrincipal, userProfile } = await import("@/lib/server/auth");
    const p = await requestPrincipal(req, { legacy: auth });
    if (p.kind === "error") return { ok: false, res: principalError(p) };
    if (p.kind !== "user") return { ok: false, res: NextResponse.json({ ok: false, error: "Sign in first." }, { status: 401, headers: noStore }) };
    const profile = await userProfile(p.user.uid);
    return { ok: true, uid: p.user.uid, active: isNotifyStoreConfigured() && profile.notifyEnabled && profile.slack.mode !== "none" };
  }
  if (!auth.ok) return { ok: false, res: NextResponse.json({ ok: false, error: auth.error }, { status: auth.status, headers: noStore }) };
  return { ok: true, active: isNotifyStoreConfigured() && !!process.env.PERSONAL_JIRA_ACCOUNT_ID && !!process.env.SLACK_WEBHOOK_URL };
}

