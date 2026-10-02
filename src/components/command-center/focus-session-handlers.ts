// E2/E3 — the Focus Session's action handlers, split out of FocusSession.tsx so the offline test
// suite drives the SAME code the dialog runs (with a real CommandCenterStore and recorded UI
// setters) rather than only calling the store directly.
//
// Rule (E2): the session's own state (COMPLETED / BLOCKED / SKIPPED / DEFERRED / IN_PROGRESS)
// changes ONLY when the store accepted the action. Every handler first re-reads storage
// (checkForNewerState), so a change made in another tab is seen before acting; a rejected
// action (e.g. the ticket is already Done) shows the rejection instead, and writes nothing.

import type { CommandCenterStore, FocusItemResult } from "@/lib/command-center/store";
import type { FocusSessionState, PersonalFocusCandidate, SkipReason } from "@/lib/command-center/types";

export type FocusSessionStore = Pick<
  CommandCenterStore,
  | "getSnapshot"
  | "checkForNewerState"
  | "startFocusItem"
  | "completeFocusItem"
  | "blockFocusItem"
  | "skipFocusItem"
  | "deferFocusItem"
  | "focusItemRejection"
  | "reopenTicketInDailyCommand"
  | "completeAction"
  | "resolveAttentionItem"
  | "addAction"
>;

/** What the dialog shows instead of an outcome when the store refused it. */
export type FocusRejection = Exclude<FocusItemResult, { ok: true }>;

export interface FocusSessionUi {
  setSessionState(state: FocusSessionState): void;
  setRejection(rejection: FocusRejection | null): void;
  setShowOutcomeCapture(show: boolean): void;
  setShowDecisionAssistant(show: boolean): void;
}

export interface FocusSessionContext {
  store: FocusSessionStore;
  planItemId: string;
  today: string;
  candidate: Pick<PersonalFocusCandidate, "title" | "actionId" | "decisionId" | "attentionItemId">;
  /** The attention item a Decision candidate opens the Decision Assistant on, if any. */
  hasDecisionAttentionItem: boolean;
  relatedWorkItemId?: string;
}

export function focusSessionHandlers(ctx: FocusSessionContext, ui: FocusSessionUi) {
  const { store, planItemId, today, candidate } = ctx;

  async function refresh() {
    await store.checkForNewerState();
  }

  /** Applies a store result: the session state moves only on ok. */
  function settle(result: FocusItemResult, next: FocusSessionState): boolean {
    if (!result.ok) {
      ui.setRejection(result);
      return false;
    }
    ui.setRejection(null);
    ui.setSessionState(next);
    return true;
  }

  async function start(): Promise<boolean> {
    await refresh();
    const item = store.getSnapshot().personalPlan.find((p) => p.id === planItemId);
    if (item?.status === "in-progress") {
      ui.setSessionState("IN_PROGRESS");
      return true;
    }
    return settle(store.startFocusItem(planItemId, today), "IN_PROGRESS");
  }

  async function complete(): Promise<boolean> {
    await refresh();
    if (candidate.decisionId && ctx.hasDecisionAttentionItem && !candidate.actionId) {
      // The Decision Assistant runs first and completes on close — check before opening it.
      const rejected = store.focusItemRejection(planItemId, "DONE");
      if (rejected) {
        ui.setRejection(rejected);
        return false;
      }
      ui.setShowDecisionAssistant(true);
      return true;
    }
    if (!settle(store.completeFocusItem(planItemId, today), "COMPLETED")) return false;
    if (candidate.actionId) {
      // G5 — the ticket's DONE may already have completed this action (and recorded it once);
      // only complete it here when it is still open.
      if (store.getSnapshot().data.actions.find((a) => a.id === candidate.actionId)?.status !== "completed") store.completeAction(candidate.actionId);
      ui.setShowOutcomeCapture(true);
    } else if (candidate.attentionItemId) {
      store.resolveAttentionItem(candidate.attentionItemId);
    }
    return true;
  }

  /** Decision Assistant closed — finish the plan item (re-checked: it may have changed meanwhile). */
  async function finishDecision(): Promise<boolean> {
    ui.setShowDecisionAssistant(false);
    await refresh();
    return settle(store.completeFocusItem(planItemId, today), "COMPLETED");
  }

  async function block(reason: string | undefined, note: string | undefined, createFollowUp: boolean): Promise<boolean> {
    await refresh();
    if (!settle(store.blockFocusItem(planItemId, today, reason, note), "BLOCKED")) return false;
    if (createFollowUp) {
      store.addAction({
        title: `Follow up: ${candidate.title}`,
        why: note || reason || "Blocked in Focus Session",
        relatedWorkItemId: ctx.relatedWorkItemId,
        relatedDecisionId: candidate.decisionId,
        source: "system-suggested",
        estimateMinutes: 15,
      });
    }
    return true;
  }

  async function skip(reason?: SkipReason): Promise<boolean> {
    await refresh();
    return settle(store.skipFocusItem(planItemId, today, reason), "SKIPPED");
  }

  async function defer(until?: string): Promise<boolean> {
    await refresh();
    return settle(store.deferFocusItem(planItemId, until), "DEFERRED");
  }

  /** "Reopen it first?" — reopens the ticket (DONE → TODO), then resumes the session. */
  async function reopen(ticketKey: string): Promise<boolean> {
    store.reopenTicketInDailyCommand(ticketKey, "focus-session");
    ui.setRejection(null);
    return start();
  }

  return { start, complete, finishDecision, block, skip, defer, reopen };
}
