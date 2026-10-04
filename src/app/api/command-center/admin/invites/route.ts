// L6 — admin invites (an invited email may sign in). POST { email } adds, DELETE { email } removes.

import { handleInvite } from "@/lib/command-center/auth/account-handlers";
import { accountRoute, handlerResponse, readJson } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const r = await accountRoute(req, { mutating: true });
  return "response" in r ? r.response : handlerResponse(await handleInvite(r.ctx, await readJson(req), "add"));
}

export async function DELETE(req: Request) {
  const r = await accountRoute(req, { mutating: true });
  return "response" in r ? r.response : handlerResponse(await handleInvite(r.ctx, await readJson(req), "remove"));
}
