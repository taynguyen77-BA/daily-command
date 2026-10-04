// L1 — NextAuth (v4, JWT sessions) for team sign-in. Only exists when AUTH_ENABLED=true; a
// misconfigured install answers 503 naming exactly what is missing (fail closed).

import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { misconfigurationError } from "@/lib/command-center/auth/auth-config";
import { authOptions, authSettings } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { nextauth: string[] } };

async function handler(req: Request, ctx: Ctx) {
  const settings = authSettings();
  if (!settings.enabled) return NextResponse.json({ ok: false, error: "Sign-in is not enabled on this server." }, { status: 404 });
  if (settings.missing.length > 0) return NextResponse.json({ ok: false, error: misconfigurationError(settings), missing: settings.missing }, { status: 503 });
  return (NextAuth(authOptions()) as unknown as (req: Request, ctx: Ctx) => Promise<Response>)(req, ctx);
}

export { handler as GET, handler as POST };
