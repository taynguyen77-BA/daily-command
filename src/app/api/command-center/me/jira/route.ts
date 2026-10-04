// L3 — connect (POST { email, apiToken }: verified via the server's JIRA_BASE_URL /myself, the
// token kept encrypted) or disconnect (DELETE) the signed-in member's own Jira account.

import { handleJiraConnect, handleJiraDisconnect } from "@/lib/command-center/auth/account-handlers";
import type { FetchLike } from "@/lib/command-center/jira/http";
import { accountRoute, handlerResponse, readJson } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const r = await accountRoute(req, { mutating: true });
  return "response" in r ? r.response : handlerResponse(await handleJiraConnect(r.ctx, await readJson(req), fetch as unknown as FetchLike));
}

export async function DELETE(req: Request) {
  const r = await accountRoute(req, { mutating: true });
  return "response" in r ? r.response : handlerResponse(await handleJiraDisconnect(r.ctx));
}
