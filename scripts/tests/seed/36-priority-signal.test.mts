// P3.1 — red-first seed: Jira priority must influence the priority score.
// Place at scripts/tests/36-priority-signal.test.mts and append to FILES in run.mts after
// 35-notify-correctness. Design-agnostic on purpose: it pins the missing behaviour, not the weights.
//
// Evidence from the review: with every other field equal, P1..P4 all score 1 (LOW) because
// scoring.ts never reads `item.priority`, and Jira items always have businessImpact === undefined
// (jira/normalize.ts), so the 20-point "Business impact" factor is dead weight on real data.

import { scoreWorkItem } from "../../../src/lib/command-center/scoring";
import type { CommandCenterData, WorkItem } from "../../../src/lib/command-center/types";
import { ok } from "../harness.mts";

const base = {
  id: "jira-X-1", key: "X-1", title: "t", projectId: "p", clientId: "c", type: "task", status: "In Progress",
  createdDate: "2026-10-01", lastUpdated: "2026-10-26", blocked: false, dependencyIds: [], riskIds: [],
  scopeChangeCount: 0, ownerId: "acc-me", owner: "Tay", businessImpact: undefined, sourceType: "jira",
} as unknown as WorkItem;
const data = { dependencies: [], clients: [], workItems: [] } as unknown as CommandCenterData;
const today = "2026-10-27";
const score = (priority: WorkItem["priority"], extra: Partial<WorkItem> = {}) => scoreWorkItem({ ...base, priority, ...extra }, data, today).score;

{
  const group = "P3.1 Priority signal";
  ok(group, score("P1") > score("P2") && score("P2") > score("P3") && score("P3") > score("P4"), `P1 > P2 > P3 > P4 when everything else is equal (got ${score("P1")}/${score("P2")}/${score("P3")}/${score("P4")})`);
  ok(group, score("P1", { dueDate: "2026-10-28" }) > score("P4", { dueDate: "2026-10-28" }), "priority still separates two tickets that share the same due date");
  const worstCase = score("P1", { dueDate: "2026-10-20", blocked: true, scopeChangeCount: 5, lastUpdated: "2026-10-01", owner: undefined, ownerId: undefined } as Partial<WorkItem>);
  ok(group, worstCase >= 80, `an overdue, blocked, P1 Jira ticket (no dependency links, no business-impact field) reaches CRITICAL (>= 80) (got ${worstCase})`);
}
