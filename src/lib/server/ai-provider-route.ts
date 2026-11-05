// D1 — shared auth + context for the provider routes. Single-user: the paired bearer (APP_STATE_SECRET), never unauthenticated.
// Team mode: a signed-in member (org scope: admin only; 503 when sign-in is misconfigured). Mutations are same-origin only.

import "server-only";
import { NextResponse } from "next/server";
import { checkSyncRequestAuth } from "../command-center/jira/sync-auth";
import { isSameOrigin } from "../command-center/auth/principal";
import type { ProviderCtx } from "../command-center/ai/provider-handlers";
import { principalError, requestPrincipal } from "./auth";
import { anthropicProviderSdk, providerEnv, providerStore, sharedLimiter } from "./ai-provider-store";

const noStore = { "Cache-Control": "no-store" };
export const respond = (r: { status: number; body: Record<string, unknown> }) => NextResponse.json(r.body, { status: r.status, headers: noStore });

export async function providerContext(req: Request, opts: { mutating: boolean }): Promise<{ ctx: ProviderCtx } | { response: NextResponse }> {
  if (opts.mutating && !isSameOrigin(req.headers.get("origin"), req.headers.get("host"), process.env.NEXTAUTH_URL)) {
    return { response: NextResponse.json({ ok: false, error: "Cross-origin requests are not allowed." }, { status: 403, headers: noStore }) };
  }
  const auth = checkSyncRequestAuth(req.headers.get("authorization"), undefined, process.env.APP_STATE_SECRET);
  const p = await requestPrincipal(req, { legacy: auth });
  if (p.kind === "error") return { response: principalError(p) };
  if (p.kind === "cron") return { response: NextResponse.json({ ok: false, error: "Not available to the scheduler." }, { status: 403, headers: noStore }) };
  return {
    ctx: {
      store: providerStore(),
      env: providerEnv(),
      sdk: anthropicProviderSdk,
      now: () => new Date(),
      principal: p.kind === "user" ? { kind: "user", uid: p.user.uid, role: p.user.role === "admin" ? "admin" : "member" } : { kind: "legacy" },
      limiter: sharedLimiter,
    },
  };
}
