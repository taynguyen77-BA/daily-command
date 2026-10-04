// L2 — who is calling, for every API route. One pure decision; src/lib/server/auth.ts wraps it
// with the real session (getServerSession) and user record.
//
// Sign-in OFF (AUTH_ENABLED unset): exactly today's behaviour — the route's own
// checkSyncRequestAuth / checkAppStateAuth result (passed in as `legacy`, or computed here)
// decides, and the caller is "legacy" (the single, paired installation).
//
// Sign-in ON:
//   - misconfigured → 503 naming the missing variables (fail closed);
//   - Bearer CRON_SECRET → "cron", only where the route allows it (the cron GET of /jira/sync);
//   - Bearer APP_STATE_SECRET / JIRA_WRITE_SECRET (device pairing) → 401: they identify a
//     device, not a person, so they never grant access to anyone's data;
//   - otherwise a signed-in, enabled user → "user"; disabled → 403; nobody → 401.

import { checkAppStateAuth } from "../app-state";
import { checkSyncRequestAuth } from "../jira/sync-auth";
import { bearerMatches } from "../secure-compare";
import { misconfigurationError, type Env } from "./auth-config";
import type { UserRecord } from "./users";

export type LegacyAuthResult = { ok: true } | { ok: false; status: 401 | 503; error: string };

export type Principal =
  | { kind: "user"; user: UserRecord }
  | { kind: "cron" }
  | { kind: "legacy" }
  | { kind: "error"; status: 401 | 403 | 503; error: string; missing?: string[] };

export function resolvePrincipal(args: {
  authEnabled: boolean;
  /** Required auth variables still missing (readAuthSettings().missing). */
  missing?: string[];
  /** The signed-in user's record (null: no session, or no record). */
  sessionUser: UserRecord | null;
  authorization: string | null;
  env: Env;
  /** Accept CRON_SECRET (sign-in on) — the cron GET of /jira/sync only. */
  allowCron?: boolean;
  /** Sign-in off: the route's own check, already computed. */
  legacy?: LegacyAuthResult;
  /** Sign-in off and no `legacy` given: which of today's checks applies ("open" = none here —
   *  the route checks itself, e.g. the Jira write gate). */
  legacyCheck?: "sync" | "app-state" | "open";
}): Principal {
  if (!args.authEnabled) {
    const legacy =
      args.legacy ??
      (args.legacyCheck === "open"
        ? ({ ok: true } as const)
        : args.legacyCheck === "app-state"
          ? checkAppStateAuth(args.authorization, args.env.APP_STATE_SECRET)
          : checkSyncRequestAuth(args.authorization, args.env.CRON_SECRET, args.env.APP_STATE_SECRET));
    return legacy.ok ? { kind: "legacy" } : { kind: "error", status: legacy.status, error: legacy.error };
  }
  if (args.missing && args.missing.length > 0) return { kind: "error", status: 503, error: misconfigurationError({ missing: args.missing }), missing: args.missing };
  const auth = args.authorization;
  if (auth) {
    // Always compare against every secret (constant time each) — timing never says which exists.
    const cron = bearerMatches(auth, args.env.CRON_SECRET?.trim());
    const pairing = bearerMatches(auth, args.env.APP_STATE_SECRET?.trim()) || bearerMatches(auth, args.env.JIRA_WRITE_SECRET?.trim());
    if (cron && args.allowCron) return { kind: "cron" };
    if (cron || pairing) return { kind: "error", status: 401, error: "Sign-in is on: device pairing secrets aren't accepted here. Sign in instead." };
  }
  if (!args.sessionUser) return { kind: "error", status: 401, error: "Not signed in." };
  if (args.sessionUser.disabled) return { kind: "error", status: 403, error: "This account is disabled. Ask an admin." };
  return { kind: "user", user: args.sessionUser };
}

/** L7 — CSRF guard for mutating /me and /admin calls: the Origin must be this app's host. */
export function isSameOrigin(origin: string | null, host: string | null, appUrl?: string): boolean {
  if (!origin) return false;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  const allowed = new Set<string>();
  if (host) allowed.add(host.toLowerCase());
  if (appUrl) {
    try {
      allowed.add(new URL(appUrl).host.toLowerCase());
    } catch {
      // ignore a malformed NEXTAUTH_URL
    }
  }
  return allowed.has(o.host.toLowerCase());
}

/** L3 — the sync's accountId: the profile's (verified via /myself, or set in shared mode) is
 *  authoritative; the request's is used only when the profile has none. */
export function effectiveAccountId(profileAccountId: string | undefined, requestAccountId: string | undefined): string | undefined {
  return profileAccountId || requestAccountId;
}
