// Release Health (BUILD REQUEST V1.3 §19-20). Groups by Jira Fix Version — the only
// "release" grouping V1.3 introduces (see WorkItem.fixVersion). Deliberately not a Jira
// release-management clone: no versions CRUD, no burndown, just a rollup of numbers the
// deterministic engines already compute, plus a documented readiness threshold.
//
// READINESS THRESHOLDS (deterministic, documented — Claude may explain but never override):
//   READY:     completion >= 90% AND 0 blocked AND 0 overdue AND 0 unresolved dependencies
//   NOT_READY: completion < 50% OR 3+ blocked OR 3+ overdue
//   AT_RISK:   everything in between

//
// B5 — RELEASE TRUTH, one number everywhere. Every surface (Release Health panel, Ask,
// CommandBar's release-update draft, the artifact rebuild, release drift, proactive engines)
// goes through selectReleaseHealth below, so the same fixVersion shows the same % everywhere:
//   - done      = Jira native Done or Work-Relevance COMPLETED — nothing else. Daily Command
//                 personal completion is a fact about MY part, never about the release, so it
//                 is never counted (it used to inflate completion on surfaces that passed it).
//   - excluded  = Work-Relevance EXCLUDED (and not Done) → out of the denominator entirely.
//   - membership = every fix version an item carries (WorkItem.fixVersions), not only the first.

import { computeDeliveryConfidence } from "./executive";
import { detectRisks, RISK_LEVEL_ORDER } from "./risk-detection";
import { isOverdue, scoreAllWorkItems } from "./scoring";
import { isWorkItemDoneOrExcluded, type WorkRelevanceIndex } from "./jira/work-relevance";
import { isWorkItemFinishedInJira } from "./task-execution";
import type { CommandCenterData, ReleaseHealth, ReleaseItemRef, ReleaseReadiness, WorkItem } from "./types";

function classifyReadiness(completionPct: number, blockedCount: number, overdueCount: number, unresolvedDependenciesCount: number): ReleaseReadiness {
  if (completionPct >= 90 && blockedCount === 0 && overdueCount === 0 && unresolvedDependenciesCount === 0) return "READY";
  if (completionPct < 50 || blockedCount >= 3 || overdueCount >= 3) return "NOT_READY";
  return "AT_RISK";
}

/** Every fix version the item belongs to. */
export function releaseVersionsOf(w: Pick<WorkItem, "fixVersion" | "fixVersions">): string[] {
  if (w.fixVersions && w.fixVersions.length > 0) return w.fixVersions;
  return w.fixVersion ? [w.fixVersion] : [];
}

export function isInRelease(w: Pick<WorkItem, "fixVersion" | "fixVersions">, fixVersion: string): boolean {
  return releaseVersionsOf(w).includes(fixVersion);
}

function itemRef(w: WorkItem): ReleaseItemRef {
  return {
    key: w.key,
    title: w.title,
    status: w.jiraStatusName ?? w.status,
    ...(w.sourceUrl ? { url: w.sourceUrl } : {}),
    ...(w.owner ? { assignee: w.owner } : {}),
    ...(w.dueDate ? { dueDate: w.dueDate } : {}),
    ...(w.blockerReason ? { blockerReason: w.blockerReason } : {}),
  };
}

/** B5 — THE release selector. Every caller passes the same Work Relevance index it uses
 *  everywhere else (omitted = native Jira Done only, nothing excluded). */
export function selectReleaseHealth(data: CommandCenterData, fixVersion: string, today: string, workRelevanceIndex?: WorkRelevanceIndex): ReleaseHealth {
  const all = data.workItems.filter((w) => isInRelease(w, fixVersion));
  const isDone = (w: WorkItem) => isWorkItemFinishedInJira(w, workRelevanceIndex);
  const isExcluded = (w: WorkItem) => !isDone(w) && isWorkItemDoneOrExcluded(w, workRelevanceIndex);
  const items = all.filter((w) => !isExcluded(w));
  const itemIds = new Set(items.map((w) => w.id));
  const open = items.filter((w) => !isDone(w));
  const completedItems = items.length - open.length;
  const completionPct = items.length > 0 ? Math.round((completedItems / items.length) * 100) : 0;
  const blockers = open.filter((w) => w.blocked);
  const overdue = items.filter((w) => isOverdue(w, today, workRelevanceIndex));
  const unresolvedDependenciesCount = data.dependencies.filter((d) => itemIds.has(d.workItemId) && d.status === "unresolved").length;
  const highPriorityIncompleteCount = open.filter((w) => w.priority === "P1" || w.priority === "P2").length;
  const withUat = items.filter((w) => w.uatCompletionPct !== undefined);
  const avgUatCompletionPct = withUat.length > 0 ? Math.round(withUat.reduce((s, w) => s + (w.uatCompletionPct ?? 0), 0) / withUat.length) : undefined;

  const releaseData = { ...data, workItems: items };
  const scores = scoreAllWorkItems(releaseData, today, workRelevanceIndex);
  const releaseRisks = [...data.risks.filter((r) => r.sourceWorkItemIds.some((id) => itemIds.has(id))), ...detectRisks(releaseData, today, workRelevanceIndex)]
    .filter((r) => r.status === "open")
    .sort((a, b) => RISK_LEVEL_ORDER[a.level] - RISK_LEVEL_ORDER[b.level]);
  const deliveryConfidence = computeDeliveryConfidence(scores, releaseRisks, overdue.length);

  const byStatus = new Map<string, ReleaseItemRef[]>();
  for (const w of open) {
    const ref = itemRef(w);
    byStatus.set(ref.status, [...(byStatus.get(ref.status) ?? []), ref]);
  }

  return {
    fixVersion,
    totalItems: items.length,
    completedItems,
    completionPct,
    blockedCount: blockers.length,
    overdueCount: overdue.length,
    unresolvedDependenciesCount,
    highPriorityIncompleteCount,
    avgUatCompletionPct,
    deliveryConfidence,
    readiness: classifyReadiness(completionPct, blockers.length, overdue.length, unresolvedDependenciesCount),
    topRiskTitle: releaseRisks[0]?.title,
    excludedItems: all.length - items.length,
    remainingByStatus: Array.from(byStatus.entries())
      .map(([status, refs]) => ({ status, items: refs.sort((a, b) => a.key.localeCompare(b.key)) }))
      .sort((a, b) => b.items.length - a.items.length || a.status.localeCompare(b.status)),
    blockers: blockers.map(itemRef),
    overdue: overdue.map(itemRef),
  };
}

