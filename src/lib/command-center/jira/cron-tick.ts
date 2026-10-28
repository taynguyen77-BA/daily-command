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
import type { NotifyPrefsStore } from "../notify-prefs";
import type { DigestStore } from "../notify-digest";
import { buildHeartbeat, type HeartbeatStore } from "../health";
import { oldestWaitMinutes, type CronProgressStore } from "../cron-progress";
import type { FetchLike } from "./http";
import type { JiraConnectionConfig } from "./types";

export interface CronTickResult {
  ok: true;
  cron: true;
  /** Which steps ran (a step whose store isn't configured is skipped, not an error). */
  ran: { notify: boolean; snapshot: boolean };
  warnings: string[];
  /** P2.2 — Slack messages delivered by the notify step this run (0 when it did not run). */
  notified?: number;
  /** C1 — Slack delivery state after the notify step (absent: the step did not run). */
  slack?: { undelivered: number; droppedUndelivered: number; lastSlackError?: string; undeliveredSince?: string };
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
    /** P1.1 — the Jira user's UTC offset for the notify step's `updated >=` cursor. */
    timezoneOffsetMinutes?: number;
    /** C1 — the Jira user's IANA zone (DST-aware); wins over the offset. */
    timeZone?: string;
    /** P3.5 — notification preferences + digest queue (omitted: the V2.41 behaviour). */
    smartNotify?: { prefsStore: NotifyPrefsStore; digestStore: DigestStore };
  }
): Promise<CronTickResult> {
  // A failure in either step never fails the other, and never corrupts persisted state (both
  // modules only write after every fetch succeeded) — it is surfaced as a warning.
  const warnings: string[] = [];
  let notified = 0;
  let slack: CronTickResult["slack"];
  if (steps.notifyStore) {
    try {
      const result = await runServerSideNotifyCheck(fetchImpl, config, accountId, steps.notifyStore, undefined, {
        ...("webhookUrl" in steps ? { webhookUrl: steps.webhookUrl } : {}),
        timezoneOffsetMinutes: steps.timezoneOffsetMinutes,
        ...(steps.timeZone ? { timeZone: steps.timeZone } : {}),
        ...(steps.smartNotify ? { smart: steps.smartNotify } : {}),
      });
      notified = result.notified;
      slack = { undelivered: result.undelivered ?? 0, droppedUndelivered: result.droppedUndelivered ?? 0, ...(result.lastSlackError ? { lastSlackError: result.lastSlackError } : {}), ...(result.undeliveredSince ? { undeliveredSince: result.undeliveredSince } : {}) };
      if (result.droppedUndelivered) warnings.push(`${result.droppedUndelivered} notification(s) dropped after repeated Slack failures.`);
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
  return { ok: true, cron: true, ran: { notify: !!steps.notifyStore, snapshot: !!steps.snapshot }, warnings, notified, ...(slack ? { slack } : {}) };
}

/** P2.2 — runCronTick plus the heartbeat: written after every run, success OR failure, and a
 *  heartbeat problem (or a throw out of the tick) never escapes — the cron response stays a
 *  normal JSON body. No store (KV not configured) -> exactly runCronTick. */
export async function runCronTickWithHeartbeat(
  fetchImpl: FetchLike,
  config: JiraConnectionConfig,
  accountId: string,
  steps: Parameters<typeof runCronTick>[3],
  heartbeat?: HeartbeatStore,
  clock: () => number = Date.now,
  extra: { oldestWaitMinutes?: number } = {}
): Promise<CronTickResult> {
  const startedAt = clock();
  let result: CronTickResult;
  try {
    result = await runCronTick(fetchImpl, config, accountId, steps);
  } catch (err) {
    result = { ok: true, cron: true, ran: { notify: false, snapshot: false }, warnings: [`Cron tick failed: ${err instanceof Error ? err.message : "unknown error"}`], notified: 0 };
  }
  if (heartbeat) {
    try {
      const previous = await heartbeat.get();
      await heartbeat.set(buildHeartbeat({ startedAt, finishedAt: clock(), notified: result.notified ?? 0, warnings: result.warnings, previous, ...(result.slack ? { slack: result.slack } : {}), ...extra }));
    } catch {
      // best-effort — a heartbeat write failure never fails the run
    }
  }
  return result;
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
  /** C1 — the member's Jira IANA zone (learned from /myself). */
  timeZone?: string;
  /** P2.3 — when this member was last processed (set by planCronMembers when fairness is on). */
  lastProcessedAt?: string;
}

export interface CronMembersResult {
  ok: true;
  cron: true;
  usersProcessed: number;
  failures: { uid: string; email: string; error: string }[];
  /** Members with nothing to do here (no usable Jira connection), or not reached in time. */
  skipped: { uid: string; email: string; reason: string }[];
  /** P2.3 — minutes the longest-waiting member (with a known last run) had waited when this run started. */
  oldestWaitMinutes?: number;
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
    /** P2.2 — per-member heartbeat store (omitted: none written). */
    heartbeatFor?: (uid: string) => HeartbeatStore | undefined;
    /** P3.5 — per-member notification preferences + digest queue (omitted: none). */
    smartNotifyFor?: (uid: string) => { prefsStore: NotifyPrefsStore; digestStore: DigestStore } | undefined;
    /** P2.3 — per-member last-processed store (omitted: not persisted). */
    progressFor?: (uid: string) => CronProgressStore | undefined;
  }
): Promise<CronMembersResult> {
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const result: CronMembersResult = { ok: true, cron: true, usersProcessed: 0, failures: [], skipped: [] };
  const waited = oldestWaitMinutes(plans, deps.now());
  if (waited !== undefined) result.oldestWaitMinutes = waited;
  for (const plan of plans) {
    if (clock() - started > deps.budgetMs) {
      result.skipped.push({ uid: plan.uid, email: plan.email, reason: "Not reached within this run's time budget." });
      continue;
    }
    const stores = deps.storesFor(plan.uid);
    try {
      const tick = await runCronTickWithHeartbeat(fetchImpl, plan.config, plan.accountId, {
        notifyStore: plan.notify ? stores.notifyStore : undefined,
        webhookUrl: plan.webhookUrl,
        timezoneOffsetMinutes: plan.timezoneOffsetMinutes,
        ...(plan.timeZone ? { timeZone: plan.timeZone } : {}),
        ...(deps.smartNotifyFor?.(plan.uid) ? { smartNotify: deps.smartNotifyFor(plan.uid) } : {}),
        snapshot: plan.snapshot && stores.reportStore ? { store: stores.reportStore, now: deps.now(), timezoneOffsetMinutes: plan.timezoneOffsetMinutes, snapshotHourLocal: deps.snapshotHourLocal } : undefined,
      }, deps.heartbeatFor?.(plan.uid), clock, { oldestWaitMinutes: waited });
      result.usersProcessed++;
      if (tick.warnings.length > 0) result.failures.push({ uid: plan.uid, email: plan.email, error: tick.warnings.join(" ") });
    } catch (err) {
      result.usersProcessed++;
      result.failures.push({ uid: plan.uid, email: plan.email, error: err instanceof Error ? err.message : "unknown error" });
    }
    // P2.3 — processed (even if it failed): it goes to the back of the queue. Best-effort.
    try {
      await deps.progressFor?.(plan.uid)?.set(deps.now().toISOString());
    } catch {
      // a progress write failure never fails the run
    }
  }
  return result;
}
