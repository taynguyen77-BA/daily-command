// P2.2 — the browser's one fetch of GET /api/command-center/health, shared (module cache) by the
// header chip and Setup Health so they always show the same judgement for the same response.

import type { HealthResponse } from "./health-response";
import { pairedAuthHeader } from "./device-pairing";
import { describeServerCheck, type CronHealth } from "./health";

let cache: { at: number; value: Promise<HealthResponse | null> } | null = null;
const TTL_MS = 60_000;

export function fetchServerHealthCached(now: number = Date.now()): Promise<HealthResponse | null> {
  if (cache && now - cache.at < TTL_MS) return cache.value;
  const value = fetch("/api/command-center/health", { headers: { ...pairedAuthHeader() } })
    .then((r) => (r.ok ? (r.json() as Promise<HealthResponse>) : null))
    .catch(() => null);
  cache = { at: now, value };
  return value;
}

/** What the chip / Setup Health should show for a response, or null when the server-side machinery
 *  isn't in use here (no KV: there is no cron to judge). One selector for both surfaces. */
export function selectServerCheck(health: HealthResponse | null): (ReturnType<typeof describeServerCheck> & { cron: CronHealth }) | null {
  if (!health?.kv?.configured) return null;
  const base = describeServerCheck(health.cron);
  // C1 — a Slack outage is not a scheduler problem: keep the label, say it in the tooltip (and turn the dot amber at least).
  const slack = health.cron.slack;
  if (slack && slack.undelivered > 0) {
    const since = slack.undeliveredSince ? ` since ${slack.undeliveredSince.slice(0, 16).replace("T", " ")} UTC` : "";
    return { ...base, tone: base.tone === "green" ? "amber" : base.tone, tooltip: `Slack delivery failing${since}: ${slack.undelivered} notification(s) waiting for a retry${slack.lastSlackError ? ` (${slack.lastSlackError})` : ""}. ${base.tooltip}`, cron: health.cron };
  }
  return { ...base, cron: health.cron };
}
