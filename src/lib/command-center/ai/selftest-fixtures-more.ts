// V2.52 A4 — fixtures for the AI tasks the first self-test did not cover (so EVERY task has one), plus Vietnamese variants for the
// language-bearing tasks. Invented data only (project SELF, people "Linh Tran" / "Dev Team"): no client names, emails or keys.

import type { SelfTestFixture } from "./selftest-fixtures";

const TODAY = "2026-11-05";
const NO_PLACEHOLDER = [/\[[A-Z_]+_\d+\]/];
const ticket = (over: Record<string, unknown> = {}) => ({
  key: "SELF-12", projectKey: "SELF", summary: "Reminder email for expiring subscriptions", status: "In Progress",
  description: "Send a reminder email 7 days before a subscription expires. Open question: should the email also go to the billing contact?",
  comments: [{ author: "Linh Tran", created: "2026-11-03T09:00:00.000Z", body: "Waiting on the Dev Team to confirm the API for expiry dates. Can you confirm the wording by Friday?" }],
  links: [{ key: "SELF-9", summary: "Expiry date API", status: "To Do", relation: "is blocked by" }],
  statusHistory: [{ at: "2026-11-01T10:00:00.000Z", from: "To Do", to: "In Progress" }],
  ...over,
});
const item = { key: "SELF-12", title: "Reminder email for expiring subscriptions", status: "In Progress" };
const evidence = [{ content: "SELF-12 is blocked by SELF-9 for 4 days." }, { content: "SELF-9 has no delivery date." }];
const reviewFacts = {
  hasEnoughHistory: true, windowDays: 7, currentConfidence: 68, confidenceDelta: -4,
  gettingBetter: ["SELF-30 was closed"], gettingWorse: ["SELF-12 stayed blocked"],
  recurringRisks: [{ title: "Expiry date API has no delivery date" }], decisionsMade: [{ title: "Send the reminder 7 days before expiry" }], decisionsUnresolved: [{ title: "Should the billing contact be copied?" }],
  actionsCompleted: [{ title: "Confirm email wording" }], actionsThatDidNotResolveTheIssue: [{ title: "Ping Dev Team about SELF-9" }], carryOverRisks: ["SELF-9 has no delivery date"],
  nextWeekPriorities: [{ item: { key: "SELF-12", title: "Reminder email for expiring subscriptions" } }],
};
const narrativeFacts = (over: Record<string, unknown> = {}) => ({
  kind: "daily", periodPhrase: "Today", style: "standup", language: "en",
  counts: { done: 3, inProgress: 1, blocked: 1, newReceived: 2, mentionsAwaitingReply: 1, overdueBlockers: 1, decisions: 0, projects: 1, doneNotListed: 0, slaBusinessDays: 2 },
  done: [{ key: "SELF-1", title: "Invoice copy", project: "Self-test" }, { key: "SELF-2", title: "Footer links", project: "Self-test" }, { key: "SELF-3", title: "Icon sizes", project: "Self-test" }],
  inProgress: [{ key: "SELF-4", title: "Retry policy", project: "Self-test" }],
  blocked: [{ key: "SELF-9", title: "Expiry date API", project: "Self-test", ageBusinessDays: 4, waitingFor: "Dev Team: API date" }],
  decisions: [], ...over,
});
const en = { language: "en" as const, mustNotContain: NO_PLACEHOLDER };

