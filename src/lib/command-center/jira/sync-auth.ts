// V2.15 §2 — pure auth decision behind jira/sync/route.ts's POST gate, split out of the route
// itself so it's directly testable: the route transitively imports "server-only" via
// jira-client.ts, so it can never be imported into the offline test process (see
// notify-store.ts's own comment for the identical reasoning behind that split elsewhere).
//
// V2.10 introduced CRON_SECRET to lock down the unattended cron path, but that had a real,
// disclosed regression: a browser can never safely hold CRON_SECRET, so the in-app "Sync Now"
// button started 401ing the moment CRON_SECRET was configured. V2.15 fixed this by accepting
// EITHER of two independent secrets as a valid Bearer token:
//   - CRON_SECRET: known only to Vercel Cron / GitHub Actions — server-to-server, NEVER sent
//     from a browser, full stop.
//   - APP_STATE_SECRET: the same paired secret Data & Settings' Cross-Device Sync pairing
//     screen stores in this device's own localStorage (see device-pairing.ts) for the
//     /api/command-center/state calls — now also attached by the browser's own "Sync Now"
//     button (see datasource/jira-source.ts), reusing this one value rather than introducing
//     a third secret.
// This is intentionally NOT symmetric — the two secrets are never merged into one trust level,
// they just both happen to satisfy the same check here.
//
// V2.18 §4 — fixes a confirmed P0 finding: when NEITHER secret was configured, this used to
// return true unconditionally ("default-open"), which meant every sensitive route reusing this
// check (jira/sync, and — as of this pass — jira/projects, jira/conformance, ai, notify) was
// silently public on any deployment that hadn't set up a secret, serving real Jira data /
// spending the account owner's Anthropic budget / posting to the org's Slack to any
// unauthenticated caller. Brought in line with checkAppStateAuth (app-state.ts), the one other
// auth check in this app, which was already correctly fail-closed (503 "not configured") in
// the same situation — the two checks now share both the same default-closed contract and the
// same discriminated result shape, so every sensitive route in the app is gated consistently.
// A trailing newline/space in the env var — e.g. from copy-pasting `openssl rand -hex 32`
// terminal output straight into Vercel's env var UI — makes the configured secret silently
// never equal `Bearer <what the user pasted into Data & Settings>`, even though both values
// "look" identical everywhere they're displayed. Trimmed once here (not at the env var read
// site) so every caller of this function gets the same forgiving comparison.
function normalizeSecret(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function checkSyncRequestAuth(
  authorizationHeader: string | null,
  cronSecretRaw: string | undefined,
  appStateSecretRaw: string | undefined
): { ok: true } | { ok: false; status: 401 | 503; error: string } {
  const cronSecret = normalizeSecret(cronSecretRaw);
  const appStateSecret = normalizeSecret(appStateSecretRaw);
  if (!cronSecret && !appStateSecret) {
    return {
      ok: false,
      status: 503,
      error: "This deployment has no CRON_SECRET or APP_STATE_SECRET configured, so this endpoint is not available. Configure one and pair this device in Data & Settings.",
    };
  }
  if (!authorizationHeader) {
    return { ok: false, status: 401, error: "Missing Authorization header. Pair this device in Data & Settings." };
  }
  const authorized = (!!cronSecret && authorizationHeader === `Bearer ${cronSecret}`) || (!!appStateSecret && authorizationHeader === `Bearer ${appStateSecret}`);
  if (!authorized) {
    return { ok: false, status: 401, error: "Invalid Authorization header. Pair this device in Data & Settings." };
  }
  return { ok: true };
}
