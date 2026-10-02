// F2 — blocker follow-up quality. A blocked ticket waits on someone else; the useful questions
// are "how long has it been waiting" (business days, the same Mon–Fri counting as Skip/Block
// ages and the Stale detector), "is that past what I tolerate" (the SLA, default 2 business
// days, set in Data & Settings), and "who do I ask, about what" — the Needs From Others rows
// (communicate.ts), grouped by person so each person gets one message.
//
// Pure: the TaskRow "Ask" control, My Work's Today/Blocked views and the Daily Report header
// all read from here.

import { businessDaysBetween, toLocalIso } from "./date-utils";
import { renderNeedsFromOthersText, needsFromOthersForBlockedTicket, type NeedsFromOthersRow } from "./communicate";
import type { CommandCenterData, TicketWorkState } from "./types";

/** Whole business days a ticket has been blocked as of `today` (0 on the day it was blocked). */
export function blockedAgeBusinessDays(blockedAtIso: string | undefined, today: string): number | undefined {
  if (!blockedAtIso) return undefined;
  const d = new Date(blockedAtIso);
  if (Number.isNaN(d.getTime())) return undefined;
  return businessDaysBetween(toLocalIso(d), today);
}

/** Overdue = blocked for MORE business days than the SLA. */
export function isBlockerOverdue(ageBusinessDays: number | undefined, slaBusinessDays: number): boolean {
  return ageBusinessDays !== undefined && ageBusinessDays > slaBusinessDays;
}

export interface OverdueBlocker {
  ticketKey: string;
  ageBusinessDays: number;
  reason?: string;
  title?: string;
}

/** Every BLOCKED ticket past the SLA, oldest first (ties by key). */
export function overdueBlockers(states: Record<string, TicketWorkState>, today: string, slaBusinessDays: number, titles?: Map<string, string>): OverdueBlocker[] {
  const out: OverdueBlocker[] = [];
  for (const r of Object.values(states)) {
    if (r.status !== "BLOCKED") continue;
    const age = blockedAgeBusinessDays(r.updatedAt, today);
    if (!isBlockerOverdue(age, slaBusinessDays)) continue;
    const title = titles?.get(r.ticketKey);
    out.push({ ticketKey: r.ticketKey, ageBusinessDays: age!, ...(r.reason ? { reason: r.reason } : {}), ...(title ? { title } : {}) });
  }
  return out.sort((a, b) => b.ageBusinessDays - a.ageBusinessDays || a.ticketKey.localeCompare(b.ticketKey));
}

/** The follow-up rows for every blocked ticket (one per unresolved dependency team, or one
 *  "who?" row carrying the reason) — the input to "Ask everyone". */
export function blockedFollowUpRows(states: Record<string, TicketWorkState>, data: Pick<CommandCenterData, "workItems" | "dependencies">): NeedsFromOthersRow[] {
  const byKey = new Map(data.workItems.map((w) => [w.key, w]));
  const rows: NeedsFromOthersRow[] = [];
  for (const r of Object.values(states).sort((a, b) => a.ticketKey.localeCompare(b.ticketKey))) {
    if (r.status !== "BLOCKED") continue;
    const w = byKey.get(r.ticketKey);
    const deps = w ? data.dependencies.filter((d) => d.workItemId === w.id && d.status === "unresolved") : [];
    rows.push(...needsFromOthersForBlockedTicket({ key: r.ticketKey, title: w?.title, dueDate: w?.dueDate }, r.reason, deps));
  }
  return rows;
}

export interface AskGroup {
  person: string;
  isUnknownPerson: boolean;
  rows: NeedsFromOthersRow[];
  /** One message for this person (renderNeedsFromOthersText over their rows). */
  text: string;
}

/** Needs From Others rows grouped by person — one copyable / sendable message each. Unknown
 *  recipients ("who?") are kept, last, so a block with no known owner is never hidden. */
export function groupAskByPerson(rows: NeedsFromOthersRow[]): AskGroup[] {
  const groups = new Map<string, NeedsFromOthersRow[]>();
  for (const r of rows) groups.set(r.person, [...(groups.get(r.person) ?? []), r]);
  return Array.from(groups.entries())
    .map(([person, rs]) => ({ person, isUnknownPerson: rs[0].isUnknownPerson, rows: rs, text: renderNeedsFromOthersText(rs) }))
    .sort((a, b) => Number(a.isUnknownPerson) - Number(b.isUnknownPerson) || a.person.localeCompare(b.person));
}
