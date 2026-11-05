// D1 — GET (status) / PUT (save, write-only key) / DELETE (remove) the AI provider configuration. Logic: ai/provider-handlers.ts.
import { deleteProvider, getProviderStatus, putProvider } from "@/lib/command-center/ai/provider-handlers";
import { providerContext, respond } from "@/lib/server/ai-provider-route";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function body(req: Request): Promise<unknown> {
  try { return await req.json(); } catch { return undefined; }
}

export async function GET(req: Request) {
  const c = await providerContext(req, { mutating: false });
  if ("response" in c) return c.response;
  return respond(await getProviderStatus(c.ctx));
}

export async function PUT(req: Request) {
  const c = await providerContext(req, { mutating: true });
  if ("response" in c) return c.response;
  const b = await body(req);
  if (b === undefined) return NextResponse.json({ ok: false, error: "Malformed request body." }, { status: 400 });
  return respond(await putProvider(c.ctx, b));
}

export async function DELETE(req: Request) {
  const c = await providerContext(req, { mutating: true });
  if ("response" in c) return c.response;
  return respond(await deleteProvider(c.ctx, await body(req)));
}
