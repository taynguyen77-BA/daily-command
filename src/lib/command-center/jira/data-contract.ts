// V1.8 §6 — Jira Data Contract Validation. Distinct from JIRA_FIELD_SUPPORT in
// conformance.ts (a property of this app's CODE, computed once) — this evaluates a real
// fetched issue SAMPLE and classifies what that sample actually contains, per sync.
// Pure function over already-fetched raw JiraIssue[] — no network calls, no duplicate
// fetch/normalize logic. MISSING_IN_SAMPLE is never silently upgraded to "safe"; a field
// this app never requests from Jira is UNSUPPORTED, not MISSING_IN_SAMPLE, because no
// sample size would ever change that answer.

import type { JiraIssue } from "./types";
import type { JiraDataContractFieldResult, JiraDataContractReport } from "../types";

function hasValue(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function classify(field: string, requested: boolean, present: number, total: number, note?: string): JiraDataContractFieldResult {
  if (!requested) {
    return { field, level: "UNSUPPORTED", detail: note ?? "Not requested from Jira — no field in this app's domain model consumes it." };
  }
  if (total === 0) {
    return { field, level: "MISSING_IN_SAMPLE", detail: "No issues were available in this sample to evaluate." };
  }
  if (present === total) {
    return { field, level: "SUPPORTED", detail: `Present on all ${total} sampled issue(s).` };
  }
  if (present === 0) {
    return { field, level: "MISSING_IN_SAMPLE", detail: `Not present on any of ${total} sampled issue(s) — Jira can return this field, but nothing in the current sample populated it. Absence in this sample is not the same as "confirmed unavailable".` };
  }
  return { field, level: "PARTIALLY_SUPPORTED", detail: `Present on ${present} of ${total} sampled issue(s).` };
}

/** Evaluates the 13 fields the Command Center actually depends on against a real (or
 *  fixture) sample of raw Jira issues — the same raw shape jira/normalize.ts consumes. */
export function evaluateJiraDataContract(issues: JiraIssue[]): JiraDataContractReport {
  const total = issues.length;
  const count = (pick: (i: JiraIssue) => unknown) => issues.filter((i) => hasValue(pick(i))).length;

  const fields: JiraDataContractFieldResult[] = [
    classify("Issue key", true, issues.filter((i) => hasValue(i.key)).length, total),
    classify("Summary", true, count((i) => i.fields.summary), total),
    classify("Status", true, count((i) => i.fields.status?.name), total),
    classify("Priority", true, count((i) => i.fields.priority?.name), total),
    classify("Assignee", true, count((i) => i.fields.assignee?.displayName), total),
    classify("Reporter", false, 0, total, "Not requested from Jira (not in this app's field list) and has no home in the domain model — no feature currently consumes it."),
    classify("Due date", true, count((i) => i.fields.duedate), total),
    classify("Fix version", true, count((i) => i.fields.fixVersions), total),
    classify("Labels", true, count((i) => i.fields.labels), total),
    classify("Issue type", true, count((i) => i.fields.issuetype?.name), total),
    classify("Updated timestamp", true, count((i) => i.fields.updated), total),
    classify("Issue links", true, count((i) => i.fields.issuelinks), total),
    {
      field: "Changelog / scope history",
      level: "PARTIALLY_SUPPORTED",
      detail: "By design, only a heuristically-prioritized subset (≤20 issues per sync) receives a real changelog-derived scope-change count; the rest report 0, meaning 'not checked this sync' — never presented as 'confirmed zero changes'.",
    },
  ];

  return { generatedAt: new Date().toISOString(), sampleSize: total, fields };
}
