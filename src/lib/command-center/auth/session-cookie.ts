// L7 — the session cookie, shared by the NextAuth options (Node) and middleware.ts (Edge), so
// both agree on its name. Kept free of Node-only imports: middleware runs on the Edge runtime.
//
// httpOnly + sameSite=lax always; secure in production or whenever NEXTAUTH_URL is https (a
// plain-http localhost dev server can't set a secure cookie). Secure cookies carry the
// "__Secure-" prefix browsers enforce.

export interface SessionCookieConfig {
  secure: boolean;
  name: string;
  options: { httpOnly: true; sameSite: "lax"; path: "/"; secure: boolean };
}

export function sessionCookieConfig(env: Record<string, string | undefined>): SessionCookieConfig {
  const secure = env.NODE_ENV === "production" || /^https:\/\//i.test(env.NEXTAUTH_URL?.trim() ?? "");
  return {
    secure,
    name: `${secure ? "__Secure-" : ""}next-auth.session-token`,
    options: { httpOnly: true, sameSite: "lax", path: "/", secure },
  };
}
