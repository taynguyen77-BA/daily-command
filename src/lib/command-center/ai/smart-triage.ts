// V2.37 I2 — Smart Triage for Morning Mode step 2. ONE batched fast-tier call over the New
// items; each gets a category (Reply needed / Review needed / Do / FYI), a suggested action,
// a confidence and a one-line rationale.
//
//   - Only metadata leaves the browser for a project outside the AI allow-list (key, title,
//     type, status, why it's new, my role) — never its comment text. Allow-listed projects
//     add the last comment excerpt (≤ 300 chars). Everything is redacted.
//   - Nothing is applied until the user ticks items and clicks "Apply selected"; each then goes
//     through setTicketStatus with surface "ai-triage" and a reason prefixed "AI-suggested".
//     Low-confidence suggestions start unticked.
//   - Acceptance per category is recorded locally (store.recordTriageAcceptance) for the
//     Weekly Review.

import { addDays } from "../date-utils";
import type { TicketStatusSurface, TicketWorkStatus } from "../types";
import { isProjectAiAllowed, projectKeyOf, type AiDataProtectionSettings } from "./data-protection";
import { RedactionSession } from "./redaction";
import type { TaskInput } from "./task-registry";
import { TRIAGE_CATEGORIES, type TriageResponse } from "./schemas";
import { AI_SUGGESTED_PREFIX } from "./ticket-brief";

export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];
export type TriageSuggestion = TriageResponse["items"][number];

export interface TriageCandidate {
  key: string;
  title: string;
  type: string;
  status: string;
  signal: string;
  role: string;
  lastCommentExcerpt?: string;
}

export const TRIAGE_LOW_CONFIDENCE = 0.6;
export const TRIAGE_MAX_ITEMS = 50;

/** Tomorrow, the day after, next Monday, and a week out — the only dates "defer" may use. */
export function deferDatesFor(today: string): string[] {
  const d = new Date(today + "T00:00:00");
  const toMonday = ((8 - d.getDay()) % 7) || 7;
  return Array.from(new Set([addDays(today, 1), addDays(today, 2), addDays(today, toMonday), addDays(today, 7)])).sort();
}

export function buildTriageInput(candidates: TriageCandidate[], settings: AiDataProtectionSettings, today: string): { input: TaskInput<"triageNewItems">; session: RedactionSession; metadataOnlyKeys: string[] } {
  const session = new RedactionSession(settings.customTerms);
  const metadataOnlyKeys: string[] = [];
  const items = candidates.slice(0, TRIAGE_MAX_ITEMS).map((c) => {
    const allowed = isProjectAiAllowed(settings, projectKeyOf(c.key));
    if (!allowed) metadataOnlyKeys.push(c.key);
    const excerpt = allowed && c.lastCommentExcerpt ? session.redact(c.lastCommentExcerpt.slice(0, 300)).slice(0, 300) : undefined;
    return {
      key: c.key,
      title: session.redact(c.title).slice(0, 500),
      type: c.type.slice(0, 60),
      status: c.status.slice(0, 100),
      signal: session.redact(c.signal).slice(0, 300),
      role: c.role.slice(0, 200),
      ...(excerpt !== undefined ? { lastCommentExcerpt: excerpt } : {}),
    };
  });
  return { input: { today, deferDates: deferDatesFor(today), items }, session, metadataOnlyKeys };
}

export const defaultChecked = (s: TriageSuggestion) => s.confidence >= TRIAGE_LOW_CONFIDENCE;

/** Suggestions for the frozen New list: one per key (unknown keys dropped, missing keys get a
 *  cautious "keep"), aliases restored, grouped by category in a stable order. */
export function normalizeTriage(keys: string[], raw: TriageSuggestion[], session: RedactionSession): TriageSuggestion[] {
  const byKey = new Map(raw.filter((r) => keys.includes(r.key)).map((r) => [r.key, session.restoreDeep(r)]));
  return keys.map((k) => byKey.get(k) ?? { key: k, category: "FYI" as const, action: { kind: "keep" as const }, confidence: 0, rationale: "No suggestion for this item." });
}

