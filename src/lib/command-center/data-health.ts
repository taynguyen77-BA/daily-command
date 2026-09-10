// V1.7 §30-31 — Data Health. Explicit, separately-labeled dimensions — never a single
// blended score (§31 "do NOT produce Data quality = 82/100"). Pure arithmetic over the
// existing domain model; reuses freshness.ts rather than recomputing anything.
//
// V1.8 §7 — each dimension also gets an actionable remediation entry (WHAT / WHY IT
// MATTERS / WHAT TO DO) when it isn't fully healthy. `affectedItemIds` always points at
// real WorkItem ids already in the domain model — never invented work.

import { computeFreshness } from "./freshness";
import { countUnclassifiedJiraStatuses, isWorkItemOperationallyOpen, type WorkRelevanceIndex } from "./jira/work-relevance";
import type { CommandCenterData, DataHealth, DataHealthRemediationItem, DataSourceType, WorkItem } from "./types";

function pct(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 100);
}

function idsOf(items: WorkItem[]): string[] {
  return items.map((w) => w.id);
}

/** V2.22 §13 (bug fix) — `dailyCommandCompletedWorkItemIds` is an additive/optional trailing
 *  parameter, and `openItems` now uses the canonical isWorkItemOperationallyOpen gate
 *  (already threaded through `workRelevanceIndex`, which this function already accepted but
 *  previously only used for `unclassifiedJiraStatusCount`) instead of raw `status !== "Done"`.
 *  Confirmed real defect: a Work-Relevance-COMPLETED or Daily-Command-completed item with no
 *  owner/due date/fix version was still counted against Ownership/Due-date/Release coverage
 *  and surfaced a "review ownership for these items" remediation nudge for tickets the user
 *  already considers finished — directly undermining trust in this exact panel. Omitting
 *  either parameter reproduces the pre-V2.22 behavior exactly. */
