// P3.6 — "Useful" / "Not now" on a Next Best Action card, recorded as ordinary memory events (NBA_ACCEPTED /
// NBA_DISMISSED: ticket + kind + reason) so they persist and sync like the rest of memory, and feed the
// learning loop as lighter-weight signals than real status changes.

import { nbaCardKey, type NbaCard, type NbaKind } from "./next-best-action";
import type { MemoryEvent } from "./types";
import type { SignalKind } from "./learned-adjustments";

export const NBA_SIGNAL_WEIGHT = 0.5;

export function nbaFeedbackEvent(card: Pick<NbaCard, "kind" | "ticketKey" | "headline">, accepted: boolean, reason: string | undefined, today: string, nowMs: number): MemoryEvent {
  return {
    id: `memory-event-nba-${accepted ? "ok" : "no"}-${card.ticketKey}-${nowMs}`,
    date: today,
    kind: accepted ? "NBA_ACCEPTED" : "NBA_DISMISSED",
    title: `${accepted ? "Useful" : "Not now"}: ${card.headline}`,
    impact: reason?.trim() || (accepted ? "Marked useful" : "Not now"),
    evidence: [`kind: ${card.kind}`],
    ticketKey: card.ticketKey,
  };
}

const kindOf = (e: Pick<MemoryEvent, "evidence">): NbaKind | undefined => {
  const m = /^kind: (REPLY|OVERDUE|SLIP|NUDGE|RECHECK|TOP)$/.exec(e.evidence[0] ?? "");
  return m ? (m[1] as NbaKind) : undefined;
};

/** Cards answered "Not now" today -> hidden for the rest of the day. */
export function dismissedTodayKeys(events: readonly MemoryEvent[], today: string): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (e.kind !== "NBA_DISMISSED" || e.date !== today || !e.ticketKey) continue;
    const k = kindOf(e);
    if (k) out.add(nbaCardKey(k, e.ticketKey));
  }
  return out;
}

export interface NbaSignal {
  date: string;
  ticketKey: string;
  accepted: boolean;
  kind: SignalKind;
}

/** The feedback as learning input: accepted = acted on, dismissed = ignored; a REPLY card is a MENTION-kind signal. */
export function nbaSignals(events: readonly MemoryEvent[]): NbaSignal[] {
  const out: NbaSignal[] = [];
  for (const e of events) {
    if ((e.kind !== "NBA_ACCEPTED" && e.kind !== "NBA_DISMISSED") || !e.ticketKey) continue;
    out.push({ date: e.date, ticketKey: e.ticketKey, accepted: e.kind === "NBA_ACCEPTED", kind: kindOf(e) === "REPLY" ? "MENTION" : "OTHER" });
  }
  return out;
}