export function groupByCategory(items: TriageSuggestion[]): { category: TriageCategory; items: TriageSuggestion[] }[] {
  return TRIAGE_CATEGORIES.map((category) => ({ category, items: items.filter((i) => i.category === category) })).filter((g) => g.items.length > 0);
}

type TriageApplyStore = {
  setTicketStatus(key: string, status: TicketWorkStatus, opts: { surface: TicketStatusSurface; reason?: string; until?: string }): boolean;
  markDailyReviewSeen(keys: string[]): void;
  recordTriageAcceptance(day: string, rows: { category: TriageCategory; accepted: boolean }[]): void;
};

/** "Apply selected" — the ONLY place a triage suggestion changes anything. */
export function applyTriageSelection(store: TriageApplyStore, suggestions: TriageSuggestion[], selected: Set<string>, today: string): { applied: string[] } {
  const surface: TicketStatusSurface = "ai-triage";
  const applied: string[] = [];
  for (const s of suggestions) {
    if (!selected.has(s.key)) continue;
    const why = `${AI_SUGGESTED_PREFIX}${s.action.reason?.trim() || s.rationale}`;
    const a = s.action;
    if (a.kind === "done") store.setTicketStatus(s.key, "DONE", { surface, reason: why });
    else if (a.kind === "defer") store.setTicketStatus(s.key, "DEFERRED", { surface, reason: why, until: a.until && a.until > today ? a.until : addDays(today, 1) });
    else if (a.kind === "block") store.setTicketStatus(s.key, "BLOCKED", { surface, reason: why });
    else if (a.kind === "skip") store.setTicketStatus(s.key, "SKIPPED", { surface, reason: why });
    // "keep" = stays TODO on Today; like Morning Mode's Enter it only acknowledges the row.
    applied.push(s.key);
  }
  if (applied.length) store.markDailyReviewSeen(applied);
  store.recordTriageAcceptance(
    today,
    suggestions.map((s) => ({ category: s.category, accepted: selected.has(s.key) }))
  );
  return { applied };
}

// ----- acceptance stats (local) -----

export type TriageStatsByDay = Record<string, Partial<Record<TriageCategory, { suggested: number; accepted: number }>>>;

export function addTriageStats(stats: TriageStatsByDay, day: string, rows: { category: TriageCategory; accepted: boolean }[], keepDays = 90): TriageStatsByDay {
  const dayStats = { ...(stats[day] ?? {}) };
  for (const r of rows) {
    const cur = dayStats[r.category] ?? { suggested: 0, accepted: 0 };
    dayStats[r.category] = { suggested: cur.suggested + 1, accepted: cur.accepted + (r.accepted ? 1 : 0) };
  }
  const next = { ...stats, [day]: dayStats };
  const days = Object.keys(next).sort();
  for (const d of days.slice(0, Math.max(0, days.length - keepDays))) delete next[d];
  return next;
}

/** Acceptance rate per category over [fromDay, toDay]. */
export function triageAcceptance(stats: TriageStatsByDay, fromDay: string, toDay: string): { category: TriageCategory; suggested: number; accepted: number; rate: number }[] {
  return TRIAGE_CATEGORIES.map((category) => {
    let suggested = 0;
    let accepted = 0;
    for (const [day, s] of Object.entries(stats)) {
      if (day < fromDay || day > toDay) continue;
      suggested += s[category]?.suggested ?? 0;
      accepted += s[category]?.accepted ?? 0;
    }
    return { category, suggested, accepted, rate: suggested ? accepted / suggested : 0 };
  }).filter((r) => r.suggested > 0);
}

export function asTriageStats(raw: unknown): TriageStatsByDay {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: TriageStatsByDay = {};
  for (const [day, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !v || typeof v !== "object") continue;
    const d: TriageStatsByDay[string] = {};
    for (const c of TRIAGE_CATEGORIES) {
      const e = (v as Record<string, { suggested?: unknown; accepted?: unknown }>)[c];
      if (e && typeof e.suggested === "number" && typeof e.accepted === "number") d[c] = { suggested: e.suggested, accepted: e.accepted };
    }
    out[day] = d;
  }
  return out;
}
