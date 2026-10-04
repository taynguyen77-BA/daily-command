// L1/L2 — the server half of team sign-in: the NextAuth options (providers enabled by env
// presence, JWT sessions, the sign-in gate) and requestPrincipal(), the one helper every API
// route uses to learn who is calling. The decisions themselves are pure and tested offline
// (command-center/auth/*); this file wires env, KV, the session and NextAuth in.

import "server-only";
import { getServerSession, type NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import AzureADProvider from "next-auth/providers/azure-ad";
import AtlassianProvider from "next-auth/providers/atlassian";
import CredentialsProvider from "next-auth/providers/credentials";
import { NextResponse } from "next/server";
import { readAuthSettings, sessionCookieConfig, userIdForEmail, type AuthSettings } from "../command-center/auth/auth-config";
import { isSameOrigin, resolvePrincipal, type LegacyAuthResult, type Principal } from "../command-center/auth/principal";
import type { AccountContext } from "../command-center/auth/account-handlers";
import { createUserDirectory, type UserDirectory, type UserProfile, type UserRecord } from "../command-center/auth/users";
import { jiraConfigForUser, type UserJiraConfig } from "../command-center/auth/connections";
import { resolveEncryptionKey } from "../command-center/auth/secret-box";
import type { JiraConnectionConfig } from "../command-center/jira/types";
import { directoryKv } from "./kv-client";
import { getJiraConfig } from "./jira-client";

export function authSettings(): AuthSettings {
  return readAuthSettings(process.env);
}

export function userDirectory(): UserDirectory | null {
  const kv = directoryKv();
  return kv ? createUserDirectory(kv) : null;
}

export function encryptionKey(): Buffer | null {
  return resolveEncryptionKey(process.env);
}

let cachedOptions: NextAuthOptions | null = null;

export function authOptions(): NextAuthOptions {
  if (cachedOptions) return cachedOptions;
  const settings = authSettings();
  const env = process.env;
  const cookie = sessionCookieConfig(env);
  const providers: NextAuthOptions["providers"] = [];
  if (settings.providers.google) providers.push(GoogleProvider({ clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET! }));
  if (settings.providers.azureAd) providers.push(AzureADProvider({ clientId: env.AZURE_AD_CLIENT_ID!, clientSecret: env.AZURE_AD_CLIENT_SECRET!, tenantId: env.AZURE_AD_TENANT_ID! }));
  // Identity only (read:me) — Jira data is read with each member's own API token, not OAuth.
  if (settings.providers.atlassian) providers.push(AtlassianProvider({ clientId: env.ATLASSIAN_CLIENT_ID!, clientSecret: env.ATLASSIAN_CLIENT_SECRET!, authorization: { params: { scope: "read:me", prompt: "consent" } } }));
  if (settings.providers.dev) {
    providers.push(
      CredentialsProvider({
        id: "dev-login",
        name: "Dev login (email only)",
        credentials: { email: { label: "Email", type: "email" } },
        // Never in production (readAuthSettings drops it there): no password, any listed email.
        async authorize(credentials) {
          const email = credentials?.email?.trim();
          return email ? { id: userIdForEmail(email), email, name: email } : null;
        },
      })
    );
  }
  cachedOptions = {
    providers,
    secret: env.NEXTAUTH_SECRET,
    session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
    useSecureCookies: cookie.secure,
    cookies: { sessionToken: { name: cookie.name, options: cookie.options } },
    pages: { signIn: "/signin", error: "/signin" },
    callbacks: {
      // The access gate: listed/invited email, not disabled. Refusals land on /signin?error=…
      async signIn({ user }) {
        const dir = userDirectory();
        if (!dir || !user.email) return "/signin?error=AccessDenied";
        const decision = await dir.signIn(user.email, user.name ?? undefined, authSettings(), new Date());
        return decision.ok ? true : `/signin?error=${decision.reason === "disabled" ? "Disabled" : "AccessDenied"}`;
      },
      async jwt({ token, user }) {
        if (user?.email) token.uid = userIdForEmail(user.email);
        return token;
      },
      async session({ session, token }) {
        if (session.user && typeof token.uid === "string") (session.user as { uid?: string }).uid = token.uid;
        return session;
      },
    },
  };
  return cachedOptions;
}

async function sessionUser(): Promise<UserRecord | null> {
  const dir = userDirectory();
  if (!dir) return null;
  const session = await getServerSession(authOptions());
  const uid = (session?.user as { uid?: string } | undefined)?.uid;
  return uid ? dir.getUser(uid) : null;
}

/** Who is calling. Sign-in off: today's check (pass the route's own result as `legacy`).
 *  Sign-in on: the signed-in user, or "cron" where `allowCron`. */
export async function requestPrincipal(req: Request, opts: { legacy?: LegacyAuthResult; legacyCheck?: "sync" | "app-state" | "open"; allowCron?: boolean } = {}): Promise<Principal> {
  const settings = authSettings();
  const base = { authEnabled: settings.enabled, missing: settings.missing, authorization: req.headers.get("authorization"), env: process.env, allowCron: opts.allowCron, legacy: opts.legacy, legacyCheck: opts.legacyCheck };
  if (!settings.enabled || settings.missing.length > 0) return resolvePrincipal({ ...base, sessionUser: null });
  if (!userDirectory()) return { kind: "error", status: 503, error: "Sign-in needs Vercel KV (KV_REST_API_URL + KV_REST_API_TOKEN).", missing: ["KV_REST_API_URL + KV_REST_API_TOKEN (Vercel KV)"] };
  return resolvePrincipal({ ...base, sessionUser: await sessionUser() });
}

export function principalError(p: Extract<Principal, { kind: "error" }>, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ ok: false, error: p.error, errorKind: p.status === 503 ? "not-configured" : "cron-unauthorized", ...(p.missing ? { missing: p.missing } : {}), ...extra }, { status: p.status });
}

