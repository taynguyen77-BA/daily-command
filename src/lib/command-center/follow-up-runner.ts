// D5 — sends due follow-up reminders to Slack: on app load and every 30 minutes, only when the
// feature is on and Slack is configured, each (ticket, ping date) at most once. The decisions
// are the pure functions in follow-up-reminders.ts; this is the thin I/O wrapper.

import type { CommandCenterStore } from "./store";
import { getTodayIso } from "./store";
import { dueFollowUps, followUpSlackPayloads, followUpsToNotify } from "./follow-up-reminders";
import { checkSlackNotifyStatus, sendFollowUpReminders } from "./notify-client";

const INTERVAL_MS = 30 * 60 * 1000;
let started = false;
let running = false;

export async function runFollowUpRemindersOnce(store: CommandCenterStore, deps: { slackConfigured: () => Promise<boolean>; send: typeof sendFollowUpReminders } = { slackConfigured: async () => (await checkSlackNotifyStatus()).configured, send: sendFollowUpReminders }): Promise<number> {
  if (running) return 0;
  const state = store.getSnapshot();
  if (!state.loaded || !state.features.followUpReminders) return 0;
  const pending = followUpsToNotify(dueFollowUps(state.dailyCommandBlocks, getTodayIso(), state.data.workItems), state.followUpNotified);
  if (pending.length === 0) return 0;
  running = true;
  try {
    if (!(await deps.slackConfigured())) return 0;
    const result = await deps.send(followUpSlackPayloads(pending));
    if (!result.sent) return 0;
    store.recordFollowUpsNotified(pending.map((p) => ({ ticketKey: p.ticketKey, pingOn: p.pingOn })));
    return pending.length;
  } finally {
    running = false;
  }
}

export function initFollowUpReminders(store: CommandCenterStore): void {
  if (started) return;
  started = true;
  void runFollowUpRemindersOnce(store);
  setInterval(() => void runFollowUpRemindersOnce(store), INTERVAL_MS);
}
