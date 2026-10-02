// My Work — one page for every ticket that is mine to act on, split into views that PARTITION
// the tickets (each ticket appears in exactly one view): Today · New · In progress · Blocked ·
// Skipped/Deferred · Done (7 days). It absorbs Your Delivery Focus, My Assigned Work, My Day's
// agenda and Daily Review: the population is the union of what those surfaces showed, and every
// row's status is read through getTicketView (ticket-work-state.ts) — the same selector every
// other list uses. Pure; the page (app/my-work) and the Command Center summary render it.

import type { DailyReview } from "./daily-review";
import { newReasonLabel } from "./daily-review";
import { getAssignedWorkItems } from "./assigned-work";
import { isWorkItemDoneOrExcluded, type WorkRelevanceIndex } from "./jira/work-relevance";
import type { PersonalRelationIdentity } from "./personal-relation";
import type { AttentionItem, FocusSignal, PersonalFocusCandidate, PersonalPlanItem, TaskReactivation, TicketWorkState, WorkItem } from "./types";
import { addDays } from "./date-utils";
import { getTicketView, type TicketView } from "./ticket-work-state";
import { blockedAgeBusinessDays, isBlockerOverdue } from "./blocker-followup";

export type MyWorkView = "today" | "new" | "in-progress" | "blocked" | "skipped" | "done";

export const MY_WORK_VIEWS: { id: MyWorkView; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "new", label: "New" },
  { id: "in-progress", label: "In progress" },
  { id: "blocked", label: "Blocked" },
  { id: "skipped", label: "Skipped / Deferred" },
  { id: "done", label: "Done (7 days)" },
];

export const MY_WORK_DONE_WINDOW_DAYS = 7;

export function isMyWorkView(v: unknown): v is MyWorkView {
  return typeof v === "string" && MY_WORK_VIEWS.some((x) => x.id === v);
}

export interface MyWorkRow {
  ticketKey: string;
  workItem?: WorkItem;
  view: TicketView;
  /** Why it's on my list: assigned to me / in my focus / on today's plan / I recorded a status. */
  sources: ("assigned" | "focus" | "plan" | "recorded" | "new")[];
  /** Highest focus score among its signals (ranking within Today). */
  score: number;
  /** Ticket done in Jira with no personal record (shown in Done, read-only). */
  finishedInJira: boolean;
  /** Daily Review: skip/block whose re-check day has come. */
  recheckDue: boolean;
  /** Daily Review "Completed recently" caption source. */
  doneSources?: ("jira" | "daily-command")[];
  /** F2 — business days blocked (BLOCKED rows only). */
  blockedAgeBusinessDays?: number;
  /** F2 — blocked longer than the SLA. */
  overdueBlocker?: boolean;
}

export interface MyWorkInput {
  workItems: WorkItem[];
  identity: PersonalRelationIdentity;
  workRelevanceIndex?: WorkRelevanceIndex;
  ticketWorkStates: Record<string, TicketWorkState>;
  today: string;
  /** Deduped focus candidates (one per ticket, signals merged). */
  focusCandidates?: PersonalFocusCandidate[];
  personalPlan?: PersonalPlanItem[];
  /** Daily Review over the same data (New rows, Jira completions, reactivations). */
  review?: DailyReview;
  /** Open attention signals — adds chips the focus engine doesn't carry (e.g. Stale, which is
   *  Attention-only by design), so a ticket row lists every signal on it. */
  attentionItems?: AttentionItem[];
  /** F2 — when set, blocked tickets older than this many business days are "overdue": they lead
   *  the Blocked view and are listed (as pointers) at the top of Today. */
  blockerSlaBusinessDays?: number;
}

const ATTENTION_SIGNAL_LABEL: Record<string, string> = { MENTION: "Mention", STALE: "Stale", RISK: "Risk", ASSIGNMENT: "Assigned", DEPENDENCY: "Dependency", DECISION: "Decision", ACTION: "Action", COMMUNICATION: "Communication", DRIFT: "Drift" };

export interface MyWork {
  views: Record<MyWorkView, MyWorkRow[]>;
  counts: Record<MyWorkView, number>;
  /** Nav badge: unreviewed New + skips/blocks/deferrals due for a re-check today. */
  badge: number;
  /** Focus candidates with no single ticket (loops, portfolio signals) — shown in Today. */
  ticketlessFocus: PersonalFocusCandidate[];
  /** F2 — overdue blockers (oldest first); the rows themselves stay in the Blocked view. */
  overdueBlockers: MyWorkRow[];
}

