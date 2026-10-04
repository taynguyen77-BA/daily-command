// L1 — team sign-in configuration, read from env. OPT-IN: with AUTH_ENABLED unset (or anything
// but "true") nothing in this module changes the app — every route keeps its pairing-secret
// checks (sync-auth.ts, app-state.ts) and the browser keeps its single local data set.
//
// Pure (env in, decisions out) so every rule is tested offline. Node-only (node:crypto for the
// user id) — middleware.ts, which runs on the Edge, uses ./session-cookie.ts instead.
//
// Fail closed: AUTH_ENABLED=true with any required piece missing makes every route answer 503
// naming exactly what is missing (`missing`), and the sign-in page shows the same list.

import { createHash } from "node:crypto";

export type Env = Record<string, string | undefined>;

export interface AuthProviders {
  google: boolean;
  azureAd: boolean;
  atlassian: boolean;
  /** AUTH_DEV_LOGIN=true — email-only login, never when NODE_ENV=production. */
  dev: boolean;
}

export interface AuthSettings {
  enabled: boolean;
  /** Required variables still missing (enabled only). Non-empty → every route fails closed. */
  missing: string[];
  providers: AuthProviders;
  adminEmails: string[];
  allowedEmails: string[];
  allowedDomains: string[];
  allowSharedJira: boolean;
  legacyDataOwner?: string;
  kvConfigured: boolean;
  production: boolean;
}

const list = (raw: string | undefined): string[] =>
  Array.from(
    new Set(
      (raw ?? "")
        .split(/[,\s;]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    )
  );

const has = (env: Env, k: string) => !!env[k]?.trim();

export const PROVIDER_REQUIREMENT =
  "a sign-in provider (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET, AZURE_AD_CLIENT_ID + AZURE_AD_CLIENT_SECRET + AZURE_AD_TENANT_ID, ATLASSIAN_CLIENT_ID + ATLASSIAN_CLIENT_SECRET, or AUTH_DEV_LOGIN=true outside production)";

/** A provider is on when all of its variables are set; a half-configured one is reported. */
function providerGroup(env: Env, vars: string[], missing: string[]): boolean {
  const set = vars.filter((v) => has(env, v));
  if (set.length === vars.length) return true;
  if (set.length > 0) missing.push(...vars.filter((v) => !has(env, v)));
  return false;
}

export function isAuthEnabled(env: Env): boolean {
  return env.AUTH_ENABLED?.trim().toLowerCase() === "true";
}

export function readAuthSettings(env: Env): AuthSettings {
  const enabled = isAuthEnabled(env);
  const production = env.NODE_ENV === "production";
  const missing: string[] = [];
  const providers: AuthProviders = {
    google: providerGroup(env, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], missing),
    azureAd: providerGroup(env, ["AZURE_AD_CLIENT_ID", "AZURE_AD_CLIENT_SECRET", "AZURE_AD_TENANT_ID"], missing),
    atlassian: providerGroup(env, ["ATLASSIAN_CLIENT_ID", "ATLASSIAN_CLIENT_SECRET"], missing),
    dev: env.AUTH_DEV_LOGIN?.trim().toLowerCase() === "true" && !production,
  };
  const adminEmails = list(env.AUTH_ADMIN_EMAILS);
  const kvConfigured = has(env, "KV_REST_API_URL") && has(env, "KV_REST_API_TOKEN");
  if (enabled) {
    if (!has(env, "NEXTAUTH_SECRET")) missing.unshift("NEXTAUTH_SECRET");
    if (!providers.google && !providers.azureAd && !providers.atlassian && !providers.dev) missing.push(PROVIDER_REQUIREMENT);
    if (adminEmails.length === 0) missing.push("AUTH_ADMIN_EMAILS");
    if (production && !kvConfigured) missing.push("KV_REST_API_URL + KV_REST_API_TOKEN (Vercel KV)");
    if (has(env, "AUTH_ENCRYPTION_KEY") && !parseKeyMaterial(env.AUTH_ENCRYPTION_KEY!)) missing.push("AUTH_ENCRYPTION_KEY (must be 32 bytes, base64 or hex)");
  }
  return {
    enabled,
    missing: enabled ? Array.from(new Set(missing)) : [],
    providers,
    adminEmails,
    allowedEmails: list(env.AUTH_ALLOWED_EMAILS),
    allowedDomains: list(env.AUTH_ALLOWED_DOMAINS).map((d) => d.replace(/^@/, "")),
    allowSharedJira: env.AUTH_ALLOW_SHARED_JIRA?.trim().toLowerCase() === "true",
    legacyDataOwner: list(env.AUTH_LEGACY_DATA_OWNER)[0],
    kvConfigured,
    production,
  };
}

export function misconfigurationError(settings: Pick<AuthSettings, "missing">): string {
  return `Sign-in is enabled (AUTH_ENABLED=true) but not fully configured — missing: ${settings.missing.join(", ")}.`;
}

/** 32 raw key bytes from base64 (44 chars) or hex (64 chars); null otherwise. */
export function parseKeyMaterial(raw: string): Buffer | null {
  const s = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, "hex");
  try {
    const b = Buffer.from(s, "base64");
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmailShaped = (email: string) => EMAIL_RE.test(email.trim()) && email.length <= 254;

/** Who may sign in: admins, listed emails, listed domains, admin invites. A disabled user is
 *  refused by the caller (it needs the user record). */
export function isEmailAllowed(email: string, settings: Pick<AuthSettings, "adminEmails" | "allowedEmails" | "allowedDomains">, invites: string[] = []): boolean {
  if (!isEmailShaped(email)) return false;
  const e = normalizeEmail(email);
  const domain = e.slice(e.lastIndexOf("@") + 1);
  return settings.adminEmails.includes(e) || settings.allowedEmails.includes(e) || settings.allowedDomains.includes(domain) || invites.map(normalizeEmail).includes(e);
}

export function isAdminEmail(email: string, settings: Pick<AuthSettings, "adminEmails">): boolean {
  return settings.adminEmails.includes(normalizeEmail(email));
}

/** The same person gets the same id (and so the same data) whichever provider they use. */
export function userIdForEmail(email: string): string {
  return "u_" + createHash("sha256").update("daily-command:" + normalizeEmail(email)).digest("hex").slice(0, 24);
}

export const USER_ID_RE = /^u_[0-9a-f]{24}$/;

/** A per-user KV key. Without a uid (sign-in off) the key is exactly the old single-user one. */
export function scopedKey(base: string, uid?: string): string {
  if (uid === undefined) return base;
  if (!USER_ID_RE.test(uid)) throw new Error("Invalid user id for a scoped key.");
  return `${base}:u:${uid}`;
}

export { sessionCookieConfig } from "./session-cookie";
