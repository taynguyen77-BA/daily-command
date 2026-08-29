// Deadline Conflict Detection (V1.7 §20-21). Completes the V1.6 Focus Overload limitation
// (documented as a known gap in the V1.6 report). Fully deterministic — no AI, no new
// scoring engine (§38); reads only explicit due/review dates already threaded onto
// PersonalFocusCandidate by personal-focus.ts. Never invents a due date (§20) — when none
// are available, returns insufficientEvidence rather than guessing at a conflict.

import { daysBetween } from "./scoring";
import type { DeadlineConflict, PersonalFocusCandidate } from "./types";

const WINDOW_HOURS = 24;

/**
 * `today` is the ISO date the rest of the app already uses as "now" for day-granularity
 * comparisons; `availableBudgetMinutes` is the same 30-minute planning budget used
 * elsewhere (personal-focus.ts's thirty-minute plan) unless the caller has a different
 * real budget in mind (e.g. a user-set daily budget).
 */
export function detectDeadlineConflict(candidates: PersonalFocusCandidate[], today: string, availableBudgetMinutes = 30): DeadlineConflict | null {
  const actionable = candidates.filter((c) => c.category !== "DEFER" && c.category !== "BLOCKED" && c.category !== "DONE");
  const withDueDate = actionable.filter((c) => !!c.dueDate);

  // §20 — no explicit due dates recorded on any actionable item: report insufficient
  // evidence explicitly (still surfaced to the UI) rather than silently returning nothing,
  // and never guess at a conflict that might exist.
  if (withDueDate.length === 0) {
    return {
      windowHours: WINDOW_HOURS,
      itemCount: 0,
      totalEstimatedMinutes: 0,
      availableBudgetMinutes,
      reason: "No explicit due dates are recorded on today's focus items.",
      nowWhat: "Deadline conflicts can't be assessed without due-date data.",
      insufficientEvidence: true,
    };
  }

  // §20 example: "two high-priority items due on same day" / "within the same narrow
  // window" — a day-granularity domain model (WorkItem.dueDate has no time component)
  // means "within 24 hours" collapses to "due today or overdue", which is the honest
  // finest-grained comparison this data supports.
  const dueWithinWindow = withDueDate.filter((c) => {
    const days = daysBetween(today, c.dueDate!);
    return days <= 0 || days * 24 < WINDOW_HOURS;
  });

  if (dueWithinWindow.length < 2) return null;

  const highPriority = dueWithinWindow.filter((c) => c.severity === "CRITICAL" || c.severity === "HIGH");
  if (highPriority.length < 2) return null;

  const totalEstimatedMinutes = highPriority.reduce((s, c) => s + c.estimatedMinutes, 0);
  const sorted = [...highPriority].sort((a, b) => b.score - a.score);

  return {
    windowHours: WINDOW_HOURS,
    itemCount: highPriority.length,
    totalEstimatedMinutes,
    availableBudgetMinutes,
    reason: `${highPriority.length} high-priority item(s) require attention within ${WINDOW_HOURS} hours.`,
    nowWhat:
      totalEstimatedMinutes > availableBudgetMinutes
        ? `Review the top ${Math.min(2, sorted.length)} item(s) first — estimated focus (${totalEstimatedMinutes}m) exceeds the available planning budget (${availableBudgetMinutes}m).`
        : "All of these fit within today's planning budget, but confirm the order before starting.",
  };
}
