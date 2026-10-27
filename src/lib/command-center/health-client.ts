// P2.2 — the browser's one fetch of GET /api/command-center/health, shared (module cache) by the
// header chip and Setup Health so they always show the same judgement for the same response.

import type { HealthResponse } from "./health-response";
import { describeServerCheck, type CronHealth } from "./health";

let cache: { at: number; value: Promise<HealthResponse | null> } | null = null;
const TTL_MS = 60_000;

export function fetchServerHealthCached(now: number = Date.now()): Promise<HealthResponse | null> {
  if (cache && now - cache.at < TTL_MS) return cache.value;
  const value = fetch("/api/command-center/health")
    .then((r) => (r.ok ? (r.json() as Promise<HealthResponse>) : null))
    .catch(() => null);
  cache = { at: now, value };
  return value;
}

/** What the chip / Setup Health should show for a response, or null when the server-side machinery
 *  isn't in use here (no KV: there is no cron to judge). One selector for both surfaces. */
export function selectServerCheck(health: HealthResponse | null): (ReturnType<typeof describeServerCheck> & { cron: CronHealth }) | null {
  if (!health || !health.kv.configured) return null;
  return { ...describeServerCheck(health.cron), cron: health.cron };
}
