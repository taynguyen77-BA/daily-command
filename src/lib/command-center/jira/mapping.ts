// Explicit Jira field-mapping tables (BUILD REQUEST V1.3 §7: "typed, testable, documented,
// isolated from UI components"). Nothing outside this module should know Jira's own field
// names or value vocabularies — normalize.ts is the only caller.

import type { WorkItemStatus, WorkItemType } from "../types";

/** Jira's default priority names → this app's P1-P4. An instance with custom priority
 *  names falls through to the default case (documented below) rather than throwing.
 *  V1.9 §8 — exported (read-only reference) so jira/mapping-drift.ts can report which
 *  observed values hit an explicit rule vs. the documented fallback, without duplicating
 *  this table. */
export const PRIORITY_MAP: Record<string, "P1" | "P2" | "P3" | "P4"> = {
  highest: "P1",
  blocker: "P1",
  critical: "P1",
  high: "P2",
  medium: "P3",
  low: "P4",
  lowest: "P4",
  minor: "P4",
  trivial: "P4",
};

export function mapPriority(jiraPriorityName: string | undefined): "P1" | "P2" | "P3" | "P4" {
  if (!jiraPriorityName) return "P3"; // undocumented/missing priority — neutral default, never "P1"
  return PRIORITY_MAP[jiraPriorityName.toLowerCase()] ?? "P3";
}

/** Jira status names that indicate "blocked" regardless of status category — this is a
 *  heuristic (Jira has no universal "blocked" status), documented and testable. */
// V1.9 §8 — exported so jira/mapping-drift.ts can determine which observed status values
// hit an explicit rule vs. the final unrecognized-category fallback, without duplicating it.
export const BLOCKED_STATUS_PATTERN = /block/i;
export const REVIEW_STATUS_PATTERN = /review/i;
export const KNOWN_STATUS_CATEGORY_KEYS = new Set(["done", "indeterminate", "new"]);

export function mapStatus(statusName: string | undefined, statusCategoryKey: string | undefined, flagged: boolean): WorkItemStatus {
  if (flagged) return "Blocked";
  if (statusName && BLOCKED_STATUS_PATTERN.test(statusName)) return "Blocked";
  if (statusCategoryKey === "done") return "Done";
  if (statusName && REVIEW_STATUS_PATTERN.test(statusName)) return "In Review";
  if (statusCategoryKey === "indeterminate") return "In Progress";
  if (statusCategoryKey === "new") return "Not Started";
  return "Not Started"; // unknown/custom category — safe, non-alarming default
}

/** Jira issue type names → this app's WorkItemType. Labels can refine the guess (e.g. a
 *  "production" label on a Bug becomes a production-issue) but are never the sole signal
 *  for anything scoring-relevant like business impact (§17). */
export function mapWorkItemType(issueTypeName: string | undefined, labels: string[]): WorkItemType {
  const lowerLabels = labels.map((l) => l.toLowerCase());
  if (lowerLabels.some((l) => l.includes("production") || l.includes("prod-issue") || l.includes("incident"))) return "production-issue";
  const t = (issueTypeName ?? "").toLowerCase();
  if (t.includes("bug")) return "bug";
  if (t.includes("epic") || t.includes("release")) return "release";
  if (t.includes("story")) return "story";
  return "task";
}

export function isBlockedByHeuristic(statusName: string | undefined, flagged: boolean): boolean {
  return flagged || Boolean(statusName && BLOCKED_STATUS_PATTERN.test(statusName));
}