export function selectAllReleaseHealth(data: CommandCenterData, today: string, workRelevanceIndex?: WorkRelevanceIndex): ReleaseHealth[] {
  const versions = Array.from(new Set(data.workItems.flatMap(releaseVersionsOf)));
  return versions.map((v) => selectReleaseHealth(data, v, today, workRelevanceIndex)).sort((a, b) => a.deliveryConfidence - b.deliveryConfidence);
}

/** Pre-B5 name, kept for compatibility. Delegates to selectReleaseHealth;
 *  `_dailyCommandCompletedWorkItemIds` is accepted but deliberately IGNORED — personal
 *  completion never counts toward a release (see this file's top comment). */
export function computeReleaseHealth(
  data: CommandCenterData,
  fixVersion: string,
  today: string,
  workRelevanceIndex?: WorkRelevanceIndex,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _dailyCommandCompletedWorkItemIds?: ReadonlySet<string>
): ReleaseHealth {
  return selectReleaseHealth(data, fixVersion, today, workRelevanceIndex);
}

/** Pre-B5 name, kept for compatibility — see computeReleaseHealth. */
export function computeAllReleaseHealth(
  data: CommandCenterData,
  today: string,
  workRelevanceIndex?: WorkRelevanceIndex,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _dailyCommandCompletedWorkItemIds?: ReadonlySet<string>
): ReleaseHealth[] {
  return selectAllReleaseHealth(data, today, workRelevanceIndex);
}

// ===== Release update export (Markdown + Slack) =========================================

function refLine(r: ReleaseItemRef, format: "markdown" | "slack"): string {
  const esc = (t: string) => (format === "slack" ? t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : t.replace(/([\\[\]*_`])/g, "\\$1"));
  const key = r.url ? (format === "slack" ? `<${r.url}|${r.key}>` : `[${r.key}](${r.url})`) : format === "slack" ? `*${r.key}*` : `**${r.key}**`;
  const extra = [r.assignee ? esc(r.assignee) : "unassigned", r.dueDate ? `due ${r.dueDate}` : "", r.blockerReason ? esc(r.blockerReason) : ""].filter(Boolean).join(" · ");
  return `${key} ${esc(r.title)} — ${extra}`;
}

/** B5 — release update, Markdown or Slack mrkdwn. `drift` (release-drift.ts) adds scope
 *  added/removed since the previous snapshot when available. */
export function renderReleaseUpdate(release: ReleaseHealth, format: "markdown" | "slack", drift?: { scopeAdded?: string[]; scopeRemoved?: string[] }): string {
  const h1 = (t: string) => (format === "slack" ? `*${t}*` : `# ${t}`);
  const h2 = (t: string) => (format === "slack" ? `*${t}*` : `## ${t}`);
  const b = format === "slack" ? "•" : "-";
  const lines: string[] = [h1(`Release update — ${release.fixVersion}`), ""];
  lines.push(
    `${b} Completion: ${release.completionPct}% (${release.completedItems}/${release.totalItems} done in Jira)${release.excludedItems ? ` · ${release.excludedItems} excluded from scope` : ""}`,
    `${b} Readiness: ${release.readiness.replace(/_/g, " ")} · Confidence ${release.deliveryConfidence}/100`,
    `${b} Blocked: ${release.blockedCount} · Overdue: ${release.overdueCount} · Open dependencies: ${release.unresolvedDependenciesCount}`,
    ""
  );
  const remaining = release.remainingByStatus ?? [];
  lines.push(h2(`Remaining (${remaining.reduce((n, g) => n + g.items.length, 0)})`));
  if (remaining.length === 0) lines.push(`${b} Nothing open.`);
  for (const g of remaining) {
    lines.push(format === "slack" ? `_${g.status} (${g.items.length})_` : `**${g.status} (${g.items.length})**`);
    lines.push(...g.items.map((r) => `${b} ${refLine(r, format)}`));
  }
  lines.push("");
  lines.push(h2(`Blockers (${release.blockers?.length ?? 0})`), ...((release.blockers ?? []).length === 0 ? [`${b} None.`] : release.blockers!.map((r) => `${b} ${refLine(r, format)}`)), "");
  lines.push(h2(`Overdue (${release.overdue?.length ?? 0})`), ...((release.overdue ?? []).length === 0 ? [`${b} None.`] : release.overdue!.map((r) => `${b} ${refLine(r, format)}`)), "");
  if (drift && ((drift.scopeAdded?.length ?? 0) > 0 || (drift.scopeRemoved?.length ?? 0) > 0)) {
    lines.push(h2("Scope change since last snapshot"));
    if (drift.scopeAdded?.length) lines.push(`${b} Added: ${drift.scopeAdded.join(", ")}`);
    if (drift.scopeRemoved?.length) lines.push(`${b} Removed: ${drift.scopeRemoved.join(", ")}`);
    lines.push("");
  }
  while (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
