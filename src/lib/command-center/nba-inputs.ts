// P3.6 — turns the derived facts the app already holds into the NbaInput that next-best-action.ts ranks.
// Pure; the one place that knows where each rank class gets its data.

import { needsFromOthersForBlockedTicket, type NeedsFromOthersRow } from "./communicate";
import { dueRechecks } from "./morning-mode";
import { dismissedTodayKeys } from "./nba-feedback";
import type { NbaInput } from "./next-best-action";
import type { AwaitingMeSignal } from "./awaiting-me";
import type { ForecastBundle } from "./forecast";
import type { CommandCenterData, MemoryEvent, PriorityScoreResult, TicketWorkState } from "./types";

export function nbaInputFrom(args: {
  today: string;
  data: Pick<CommandCenterData, "workItems" | "dependencies">;
  scores: readonly PriorityScoreResult[];
  awaitingMeByKey: Readonly<Record<string, AwaitingMeSignal>> | undefined;
  ticketWorkStates: Record<string, TicketWorkState>;
  forecast: Pick<ForecastBundle, "byTicket">;
  blockerSlaBusinessDays: number;
  memoryEvents: readonly MemoryEvent[];
}): { input: NbaInput; followUpRowsFor: (ticketKey: string) => NeedsFromOthersRow[] } {
  const byKey = new Map(args.data.workItems.map((w) => [w.key, w]));
  const rowsFor = (key: string): NeedsFromOthersRow[] => {
    const st = args.ticketWorkStates[key];
    const w = byKey.get(key);
    if (!st || st.status !== "BLOCKED" || !w) return [];
    return needsFromOthersForBlockedTicket({ key, title: w.title, dueDate: w.dueDate }, st.reason, args.data.dependencies.filter((d) => d.workItemId === w.id && d.status === "unresolved"));
  };
  const slipHigh = new Map<string, { explanation: string; remainingDays: number }>();
  for (const [key, f] of args.forecast.byTicket) if (f.slip?.level === "HIGH") slipHigh.set(key, { explanation: f.slip.explanation, remainingDays: f.slip.remainingDays });
  const nudgeReadyKeys = new Set<string>();
  for (const st of Object.values(args.ticketWorkStates)) if (st.status === "BLOCKED" && rowsFor(st.ticketKey).length > 0) nudgeReadyKeys.add(st.ticketKey);
  return {
    input: {
      today: args.today,
      workItems: args.data.workItems,
      scores: args.scores,
      awaitingMeByKey: args.awaitingMeByKey ?? {},
      ticketWorkStates: args.ticketWorkStates,
      slipHigh,
      nudgeReadyKeys,
      blockerSlaBusinessDays: args.blockerSlaBusinessDays,
      dueRecheckKeys: new Set(dueRechecks(args.ticketWorkStates, args.today).map((r) => r.ticketKey)),
      dismissedToday: dismissedTodayKeys(args.memoryEvents, args.today),
    },
    followUpRowsFor: rowsFor,
  };
}
