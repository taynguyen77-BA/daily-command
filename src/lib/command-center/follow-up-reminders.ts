// D5 — follow-up reminders: a block can carry "ping on <date>". On/after that day the ticket
// is listed in Daily Review's "Follow-ups to send", and — once per ticket per ping date, only
// when Slack is configured — sent as a Slack reminder. Never sends anything else.

import type { DailyCommandBlock, WorkItem } from "./types";

export interface DueFollowUp {
  ticketKey: string;
  pingOn: string;
  reason?: string;
  title?: string;
  url?: string;
}

export function dueFollowUps(blocks: Record<string, DailyCommandBlock>, today: string, workItems: Pick<WorkItem, "key" | "title" | "sourceUrl">[] = []): DueFollowUp[] {
  const byKey = new Map(workItems.map((w) => [w.key, w]));
  return Object.values(blocks)
    .filter((b) => !!b.pingOn && b.pingOn <= today)
    .map((b) => {
      const w = byKey.get(b.ticketKey);
      return { ticketKey: b.ticketKey, pingOn: b.pingOn!, ...(b.reason ? { reason: b.reason } : {}), ...(w ? { title: w.title } : {}), ...(w?.sourceUrl ? { url: w.sourceUrl } : {}) };
    })
    .sort((a, b) => a.pingOn.localeCompare(b.pingOn) || a.ticketKey.localeCompare(b.ticketKey));
}

/** The reminders not yet sent for their current ping date. */
export function followUpsToNotify(due: DueFollowUp[], notified: Record<string, string>): DueFollowUp[] {
  return due.filter((f) => notified[f.ticketKey] !== f.pingOn);
}

/** Slack payloads in the notify route's existing signal shape (kind FOLLOW_UP). */
export function followUpSlackPayloads(due: DueFollowUp[]): { issueKey: string; summary: string; url?: string; kind: "FOLLOW_UP"; detail: string }[] {
  return due.map((f) => ({
    issueKey: f.ticketKey,
    summary: f.title ?? f.ticketKey,
    ...(f.url ? { url: f.url } : {}),
    kind: "FOLLOW_UP" as const,
    detail: f.reason ? `blocked: ${f.reason}` : "blocked — ping whoever it waits on",
  }));
}