export function computeDataHealth(
  data: CommandCenterData,
  sourceType: DataSourceType,
  lastSyncedAtIso: string | undefined,
  nowMs?: number,
  workRelevanceIndex?: WorkRelevanceIndex,
  dailyCommandCompletedWorkItemIds?: ReadonlySet<string>
): DataHealth {
  const openItems = data.workItems.filter((w) => isWorkItemOperationallyOpen(w, workRelevanceIndex, dailyCommandCompletedWorkItemIds));
  const totalWorkItems = openItems.length;

  const missingOwner = openItems.filter((w) => !w.owner);
  const missingDueDate = openItems.filter((w) => !w.dueDate);
  const missingRelease = openItems.filter((w) => !w.fixVersion);

  const ownershipCoveragePct = pct(openItems.filter((w) => !!w.owner).length, totalWorkItems);
  const dueDateCoveragePct = pct(openItems.filter((w) => !!w.dueDate).length, totalWorkItems);
  const releaseCoveragePct = pct(openItems.filter((w) => !!w.fixVersion).length, totalWorkItems);

  // scopeChangeCount is only ever non-zero for the ~20 issues Jira sync prioritizes for a
  // changelog fetch (see jira/scope-drift.ts) — so "full" only applies to non-Jira sources
  // where every item's count is directly authored/imported, never partially sampled.
  const withScopeSignal = openItems.filter((w) => w.scopeChangeCount > 0).length;
  const scopeHistoryCoverage: DataHealth["scopeHistoryCoverage"] = sourceType !== "jira" ? "full" : withScopeSignal === 0 ? "none" : "partial";
  const withoutScopeSignal = openItems.filter((w) => w.scopeChangeCount === 0);

  const freshness = computeFreshness(lastSyncedAtIso, nowMs);

  const remediation: DataHealthRemediationItem[] = [];

  if (totalWorkItems > 0 && ownershipCoveragePct < 100) {
    remediation.push({
      dimension: "Ownership coverage",
      what: `Ownership coverage is ${ownershipCoveragePct}%. ${missingOwner.length} item(s) have no explicit owner.`,
      whyItMatters: "This can reduce confidence in Personal Focus (an unowned item can never reach DO_NOW) and Stakeholder Attention (unowned items can't be routed to a person).",
      whatToDo: `Review ownership for ${missingOwner.length} item(s): ${missingOwner.slice(0, 5).map((w) => w.key).join(", ")}${missingOwner.length > 5 ? ", …" : ""}.`,
      affectedItemIds: idsOf(missingOwner),
    });
  }
  if (totalWorkItems > 0 && dueDateCoveragePct < 100) {
    remediation.push({
      dimension: "Due date coverage",
      what: `Due date coverage is ${dueDateCoveragePct}%. ${missingDueDate.length} item(s) have no due date.`,
      whyItMatters: "Items without a due date are invisible to deadline-conflict detection and can't contribute to release-readiness overdue counts — they may be silently deprioritized.",
      whatToDo: `Review due dates for ${missingDueDate.length} item(s): ${missingDueDate.slice(0, 5).map((w) => w.key).join(", ")}${missingDueDate.length > 5 ? ", …" : ""}.`,
      affectedItemIds: idsOf(missingDueDate),
    });
  }
  if (totalWorkItems > 0 && releaseCoveragePct < 100) {
    remediation.push({
      dimension: "Release mapping coverage",
      what: `Release mapping coverage is ${releaseCoveragePct}%. ${missingRelease.length} item(s) have no fix version.`,
      whyItMatters: "Items without a fix version are excluded from Release Health and Delivery Drift rollups for any release — they don't count toward or against readiness.",
      whatToDo: `Assign a fix version to ${missingRelease.length} item(s): ${missingRelease.slice(0, 5).map((w) => w.key).join(", ")}${missingRelease.length > 5 ? ", …" : ""}.`,
      affectedItemIds: idsOf(missingRelease),
    });
  }
  if (sourceType === "jira" && scopeHistoryCoverage !== "full" && withoutScopeSignal.length > 0) {
    remediation.push({
      dimension: "Scope history coverage",
      what: `Scope history is ${scopeHistoryCoverage}. ${withoutScopeSignal.length} item(s) report 0 scope changes, which may mean "not checked this sync" rather than "confirmed unchanged".`,
      whyItMatters: "This affects how much weight Delivery Drift and Decision Radar can place on scope-change signals for those specific items.",
      whatToDo: "This is a by-design sampling limitation (only a prioritized subset gets a real changelog check each sync) — re-run a full sync to refresh which items are prioritized, not something to fix per-item.",
      affectedItemIds: idsOf(withoutScopeSignal),
    });
  }
  // V2.5 §19 — its own dimension, never blended into any other score or into Delivery
  // Confidence. Only meaningful when a Work Relevance Policy index was actually supplied
  // (data-health.ts is also called from contexts with no Jira concept at all).
  const unclassifiedJiraStatusCount = workRelevanceIndex ? countUnclassifiedJiraStatuses(data, workRelevanceIndex) : undefined;
  if (sourceType === "jira" && unclassifiedJiraStatusCount !== undefined && unclassifiedJiraStatusCount > 0) {
    remediation.push({
      dimension: "Unclassified Jira statuses",
      what: `${unclassifiedJiraStatusCount} Jira status(es) observed in your data have not been classified under the Work Relevance Policy.`,
      whyItMatters: "Daily Command Center excludes unclassified statuses from actionable work surfaces (Personal Focus, Next Actions, First 30 Minutes) until they're classified — this is intentional, not a bug.",
      whatToDo: "Review Jira Work Relevance Policy in Data & Settings and classify each status as ACTIONABLE, WAITING, OBSERVE, COMPLETED, or EXCLUDED.",
      affectedItemIds: [],
    });
  }
  if (freshness === "stale" || freshness === "aging") {
    remediation.push({
      dimension: "Freshness",
      what: `Data is ${freshness}${lastSyncedAtIso ? ` (last synced ${lastSyncedAtIso})` : ""}.`,
      whyItMatters: "Conclusions drawn from this data may be outdated — this affects DATA FRESHNESS, not the underlying deterministic delivery score itself.",
      whatToDo: "Run a Jira sync (or refresh the active data source) from Data & Settings.",
      affectedItemIds: [],
    });
  }

  return {
    freshness,
    sourceType,
    ownershipCoveragePct,
    dueDateCoveragePct,
    releaseCoveragePct,
    scopeHistoryCoverage,
    totalWorkItems,
    remediation,
    unclassifiedJiraStatusCount,
  };
}