export function buildMyWork(input: MyWorkInput): MyWork {
  const { workItems, identity, workRelevanceIndex, ticketWorkStates, today, review } = input;
  const byKey = new Map(workItems.map((w) => [w.key, w]));
  const sources = new Map<string, Set<MyWorkRow["sources"][number]>>();
  const add = (key: string, src: MyWorkRow["sources"][number]) => {
    if (!sources.has(key)) sources.set(key, new Set());
    sources.get(key)!.add(src);
  };

  for (const w of getAssignedWorkItems(workItems, identity)) add(w.key, "assigned");
  const signals = new Map<string, FocusSignal[]>();
  const score = new Map<string, number>();
  for (const c of input.focusCandidates ?? []) {
    if (!c.ticketKey) continue;
    add(c.ticketKey, "focus");
    signals.set(c.ticketKey, c.signals ?? []);
    score.set(c.ticketKey, Math.max(score.get(c.ticketKey) ?? 0, c.score));
  }
  for (const a of input.attentionItems ?? []) {
    if (!a.ticketKey || a.lifecycle === "RESOLVED" || a.lifecycle === "SNOOZED") continue;
    const list = [...(signals.get(a.ticketKey) ?? [])]; // never mutate a focus candidate's own array
    if (!list.some((s) => s.kind === a.category)) list.push({ kind: a.category, label: ATTENTION_SIGNAL_LABEL[a.category] ?? a.category, candidateId: `attention:${a.id}`, attentionItemId: a.id, score: 0 });
    signals.set(a.ticketKey, list);
  }
  for (const p of input.personalPlan ?? []) if (p.ticketKey && p.plannedDate === today) add(p.ticketKey, "plan");
  for (const r of Object.values(ticketWorkStates)) if (r.status !== "TODO") add(r.ticketKey, "recorded");
  const newReasons = new Map<string, string>();
  for (const r of review?.newRows ?? []) {
    add(r.ticketKey, "new");
    newReasons.set(r.ticketKey, newReasonLabel(r.reasons));
  }
  const reactivations = new Map<string, TaskReactivation>();
  for (const r of [...(review?.dueForRecheck ?? []), ...(review?.skipped ?? []), ...(review?.blocked ?? []), ...(review?.completedRecently ?? [])]) if (r.reactivation) reactivations.set(r.ticketKey, r.reactivation);
  const jiraDone = new Map<string, ("jira" | "daily-command")[]>();
  for (const r of review?.completedRecently ?? []) {
    jiraDone.set(r.ticketKey, r.sources);
    if (r.sources.includes("jira")) add(r.ticketKey, "recorded");
  }

  const ctx = { ticketWorkStates, today, workItemsByKey: byKey, workRelevanceIndex, newReasons, reactivations, signals };
  const views: Record<MyWorkView, MyWorkRow[]> = { today: [], new: [], "in-progress": [], blocked: [], skipped: [], done: [] };
  const doneSince = addDays(today, -(MY_WORK_DONE_WINDOW_DAYS - 1));
  let recheckDue = 0;

  for (const [key, src] of Array.from(sources.entries())) {
    const view = getTicketView(key, ctx);
    const w = byKey.get(key);
    const finishedInJira = view.status === "TODO" && !!w && isWorkItemDoneOrExcluded(w, workRelevanceIndex);
    // Re-check due: a skip/block whose re-check day has come (it stays skipped/blocked until I
    // act), or a deferral coming back today.
    const due = ((view.status === "SKIPPED" || view.status === "BLOCKED") && !!view.until && view.until <= today) || (view.status === "DEFERRED" && view.until === today);
    if (due) recheckDue++;
    const age = view.status === "BLOCKED" ? blockedAgeBusinessDays(ticketWorkStates[key]?.updatedAt, today) : undefined;
    const overdue = input.blockerSlaBusinessDays !== undefined && isBlockerOverdue(age, input.blockerSlaBusinessDays);
    const row: MyWorkRow = {
      ticketKey: key,
      ...(age !== undefined ? { blockedAgeBusinessDays: age } : {}),
      ...(overdue ? { overdueBlocker: true } : {}),
      ...(w ? { workItem: w } : {}),
      view,
      sources: Array.from(src),
      score: score.get(key) ?? 0,
      finishedInJira,
      recheckDue: due,
      ...(jiraDone.has(key) ? { doneSources: jiraDone.get(key) } : {}),
    };
    let target: MyWorkView | null;
    if (finishedInJira) target = jiraDone.has(key) ? "done" : null; // done in Jira long ago: not mine to act on
    else if (view.bucket === "DONE") target = (view.since ?? "").slice(0, 10) >= doneSince || jiraDone.has(key) ? "done" : null;
    else if (view.bucket === "IN_PROGRESS") target = "in-progress";
    else if (view.bucket === "BLOCKED") target = "blocked";
    else if (view.bucket === "SKIPPED_DEFERRED") target = "skipped";
    else target = view.isNew ? "new" : "today";
    if (target) views[target].push(row);
  }

  const bySince = (a: MyWorkRow, b: MyWorkRow) => (b.view.since ?? "").localeCompare(a.view.since ?? "") || a.ticketKey.localeCompare(b.ticketKey);
  views.today.sort((a, b) => b.score - a.score || Number(b.sources.includes("plan")) - Number(a.sources.includes("plan")) || a.ticketKey.localeCompare(b.ticketKey));
  views.new.sort((a, b) => a.ticketKey.localeCompare(b.ticketKey));
  views["in-progress"].sort(bySince);
  views.blocked.sort((a, b) => Number(!!b.overdueBlocker) - Number(!!a.overdueBlocker) || (b.overdueBlocker ? (b.blockedAgeBusinessDays ?? 0) - (a.blockedAgeBusinessDays ?? 0) : 0) || Number(b.recheckDue) - Number(a.recheckDue) || bySince(a, b));
  views.skipped.sort((a, b) => Number(b.recheckDue) - Number(a.recheckDue) || bySince(a, b));
  views.done.sort(bySince);
  if (review) {
    // Keep Daily Review's own New order (newest reason first).
    const order = new Map(review.newRows.map((r, i) => [r.ticketKey, i]));
    views.new.sort((a, b) => (order.get(a.ticketKey) ?? 0) - (order.get(b.ticketKey) ?? 0));
  }

  const counts = Object.fromEntries(Object.entries(views).map(([k, v]) => [k, v.length])) as Record<MyWorkView, number>;
  return { views, counts, badge: counts.new + recheckDue, ticketlessFocus: (input.focusCandidates ?? []).filter((c) => !c.ticketKey), overdueBlockers: views.blocked.filter((r) => r.overdueBlocker) };
}

/** Which view a ticket is in (or null when it isn't on My Work) — for the consistency tests. */
export function myWorkViewOf(work: MyWork, ticketKey: string): MyWorkView | null {
  for (const v of MY_WORK_VIEWS) if (work.views[v.id].some((r) => r.ticketKey === ticketKey)) return v.id;
  return null;
}
