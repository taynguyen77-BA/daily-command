// F5 — report summaries. Every Daily/Weekly Report opens with ONE deterministic paragraph —
// counts, the top blocker, the biggest risk — plus two sections: "Blocked aging" (oldest
// first) and "Needs decision from" (open decisions and decision-blocked tickets, by person).
// No AI involved. The optional "Polish with AI" rewrite is accepted only when it keeps every
// number and every ticket key exactly (checkPolishPreservesFacts) — otherwise the
// deterministic text stays.

import type { Decision, Risk, RiskLevel } from "./types";
import type { ReportTicket } from "./reports";

export interface RiskSummary {
  title: string;
  level?: RiskLevel;
}

export interface NeedsDecisionGroup {
  person: string;
  items: string[];
}

const LEVEL_ORDER: Record<RiskLevel, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const OPEN_DECISION = new Set<Decision["status"]>(["pending", "PROPOSED", "UNDER_REVIEW", "AT_RISK", "REVISIT_REQUIRED"]);

/** The open risk with the highest level (first one on a tie — callers pass them ranked). */
export function biggestRisk(risks: Pick<Risk, "title" | "level" | "status">[] | undefined): RiskSummary | undefined {
  const open = (risks ?? []).filter((r) => r.status === "open");
  if (open.length === 0) return undefined;
  const top = open.reduce((best, r) => (LEVEL_ORDER[r.level] < LEVEL_ORDER[best.level] ? r : best));
  return { title: top.title, level: top.level };
}

/** Blocked tickets, oldest block first (unknown age last). */
export function blockedAging(blocked: ReportTicket[]): ReportTicket[] {
  return [...blocked].sort((a, b) => (b.ageBusinessDays ?? -1) - (a.ageBusinessDays ?? -1) || (a.key ?? "").localeCompare(b.key ?? ""));
}

/** Who a decision is needed from: open decisions by owner, and blocked tickets whose reason /
 *  waits-on mention a decision, by the person waited on. "Unassigned" when nobody is named. */
export function needsDecisionFrom(decisions: Pick<Decision, "title" | "status" | "owner">[] | undefined, blocked: ReportTicket[]): NeedsDecisionGroup[] {
  const groups = new Map<string, string[]>();
  const add = (person: string | undefined, item: string) => {
    const p = person?.trim() || "Unassigned";
    groups.set(p, [...(groups.get(p) ?? []), item]);
  };
  for (const d of decisions ?? []) if (OPEN_DECISION.has(d.status)) add(d.owner, d.title);
  for (const t of blocked) {
    const text = [...(t.notes ?? []), ...(t.waitsOn ?? [])].join(" ");
    if (!/decision/i.test(text)) continue;
    add(t.waitsOn?.[0]?.split(":")[0], `${t.key ?? ""}${t.title ? ` ${t.title}` : ""}`.trim());
  }
  return Array.from(groups.entries())
    .map(([person, items]) => ({ person, items }))
    .sort((a, b) => Number(a.person === "Unassigned") - Number(b.person === "Unassigned") || b.items.length - a.items.length || a.person.localeCompare(b.person));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function topBlockerSentence(aging: ReportTicket[]): string {
  const top = aging[0];
  if (!top) return "No blockers.";
  const age = top.ageBusinessDays !== undefined ? ` — blocked ${plural(top.ageBusinessDays, "business day")}` : "";
  const why = top.notes?.find((n) => n.trim()) ?? top.waitsOn?.[0];
  return `Top blocker: ${top.key ?? ""}${top.title ? ` ${top.title}` : ""}${age}${why ? ` (${why})` : ""}.`;
}

function riskSentence(risk: RiskSummary | undefined): string {
  return risk ? `Biggest risk: ${risk.title}${risk.level ? ` (${risk.level})` : ""}.` : "No open risks recorded.";
}

export interface DailySummaryInput {
  doneMine: number;
  inProgress: number;
  blocked: ReportTicket[];
  newToday: number;
  mentionsAwaitingReply: number;
  overdueBlockers?: number;
  risk?: RiskSummary;
}

export function dailySummary(input: DailySummaryInput): string {
  const aging = blockedAging(input.blocked);
  const overdue = input.overdueBlockers ? ` (${input.overdueBlockers} over SLA)` : "";
  const counts = `${input.doneMine} done, ${input.inProgress} in progress, ${input.blocked.length} blocked${overdue}, ${input.newToday} new, ${plural(input.mentionsAwaitingReply, "mention")} awaiting reply.`;
  return [counts, topBlockerSentence(aging), riskSentence(input.risk)].join(" ");
}

export interface WeeklySummaryInput {
  doneMine: number;
  newReceived: number;
  blockers: ReportTicket[];
  skipped: number;
  decisions: number;
  reportedDays: number;
  risk?: RiskSummary;
}

export function weeklySummary(input: WeeklySummaryInput): string {
  const counts = `This week: ${input.doneMine} done, ${input.newReceived} new received, ${input.blockers.length} blocked, ${input.skipped} skipped, ${plural(input.decisions, "decision")} (${plural(input.reportedDays, "day")} reported).`;
  return [counts, topBlockerSentence(blockedAging(input.blockers)), riskSentence(input.risk)].join(" ");
}

// ===== "Polish with AI" guard ==========================================================

const TICKET_KEY = /\b[A-Z][A-Z0-9_]{0,19}-\d+\b/g;
const NUMBER = /\b\d+(?:\.\d+)?\b/g;

function factsOf(text: string): { keys: string[]; numbers: string[] } {
  const keys = text.match(TICKET_KEY) ?? [];
  const withoutKeys = text.replace(TICKET_KEY, " ");
  return { keys: [...keys].sort(), numbers: [...(withoutKeys.match(NUMBER) ?? [])].sort() };
}

/** The AI rewrite may change wording only: the same ticket keys and the same numbers, each the
 *  same number of times. Returns why it was refused, or null when it is safe to show. */
export function checkPolishPreservesFacts(original: string, polished: string): string | null {
  if (!polished.trim()) return "The AI returned nothing.";
  const a = factsOf(original);
  const b = factsOf(polished);
  if (a.keys.join() !== b.keys.join()) return "The AI changed the ticket keys — keeping the original summary.";
  if (a.numbers.join() !== b.numbers.join()) return "The AI changed a number — keeping the original summary.";
  return null;
}
