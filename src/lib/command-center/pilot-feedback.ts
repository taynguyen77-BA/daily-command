// V2.22 §3-4 — Pilot Trust Model + Pilot Observability. A pure reshape of values every
// caller already has computed (freshness, project scope, Assigned Work / Recent Mentions /
// Waiting For / Attention Queue counts) into one PilotFeedbackContext snapshot — never a new
// engine, never new tracking. See types.ts's PilotFeedbackEntry for the full reasoning.

import type { Freshness, JiraProjectScope, PilotFeedbackContext } from "./types";

export function buildPilotFeedbackContext(params: {
  isJira: boolean;
  freshness: Freshness | undefined; // undefined when not applicable (non-Jira source)
  jiraProjectScope: JiraProjectScope;
  assignedWorkActiveCount: number;
  recentMentionsCount: number;
  waitingForCount: number;
  attentionQueueActiveCount: number;
}): PilotFeedbackContext {
  return {
    freshness: params.isJira ? params.freshness ?? "unknown" : "not-jira",
    projectScopeMode: params.jiraProjectScope.mode,
    focusedProjectCount: params.jiraProjectScope.mode === "FOCUSED" ? params.jiraProjectScope.projectKeys.length : undefined,
    assignedWorkActiveCount: params.assignedWorkActiveCount,
    recentMentionsCount: params.recentMentionsCount,
    waitingForCount: params.waitingForCount,
    attentionQueueActiveCount: params.attentionQueueActiveCount,
  };
}
