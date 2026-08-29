// Personal Plan reconciliation, carry-forward, and daily-plan suggestion (V1.6 §11-15,
// §33, §49-52). Fully deterministic. `personal-focus.ts` computes what SHOULD be focused
// on right now; this module reconciles that live truth against the human's persisted plan
// (PersonalPlanItem[]) — never silently rewriting user-confirmed ordering (§15, §34).

import type { CommandCenterData, PersonalFocusCandidate, PersonalPlanItem, PlanReconciliationEntry, CarryForwardSuggestion } from "./types";

const ACTIVE_STATUSES = new Set(["planned", "in-progress", "blocked"]);
const UNFINISHED_STATUSES = new Set(["planned", "in-progress"]);

function candidateFor(item: PersonalPlanItem, candidates: PersonalFocusCandidate[]): PersonalFocusCandidate | undefined {
  return candidates.find((c) => c.sourceType === item.sourceType && c.sourceId === item.sourceId);
}

/** V1.7 §23 — wraps what would otherwise be a REMOVE for a pinned item into a REVIEW that
 *  requires an explicit human choice ([REMOVE]/[KEEP ANYWAY]) instead of silent/bulk removal. */
function pinAware(item: PersonalPlanItem, reason: string): PlanReconciliationEntry {
  if (item.pinned) return { planItemId: item.id, action: "REVIEW", reason: `PINNED ITEM NEEDS REVIEW — ${reason}`, pinnedNeedsReview: true };
  return { planItemId: item.id, action: "REMOVE", reason };
}

/** V1.7 §22 — beyond source deletion: detects "became blocked", "became urgent" (a new
 *  DO_NOW that wasn't when planned), "ownership changed away from the user", and "changed
 *  project" by diffing the live candidate against the snapshot taken when the item was
 *  added. Pre-V1.7 plan items have no snapshot — they simply skip this finer-grained check
 *  and fall back to KEEP, which is strictly safe (never worse than V1.6's behavior). */
function reviewReasonFromSnapshot(item: PersonalPlanItem, live: PersonalFocusCandidate): string | null {
  const snap = item.snapshot;
  if (!snap) return null;
  if (live.category === "BLOCKED" && snap.category !== "BLOCKED") return "This item is now blocked and cannot progress.";
  if (live.category === "DO_NOW" && snap.category !== "DO_NOW") return "This item has become urgent since it was planned.";
  if (snap.ownershipExplicit && !live.ownershipExplicit) return "This item is no longer explicitly owned by you.";
  if (snap.projectId && live.projectId && snap.projectId !== live.projectId) return `This item moved from ${snap.projectId} to ${live.projectId}.`;
  return null;
}

/** §50 — KEEP / UPDATE / REMOVE / REVIEW per persisted (non-terminal) plan item. When a
 *  plan item's live candidate has disappeared, the underlying data is inspected directly
 *  (not guessed) to tell "resolved" apart from "just no longer flagged". */
export function reconcilePersonalPlan(planItems: PersonalPlanItem[], candidates: PersonalFocusCandidate[], data: CommandCenterData, today: string): PlanReconciliationEntry[] {
  const entries: PlanReconciliationEntry[] = [];

  for (const item of planItems) {
    if (!ACTIVE_STATUSES.has(item.status)) continue; // completed/skipped/deferred are historical — never reconciled
    const live = candidateFor(item, candidates);

    if (live) {
      const reviewReason = item.status === "planned" ? reviewReasonFromSnapshot(item, live) : null;
      entries.push(reviewReason ? { planItemId: item.id, action: "REVIEW", reason: reviewReason } : { planItemId: item.id, action: "KEEP", reason: "Still relevant — no meaningful change." });
      continue;
    }

    if (item.sourceType === "attention") {
      entries.push(pinAware(item, "The underlying attention item has been resolved."));
      continue;
    }

    // sourceType === "loop" — resolve by checking the underlying decision directly.
    const decision = data.decisions.find((d) => d.id === item.sourceId);
    if (!decision) {
      entries.push(pinAware(item, "The underlying decision no longer exists."));
    } else if (decision.status === "SUPERSEDED") {
      entries.push(pinAware(item, "The decision was superseded."));
    } else if (decision.outcomeStatus) {
      entries.push(pinAware(item, "The decision's outcome has already been recorded."));
    } else {
      const relatedActions = data.actions.filter((a) => a.relatedDecisionId === decision.id || (decision.relatedActionIds ?? []).includes(a.id));
      const anyCompleted = relatedActions.some((a) => a.status === "completed");
      if (anyCompleted) {
        entries.push(pinAware(item, "The related action was completed."));
      } else {
        entries.push({ planItemId: item.id, action: "KEEP", reason: "The decision loop is still open." });
      }
    }
  }

  void today;
  return entries;
}

/** §15 — "PLAN UPDATED" trigger: a DO_NOW-worthy candidate that isn't in today's plan yet
 *  at all (any status), for any planned date. Additive-only detection — never removes. */
export function detectNewCriticalArrivals(candidates: PersonalFocusCandidate[], planItems: PersonalPlanItem[]): PersonalFocusCandidate[] {
  const known = new Set(planItems.map((p) => `${p.sourceType}:${p.sourceId}`));
  return candidates.filter((c) => c.category === "DO_NOW" && !known.has(`${c.sourceType}:${c.sourceId}`));
}

/** §51-52 — only unfinished, still-relevant items from a previous day carry forward, and
 *  only as a suggestion the user explicitly accepts (§51 "user gets a suggested carry-
 *  forward list", never an automatic copy). */
export function buildCarryForward(planItems: PersonalPlanItem[], candidates: PersonalFocusCandidate[], today: string): CarryForwardSuggestion[] {
  const out: CarryForwardSuggestion[] = [];
  const alreadyToday = new Set(planItems.filter((p) => p.plannedDate === today).map((p) => `${p.sourceType}:${p.sourceId}`));

  for (const item of planItems) {
    if (item.plannedDate >= today) continue;
    if (!UNFINISHED_STATUSES.has(item.status)) continue;
    if (alreadyToday.has(`${item.sourceType}:${item.sourceId}`)) continue;
    const live = candidateFor(item, candidates);
    if (!live) continue; // not still relevant/unresolved — don't suggest it
    if (live.category === "DEFER") continue; // no longer important enough to carry forward
    out.push({ planItem: item, candidate: live, reason: `Unfinished since ${item.plannedDate} and still relevant.` });
  }
  return out;
}

/** §33 — deterministic suggested plan for a fresh day: DO_NOW first, then DO_TODAY, capped
 *  so the suggestion stays focused rather than dumping the whole backlog. */
export function buildSuggestedDailyPlan(candidates: PersonalFocusCandidate[], maxItems = 7): PersonalFocusCandidate[] {
  const prioritized = candidates.filter((c) => c.category === "DO_NOW" || c.category === "DO_TODAY");
  return prioritized.slice(0, maxItems);
}