export const MORE_FIXTURES: SelfTestFixture[] = [
  { id: "analyze-priorities", task: "analyzePriorities", label: "Priority reasoning", core: false, estTokens: 1100, input: { item, result: { score: 82, classification: "HIGH", confidence: 0.7, reasoning: "Blocked and due soon.", factors: [{ name: "Blocked", contribution: 30, max: 30, detail: "Blocked by SELF-9 for 4 days." }] }, facts: ["SELF-12 is blocked by SELF-9 for 4 days."], evidence }, expect: { ...en, maxChars: 900 } },
  { id: "detect-risks", task: "detectRisks", label: "Risk reasoning", core: false, estTokens: 1100, input: { risk: { title: "Expiry date API has no delivery date", level: "HIGH", confidence: 0.7, reason: "SELF-9 has no date.", potentialImpact: "SELF-12 cannot ship.", mitigation: "Ask the Dev Team for a date." }, facts: ["SELF-9 has no delivery date."], evidence }, expect: { ...en, maxChars: 900 } },
  { id: "explain-changes", task: "explainChanges", label: "Explain a change", core: false, estTokens: 700, input: { change: { entityLabel: "SELF-12 Reminder email", entityType: "WorkItem", field: "status", before: "In Progress", after: "Blocked", impact: "The release may slip." } }, expect: { ...en, mustMention: ["SELF-12"], maxChars: 600 } },
  { id: "action-plan", task: "generateActionPlan", label: "Action plan", core: false, estTokens: 900, input: { budgetMinutes: 60, candidates: [{ item, estimateMinutes: 30 }, { action: { title: "Ping Dev Team about SELF-9" }, estimateMinutes: 15 }] }, expect: { ...en, maxChars: 700 } },
  { id: "communication", task: "generateCommunication", label: "Draft a nudge", core: false, estTokens: 800, input: { item, audience: "the Dev Team", why: "SELF-12 is blocked by SELF-9." }, expect: { ...en, mustMention: ["SELF-12"], maxChars: 500 } },
  { id: "end-of-day", task: "generateEndOfDaySummary", label: "End-of-day summary", core: false, estTokens: 900, input: { completed: [{ title: "Confirm email wording" }], deferred: [{ title: "Retry policy review" }], blocked: [{ title: "SELF-12 waits on SELF-9" }], newRisks: [{ title: "SELF-9 has no date" }] }, expect: { ...en, maxChars: 900 } },
  { id: "end-of-day-vi", task: "generateEndOfDaySummary", label: "End-of-day summary (Vietnamese)", core: false, estTokens: 1100, input: { completed: [{ title: "Xác nhận nội dung email" }], deferred: [], blocked: [{ title: "SELF-12 chờ SELF-9" }], newRisks: [], language: "vi" }, expect: { language: "vi", mustNotContain: NO_PLACEHOLDER, maxChars: 900 } },
  { id: "trend", task: "interpretTrend", label: "Interpret a trend", core: false, estTokens: 800, input: { trend: { hasHistory: true, overall: "worsening", deltas: [{ label: "Blocked tickets", before: 1, after: 3, delta: 2, direction: "worse" }] }, currentConfidence: 0.6 }, expect: { ...en, maxChars: 700 } },
  { id: "decision-conflicts", task: "detectDecisionConflicts", label: "Decision conflicts", core: false, estTokens: 900, input: { candidate: { decision: { title: "Send the reminder 7 days before expiry", status: "PROPOSED" }, reasons: ["SELF-14 proposes 3 days before expiry."], evidence: [{ content: "SELF-14 proposes 3 days before expiry." }] } }, expect: { ...en, maxChars: 700 } },
  { id: "action-outcomes", task: "analyzeActionOutcomes", label: "Action outcome", core: false, estTokens: 800, input: { ctx: { yesterdayRecommendation: "Ping the Dev Team about SELF-9.", actionTaken: "Pinged the Dev Team.", outcome: "No reply yet.", currentStateFacts: ["SELF-9 is still without a date."] } }, expect: { ...en, maxChars: 700 } },
  { id: "weekly-review", task: "generateWeeklyReview", label: "Weekly review", core: false, estTokens: 2000, input: { facts: reviewFacts }, expect: { ...en, mustMention: ["EXECUTIVE SUMMARY"], maxChars: 1500 } },
  { id: "weekly-review-vi", task: "generateWeeklyReview", label: "Weekly review (Vietnamese)", core: false, estTokens: 2400, input: { facts: reviewFacts, language: "vi" }, expect: { language: "vi", mustNotContain: NO_PLACEHOLDER, maxChars: 1500 } },
  { id: "answer-query", task: "answerQuery", label: "Answer a question", core: false, estTokens: 800, input: { query: "What is blocking SELF-12?", facts: ["SELF-12 is blocked by SELF-9 for 4 days."], recommendedActionSeed: "Ask the Dev Team for the API date." }, expect: { ...en, mustMention: ["SELF-9"], maxChars: 600 } },
  { id: "assess-proactive", task: "assessProactive", label: "Proactive assessment", core: false, estTokens: 900, input: { category: "risk aging", facts: ["SELF-9 has been open for 12 days."], evidenceStrings: ["SELF-9 has no delivery date."], trendQualityNote: "Only 3 days of history — early signal." }, expect: { ...en, maxChars: 600 } },
  { id: "project-story", task: "generateProjectStory", label: "Project story", core: false, estTokens: 900, input: { timelineFacts: ["2026-11-01: SELF-12 started.", "2026-11-04: SELF-12 became blocked by SELF-9."], evidenceStrings: ["SELF-9 has no delivery date."], hasEnoughHistory: true }, expect: { ...en, maxChars: 800 } },
  { id: "decision-options", task: "generateDecisionOptions", label: "Decision options", core: false, estTokens: 1500, input: { issueTitle: "Who receives the reminder email?", facts: ["Billing contact exists for 40% of accounts."], evidenceStrings: ["Open question in SELF-12."] }, expect: { ...en, maxChars: 600 } },
  { id: "interpret-outcome", task: "interpretOutcome", label: "Interpret an outcome", core: false, estTokens: 900, input: { subjectTitle: "Ping the Dev Team about SELF-9", observedChangeFacts: ["SELF-9 is still To Do.", "SELF-12 stayed blocked."], evidenceStrings: ["No reply yet."] }, expect: { ...en, maxChars: 600 } },
  { id: "communication-artifact", task: "generateCommunicationArtifact", label: "Communication artifact", core: false, estTokens: 1300, input: { type: "STATUS_UPDATE", facts: ["SELF-12 is blocked by SELF-9.", "SELF-30 was closed."], evidenceStrings: ["SELF-9 has no delivery date."] }, expect: { ...en, maxChars: 1500 } },
  { id: "polish-summary", task: "polishReportSummary", label: "Polish the numbers line", core: false, estTokens: 600, input: { summary: "3 done, 1 in progress, 1 blocked, 2 new, 1 mention awaiting reply. Top blocker: SELF-9 Expiry date API — blocked 4 business days." }, expect: { ...en, mustMention: ["SELF-9"], maxChars: 500 } },
  { id: "ticket-brief-vi", task: "generateTicketBrief", label: "Ticket brief (Vietnamese)", core: false, estTokens: 2100, input: { ticket: ticket(), today: TODAY, language: "vi" }, expect: { language: "vi", mustMention: ["SELF-9"], mustNotContain: NO_PLACEHOLDER, maxChars: 1000 } },
  { id: "weekly-insights-vi", task: "weeklyInsights", label: "Weekly insights (Vietnamese)", core: false, estTokens: 1500, input: { weekStart: "2026-10-26", weekEnd: "2026-11-01", facts: ["12 tickets were completed this week", "SELF-12 has been blocked for 4 days"], language: "vi" }, expect: { language: "vi", mustNotContain: NO_PLACEHOLDER, maxChars: 500 } },
  { id: "report-narrative", task: "summarizeReport", label: "Report summary (standup, EN)", core: true, estTokens: 1500, input: narrativeFacts(), expect: { language: "en", mustMention: ["SELF-9"], mustNotContain: NO_PLACEHOLDER, maxChars: 1000, sentences: { min: 3, max: 5 } } },
  { id: "report-narrative-vi", task: "summarizeReport", label: "Report summary (work log, VI)", core: false, estTokens: 1800, input: narrativeFacts({ periodPhrase: "Ngày 2026-11-05", style: "worklog", language: "vi" }), expect: { language: "vi", mustMention: ["SELF-9"], mustNotContain: NO_PLACEHOLDER, maxChars: 1000, sentences: { min: 3, max: 5 } } },
];
