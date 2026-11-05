// D3 — synthetic fixtures for the AI self-test: one representative input per AI task (plus Vietnamese variants for the
// language-bearing tasks). NO client data, NO real names / emails / keys: everything is invented (project SELF, people "Linh Tran",
// "Dev Team"). Each fixture carries its own expectations; ai/selftest.ts turns them into a rubric.

import type { AITask } from "./schemas";

export interface SelfTestExpect {
  /** "vi": the answer's prose must be Vietnamese (diacritic ratio); "en": English. */
  language: "en" | "vi" | "any";
  /** Ticket keys / tokens that must appear in the answer text. */
  mustMention?: string[];
  /** Strings or patterns that must NOT appear (placeholders, Given/When/Then …). */
  mustNotContain?: (string | RegExp)[];
  /** Longest single string allowed in the answer. */
  maxChars?: number;
}
export interface SelfTestFixture {
  id: string;
  task: AITask;
  label: string;
  /** Part of the quick run (the 5 core tasks). */
  core: boolean;
  input: unknown;
  expect: SelfTestExpect;
  /** Rough tokens one run costs (prompt + answer), for the up-front estimate. */
  estTokens: number;
}

const TODAY = "2026-11-05";
const ticket = (over: Record<string, unknown> = {}) => ({
  key: "SELF-12",
  projectKey: "SELF",
  summary: "Reminder email for expiring subscriptions",
  status: "In Progress",
  description: "Send a reminder email 7 days before a subscription expires. Open question: should the email also go to the billing contact?",
  comments: [
    { author: "Linh Tran", created: "2026-11-03T09:00:00.000Z", body: "Waiting on the Dev Team to confirm the API for expiry dates. Can you confirm the wording by Friday?" },
    { author: "Dev Team", created: "2026-11-04T08:30:00.000Z", body: "API change is planned, no date yet." },
  ],
  links: [{ key: "SELF-9", summary: "Expiry date API", status: "To Do", relation: "is blocked by" }],
  statusHistory: [{ at: "2026-11-01T10:00:00.000Z", from: "To Do", to: "In Progress" }],
  ...over,
});

