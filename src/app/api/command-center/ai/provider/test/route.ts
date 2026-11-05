// D1 — POST: validate the key with models.list() (no tokens), check each tier's model id is in that list, then one tiny call per tier.
import { testProvider } from "@/lib/command-center/ai/provider-handlers";
import { providerContext, respond } from "@/lib/server/ai-provider-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const c = await providerContext(req, { mutating: true });
  if ("response" in c) return c.response;
  return respond(await testProvider(c.ctx));
}
