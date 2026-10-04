// V2.38 J6 — Weekly Insights: deterministic facts about the week (ticket history, blockers by
// person, skip reasons, AI-triage acceptance) → 3-5 observations with evidence and 3
// suggestions. Shown in Weekly Review and (optionally) appended to the weekly report.

import type { TicketWorkState } from "../types";
import { groupAskByPerson, blockedFollowUpRows } from "../blocker-followup";
import type { CommandCenterData } from "../types";
import { triageAcceptance, type TriageStatsByDay } from "./smart-triage";
import type { AIProvider } from "./provider";
import type { WeeklyInsightsResponse } from "./schemas";
import { RedactionSession, type CustomTerm } from "./redaction";

export interface StoredWeeklyInsights {
  weekStart: string;
  createdAt: string;
  mode: "mock" | "claude";
  insights: WeeklyInsightsResponse;
}

export function buildWeeklyFacts(args: { states: Record<string, TicketWorkState>; data: Pick<CommandCenterData, "workItems" | "dependencies">; triageStats: TriageStatsByDay; weekStart: string; weekEnd: string }): string[] {
  const facts: string[] = [];
  const inWeek = (iso: string) => iso.slice(0, 10) >= args.weekStart && iso.slice(0, 10) <= args.weekEnd;
  const counts: Record<string, number> = {};
  const skipReasons: Record<string, number> = {};
  const aiSurfaces: Record<string, number> = {};
  for (const s of Object.values(args.states)) {
    for (const h of s.history) {
      if (!inWeek(h.at)) continue;
      counts[h.to] = (counts[h.to] ?? 0) + 1;
      if (h.to === "SKIPPED" && h.reason) skipReasons[h.reason.replace(/^AI-suggested: /, "")] = (skipReasons[h.reason.replace(/^AI-suggested: /, "")] ?? 0) + 1;
      if (h.surface.startsWith("ai-")) aiSurfaces[h.surface] = (aiSurfaces[h.surface] ?? 0) + 1;
    }
  }
  const order = ["DONE", "IN_PROGRESS", "BLOCKED", "SKIPPED", "DEFERRED", "TODO"];
  const changes = order.filter((k) => counts[k]).map((k) => `${k.toLowerCase().replace("_", " ")} ${counts[k]}`);
  facts.push(changes.length ? `Status changes this week: ${changes.join(", ")}.` : "No ticket status changes recorded this week.");
  const reasons = Object.entries(skipReasons).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (reasons.length) facts.push(`Skip reasons: ${reasons.map(([r, n]) => `"${r.slice(0, 60)}" ×${n}`).join(", ")}.`);
  const groups = groupAskByPerson(blockedFollowUpRows(args.states, args.data));
  for (const g of groups.slice(0, 8)) {
    const keys = Array.from(new Set(g.rows.flatMap((r) => r.why.match(/\b[A-Z][A-Z0-9_]+-\d+\b/g) ?? [])));
    facts.push(`Blocked waiting on ${g.isUnknownPerson ? "no recorded owner" : g.person}: ${keys.length} ticket(s) (${keys.slice(0, 6).join(", ")}).`);
  }
  for (const r of triageAcceptance(args.triageStats, args.weekStart, args.weekEnd)) facts.push(`AI triage "${r.category}": ${r.accepted} of ${r.suggested} suggestions applied.`);
  const ai = Object.entries(aiSurfaces);
  if (ai.length) facts.push(`Status changes applied from AI suggestions: ${ai.map(([k, n]) => `${k} ${n}`).join(", ")}.`);
  return facts;
}

export async function generateWeeklyInsights(args: { facts: string[]; weekStart: string; weekEnd: string; customTerms: CustomTerm[]; provider: Pick<AIProvider, "weeklyInsights" | "mode">; nowIso?: string }): Promise<StoredWeeklyInsights> {
  const session = new RedactionSession(args.customTerms);
  const out = await args.provider.weeklyInsights({ weekStart: args.weekStart, weekEnd: args.weekEnd, facts: args.facts.map((f) => session.redact(f).slice(0, 400)).slice(0, 80) });
  return { weekStart: args.weekStart, createdAt: args.nowIso ?? new Date().toISOString(), mode: args.provider.mode, insights: session.restoreDeep(out) };
}

export function weeklyInsightsText(s: StoredWeeklyInsights): string {
  return [
    `AI insights (${s.mode === "claude" ? "AI" : "deterministic"}):`,
    ...s.insights.observations.map((o) => `- ${o.text} [${o.evidence.join("; ")}]`),
    "Suggestions for next week:",
    ...s.insights.suggestions.map((x) => `- ${x}`),
  ].join("\n");
}

export function asWeeklyInsights(raw: unknown): Record<string, StoredWeeklyInsights> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, StoredWeeklyInsights> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const s = v as Partial<StoredWeeklyInsights> | null;
    if (s && s.weekStart === k && typeof s.createdAt === "string" && s.insights && Array.isArray(s.insights.observations) && Array.isArray(s.insights.suggestions)) out[k] = s as StoredWeeklyInsights;
  }
  return out;
}
