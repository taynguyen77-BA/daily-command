// V2.36 H4 — GET /api/command-center/ai/usage: today / 7-day AI token totals from the usage
// ledger, the daily cap and what remains of it (Data & Settings). Same auth as the AI route.
// Counts only — no prompts, inputs or outputs are ever logged.

import { NextResponse } from "next/server";
import { checkSyncRequestAuth } from "@/lib/command-center/jira/sync-auth";
import { getUsageLedger, lastSevenDays, recordsOfUser, resolveDailyTokenCap, resolveUserDailyTokenCap, summarizeUsage } from "@/lib/command-center/ai/usage-ledger";
import { principalError, requestPrincipal } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = checkSyncRequestAuth(req.headers.get("authorization"), process.env.CRON_SECRET, process.env.APP_STATE_SECRET);
  const p = await requestPrincipal(req, { legacy: auth });
  if (p.kind === "error") return principalError(p);
  const now = new Date();
  const ledger = getUsageLedger();
  const records = await ledger.listDays(lastSevenDays(now));
  // L4 — sign-in on: "you" (your own calls, against your own cap when one is set) and, for
  // admins only, "team" (everyone's, against the global cap).
  if (p.kind === "user") {
    const globalCap = resolveDailyTokenCap(process.env.AI_DAILY_TOKEN_CAP);
    const userCap = resolveUserDailyTokenCap(process.env.AI_USER_DAILY_TOKEN_CAP);
    const team = summarizeUsage(records, globalCap, now, ledger.storage);
    const mine = summarizeUsage(recordsOfUser(records, p.user.uid), userCap ?? globalCap, now, ledger.storage);
    const you = { ...mine, remainingToday: Math.min(mine.remainingToday, team.remainingToday) };
    return NextResponse.json({ ok: true, usage: you, scope: "you", ...(p.user.role === "admin" ? { team } : {}) }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ ok: true, usage: summarizeUsage(records, resolveDailyTokenCap(process.env.AI_DAILY_TOKEN_CAP), now, ledger.storage) }, { headers: { "Cache-Control": "no-store" } });
}
