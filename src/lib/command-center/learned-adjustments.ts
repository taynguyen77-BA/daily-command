// P3.3 — the personal learning loop: let the ranking adapt to how THIS user actually works,
// explainably and reversibly. Pure and deterministic: no AI, no network, no clock reads
// (`today` is passed in). Label: LEARNED — derived from the user's own history, shows its
// sample size, can be switched off ("off") and reset.
//
// Signals (all already stored): plan items (a ticket "appeared in Today" on its plannedDate) and
// the ticket's status history (what the user then did with it).
//
// An appearance is ACTED ON when, within 2 business days of its planned date, the ticket went to
// DONE or IN_PROGRESS, or to BLOCKED with a real reason; IGNORED when it was skipped / deferred
// instead, or nothing happened and those 2 business days are over; otherwise still PENDING (not
// counted yet).
//
// Group key = (project, issue type, priority, first signal kind). The kind is normalised to
// MENTION / OTHER: whether a ticket is waiting on my reply is knowable when it is scored, while
// the full attention queue (which depends on the scores) does not exist yet — using it would be
// circular. (Deviation from the prompt's free-form signal kind, documented in the README.)

import { addDays } from "./date-utils";
import { awaitingMeAgeBusinessDays, REPLY_SLA_BUSINESS_DAYS, type AwaitingMeSignal } from "./awaiting-me";
import type { PersonalPlanItem, TicketWorkState, WorkItem } from "./types";

export type LearnedMode = "off" | "shadow" | "on";
export type SignalKind = "MENTION" | "OTHER";

export const LEARN_WINDOW_DAYS = 45;
export const LEARN_MIN_SAMPLES = 6;
export const LEARN_MAX_DELTA = 8;
export const LEARN_ACT_WITHIN_BUSINESS_DAYS = 2;
export const LEARN_DECAY_AFTER_DAYS = 30;
export const LEARN_SHADOW_DAYS_BEFORE_PROPOSAL = 14;
/** Next Best Action feedback counts for less than a real status change. */
const NBA_WEIGHT = 0.5;

const KIND_LABEL: Record<SignalKind, string> = { MENTION: "mentions", OTHER: "tickets" };

export function asLearnedMode(v: unknown): LearnedMode {
  return v === "off" || v === "on" ? v : "shadow";
}

/** The plan item's attention category (the prefix of its sourceId) normalised to a SignalKind. */
export function signalKindOfPlanItem(item: Pick<PersonalPlanItem, "sourceType" | "sourceId">): SignalKind {
  return item.sourceType === "attention" && item.sourceId.split(":")[0] === "MENTION" ? "MENTION" : "OTHER";
}

/** The signal kind knowable for a ticket at scoring time: waiting on my reply = MENTION, else OTHER. */
export function signalKindForTicket(ticketKey: string, awaitingMeByKey: Readonly<Record<string, AwaitingMeSignal>> | undefined): SignalKind {
  return awaitingMeByKey?.[ticketKey] ? "MENTION" : "OTHER";
}

export interface Appearance {
  ticketKey: string;
  date: string;
  projectId: string;
  projectLabel: string;
  issueType: string;
  priority: string;
  kind: SignalKind;
  outcome: "acted" | "ignored" | "pending";
  /** 1 for plan appearances; lighter for Next Best Action feedback (P3.6). */
  weight?: number;
}

export interface AppearanceInput {
  today: string;
  planItems: readonly Pick<PersonalPlanItem, "ticketKey" | "plannedDate" | "sourceType" | "sourceId">[];
  ticketWorkStates: Readonly<Record<string, Pick<TicketWorkState, "history">>>;
  workItems: readonly Pick<WorkItem, "key" | "projectId" | "type" | "priority">[];
  /** Appearances planned before this date are ignored ("Reset learning"). */
  resetAt?: string;
  /** P3.6 — "Useful" / "Not now" answers on Next Best Action cards: extra signals, weighted lower than real status changes. */
  nbaSignals?: readonly { date: string; ticketKey: string; accepted: boolean; kind: SignalKind }[];
}

/** The business day on which the 2-business-day window ends. */
function actWindowEnd(plannedDate: string): string {
  let d = plannedDate;
  let n = 0;
  while (n < LEARN_ACT_WITHIN_BUSINESS_DAYS) {
    d = addDays(d, 1);
    const day = new Date(d + "T00:00:00").getDay();
    if (day !== 0 && day !== 6) n++;
  }
  return d;
}

