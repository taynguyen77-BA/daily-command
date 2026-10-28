// P2.2 — is the unattended run (cron) actually running? Pure: no clock, no I/O.
// The heartbeat is written by the cron GET (jira/cron-tick.ts); this module only judges it.

export interface CronHeartbeat {
  lastRunAt: string;
  /** The last run that finished with no warning/error. */
  lastOkAt?: string;
  lastError?: string;
  durationMs: number;
  notified: number;
  /** <= 5 */
  warnings: string[];
  /** P2.3 — how long the longest-waiting member had waited for this run (team mode only). */
  oldestWaitMinutes?: number;
  /** C1 — signals waiting for a Slack retry after a failed post (0/absent: none). */
  undelivered?: number;
  /** C1 — signals given up on after too many failed posts (this run). */
  droppedUndelivered?: number;
  /** C1 — the last Slack error, while undelivered > 0. */
  lastSlackError?: string;
  /** C1 — when the current Slack failure streak began. */
  undeliveredSince?: string;
}

export interface HeartbeatStore {
  get(): Promise<CronHeartbeat | null>;
  set(heartbeat: CronHeartbeat): Promise<void>;
}

export type CronHealthStatus = "OK" | "LATE" | "STALE" | "NEVER" | "ERROR";

export interface CronHealth {
  status: CronHealthStatus;
  ageMinutes?: number;
  message: string;
}

export const DEFAULT_CRON_EXPECTED_MINUTES = 20;
/** LATE when older than this many expected intervals, STALE when older than STALE_FACTOR. */
export const LATE_FACTOR = 2;
export const STALE_FACTOR = 6;
export const MAX_HEARTBEAT_WARNINGS = 5;

/** CRON_EXPECTED_MINUTES (positive number, default 20). Set it to 1440 for a once-a-day Vercel cron. */
export function cronExpectedMinutes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.CRON_EXPECTED_MINUTES);
  return Number.isFinite(n) && n > 0 && env.CRON_EXPECTED_MINUTES?.trim() !== "" ? n : DEFAULT_CRON_EXPECTED_MINUTES;
}

const minutesBetween = (fromIso: string, now: Date) => Math.max(0, Math.floor((now.getTime() - new Date(fromIso).getTime()) / 60_000));

/** Ordering: never run -> NEVER; older than 6x expected -> STALE (even if it also errored);
 *  last run errored -> ERROR; older than 2x -> LATE; else OK. "Older than" is strictly greater,
 *  so exactly 2x is still OK and exactly 6x is still LATE. */
export function evaluateCronHealth(heartbeat: { lastRunAt?: string; lastOkAt?: string; lastError?: string } | null | undefined, now: Date, expectedMinutes: number = DEFAULT_CRON_EXPECTED_MINUTES): CronHealth {
  if (!heartbeat?.lastRunAt || !Number.isFinite(new Date(heartbeat.lastRunAt).getTime())) {
    return { status: "NEVER", message: "The scheduled server check has never run. Configure a scheduler (see README: Choosing a scheduler)." };
  }
  const ageMinutes = minutesBetween(heartbeat.lastRunAt, now);
  const okNote = heartbeat.lastOkAt && Number.isFinite(new Date(heartbeat.lastOkAt).getTime()) ? ` Last fully successful run ${minutesBetween(heartbeat.lastOkAt, now)} min ago.` : " No fully successful run on record.";
  if (ageMinutes > STALE_FACTOR * expectedMinutes) {
    return { status: "STALE", ageMinutes, message: `The scheduled server check last ran ${ageMinutes} min ago (expected every ~${expectedMinutes} min) — the scheduler has probably stopped.${heartbeat.lastError ? ` Last error: ${heartbeat.lastError}` : ""}` };
  }
  if (heartbeat.lastError) {
    return { status: "ERROR", ageMinutes, message: `The last scheduled server check failed: ${heartbeat.lastError}.${okNote}` };
  }
  if (ageMinutes > LATE_FACTOR * expectedMinutes) {
    return { status: "LATE", ageMinutes, message: `The scheduled server check is late: last ran ${ageMinutes} min ago (expected every ~${expectedMinutes} min).` };
  }
  return { status: "OK", ageMinutes, message: `The scheduled server check ran ${ageMinutes} min ago.` };
}

/** The UI's one rendering of a CronHealth — used by the header chip AND Setup Health so the two never disagree. */
export type ServerCheckTone = "green" | "amber" | "red";
export function describeServerCheck(health: CronHealth): { label: string; tone: ServerCheckTone; tooltip: string } {
  const tone: ServerCheckTone = health.status === "OK" ? "green" : health.status === "LATE" ? "amber" : "red";
  const label = { OK: "Server check OK", LATE: "Server check late", STALE: "Server check stale", NEVER: "Server check never ran", ERROR: "Server check failed" }[health.status];
  return { label, tone, tooltip: health.message };
}

export function buildHeartbeat(input: { startedAt: number; finishedAt: number; notified: number; warnings: string[]; previous: CronHeartbeat | null; oldestWaitMinutes?: number; slack?: { undelivered: number; droppedUndelivered: number; lastSlackError?: string; undeliveredSince?: string } }): CronHeartbeat {
  const failed = input.warnings.length > 0;
  const runAt = new Date(input.finishedAt).toISOString();
  const lastOkAt = failed ? input.previous?.lastOkAt : runAt;
  return {
    lastRunAt: runAt,
    ...(lastOkAt ? { lastOkAt } : {}),
    ...(failed ? { lastError: input.warnings[0].slice(0, 300) } : {}),
    durationMs: Math.max(0, input.finishedAt - input.startedAt),
    notified: input.notified,
    warnings: input.warnings.slice(0, MAX_HEARTBEAT_WARNINGS).map((w) => w.slice(0, 300)),
    ...(input.oldestWaitMinutes !== undefined ? { oldestWaitMinutes: input.oldestWaitMinutes } : {}),
    ...(input.slack && (input.slack.undelivered > 0 || input.slack.droppedUndelivered > 0)
      ? {
          undelivered: input.slack.undelivered,
          droppedUndelivered: input.slack.droppedUndelivered,
          ...(input.slack.lastSlackError ? { lastSlackError: input.slack.lastSlackError.slice(0, 300) } : {}),
          ...(input.slack.undeliveredSince ? { undeliveredSince: input.slack.undeliveredSince } : {}),
        }
      : {}),
  };
}

export function createInMemoryHeartbeatStore(initial: CronHeartbeat | null = null): HeartbeatStore {
  let state = initial;
  return { get: async () => state, set: async (h) => { state = h; } };
}
