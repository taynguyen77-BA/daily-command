// V1.9 §8 — Mapping Drift Report. For each field with an explicit mapping table
// (Priority, Status, Issue Type), report every DISTINCT observed source value from a real
// (or fixture) issue sample, how many times it occurred, what it currently maps to, and
// whether that mapping came from an explicit rule or the documented fallback default.
// Pure function over already-fetched raw JiraIssue[] — reuses mapping.ts's own tables/
// patterns (via its exports) rather than re-implementing the mapping logic.

import { mapPriority, mapStatus, mapWorkItemType, BLOCKED_STATUS_PATTERN, KNOWN_STATUS_CATEGORY_KEYS, PRIORITY_MAP, REVIEW_STATUS_PATTERN } from "./mapping";
import type { JiraIssue } from "./types";
import type { MappingDriftFieldReport, MappingDriftReport, MappingDriftValue } from "../types";

function tally<T>(items: T[], keyOf: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function priorityDrift(issues: JiraIssue[]): MappingDriftFieldReport {
  const counts = tally(issues, (i) => i.fields.priority?.name ?? "(none)");
  const values: MappingDriftValue[] = Array.from(counts.entries()).map(([observedValue, occurrences]) => {
    if (observedValue === "(none)") {
      return { observedValue, occurrences, mappedTo: mapPriority(undefined), confidence: "SUPPORTED", reason: "Missing priority is a documented, expected case — defaults to P3, never P1." };
    }
    const hitExplicitRule = observedValue.toLowerCase() in PRIORITY_MAP;
    return {
      observedValue,
      occurrences,
      mappedTo: mapPriority(observedValue),
      confidence: hitExplicitRule ? "SUPPORTED" : "UNKNOWN",
      reason: hitExplicitRule ? undefined : "No explicit rule for this priority name — falling back to the documented P3 default, not a deterministic classification.",
    };
  });
  return { field: "Priority", values };
}

function statusDrift(issues: JiraIssue[]): MappingDriftFieldReport {
  const counts = tally(issues, (i) => `${i.fields.status?.name ?? "(none)"}|${i.fields.status?.statusCategory?.key ?? "(none)"}|${i.fields.flagged ? "flagged" : "not-flagged"}`);
  const values: MappingDriftValue[] = Array.from(counts.entries()).map(([key, occurrences]) => {
    const [name, categoryKey, flaggedTag] = key.split("|");
    const statusName = name === "(none)" ? undefined : name;
    const statusCategoryKey = categoryKey === "(none)" ? undefined : categoryKey;
    const flagged = flaggedTag === "flagged";
    const mappedTo = mapStatus(statusName, statusCategoryKey, flagged);
    const hitExplicitRule = flagged || (statusName && (BLOCKED_STATUS_PATTERN.test(statusName) || REVIEW_STATUS_PATTERN.test(statusName))) || (statusCategoryKey !== undefined && KNOWN_STATUS_CATEGORY_KEYS.has(statusCategoryKey));
    return {
      observedValue: statusName ?? "(none)",
      occurrences,
      mappedTo,
      confidence: hitExplicitRule ? "SUPPORTED" : "UNKNOWN",
      reason: hitExplicitRule ? undefined : "No status name pattern or recognized status category matched — falling back to 'Not Started', not a deterministic classification. No rule exists for this value yet.",
    };
  });
  return { field: "Status", values };
}

function issueTypeDrift(issues: JiraIssue[]): MappingDriftFieldReport {
  const counts = tally(issues, (i) => i.fields.issuetype?.name ?? "(none)");
  const values: MappingDriftValue[] = Array.from(counts.entries()).map(([observedValue, occurrences]) => {
    const anyIssueWithThisType = issues.find((i) => (i.fields.issuetype?.name ?? "(none)") === observedValue);
    const labels = anyIssueWithThisType?.fields.labels ?? [];
    const mappedTo = mapWorkItemType(observedValue === "(none)" ? undefined : observedValue, labels);
    const lower = observedValue.toLowerCase();
    const hitExplicitRule = lower.includes("bug") || lower.includes("epic") || lower.includes("release") || lower.includes("story") || lower.includes("task") || mappedTo === "production-issue";
    return {
      observedValue,
      occurrences,
      mappedTo,
      confidence: hitExplicitRule ? "SUPPORTED" : "UNKNOWN",
      reason: hitExplicitRule ? undefined : "Issue type name doesn't match any recognized keyword — defaulted to 'task', not a deterministic classification.",
    };
  });
  return { field: "Issue type", values };
}

export function computeMappingDrift(issues: JiraIssue[]): MappingDriftReport {
  return {
    generatedAt: new Date().toISOString(),
    sampleSize: issues.length,
    fields: [priorityDrift(issues), statusDrift(issues), issueTypeDrift(issues)],
  };
}