export function collectAppearances(input: AppearanceInput): Appearance[] {
  const byKey = new Map(input.workItems.map((w) => [w.key, w]));
  const from = addDays(input.today, -LEARN_WINDOW_DAYS);
  const seen = new Set<string>();
  const out: Appearance[] = [];
  for (const p of input.planItems) {
    if (!p.ticketKey || p.plannedDate < from || p.plannedDate > input.today) continue;
    if (input.resetAt && p.plannedDate < input.resetAt) continue;
    const dedupe = `${p.ticketKey}|${p.plannedDate}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const w = byKey.get(p.ticketKey);
    if (!w) continue;
    const end = actWindowEnd(p.plannedDate);
    const hist = (input.ticketWorkStates[p.ticketKey]?.history ?? []).filter((t) => t.at.slice(0, 10) >= p.plannedDate && t.at.slice(0, 10) <= end);
    const acted = hist.some((t) => t.to === "DONE" || t.to === "IN_PROGRESS" || (t.to === "BLOCKED" && !!t.reason?.trim()));
    const ignoredExplicitly = hist.some((t) => t.to === "SKIPPED" || t.to === "DEFERRED");
    const windowOver = input.today > end;
    out.push({
      ticketKey: p.ticketKey,
      date: p.plannedDate,
      projectId: w.projectId,
      projectLabel: p.ticketKey.split("-")[0],
      issueType: w.type,
      priority: w.priority,
      kind: signalKindOfPlanItem(p),
      outcome: acted ? "acted" : ignoredExplicitly || windowOver ? "ignored" : "pending",
    });
  }
  const nbaSeen = new Set<string>();
  for (const n of input.nbaSignals ?? []) {
    if (n.date < from || n.date > input.today || (input.resetAt && n.date < input.resetAt)) continue;
    const w = byKey.get(n.ticketKey);
    const dedupe = `${n.ticketKey}|${n.date}|${n.accepted}`;
    if (!w || nbaSeen.has(dedupe)) continue;
    nbaSeen.add(dedupe);
    out.push({ ticketKey: n.ticketKey, date: n.date, projectId: w.projectId, projectLabel: n.ticketKey.split("-")[0], issueType: w.type, priority: w.priority, kind: n.kind, outcome: n.accepted ? "acted" : "ignored", weight: NBA_WEIGHT });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.ticketKey.localeCompare(b.ticketKey));
}

export interface LearnedAdjustment {
  groupKey: string;
  projectId: string;
  projectLabel: string;
  issueType: string;
  priority: string;
  kind: SignalKind;
  n: number;
  acted: number;
  /** Recency-weighted rate of this group / of everything, 0-1. */
  rate: number;
  overallRate: number;
  /** clamp(round(8 x (rate - overallRate)), -8, +8), before decay. */
  rawDelta: number;
  /** What is applied: rawDelta, halved once the newest sample is older than 30 days. */
  delta: number;
  decayed: boolean;
  newestSample: string;
  evidence: string;
}

export const groupKeyOf = (a: { projectId: string; issueType: string; priority: string; kind: string }) => `${a.projectId}|${a.issueType}|${a.priority}|${a.kind}`;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const halve = (n: number) => Math.sign(n) * Math.round(Math.abs(n) / 2);
/** Newer samples weigh more: 1.0 today down to 0.5 at the edge of the 45-day window. */
const weightOf = (date: string, today: string) => 1 - 0.5 * clamp(calendarDaysBetween(date, today) / LEARN_WINDOW_DAYS, 0, 1);
function calendarDaysBetween(from: string, to: string): number {
  return Math.max(0, Math.round((new Date(to + "T00:00:00").getTime() - new Date(from + "T00:00:00").getTime()) / 86_400_000));
}

export function computeLearnedAdjustments(appearances: readonly Appearance[], today: string): LearnedAdjustment[] {
  const decided = appearances.filter((a) => a.outcome !== "pending");
  if (decided.length === 0) return [];
  const w = (a: Appearance) => weightOf(a.date, today) * (a.weight ?? 1);
  const overallRate = decided.reduce((s, a) => s + (a.outcome === "acted" ? w(a) : 0), 0) / decided.reduce((s, a) => s + w(a), 0);
  const groups = new Map<string, Appearance[]>();
  for (const a of decided) groups.set(groupKeyOf(a), [...(groups.get(groupKeyOf(a)) ?? []), a]);
  const out: LearnedAdjustment[] = [];
  for (const [groupKey, list] of groups) {
    if (list.length < LEARN_MIN_SAMPLES) continue; // n < 6 -> no adjustment
    const weightSum = list.reduce((s, a) => s + w(a), 0);
    const rate = list.reduce((s, a) => s + (a.outcome === "acted" ? w(a) : 0), 0) / weightSum;
    const rawDelta = clamp(Math.round(LEARN_MAX_DELTA * (rate - overallRate)), -LEARN_MAX_DELTA, LEARN_MAX_DELTA);
    const newestSample = list.reduce((m, a) => (a.date > m ? a.date : m), "");
    const decayed = calendarDaysBetween(newestSample, today) > LEARN_DECAY_AFTER_DAYS;
    const delta = decayed ? halve(rawDelta) : rawDelta;
    const acted = list.filter((a) => a.outcome === "acted").length;
    const first = list[0];
    out.push({
      groupKey,
      projectId: first.projectId,
      projectLabel: first.projectLabel,
      issueType: first.issueType,
      priority: first.priority,
      kind: first.kind,
      n: list.length,
      acted,
      rate: Math.round(rate * 1000) / 1000,
      overallRate: Math.round(overallRate * 1000) / 1000,
      rawDelta,
      delta,
      decayed,
      newestSample,
      evidence: `You acted on ${acted} of ${list.length} ${first.projectLabel} ${first.priority} ${KIND_LABEL[first.kind]} within ${LEARN_ACT_WITHIN_BUSINESS_DAYS} business days (your overall rate is ${Math.round(overallRate * 100)}%), n=${list.length}${decayed ? "; last sample over 30 days ago, so the effect is halved" : ""}`,
    });
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.groupKey.localeCompare(b.groupKey));
}

export interface LearnedLookup {
  delta: number;
  adjustment?: LearnedAdjustment;
  /** Set when a hard rule stopped a negative delta from being applied. */
  exemptBecause?: "overdue" | "blocked" | "P1" | "awaiting-you-past-SLA";
}

/** HARD RULES WIN: a negative delta is never applied to a ticket that is overdue, blocked, P1, or waiting on
 *  the user's reply past the reply SLA. (Positive deltas always apply.) */
export function learnedDeltaFor(
  item: Pick<WorkItem, "key" | "projectId" | "type" | "priority" | "dueDate" | "blocked">,
  kind: SignalKind,
  adjustments: readonly LearnedAdjustment[] | undefined,
  ctx: { today: string; awaitingMe?: AwaitingMeSignal }
): LearnedLookup {
  const adjustment = adjustments?.find((a) => a.groupKey === groupKeyOf({ projectId: item.projectId, issueType: item.type, priority: item.priority, kind }));
  if (!adjustment || adjustment.delta === 0) return { delta: 0 };
  if (adjustment.delta < 0) {
    const exempt: LearnedLookup["exemptBecause"] | undefined =
      item.dueDate && item.dueDate < ctx.today ? "overdue" : item.blocked ? "blocked" : item.priority === "P1" ? "P1" : ctx.awaitingMe && awaitingMeAgeBusinessDays(ctx.awaitingMe, ctx.today) > REPLY_SLA_BUSINESS_DAYS ? "awaiting-you-past-SLA" : undefined;
    if (exempt) return { delta: 0, adjustment, exemptBecause: exempt };
  }
  return { delta: adjustment.delta, adjustment };
}

/** Weekly Review: what learning moved, both directions, so nothing is de-prioritised silently. */
export function learningMoves(adjustments: readonly LearnedAdjustment[], limit = 3): { raised: LearnedAdjustment[]; lowered: LearnedAdjustment[] } {
  return {
    raised: adjustments.filter((a) => a.delta > 0).slice(0, limit),
    lowered: adjustments.filter((a) => a.delta < 0).slice(0, limit),
  };
}

/** Should the Weekly Review propose switching shadow -> on? After 14 days of shadow data, with something to show. */
export function shouldProposeLearningOn(mode: LearnedMode, shadowSince: string | undefined, adjustments: readonly LearnedAdjustment[], today: string): boolean {
  if (mode !== "shadow" || !shadowSince) return false;
  return calendarDaysBetween(shadowSince, today) >= LEARN_SHADOW_DAYS_BEFORE_PROPOSAL && adjustments.some((a) => a.delta !== 0);
}
