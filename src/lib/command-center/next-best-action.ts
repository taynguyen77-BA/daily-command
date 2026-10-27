// P3.6 — Next Best Action: "do this next, and here is why". Deterministic and explainable: it ranks facts
// the app already derived (Score v2, who-is-waiting-on-whom, forecast, blockers) — no new AI task, no guessing.
//
// RANK ORDER (documented here and shown in the UI):
//   1 REPLY    a mention is waiting on you past the reply SLA            -> Draft reply
//   2 OVERDUE  an overdue P1/P2 ticket                                   -> Start focus
//   3 SLIP     the forecast says a ticket will miss its due date (HIGH)  -> Start focus
//   4 NUDGE    a blocked ticket past the blocker SLA with a nudge ready  -> Nudge
//   5 RECHECK  a skipped/blocked ticket whose re-check is due today      -> Start focus
//   6 TOP      the highest-scored remaining ticket (Score v2)            -> Start focus
// A ticket appears once (in its best class); Done / Skipped / still-deferred tickets never appear; at most 3 cards.

import { addDays, businessDaysBetween } from "./date-utils";
import { REPLY_SLA_BUSINESS_DAYS, awaitingMeAgeBusinessDays, type AwaitingMeSignal } from "./awaiting-me";
import { daysBetween } from "./score-core";
import type { Evidence, PriorityScoreResult, TicketWorkState, WorkItem } from "./types";

export type NbaKind = "REPLY" | "OVERDUE" | "SLIP" | "NUDGE" | "RECHECK" | "TOP";
export type NbaIntent = "start-focus" | "draft-reply" | "nudge" | "defer";

export const NBA_RANK: Record<NbaKind, number> = { REPLY: 1, OVERDUE: 2, SLIP: 3, NUDGE: 4, RECHECK: 5, TOP: 6 };
export const NBA_LIMIT = 3;

export interface NbaCard {
  id: string;
  kind: NbaKind;
  ticketKey: string;
  headline: string;
  why: Evidence[];
  primary: { label: string; intent: NbaIntent };
  rank: number;
}

export interface NbaInput {
  today: string;
  workItems: readonly WorkItem[];
  /** Score results for the open tickets (any order). */
  scores: readonly PriorityScoreResult[];
  awaitingMeByKey: Readonly<Record<string, AwaitingMeSignal>>;
  ticketWorkStates: Readonly<Record<string, Pick<TicketWorkState, "status" | "until" | "updatedAt" | "reason">>>;
  /** Forecast slip HIGH tickets: key -> explanation (forecast/slip-risk.ts). */
  slipHigh: ReadonlyMap<string, { explanation: string; remainingDays: number }>;
  /** Blocked tickets that have a follow-up message ready to send (blocker-followup.ts). */
  nudgeReadyKeys: ReadonlySet<string>;
  blockerSlaBusinessDays: number;
  /** Skipped / blocked tickets whose re-check day has come (daily-review.ts). */
  dueRecheckKeys: ReadonlySet<string>;
  /** Cards the user answered "Not now" to today (kind|ticket): hidden for the rest of the day. */
  dismissedToday?: ReadonlySet<string>;
}

export const nbaCardKey = (kind: NbaKind, ticketKey: string) => `${kind}|${ticketKey}`;
/** Deterministic evidence (a stable id, unlike evidence.ts's counter): the same facts always give the same card. */
const ev = (text: string, key: string): Evidence => ({ id: `nba-ev-${key}-${text.length}-${text.charCodeAt(0)}-${text.charCodeAt(text.length - 1)}`, sourceType: "jira", sourceId: key, content: text });

function eligible(w: WorkItem, input: NbaInput): boolean {
  if (w.status === "Done") return false;
  const s = input.ticketWorkStates[w.key];
  if (!s) return true;
  if (s.status === "DONE" || s.status === "SKIPPED") return false;
  if (s.status === "DEFERRED" && s.until && s.until > input.today) return false;
  return true;
}

