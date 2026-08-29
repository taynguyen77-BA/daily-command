// Scope Drift from Jira changelog (V1.4 §32-33). Turns raw changelog field changes into
// labeled ScopeSignal[] — never infers actual business scope, always surfaced as
// "Scope-related Jira change detected." Only a fixed allow-list of fields counts; anything
// else in the changelog (comments, arbitrary custom fields) is ignored.

import type { JiraChangelogHistory } from "./types";
import type { ScopeSignal } from "../types";

const SCOPE_FIELDS = new Set(["priority", "assignee", "duedate", "fix version", "status", "flagged", "labels"]);

export function changelogToScopeSignals(workItemId: string, histories: JiraChangelogHistory[]): ScopeSignal[] {
  const out: ScopeSignal[] = [];
  for (const history of histories) {
    for (const item of history.items) {
      if (!item.field || !SCOPE_FIELDS.has(item.field.toLowerCase())) continue;
      out.push({
        workItemId,
        field: item.field,
        before: item.fromString ?? "(none)",
        after: item.toString ?? "(none)",
        detectedAt: history.created ? history.created.slice(0, 10) : "",
      });
    }
  }
  return out;
}

/**
 * Selects which issues are worth a changelog fetch (§32 "do NOT retrieve changelogs for
 * every issue"): P1/P2 items, items already blocked, and items on the nearest upcoming
 * due date — capped so a large sync never fans out into dozens of extra requests.
 */
export function selectPrioritizedIssueKeys(items: { key: string; priority: string; blocked: boolean; dueDate?: string; fixVersion?: string }[], cap = 20): string[] {
  const scored = items.map((item) => {
    let score = 0;
    if (item.priority === "P1") score += 3;
    else if (item.priority === "P2") score += 2;
    if (item.blocked) score += 2;
    if (item.fixVersion) score += 1;
    if (item.dueDate) score += 1;
    return { key: item.key, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)
    .map((s) => s.key);
}
