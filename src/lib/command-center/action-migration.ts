// G1 — one-time (idempotent) migration of action-level Defer / Snooze / Blocked on ticket-backed
// actions. Those were a second status vocabulary next to the ticket's own TicketWorkState, and
// they hid the ticket from the Action Plan for good (nothing ever woke them up). From V2.35 the
// ticket buttons are the only status controls for a ticket-backed action, so an old record is
// moved onto its ticket:
//   deferred → ticket DEFERRED until tomorrow
//   snoozed  → ticket DEFERRED until snoozedUntil (tomorrow if missing)
//   blocked  → ticket BLOCKED, reason "Migrated from action"
// — only when the ticket has no NEWER TicketWorkState (its record is older than the action's
// last status change, or there is none). Either way the action itself goes back to "open": the
// ticket state now decides whether it is in today's plan. Transition rules are the normal ones
// (applyTicketStatus), recorded with surface "migration". Ticketless actions are untouched.

import { addDays } from "./date-utils";
import { applyTicketStatus } from "./ticket-work-state";
import type { Action, TicketWorkState, WorkItem } from "./types";

export const MIGRATED_BLOCK_REASON = "Migrated from action";

export function migrateTicketBackedActionStatuses(
  actions: Action[],
  workItems: Pick<WorkItem, "id" | "key">[],
  states: Record<string, TicketWorkState>,
  today: string,
  nowIso: string
): { actions: Action[]; ticketWorkStates: Record<string, TicketWorkState>; migrated: number } {
  // Loading must never throw: a corrupted record (non-array) is left exactly as it is.
  if (!Array.isArray(actions) || !Array.isArray(workItems) || typeof states !== "object" || states === null) return { actions, ticketWorkStates: states, migrated: 0 };
  const keyById = new Map(workItems.map((w) => [w.id, w.key]));
  let ticketWorkStates = states;
  let migrated = 0;
  const out = actions.map((a) => {
    if (!a || typeof a !== "object" || !a.relatedWorkItemId || (a.status !== "deferred" && a.status !== "snoozed" && a.status !== "blocked")) return a;
    const key = keyById.get(a.relatedWorkItemId);
    if (!key) return a; // ticket not in the local data — leave it until it is
    migrated++;
    const actionAt = a.statusChangedAt ?? a.createdAt;
    const record = ticketWorkStates[key];
    const ticketIsNewer = !!record && record.updatedAt >= actionAt;
    if (!ticketIsNewer) {
      const result =
        a.status === "blocked"
          ? applyTicketStatus(ticketWorkStates, key, "BLOCKED", { surface: "migration", reason: MIGRATED_BLOCK_REASON }, nowIso)
          : applyTicketStatus(ticketWorkStates, key, "DEFERRED", { surface: "migration", until: a.status === "snoozed" && a.snoozedUntil ? a.snoozedUntil.slice(0, 10) : addDays(today, 1) }, nowIso);
      if (result.changed) ticketWorkStates = result.states;
    }
    const { deferredUntil: _d, snoozedUntil: _s, blockedReason: _b, ...rest } = a;
    void _d;
    void _s;
    void _b;
    return { ...rest, status: "open" as const, statusChangedAt: nowIso };
  });
  return migrated === 0 ? { actions, ticketWorkStates: states, migrated } : { actions: out, ticketWorkStates, migrated };
}
