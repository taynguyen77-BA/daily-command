// V1.9 §7 — Real Data Shape Discovery. Classifies what a fetched issue sample's field
// VALUES actually look like, before any mapping decision is changed. Never changes a
// mapping itself (§7 "Do NOT immediately change mappings") — this only produces evidence
// for a human (or a later, separately-reviewed change) to act on. Reuses normalize.ts and
// mapping.ts rather than re-implementing any classification logic.

import { normalizeIssue } from "./normalize";
import { BLOCKED_STATUS_PATTERN, KNOWN_STATUS_CATEGORY_KEYS, PRIORITY_MAP, REVIEW_STATUS_PATTERN } from "./mapping";
import type { JiraIssue } from "./types";
import type { ShapeDiscoveryReport, ShapeObservation } from "../types";

function bump(map: Map<string, ShapeObservation>, obs: ShapeObservation) {
  const key = `${obs.field}::${obs.observedValue}`;
  const existing = map.get(key);
  if (existing) existing.occurrences += 1;
  else map.set(key, { ...obs });
}

function classifyPriority(issue: JiraIssue, out: Map<string, ShapeObservation>) {
  const name = issue.fields.priority?.name;
  if (!name) {
    bump(out, { field: "Priority", observedValue: "(missing)", occurrences: 1, category: "EXPECTED", detail: "Missing priority — a well-documented, safely-handled case (defaults to P3)." });
    return;
  }
  if (name.toLowerCase() in PRIORITY_MAP) {
    bump(out, { field: "Priority", observedValue: name, occurrences: 1, category: "EXPECTED", detail: "Matches an explicit priority-mapping rule." });
  } else {
    bump(out, { field: "Priority", observedValue: name, occurrences: 1, category: "NEW_VARIATION", detail: "Not in the current priority table — safely defaults to P3 (never P1), but this is a value the mapping hasn't catalogued yet." });
  }
}

function classifyStatus(issue: JiraIssue, out: Map<string, ShapeObservation>) {
  const name = issue.fields.status?.name;
  const categoryKey = issue.fields.status?.statusCategory?.key;
  const flagged = issue.fields.flagged === true;
  const label = `${name ?? "(missing)"} [category: ${categoryKey ?? "(missing)"}]${flagged ? " [flagged]" : ""}`;
  if (flagged || (name && BLOCKED_STATUS_PATTERN.test(name)) || (name && REVIEW_STATUS_PATTERN.test(name))) {
    bump(out, { field: "Status", observedValue: label, occurrences: 1, category: "EXPECTED", detail: "Matched an explicit name-based rule (blocked/review/flagged)." });
    return;
  }
  if (categoryKey && KNOWN_STATUS_CATEGORY_KEYS.has(categoryKey)) {
    bump(out, { field: "Status", observedValue: label, occurrences: 1, category: "EXPECTED", detail: "Recognized status category." });
    return;
  }
  if (!categoryKey) {
    bump(out, { field: "Status", observedValue: label, occurrences: 1, category: "AMBIGUOUS", detail: "No status category present at all and no name-based rule matched — nothing to disambiguate from besides the safe 'Not Started' default." });
    return;
  }
  bump(out, { field: "Status", observedValue: label, occurrences: 1, category: "NEW_VARIATION", detail: `Status category "${categoryKey}" is not one this app's mapping table has catalogued — falls back safely to 'Not Started', but worth reviewing.` });
}

function classifyIssueLinks(issue: JiraIssue, out: Map<string, ShapeObservation>) {
  for (const link of issue.fields.issuelinks ?? []) {
    const typeName = link.type?.name;
    if (!typeName) {
      bump(out, { field: "Issue link", observedValue: "(missing link type)", occurrences: 1, category: "AMBIGUOUS", detail: "A link with no type name present — cannot classify." });
      continue;
    }
    const isBlocksFamily = /block/i.test(typeName);
    if (isBlocksFamily && link.inwardIssue) {
      bump(out, { field: "Issue link", observedValue: typeName, occurrences: 1, category: "EXPECTED", detail: "A 'blocks'-family link with the inward (blocked-by) side present — fully modeled as a Dependency." });
    } else if (isBlocksFamily && !link.inwardIssue) {
      bump(out, { field: "Issue link", observedValue: `${typeName} (outward only)`, occurrences: 1, category: "UNSUPPORTED", detail: "This issue BLOCKS another (outward direction) — only the inward 'is blocked by' direction is modeled as a Dependency today." });
    } else {
      bump(out, { field: "Issue link", observedValue: typeName, occurrences: 1, category: "UNSUPPORTED", detail: "A non-'blocks' link type — not modeled as a Dependency (only blocking relationships are)." });
    }
  }
}

function classifyFixVersions(issue: JiraIssue, out: Map<string, ShapeObservation>) {
  const count = issue.fields.fixVersions?.length ?? 0;
  if (count <= 1) {
    bump(out, { field: "Fix versions", observedValue: `${count} fix version(s)`, occurrences: 1, category: "EXPECTED", detail: count === 0 ? "No fix version — expected, unreleased/unplanned work." : "Exactly one fix version — the fully-supported case." });
  } else {
    bump(out, { field: "Fix versions", observedValue: `${count} fix version(s)`, occurrences: 1, category: "NEW_VARIATION", detail: "More than one fix version on this issue — only the FIRST is currently kept (jira/normalize.ts); the rest are silently dropped. Worth reviewing if this is common in the real dataset." });
  }
}

function classifyAssignee(issue: JiraIssue, out: Map<string, ShapeObservation>) {
  const hasAssignee = !!issue.fields.assignee?.displayName;
  bump(out, {
    field: "Assignee",
    observedValue: hasAssignee ? "present" : "(unassigned)",
    occurrences: 1,
    category: "EXPECTED",
    detail: hasAssignee ? "Explicit owner present." : "Unassigned — a well-documented, safely-handled case (never guessed).",
  });
}

/** Runs the classifiers above across a sample, plus a structural BUG check (does
 *  normalizeIssue throw on this exact issue?). Never mutates any mapping decision. */
export function discoverJiraDataShape(issues: JiraIssue[]): ShapeDiscoveryReport {
  const out = new Map<string, ShapeObservation>();

  for (const issue of issues) {
    classifyPriority(issue, out);
    classifyStatus(issue, out);
    classifyIssueLinks(issue, out);
    classifyFixVersions(issue, out);
    classifyAssignee(issue, out);
    try {
      normalizeIssue(issue, { today: new Date().toISOString().slice(0, 10) });
    } catch (err) {
      bump(out, { field: "Normalization", observedValue: issue.key ?? "(unknown key)", occurrences: 1, category: "BUG", detail: err instanceof Error ? `normalizeIssue threw: ${err.message}` : "normalizeIssue threw an unknown error." });
    }
  }

  return { generatedAt: new Date().toISOString(), sampleSize: issues.length, observations: Array.from(out.values()) };
}