export function nextBestActions(input: NbaInput, limit: number = NBA_LIMIT): NbaCard[] {
  const { today } = input;
  const open = input.workItems.filter((w) => eligible(w, input));
  const scoreOf = new Map(input.scores.map((s) => [s.itemId, s]));
  const taken = new Set<string>();
  const out: NbaCard[] = [];
  const push = (kind: NbaKind, w: WorkItem, headline: string, why: Evidence[], primary: NbaCard["primary"]) => {
    if (taken.has(w.key)) return;
    taken.add(w.key);
    if (input.dismissedToday?.has(nbaCardKey(kind, w.key))) return; // "Not now": hidden today, and it does not come back as a lower class
    out.push({ id: `nba-${kind.toLowerCase()}-${w.key}`, kind, ticketKey: w.key, headline, why, primary, rank: NBA_RANK[kind] });
  };
  const byScoreThenKey = (a: WorkItem, b: WorkItem) => (scoreOf.get(b.id)?.score ?? 0) - (scoreOf.get(a.id)?.score ?? 0) || a.key.localeCompare(b.key);

  // 1 — waiting on you past the SLA (oldest first)
  open
    .map((w) => ({ w, sig: input.awaitingMeByKey[w.key] }))
    .filter((x): x is { w: WorkItem; sig: AwaitingMeSignal } => !!x.sig && awaitingMeAgeBusinessDays(x.sig, today) > REPLY_SLA_BUSINESS_DAYS)
    .sort((a, b) => awaitingMeAgeBusinessDays(b.sig, today) - awaitingMeAgeBusinessDays(a.sig, today) || a.w.key.localeCompare(b.w.key))
    .forEach(({ w, sig }) => {
      const age = awaitingMeAgeBusinessDays(sig, today);
      push("REPLY", w, `Reply on ${w.key} — ${w.title}`, [ev(`${sig.count} unanswered mention(s) of you, the oldest ${age} business days ago (reply SLA: ${REPLY_SLA_BUSINESS_DAYS})`, w.key)], { label: "Draft reply", intent: "draft-reply" });
    });

  // 2 — overdue P1/P2 (most overdue first)
  open
    .filter((w) => (w.priority === "P1" || w.priority === "P2") && w.priorityKnown !== false && !!w.dueDate && w.dueDate < today)
    .sort((a, b) => daysBetween(b.dueDate!, today) - daysBetween(a.dueDate!, today) || a.key.localeCompare(b.key))
    .forEach((w) => push("OVERDUE", w, `${w.key} is overdue — ${w.title}`, [ev(`Priority ${w.priority}, due ${w.dueDate} (${daysBetween(w.dueDate!, today)} day(s) overdue)`, w.key)], { label: "Start focus", intent: "start-focus" }));

  // 3 — forecast says it will slip (least time left first)
  open
    .filter((w) => input.slipHigh.has(w.key))
    .sort((a, b) => input.slipHigh.get(a.key)!.remainingDays - input.slipHigh.get(b.key)!.remainingDays || a.key.localeCompare(b.key))
    .forEach((w) => push("SLIP", w, `${w.key} is likely to miss its date — ${w.title}`, [ev(`Forecast: ${input.slipHigh.get(w.key)!.explanation}`, w.key)], { label: "Start focus", intent: "start-focus" }));

  // 4 — blocked past the blocker SLA, with a nudge ready (longest blocked first)
  open
    .filter((w) => input.ticketWorkStates[w.key]?.status === "BLOCKED" && input.nudgeReadyKeys.has(w.key) && businessDaysBetween(input.ticketWorkStates[w.key].updatedAt.slice(0, 10), today) > input.blockerSlaBusinessDays)
    .sort((a, b) => businessDaysBetween(input.ticketWorkStates[b.key].updatedAt.slice(0, 10), today) - businessDaysBetween(input.ticketWorkStates[a.key].updatedAt.slice(0, 10), today) || a.key.localeCompare(b.key))
    .forEach((w) => {
      const age = businessDaysBetween(input.ticketWorkStates[w.key].updatedAt.slice(0, 10), today);
      push("NUDGE", w, `Nudge on ${w.key} — blocked for ${age} business days`, [ev(`Blocked ${age} business days (SLA ${input.blockerSlaBusinessDays})${input.ticketWorkStates[w.key].reason ? `: ${input.ticketWorkStates[w.key].reason}` : ""}; a follow-up message is ready`, w.key)], { label: "Nudge", intent: "nudge" });
    });

  // 5 — re-check due today
  open
    .filter((w) => input.dueRecheckKeys.has(w.key))
    .sort((a, b) => byScoreThenKey(a, b))
    .forEach((w) => push("RECHECK", w, `Re-check ${w.key} today — ${w.title}`, [ev("Its skip/block re-check day is today", w.key)], { label: "Start focus", intent: "start-focus" }));

  // 6 — the highest-scored remaining ticket (Score v2 when that model is on)
  open
    .filter((w) => scoreOf.has(w.id))
    .sort(byScoreThenKey)
    .forEach((w) => {
      const r = scoreOf.get(w.id)!;
      push("TOP", w, `Highest priority now: ${w.key} — ${w.title}`, [ev(`${r.reasoning} (score ${r.score}/100, confidence ${Math.round(r.confidence * 100)}%)`, w.key)], { label: "Start focus", intent: "start-focus" });
    });

  return out.sort((a, b) => a.rank - b.rank).slice(0, limit);
}

/** Later default for a "Defer" on a card: tomorrow. */
export const nbaDeferUntil = (today: string) => addDays(today, 1);
