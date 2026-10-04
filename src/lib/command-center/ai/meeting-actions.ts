// V2.38 J4 — Meeting Notes → Actions. Paste notes or a transcript; the model extracts
// decisions, action items, explicit ticket status changes and open questions. A REVIEW screen
// (edit + checkboxes) comes first; only "Create selected" calls the normal store APIs
// (addDecision / addAction / setTicketStatus with surface "ai-meeting"). Ticket keys that
// don't exist in the app are dropped (never created); dates are resolved from the notes' words.

import type { TicketStatusSurface, TicketWorkStatus } from "../types";
import type { AIProvider } from "./provider";
import { RedactionSession, type CustomTerm } from "./redaction";
import type { MeetingActionsResponse } from "./schemas";
import { AI_SUGGESTED_PREFIX } from "./ticket-brief";
import { resolveWhen } from "./when";

export interface ReviewDecision {
  id: string;
  title: string;
  detail?: string;
  selected: boolean;
}
export interface ReviewAction {
  id: string;
  title: string;
  owner?: string;
  dueText?: string;
  dueDate?: string;
  relatedTicketKey?: string;
  selected: boolean;
}
export interface ReviewStatusChange {
  id: string;
  ticketKey: string;
  status: TicketWorkStatus;
  reason?: string;
  until?: string;
  selected: boolean;
}
export interface MeetingReview {
  decisions: ReviewDecision[];
  actions: ReviewAction[];
  statusChanges: ReviewStatusChange[];
  openQuestions: string[];
  /** Ticket keys the notes mentioned that don't exist here — dropped, shown for transparency. */
  droppedKeys: string[];
}

/** Model output → the review screen. Unknown keys are dropped; dates resolved; everything
 *  starts selected except changes that need a date we couldn't resolve. */
export function toMeetingReview(out: MeetingActionsResponse, knownKeys: Set<string>, today: string): MeetingReview {
  const dropped = new Set<string>();
  const known = (k: string | undefined) => {
    if (!k) return undefined;
    const key = k.trim().toUpperCase();
    if (knownKeys.has(key)) return key;
    dropped.add(key);
    return undefined;
  };
  const actions = out.actions.map((a, i) => {
    const dueDate = resolveWhen(a.due, today);
    return { id: `a${i}`, title: a.title, ...(a.owner ? { owner: a.owner } : {}), ...(a.due ? { dueText: a.due } : {}), ...(dueDate ? { dueDate } : {}), ...(known(a.relatedTicketKey) ? { relatedTicketKey: known(a.relatedTicketKey) } : {}), selected: true };
  });
  const statusChanges: ReviewStatusChange[] = [];
  out.statusChanges.forEach((c, i) => {
    const key = known(c.ticketKey);
    if (!key) return;
    const until = c.status === "DEFERRED" ? resolveWhen(c.when, today) : undefined;
    statusChanges.push({ id: `s${i}`, ticketKey: key, status: c.status, ...(c.reason ? { reason: c.reason } : {}), ...(until ? { until } : {}), selected: c.status !== "DEFERRED" || !!until });
  });
  return {
    decisions: out.decisions.map((d, i) => ({ id: `d${i}`, title: d.title, ...(d.detail ? { detail: d.detail } : {}), selected: true })),
    actions,
    statusChanges,
    openQuestions: out.openQuestions,
    droppedKeys: Array.from(dropped).sort(),
  };
}

export async function extractMeetingReview(args: { notes: string; today: string; customTerms: CustomTerm[]; knownKeys: Set<string>; provider: Pick<AIProvider, "extractMeetingActions" | "mode"> }): Promise<{ review: MeetingReview; mode: "mock" | "claude" }> {
  const session = new RedactionSession(args.customTerms);
  const out = await args.provider.extractMeetingActions({ today: args.today, notes: session.redact(args.notes).slice(0, 20_000) });
  return { review: toMeetingReview(session.restoreDeep(out), args.knownKeys, args.today), mode: args.provider.mode };
}

type MeetingStore = {
  addDecision(d: { projectId: string; title: string; status: "ACTIVE"; description: string; date?: string; owner?: string; relatedWorkItemIds?: string[] }): string;
  addAction(a: { title: string; why: string; estimateMinutes: number; owner?: string; dueDate?: string; relatedWorkItemId?: string }): string;
  setTicketStatus(key: string, status: TicketWorkStatus, opts: { surface: TicketStatusSurface; reason?: string; until?: string }): boolean;
};

/** "Create selected" — the ONLY place the review changes anything. */
export function applyMeetingReview(store: MeetingStore, review: MeetingReview, ctx: { today: string; projectIdFor: (ticketKey?: string) => string; workItemIdFor: (ticketKey: string) => string | undefined; meetingLabel: string }): { decisions: number; actions: number; statusChanges: number } {
  let decisions = 0;
  let actions = 0;
  let statusChanges = 0;
  for (const d of review.decisions.filter((x) => x.selected && x.title.trim())) {
    store.addDecision({ projectId: ctx.projectIdFor(), title: d.title.trim(), status: "ACTIVE", description: d.detail?.trim() || d.title.trim(), date: ctx.today });
    decisions++;
  }
  for (const a of review.actions.filter((x) => x.selected && x.title.trim())) {
    const wid = a.relatedTicketKey ? ctx.workItemIdFor(a.relatedTicketKey) : undefined;
    store.addAction({ title: a.title.trim(), why: `From ${ctx.meetingLabel}`, estimateMinutes: 15, ...(a.owner ? { owner: a.owner } : {}), ...(a.dueDate ? { dueDate: a.dueDate } : {}), ...(wid ? { relatedWorkItemId: wid } : {}) });
    actions++;
  }
  for (const c of review.statusChanges.filter((x) => x.selected)) {
    if (store.setTicketStatus(c.ticketKey, c.status, { surface: "ai-meeting", reason: `${AI_SUGGESTED_PREFIX}${c.reason?.trim() || ctx.meetingLabel}`, ...(c.until ? { until: c.until } : {}) })) statusChanges++;
  }
  return { decisions, actions, statusChanges };
}
