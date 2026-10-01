// D2 — keyboard triage on Daily Review. Pure mapping from a key press to what should happen;
// the page owns focus and calls the store. J/K move, C complete, S skip, B block, R reviewed,
// O open in Jira. Keys typed into a text field, or with a modifier held, are never captured.

export type TriageCommand =
  | { kind: "move"; index: number }
  | { kind: "complete" | "skip" | "block" | "reviewed"; ticketKey: string }
  | { kind: "open"; url: string }
  | { kind: "none" };

export interface TriageRow {
  ticketKey: string;
  url?: string;
  /** Only rows in the New list can be marked reviewed. */
  reviewable: boolean;
  /** Completed rows can't be completed/skipped/blocked again from the keyboard. */
  actionable: boolean;
}

export function triageCommand(key: string, rows: TriageRow[], selected: number, modifiers: { ctrl?: boolean; meta?: boolean; alt?: boolean; inTextField?: boolean } = {}): TriageCommand {
  if (modifiers.ctrl || modifiers.meta || modifiers.alt || modifiers.inTextField || rows.length === 0) return { kind: "none" };
  const k = key.toLowerCase();
  const clamp = (i: number) => Math.max(0, Math.min(rows.length - 1, i));
  if (k === "j") return { kind: "move", index: clamp(selected + 1) };
  if (k === "k") return { kind: "move", index: clamp(selected - 1) };
  const row = rows[clamp(selected)];
  if (!row) return { kind: "none" };
  if (k === "o") return row.url ? { kind: "open", url: row.url } : { kind: "none" };
  if (k === "r") return row.reviewable ? { kind: "reviewed", ticketKey: row.ticketKey } : { kind: "none" };
  if (!row.actionable) return { kind: "none" };
  if (k === "c") return { kind: "complete", ticketKey: row.ticketKey };
  if (k === "s") return { kind: "skip", ticketKey: row.ticketKey };
  if (k === "b") return { kind: "block", ticketKey: row.ticketKey };
  return { kind: "none" };
}
