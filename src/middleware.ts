// L1 — with team sign-in on (AUTH_ENABLED=true), a page request without a session goes to
// /signin. API routes are excluded: each checks auth itself (src/lib/server/auth.ts) and answers
// 401/503 as JSON. With sign-in off this is a no-op. Runs on the Edge — no Node-only imports.

import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { sessionCookieConfig } from "@/lib/command-center/auth/session-cookie";

export async function middleware(req: NextRequest) {
  if (process.env.AUTH_ENABLED?.trim().toLowerCase() !== "true") return NextResponse.next();
  const secret = process.env.NEXTAUTH_SECRET;
  // Without the secret no session can be read; /signin explains what is missing.
  const cookie = sessionCookieConfig(process.env);
  const token = secret ? await getToken({ req, secret, cookieName: cookie.name, secureCookie: cookie.secure }) : null;
  if (token) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/signin";
  url.search = "";
  url.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except API routes, Next internals, the sign-in page and static files.
  matcher: ["/((?!api/|_next/|signin|favicon\\.ico|.*\\.[a-zA-Z0-9]+$).*)"],
};
