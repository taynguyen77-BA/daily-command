// Round-3 seed (red-first). Place at scripts/tests/55-severity-calibration.test.mts.
// Bug: v2 fixed the P1-vs-P4 blind spot but the 80/60/40 thresholds are unreachable for realistic Jira tickets: a P1 overdue by
// 6 days AND blocked scores 56 (MEDIUM); a P1 due tomorrow scores 39 (LOW). The Priorities page filters by Critical/High, so those
// tabs stay empty. Pins behaviour, not weights: hard rules + calibrated thresholds are the implementer's choice.
import { scoreWorkItem } from "../../src/lib/command-center/scoring";
import type { CommandCenterData, Severity, WorkItem } from "../../src/lib/command-center/types";
import { ok } from "./harness.mts";

const rank: Record<Severity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const base = { id: "jira-X-1", key: "X-1", title: "t", projectId: "p", clientId: "c", type: "task", status: "In Progress", createdDate: "2026-10-01", lastUpdated: "2026-11-04", blocked: false, dependencyIds: [], riskIds: [], scopeChangeCount: 0, ownerId: "me", owner: "Tay", sourceType: "jira", priority: "P3", priorityKnown: true } as unknown as WorkItem;
const data = { dependencies: [], clients: [], workItems: [] } as unknown as CommandCenterData;
const today = "2026-11-05";
const sev = (over: Partial<WorkItem>) => scoreWorkItem({ ...base, ...over }, data, today, { model: "v2" }).classification;

{
  const group = "T2 Severity calibration (v2)";
  ok(group, rank[sev({ priority: "P1", dueDate: "2026-10-30", blocked: true })] >= rank.CRITICAL, `P1 overdue 6 days AND blocked is CRITICAL (got ${sev({ priority: "P1", dueDate: "2026-10-30", blocked: true })})`);
  ok(group, rank[sev({ priority: "P1", dueDate: "2026-10-30" })] >= rank.HIGH, "P1 overdue is at least HIGH");
  ok(group, rank[sev({ priority: "P2", dueDate: "2026-11-02", lastUpdated: "2026-10-26" })] >= rank.HIGH, "P2 overdue 3 days and stale is at least HIGH");
  ok(group, rank[sev({ priority: "P1", dueDate: "2026-11-06" })] >= rank.MEDIUM, "P1 due tomorrow is at least MEDIUM");
  ok(group, rank[sev({ priority: "P1", blocked: true })] >= rank.MEDIUM, "a blocked P1 without a due date is at least MEDIUM");
  ok(group, sev({ priority: "P4" }) === "LOW", "a fresh P4 without a due date stays LOW");
  ok(group, rank[sev({ priority: "P4", dueDate: "2026-11-30" })] <= rank.LOW, "a P4 with a due date a month away stays LOW");
  ok(group, rank[sev({ priority: "P1", dueDate: "2026-10-30", blocked: true })] > rank[sev({ priority: "P4", dueDate: "2026-10-30", blocked: true })], "severity is monotonic in priority when everything else is equal");
}