export const SELFTEST_FIXTURES: SelfTestFixture[] = [
  { id: "ticket-brief", task: "generateTicketBrief", label: "Ticket brief", core: true, estTokens: 1800, input: { ticket: ticket(), today: TODAY }, expect: { language: "en", mustMention: ["SELF-9"], mustNotContain: [/\[[A-Z_]+_\d+\]/], maxChars: 1000 } },
  { id: "triage", task: "triageNewItems", label: "Smart triage", core: true, estTokens: 1600, input: { today: TODAY, deferDates: ["2026-11-06", "2026-11-09"], items: [{ key: "SELF-20", title: "Customer asks for invoice copy", type: "task", status: "To Do", signal: "Mentioned you", role: "Assignee" }, { key: "SELF-21", title: "Release notes review", type: "task", status: "To Do", signal: "Assigned to you", role: "Assignee" }] }, expect: { language: "en", mustMention: ["SELF-20"], mustNotContain: [/\[[A-Z_]+_\d+\]/] } },
  { id: "mention-reply-vi", task: "draftMentionReply", label: "Mention reply (Vietnamese)", core: true, estTokens: 1900, input: { ticket: ticket(), mention: { author: "Linh Tran", created: "2026-11-03T09:00:00.000Z", body: "Anh/chị xác nhận giúp nội dung email trước thứ Sáu nhé?" }, tone: "internal", language: "vi", length: "short" }, expect: { language: "vi", mustNotContain: [/\[[A-Z_]+_\d+\]/], maxChars: 1500 } },
  { id: "mention-reply-en", task: "draftMentionReply", label: "Mention reply (English)", core: false, estTokens: 1900, input: { ticket: ticket(), mention: { author: "Linh Tran", created: "2026-11-03T09:00:00.000Z", body: "Can you confirm the email wording by Friday?" }, tone: "client", language: "en", length: "short" }, expect: { language: "en", mustNotContain: [/\[[A-Z_]+_\d+\]/], maxChars: 1500 } },
  { id: "weekly-insights", task: "weeklyInsights", label: "Weekly insights", core: true, estTokens: 1200, input: { weekStart: "2026-10-26", weekEnd: "2026-11-01", facts: ["12 tickets were completed this week", "SELF-12 has been blocked for 4 days", "SELF-30 is overdue by 3 days"] }, expect: { language: "en", mustNotContain: [/\[[A-Z_]+_\d+\]/] } },
  { id: "command", task: "parseCommand", label: "Command Bar", core: true, estTokens: 900, input: { today: TODAY, command: "defer SELF-20 to next Monday", knownProjects: [{ key: "SELF", name: "Self-test project" }] }, expect: { language: "any", mustMention: ["SELF-20"] } },
  { id: "report-rewrite-vi", task: "rewriteReport", label: "Report rewrite (Vietnamese)", core: false, estTokens: 2600, input: { audience: "vi", report: `Daily report ${TODAY}\n- SELF-12 Reminder email: in progress, blocked by SELF-9 (due 2026-11-12).\n- SELF-20 Invoice copy: to do.\nRisks: SELF-9 has no delivery date yet.` }, expect: { language: "vi", mustMention: ["SELF-12", "SELF-9"], mustNotContain: [/\[[A-Z_]+_\d+\]/] } },
  { id: "blocker-followups", task: "draftBlockerFollowUps", label: "Blocker follow-ups", core: false, estTokens: 1700, input: { today: TODAY, channel: "slack", slaBusinessDays: 2, deadlineOptions: ["2026-11-07", "2026-11-10"], people: [{ person: "Dev Team", tickets: [{ key: "SELF-9", title: "Expiry date API", reason: "Waiting for API change", ageBusinessDays: 4, overSla: true }] }] }, expect: { language: "en", mustMention: ["SELF-9"], mustNotContain: [/\[[A-Z_]+_\d+\]/] } },
  { id: "release-go-no-go", task: "releaseGoNoGo", label: "Release go/no-go", core: false, estTokens: 2600, input: { fixVersion: "2.4", facts: { completionPct: 70, completedItems: 7, totalItems: 10, readiness: "AT_RISK", blockedCount: 1, overdueCount: 1, unresolvedDependenciesCount: 1, highPriorityIncompleteCount: 1, openP1BlockerCount: 0, deliveryConfidence: 62 }, allowedRecommendations: ["GO_WITH_RISKS", "NO_GO"], ruleReasons: ["1 blocked item remains"], blockers: [{ key: "SELF-12", title: "Reminder email", status: "In Progress", priority: "P2", reason: "Blocked by SELF-9" }], openItems: [{ key: "SELF-12", title: "Reminder email", status: "In Progress", priority: "P2" }], drift: [], risks: ["SELF-9 has no delivery date"] }, expect: { language: "en", mustMention: ["SELF-12"], mustNotContain: [/\[[A-Z_]+_\d+\]/] } },
  { id: "ba-requirement-check", task: "baRequirementCheck", label: "BA requirement check", core: false, estTokens: 3200, input: { ticket: ticket({ acceptanceCriteria: "- The email is sent 7 days before expiry\n- The email shows the plan name" }) }, expect: { language: "en", mustNotContain: [/\bGiven\b/, /\bWhen\b/, /\bThen\b/, /\[[A-Z_]+_\d+\]/] } },
  { id: "ticket-ai", task: "checkRequirements", label: "Ticket AI (requirement gaps)", core: false, estTokens: 2600, input: { ticket: ticket() }, expect: { language: "en", mustNotContain: [/\[[A-Z_]+_\d+\]/] } },
  { id: "meeting-notes", task: "extractMeetingActions", label: "Meeting notes → actions", core: false, estTokens: 1500, input: { today: TODAY, notes: "Sync 2026-11-05. Linh Tran will confirm the email wording for SELF-12 by 2026-11-07. Dev Team to share the API date for SELF-9." }, expect: { language: "en", mustMention: ["SELF-12"], mustNotContain: [/\[[A-Z_]+_\d+\]/] } },
  { id: "daily-guidance", task: "generateDailyGuidance", label: "Next Best Action wording", core: false, estTokens: 900, input: { topFocusFacts: ["SELF-12 is blocked by SELF-9 for 4 days"], watchFacts: ["SELF-30 is overdue by 3 days"], planFacts: [], recentOutcomeFacts: [], evidenceStrings: [] }, expect: { language: "en", mustNotContain: [/\[[A-Z_]+_\d+\]/] } },
];

export const quickFixtures = (): SelfTestFixture[] => SELFTEST_FIXTURES.filter((f) => f.core);
