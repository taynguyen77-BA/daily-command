// C2 (R4) — what an unauthenticated caller may learn from the status endpoints. Pure.
// With sign-in OFF, GET /api/command-center/health and /notify used to answer anyone: version, which services are
// configured and the user's notify prefs (incl. muted project keys). Now an unpaired caller gets a minimal body
// (the same contract as /jira/status); the full body needs the pairing secret (Authorization: Bearer
// APP_STATE_SECRET / CRON_SECRET via checkSyncRequestAuth) or a signed-in member.

export const MINIMAL_HEALTH_BODY = { ok: true } as const;

/** /notify for an unpaired caller: only whether Slack is configured — never prefs, channel label or cron state. */
export function minimalNotifyBody(slackConfigured: boolean): { configured: boolean } {
  return { configured: slackConfigured };
}

/** A tiny TTL memo for an async probe (the health route's KV reachability check), per server instance. */
export function memoizeProbe<T>(probe: () => Promise<T>, ttlMs: number, clock: () => number = Date.now): () => Promise<T> {
  let cached: { at: number; value: Promise<T> } | null = null;
  return () => {
    const now = clock();
    if (cached && now - cached.at < ttlMs) return cached.value;
    const value = probe();
    cached = { at: now, value };
    return value;
  };
}
