// W1 — the compact BriefingSnapshot the browser mirrors (keys + short reasons only, never ticket text) and the in-app card's inputs. Pure.

import { awaitingMeAgeBusinessDays, type AwaitingMeSignal } from "./awaiting-me";
import type { BriefingRecord, BriefingSnapshot, DueSoonTicket } from "./briefing";
import type { NbaCard } from "./next-best-action";
import { addDays } from "./reminder-schedule";
import type { WorkItem } from "./types";

export function buildBriefingSnapshot(args: {
  nowIso: string;
  today: string;
  cards: readonly Pick<NbaCard, "ticketKey" | "headline">[];
  slipHigh: ReadonlyMap<string, { explanation: string }> | readonly [string, { explanation: string }][];
  awaitingMeByKey: Readonly<Record<string, AwaitingMeSignal>>;
}): BriefingSnapshot {
  const slip = args.slipHigh instanceof Map ? Array.from(args.slipHigh.entries()) : Array.from(args.slipHigh as readonly [string, { explanation: string }][]);
  return {
    builtAt: args.nowIso,
    nba: args.cards.slice(0, 3).map((c) => ({ key: c.ticketKey, headline: c.headline.slice(0, 140) })),
    slipHigh: slip.slice(0, 30).map(([key, v]) => ({ key, reason: v.explanation.slice(0, 140) })),
    awaiting: Object.entries(args.awaitingMeByKey).slice(0, 30).map(([key, s]) => ({ key, ageBusinessDays: awaitingMeAgeBusinessDays(s, args.today) })),
  };
}

/** Assigned open tickets due within 2 days or overdue (the live JQL part, computed from local data for the in-app card). */
export function dueSoonFrom(workItems: readonly Pick<WorkItem, "key" | "title" | "dueDate" | "status">[], today: string): DueSoonTicket[] {
  const horizon = addDays(today, 2);
  return workItems.filter((w) => w.status !== "Done" && w.dueDate && w.dueDate.slice(0, 10) <= horizon).slice(0, 30).map((w) => ({ key: w.key, title: w.title.slice(0, 100), dueDate: w.dueDate!.slice(0, 10) }));
}

/** Titles and Jira links for every key the briefing may mention (https only; sanitised again server-side). */
export function briefingLinks(keys: readonly string[], workItems: readonly Pick<WorkItem, "key" | "title" | "sourceUrl">[]): NonNullable<BriefingRecord["links"]> {
  const byKey = new Map(workItems.map((w) => [w.key, w]));
  const out: NonNullable<BriefingRecord["links"]> = {};
  for (const k of Array.from(new Set(keys)).slice(0, 100)) {
    const w = byKey.get(k);
    if (w) out[k] = { title: w.title.slice(0, 100), ...(w.sourceUrl?.startsWith("https://") ? { url: w.sourceUrl } : {}) };
  }
  return out;
}
