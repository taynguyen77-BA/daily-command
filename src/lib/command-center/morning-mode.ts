// F1 — Morning Mode: a guided 5-step start of the day on /my-work.
//   1. Sync — Jira sync with progress (skipped when Jira isn't the data source).
//   2. Triage New — one key per action: D done · B block · S skip · F defer (tomorrow) ·
//      Enter keep for today. J/K or ↓/↑ move.
//   3. Due re-checks — skipped/blocked tickets whose re-check date has come, deferred tickets
//      whose date has arrived.
//   4. Today's plan — order it, against the Action Plan time budget.
//   5. Start the first task.
// Finishing records "Triage done in Xm" for the day (store.recordMorningTriage); the flow is the
// first-open-of-the-day landing while the feature is on and today's triage isn't done.
//
// Pure: the component (MorningMode.tsx) owns focus/state and calls the store.

import type { MorningTriageRecord, TicketWorkState } from "./types";

export type MorningStep = "sync" | "triage" | "rechecks" | "plan" | "start";

export const MORNING_STEPS: { id: MorningStep; label: string }[] = [
  { id: "sync", label: "Sync" },
  { id: "triage", label: "Triage New" },
  { id: "rechecks", label: "Due re-checks" },
  { id: "plan", label: "Today's plan" },
  { id: "start", label: "Start" },
];

export const MORNING_MODE_LANDING = "/my-work?mode=morning";

export function nextMorningStep(step: MorningStep): MorningStep | null {
  const i = MORNING_STEPS.findIndex((s) => s.id === step);
  return MORNING_STEPS[i + 1]?.id ?? null;
}

/** Lands on Morning Mode: feature on, data loaded, and today's triage not finished yet. */
export function shouldOpenMorningMode(input: { enabled: boolean; loaded: boolean; today: string; morningTriage: Record<string, MorningTriageRecord> }): boolean {
  return input.enabled && input.loaded && !input.morningTriage[input.today];
}

// ===== Step 2 — one key per action ======================================================

export type MorningKeyCommand =
  | { kind: "move"; index: number }
  | { kind: "done" | "block" | "skip" | "defer" | "keep"; ticketKey: string }
  | { kind: "none" };

export const MORNING_KEYS: { key: string; label: string }[] = [
  { key: "D", label: "done" },
  { key: "B", label: "block" },
  { key: "S", label: "skip" },
  { key: "F", label: "defer to tomorrow" },
  { key: "Enter", label: "keep for today" },
];

/** A key press → what to do with the selected New row. Typing in a field, or any modifier,
 *  never triggers anything (same rule as Daily Review's keyboard triage). */
export function morningKeyCommand(key: string, rowKeys: string[], selected: number, modifiers: { ctrl?: boolean; meta?: boolean; alt?: boolean; inTextField?: boolean } = {}): MorningKeyCommand {
  if (modifiers.ctrl || modifiers.meta || modifiers.alt || modifiers.inTextField || rowKeys.length === 0) return { kind: "none" };
  const clamp = (i: number) => Math.max(0, Math.min(rowKeys.length - 1, i));
  const k = key.length === 1 ? key.toLowerCase() : key;
  if (k === "j" || k === "ArrowDown") return { kind: "move", index: clamp(selected + 1) };
  if (k === "k" || k === "ArrowUp") return { kind: "move", index: clamp(selected - 1) };
  const ticketKey = rowKeys[clamp(selected)];
  if (k === "d") return { kind: "done", ticketKey };
  if (k === "b") return { kind: "block", ticketKey };
  if (k === "s") return { kind: "skip", ticketKey };
  if (k === "f") return { kind: "defer", ticketKey };
  if (k === "Enter") return { kind: "keep", ticketKey };
  return { kind: "none" };
}

// ===== Step 3 — due re-checks ===========================================================

export interface DueRecheck {
  ticketKey: string;
  status: "SKIPPED" | "BLOCKED" | "DEFERRED";
  until: string;
  reason?: string;
}

/** Skipped/blocked tickets whose re-check date has come, and deferred tickets whose date has
 *  arrived (still recorded as DEFERRED) — oldest date first. */
export function dueRechecks(states: Record<string, TicketWorkState>, today: string): DueRecheck[] {
  const out: DueRecheck[] = [];
  for (const r of Object.values(states)) {
    if ((r.status === "SKIPPED" || r.status === "BLOCKED" || r.status === "DEFERRED") && r.until && r.until <= today) {
      out.push({ ticketKey: r.ticketKey, status: r.status, until: r.until, ...(r.reason ? { reason: r.reason } : {}) });
    }
  }
  return out.sort((a, b) => a.until.localeCompare(b.until) || a.ticketKey.localeCompare(b.ticketKey));
}

// ===== Step 4 — plan against the time budget ============================================

export interface PlanBudget {
  totalMinutes: number;
  budgetMinutes: number;
  /** Ids that fit, in order, before the budget runs out. */
  fitIds: string[];
  overByMinutes: number;
}

export function planAgainstBudget(items: { id: string; estimatedMinutes: number }[], budgetMinutes: number): PlanBudget {
  let used = 0;
  const fitIds: string[] = [];
  for (const i of items) {
    if (used + i.estimatedMinutes <= budgetMinutes) fitIds.push(i.id);
    used += i.estimatedMinutes;
  }
  return { totalMinutes: used, budgetMinutes, fitIds, overByMinutes: Math.max(0, used - budgetMinutes) };
}

/** Moves `id` to `toIndex` (drag & drop / up-down). Unknown id → unchanged copy. */
export function reorderIds(ids: string[], id: string, toIndex: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return [...ids];
  const next = ids.filter((x) => x !== id);
  next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, id);
  return next;
}

// ===== Finish ===========================================================================

/** "Triage done in 4m" — whole minutes, at least 1. */
export function triageDoneLabel(record: Pick<MorningTriageRecord, "startedAt" | "finishedAt">): string {
  const ms = new Date(record.finishedAt).getTime() - new Date(record.startedAt).getTime();
  const minutes = Number.isFinite(ms) ? Math.max(1, Math.round(ms / 60_000)) : 1;
  return `Triage done in ${minutes}m`;
}
