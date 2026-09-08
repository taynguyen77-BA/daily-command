// V2.15 §2 — pure auth decision behind jira/sync/route.ts's POST gate, split out of the route
// itself so it's directly testable: the route transitively imports "server-only" via
// jira-client.ts, so it can never be imported into the offline test process (see
// notify-store.ts's own comment for the identical reasoning behind that split elsewhere).
//
// V2.10 introduced CRON_SECRET to lock down the unattended cron path, but that had a real,
// disclosed regression: a browser can never safely hold CRON_SECRET, so the in-app "Sync Now"
// button started 401ing the moment CRON_SECRET was configured. V2.15 fixes this by accepting
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
export function isSyncRequestAuthorized(authorizationHeader: string | null, cronSecret: string | undefined, appStateSecret: string | undefined): boolean {
  if (!cronSecret && !appStateSecret) return true; // unchanged default-open behavior (pre-V2.10)
  if (!authorizationHeader) return false;
  return (!!cronSecret && authorizationHeader === `Bearer ${cronSecret}`) || (!!appStateSecret && authorizationHeader === `Bearer ${appStateSecret}`);
}
