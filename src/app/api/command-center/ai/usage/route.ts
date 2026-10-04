// V2.36 H4 — GET /api/command-center/ai/usage: today / 7-day AI token totals from the usage
// ledger, the daily cap and what remains of it (Data & Settings). Same auth as the AI route.
// Counts only — no prompts, inputs or outputs are ever logged.

import { NextResponse } from "next/server";
import { checkSyncRequestAuth } from "@/lib/command-center/jira/sync-auth";
import { getUsageLedger, lastSevenDays, resolveDailyTokenCap, summarizeUsage } from "@/lib/command-center/ai/usage-ledger";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = checkSyncRequestAuth(req.headers.get("authorization"), process.env.CRON_SECRET, process.env.APP_STATE_SECRET);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const now = new Date();
  const ledger = getUsageLedger();
  const records = await ledger.listDays(lastSevenDays(now));
  return NextResponse.json({ ok: true, usage: summarizeUsage(records, resolveDailyTokenCap(process.env.AI_DAILY_TOKEN_CAP), now, ledger.storage) }, { headers: { "Cache-Control": "no-store" } });
}
