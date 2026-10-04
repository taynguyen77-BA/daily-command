// L3/L6 — the signed-in member: who they are, their settings (never a token or webhook — see
// auth/account-handlers.ts), and PATCH for Slack, shared-Jira accountId, server notifications,
// the daily snapshot and timezone. Sign-in off → { authEnabled: false }.

import { NextResponse } from "next/server";
import { handleMeGet, handleMePatch } from "@/lib/command-center/auth/account-handlers";
import { accountRoute, authSettings, handlerResponse, readJson } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!authSettings().enabled) return NextResponse.json({ ok: true, authEnabled: false });
  const r = await accountRoute(req, { mutating: false });
  return "response" in r ? r.response : handlerResponse(await handleMeGet(r.ctx));
}

export async function PATCH(req: Request) {
  const r = await accountRoute(req, { mutating: true });
  return "response" in r ? r.response : handlerResponse(await handleMePatch(r.ctx, await readJson(req)));
}
