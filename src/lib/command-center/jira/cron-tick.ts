// K3 — what the unattended cron (GET /api/command-center/jira/sync) actually does. Until V2.39
// that GET ran the full POST sync first — every issue, changelogs, mention comments — and then
// threw the result away, since a cron has no browser to merge it into. Now it runs only the
// two server-side steps that persist something: the notify check (cron-notify.ts) and the
// day's standup snapshot (server-daily-report.ts), each with its own targeted Jira queries.
//
// Credentials, env and the KV-backed stores stay with the caller (the route); this module takes
// an injected fetch and injected stores, so the offline tests can count every Jira request.

import { runServerSideNotifyCheck } from "../cron-notify";
import { runServerDailySnapshot, type ServerReportStore } from "../server-daily-report";
import type { NotifyStateStore } from "../notify-state";
import type { FetchLike } from "./http";
import type { JiraConnectionConfig } from "./types";

export interface CronTickResult {
  ok: true;
  cron: true;
  /** Which steps ran (a step whose store isn't configured is skipped, not an error). */
  ran: { notify: boolean; snapshot: boolean };
  warnings: string[];
}

export async function runCronTick(
  fetchImpl: FetchLike,
  config: JiraConnectionConfig,
  accountId: string,
  steps: {
    notifyStore?: NotifyStateStore;
    snapshot?: { store: ServerReportStore; now: Date; timezoneOffsetMinutes?: number; snapshotHourLocal?: number };
  }
): Promise<CronTickResult> {
  // A failure in either step never fails the other, and never corrupts persisted state (both
  // modules only write after every fetch succeeded) — it is surfaced as a warning.
  const warnings: string[] = [];
  if (steps.notifyStore) {
    try {
      const result = await runServerSideNotifyCheck(fetchImpl, config, accountId, steps.notifyStore);
      if (result.error) warnings.push(`Server-side notify check failed: ${result.error}`);
    } catch (err) {
      warnings.push(`Server-side notify check failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }
  if (steps.snapshot) {
    const { store, ...options } = steps.snapshot;
    try {
      const result = await runServerDailySnapshot(fetchImpl, config, accountId, store, options);
      if (result.error) warnings.push(`Server-side daily report failed: ${result.error}`);
    } catch (err) {
      warnings.push(`Server-side daily report failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }
  return { ok: true, cron: true, ran: { notify: !!steps.notifyStore, snapshot: !!steps.snapshot }, warnings };
}
