// L6 — Team (admins only; members get 403): the user list, and role / Jira-write permission /
// disabled changes. The last enabled admin can't be demoted or disabled.

import { handleAdminUsersGet, handleAdminUsersPatch } from "@/lib/command-center/auth/account-handlers";
import { accountRoute, handlerResponse, readJson } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const r = await accountRoute(req, { mutating: false });
  return "response" in r ? r.response : handlerResponse(await handleAdminUsersGet(r.ctx));
}

export async function PATCH(req: Request) {
  const r = await accountRoute(req, { mutating: true });
  return "response" in r ? r.response : handlerResponse(await handleAdminUsersPatch(r.ctx, await readJson(req)));
}
