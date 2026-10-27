// L4 — which members the cron runs for, and with what: members (not disabled) who turned on
// server notifications or the daily snapshot AND have a usable Jira connection with an
// accountId. Everyone else is listed as skipped with the reason — never an error.

import type { Env } from "./auth-config";
import { jiraConfigForUser, slackWebhookForUser } from "./connections";
import type { UserDirectory } from "./users";
import type { CronMemberPlan } from "../jira/cron-tick";
import { orderByLongestWaiting } from "../cron-progress";

export async function planCronMembers(directory: UserDirectory, env: Env, key: Buffer | null, allowSharedJira: boolean, lastProcessedFor?: (uid: string) => Promise<string | null>): Promise<{ plans: CronMemberPlan[]; skipped: { uid: string; email: string; reason: string }[] }> {
  const plans: CronMemberPlan[] = [];
  const skipped: { uid: string; email: string; reason: string }[] = [];
  for (const user of await directory.listUsers()) {
    if (user.disabled) continue;
    const profile = await directory.getProfile(user.uid);
    if (!profile.notifyEnabled && !profile.dailySnapshotEnabled) continue;
    const jira = jiraConfigForUser(user.uid, profile, env, key, allowSharedJira);
    if (!jira.ok || !jira.accountId) {
      skipped.push({ uid: user.uid, email: user.email, reason: jira.ok ? "No Jira accountId on this member's connection." : jira.error });
      continue;
    }
    plans.push({
      uid: user.uid,
      email: user.email,
      config: jira.config,
      accountId: jira.accountId,
      webhookUrl: slackWebhookForUser(user.uid, profile, env, key),
      notify: profile.notifyEnabled,
      snapshot: profile.dailySnapshotEnabled,
      timezoneOffsetMinutes: profile.timezoneOffsetMinutes,
      ...(lastProcessedFor ? { lastProcessedAt: (await lastProcessedFor(user.uid)) ?? undefined } : {}),
    });
  }
  // P2.3 — whoever has waited longest goes first (never-processed first; ties by uid).
  return { plans: lastProcessedFor ? orderByLongestWaiting(plans) : plans, skipped };
}
