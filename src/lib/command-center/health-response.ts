// P2.2 — the body of GET /api/command-center/health. Pure: the route gathers the facts, this shapes
// them. Booleans and numbers only (plus the version and the cron judgement) — never a secret or URL.

import type { TimeZoneInUse } from "./time-zone-source";
import { evaluateCronHealth, type CronHealth, type CronHeartbeat } from "./health";

export interface HealthFacts {
  version: string;
  kvConfigured: boolean;
  kvReachable: boolean | null;
  jiraConfigured: boolean;
  slackConfigured: boolean;
  aiAvailable: boolean;
  heartbeat: CronHeartbeat | null;
  expectedMinutes: number;
  now: Date;
  schedule: { cronHoursUtc: number[]; offsetMinutes?: number; snapshotHourLocal: number; timeZone?: TimeZoneInUse };
}

export interface HealthResponse {
  version: string;
  kv: { configured: boolean; reachable: boolean | null };
  jira: { configured: boolean };
  slack: { configured: boolean };
  ai: { available: boolean };
  cron: CronHealth & { lastRunAt?: string; lastOkAt?: string; notified?: number; oldestWaitMinutes?: number; /** C1 */ slack?: { undelivered: number; droppedUndelivered: number; lastSlackError?: string; undeliveredSince?: string } };
  schedule: HealthFacts["schedule"];
}

export function buildHealthResponse(f: HealthFacts): HealthResponse {
  const cron = evaluateCronHealth(f.heartbeat, f.now, f.expectedMinutes);
  return {
    version: f.version,
    kv: { configured: f.kvConfigured, reachable: f.kvReachable },
    jira: { configured: f.jiraConfigured },
    slack: { configured: f.slackConfigured },
    ai: { available: f.aiAvailable },
    cron: {
      ...cron,
      ...(f.heartbeat ? { lastRunAt: f.heartbeat.lastRunAt, ...(f.heartbeat.lastOkAt ? { lastOkAt: f.heartbeat.lastOkAt } : {}), notified: f.heartbeat.notified, ...(f.heartbeat.oldestWaitMinutes !== undefined ? { oldestWaitMinutes: f.heartbeat.oldestWaitMinutes } : {}), ...(f.heartbeat.undelivered || f.heartbeat.droppedUndelivered ? { slack: { undelivered: f.heartbeat.undelivered ?? 0, droppedUndelivered: f.heartbeat.droppedUndelivered ?? 0, ...(f.heartbeat.lastSlackError ? { lastSlackError: f.heartbeat.lastSlackError } : {}), ...(f.heartbeat.undeliveredSince ? { undeliveredSince: f.heartbeat.undeliveredSince } : {}) } } : {}) } : {}),
    },
    schedule: f.schedule,
  };
}
