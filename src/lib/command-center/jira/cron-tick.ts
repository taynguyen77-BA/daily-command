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
    /** L4 — this member's Slack destination (null: none). Omitted: SLACK_WEBHOOK_URL. */
    webhookUrl?: string | null;
    snapshot?: { store: ServerReportStore; now: Date; timezoneOffsetMinutes?: number; snapshotHourLocal?: number };
  }
): Promise<CronTickResult> {
  // A failure in either step never fails the other, and never corrupts persisted state (both
  // modules only write after every fetch succeeded) — it is surfaced as a warning.
  const warnings: string[] = [];
  if (steps.notifyStore) {
    try {
      const result =
        "webhookUrl" in steps
          ? await runServerSideNotifyCheck(fetchImpl, config, accountId, steps.notifyStore, undefined, { webhookUrl: steps.webhookUrl })
          : await runServerSideNotifyCheck(fetchImpl, config, accountId, steps.notifyStore);
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

// ===== L4 — team sign-in: one run per member =================================================
// The cron (Bearer CRON_SECRET) walks every member who turned on server notifications or the
// daily snapshot and has a usable Jira connection, and runs the same two steps with THAT
// member's Jira connection, stores, Slack destination and timezone. Sequential, within a time
// budget (members not reached are reported as skipped; the next run starts from the top again);
// one member's failure (e.g. their Jira token was revoked → 401) never stops the others.

export interface CronMemberPlan {
  uid: string;
  email: string;
  config: JiraConnectionConfig;
  accountId: string;
  webhookUrl: string | null;
  notify: boolean;
  snapshot: boolean;
  timezoneOffsetMinutes?: number;
}

export interface CronMembersResult {
  ok: true;
  cron: true;
  usersProcessed: number;
  failures: { uid: string; email: string; error: string }[];
  /** Members with nothing to do here (no usable Jira connection), or not reached in time. */
  skipped: { uid: string; email: string; reason: string }[];
}

export async function runCronForMembers(
  fetchImpl: FetchLike,
  plans: CronMemberPlan[],
  deps: {
    storesFor: (uid: string) => { notifyStore?: NotifyStateStore; reportStore?: ServerReportStore };
    now: () => Date;
    snapshotHourLocal?: number;
    /** Wall-clock budget for the whole run, ms. */
    budgetMs: number;
    clock?: () => number;
  }
): Promise<CronMembersResult> {
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const result: CronMembersResult = { ok: true, cron: true, usersProcessed: 0, failures: [], skipped: [] };
  for (const plan of plans) {
    if (clock() - started > deps.budgetMs) {
      result.skipped.push({ uid: plan.uid, email: plan.email, reason: "Not reached within this run's time budget." });
      continue;
    }
    const stores = deps.storesFor(plan.uid);
    try {
      const tick = await runCronTick(fetchImpl, plan.config, plan.accountId, {
        notifyStore: plan.notify ? stores.notifyStore : undefined,
        webhookUrl: plan.webhookUrl,
        snapshot: plan.snapshot && stores.reportStore ? { store: stores.reportStore, now: deps.now(), timezoneOffsetMinutes: plan.timezoneOffsetMinutes, snapshotHourLocal: deps.snapshotHourLocal } : undefined,
      });
      result.usersProcessed++;
      if (tick.warnings.length > 0) result.failures.push({ uid: plan.uid, email: plan.email, error: tick.warnings.join(" ") });
    } catch (err) {
      result.usersProcessed++;
      result.failures.push({ uid: plan.uid, email: plan.email, error: err instanceof Error ? err.message : "unknown error" });
    }
  }
  return result;
}