export async function userProfile(uid: string): Promise<UserProfile> {
  return userDirectory()!.getProfile(uid);
}

export type PrincipalJira = UserJiraConfig | { ok: true; mode: "server"; config: JiraConnectionConfig; accountId?: undefined } | { ok: false; status: 503; error: string; errorKind: "not-configured" };

/** The Jira connection a request runs with: the server's for "legacy"/"cron", the member's own
 *  (or shared, when allowed) for a signed-in user. */
export async function principalJira(p: Exclude<Principal, { kind: "error" }>): Promise<PrincipalJira> {
  if (p.kind !== "user") {
    const config = getJiraConfig();
    return config ? { ok: true, mode: "server", config } : { ok: false, status: 503, error: "Jira is not configured on the server.", errorKind: "not-configured" };
  }
  return jiraConfigForUser(p.user.uid, await userProfile(p.user.uid), process.env, encryptionKey(), authSettings().allowSharedJira);
}

/** The uid that scopes this request's server data (undefined = the single-user keys). */
export const scopeOf = (p: Principal): string | undefined => (p.kind === "user" ? p.user.uid : undefined);

/** L6/L7 — the signed-in member's context for /me and /admin routes. Mutating calls must come
 *  from this app's own origin (CSRF). Sign-in off → 404. */
export async function accountRoute(req: Request, opts: { mutating: boolean }): Promise<{ ctx: AccountContext } | { response: NextResponse }> {
  const settings = authSettings();
  if (!settings.enabled) return { response: NextResponse.json({ ok: false, authEnabled: false, error: "Sign-in is not enabled on this server." }, { status: 404 }) };
  if (opts.mutating && !isSameOrigin(req.headers.get("origin"), req.headers.get("host"), process.env.NEXTAUTH_URL)) {
    return { response: NextResponse.json({ ok: false, error: "Cross-origin request refused." }, { status: 403 }) };
  }
  const p = await requestPrincipal(req, { legacyCheck: "open" });
  if (p.kind === "error") return { response: principalError(p) };
  if (p.kind !== "user") return { response: NextResponse.json({ ok: false, error: "Sign in first." }, { status: 401 }) };
  return { ctx: { user: p.user, directory: userDirectory()!, env: process.env, settings, key: encryptionKey(), now: () => new Date() } };
}

export function handlerResponse(r: { status: number; body: Record<string, unknown> }): NextResponse {
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}
