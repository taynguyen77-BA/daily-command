// L6 — "Test" for the signed-in member's Slack destination (their own webhook or the team one).

import { handleSlackTest } from "@/lib/command-center/auth/account-handlers";
import { postToSlack } from "@/lib/server/slack-notify";
import { accountRoute, handlerResponse } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const r = await accountRoute(req, { mutating: true });
  return "response" in r ? r.response : handlerResponse(await handleSlackTest(r.ctx, postToSlack));
}
