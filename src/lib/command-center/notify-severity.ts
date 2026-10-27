// P3.5 — which signals are URGENT. Pure and deterministic: priority P1/P2, overdue, blocked — or a mention on such a ticket.

import type { ImmediateKind } from "./notify-prefs";

export interface TicketUrgencyFacts {
  priority?: "P1" | "P2" | "P3" | "P4";
  dueDate?: string;
  blocked?: boolean;
}

export type SignalClass = "ASSIGNMENT" | "MENTION" | "ESCALATION";

export function isUrgent(facts: TicketUrgencyFacts | undefined, today: string): boolean {
  if (!facts) return false;
  return facts.priority === "P1" || facts.priority === "P2" || !!facts.blocked || (!!facts.dueDate && facts.dueDate.slice(0, 10) < today);
}

/** The preference kind an URGENT signal may bypass quiet hours / digest mode under, if any. */
export function immediateKindFor(signalClass: SignalClass, facts: TicketUrgencyFacts | undefined, today: string): ImmediateKind | null {
  if (signalClass === "ESCALATION") return "ESCALATION";
  if (!isUrgent(facts, today)) return null;
  if (signalClass === "MENTION") return "MENTION_URGENT";
  return facts?.priority === "P1" || facts?.priority === "P2" ? "ASSIGNMENT_P1P2" : null;
}
