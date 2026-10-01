// B3/B4 — standup-ready Daily Report and Weekly Report, as ticket lists (key + Jira link +
// project), with Markdown / Slack mrkdwn / plain-text exports.
//
// Two inputs, kept apart on purpose:
//   - EVENTS (DailyReportSnapshot.events — frozen memoryEvents): what HAPPENED that day.
//     Done (mine / team), removed from scope, decisions, and — for a day with no standup
//     snapshot — the skips/blocks recorded that day.
//   - STANDUP STATE (DailyReportSnapshot.standup, built by buildStandupState): what was TRUE
//     at generation time — in progress / planned, blocked, skipped, new, mentions awaiting a
//     reply, open assigned work. Frozen with the report, so a past day reads what was true
//     then; today's view is built live.
// Never fabricates: a missing title/link/project is left out of the line, never "undefined".

import type {
  TicketWorkState,
  AttentionItemState,
  CommandCenterData,
  DailyCommandBlock,
  DailyCommandCompletion,
  DailyCommandSkip,
  DailyReportSnapshot,
  DailyReviewAck,
  MemoryEvent,
  MentionEvent,
  MentionReply,
  MyTicketActivity,
  PersonalPlanItem,
  SyncLogEntry,
  WorkItem,
} from "./types";
import { addDays, businessDaysBetween, toLocalIso } from "./date-utils";
import { getActiveAssignedWorkItems } from "./assigned-work";
import { buildDailyReview, newReasonLabel } from "./daily-review";
import { selectRecentMentions } from "./recent-mentions";
import { matchesIdentity, type PersonalRelationIdentity } from "./personal-relation";
import { isWorkItemDoneOrExcluded, type WorkRelevanceIndex } from "./jira/work-relevance";
import { slug } from "./attention-queue";
import { isMentionReplied } from "./mention-replies";

// ===== Shared shapes ===================================================================

export interface ReportTicket {
  /** Jira key; absent only for an in-app action that has no ticket. */
  key?: string;
  title?: string;
  url?: string;
  project?: string;
  client?: string;
  assignee?: string;
  sprint?: string;
  /** Free-form qualifier shown after the project ("via Daily Command", a reason, …). */
  notes?: string[];
  /** ISO datetime the ticket was first seen (for "carried over"). */
  since?: string;
  ageBusinessDays?: number;
  waitsOn?: string[];
  revisitOn?: string;
  /** D4 — set on "awaiting my reply" rows, so the UI can offer "Replied". */
  mention?: { commentId: string };
}

export interface StandupState {
  asOf: string;
  inProgress: ReportTicket[];
  blocked: ReportTicket[];
  skipped: ReportTicket[];
  newToday: ReportTicket[];
  mentionsAwaitingReply: ReportTicket[];
  /** All active assigned work (planned or not) — for the weekly "carried over" / "next week". */
  openAssigned: ReportTicket[];
}

export const MENTION_REPLY_WINDOW_DAYS = 14;

function ticketFromWorkItem(w: WorkItem, data: Pick<CommandCenterData, "projects" | "clients">, extra: Partial<ReportTicket> = {}): ReportTicket {
  const project = data.projects.find((p) => p.id === w.projectId);
  const client = data.clients.find((c) => c.id === (w.clientId ?? project?.clientId));
  return {
    key: w.key,
    title: w.title,
    ...(w.sourceUrl ? { url: w.sourceUrl } : {}),
    ...(project ? { project: project.name } : {}),
    ...(client ? { client: client.name } : {}),
    ...(w.owner ? { assignee: w.owner } : {}),
    ...(w.sprint ? { sprint: w.sprint } : {}),
    ...(w.firstSeenAt ? { since: w.firstSeenAt } : {}),
    ...extra,
  };
}

function ageInBusinessDays(at: string | undefined, now: Date): number | undefined {
  if (!at) return undefined;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return undefined;
  return businessDaysBetween(toLocalIso(d), toLocalIso(now));
}

/** A plan item's ticket — moved to ticket-work-state.ts (shared by the store's linking and
 *  the standup); re-exported here for existing importers. */
export { ticketKeyForPlanItem } from "./ticket-work-state";
import { ticketKeyForPlanItem } from "./ticket-work-state";

// ===== Standup state (live → frozen into the day's report) ===============================

export interface StandupInput {
  /** Scope-filtered data, same as every page. */
  data: CommandCenterData;
  identity: PersonalRelationIdentity;
  workRelevanceIndex?: WorkRelevanceIndex;
  dailyCommandCompletions: Record<string, DailyCommandCompletion>;
  dailyCommandSkips: Record<string, DailyCommandSkip>;
  dailyCommandBlocks: Record<string, DailyCommandBlock>;
  personalPlan: PersonalPlanItem[];
  /** Canonical ticket state — IN_PROGRESS tickets lead "In progress". Optional for old callers. */
  ticketWorkStates?: Record<string, TicketWorkState>;
  mentionEvents: MentionEvent[];
  attentionState: Record<string, AttentionItemState>;
  memoryEvents: MemoryEvent[];
  syncLog: SyncLogEntry[];
  baselineAt?: string;
  lastVisitAt?: string;
  reviewAcks?: Record<string, DailyReviewAck>;
  /** D4 — answered mentions leave "awaiting my reply" (omit both = pre-D behavior). */
  mentionReplies?: Record<string, MentionReply>;
  myTicketActivity?: Record<string, MyTicketActivity>;
  now: Date;
}

export function buildStandupState(input: StandupInput): StandupState {
  const { data, identity, workRelevanceIndex: index, now } = input;
  const today = toLocalIso(now);
  const byKey = new Map(data.workItems.map((w) => [w.key, w]));
  const keys = (m: Record<string, unknown>) => new Set(Object.keys(m));
  const active = getActiveAssignedWorkItems(data.workItems, identity, index, keys(input.dailyCommandCompletions), keys(input.dailyCommandSkips), keys(input.dailyCommandBlocks));

  // Planned today first (Focus plan), then the rest of the active assigned work.
  const plannedKeys: string[] = [];
  for (const r of Object.values(input.ticketWorkStates ?? {})) if (r.status === "IN_PROGRESS" && !plannedKeys.includes(r.ticketKey)) plannedKeys.push(r.ticketKey);
  for (const item of input.personalPlan) {
    if (item.plannedDate !== today || (item.status !== "planned" && item.status !== "in-progress")) continue;
    const key = ticketKeyForPlanItem(item, data);
    if (key && !plannedKeys.includes(key)) plannedKeys.push(key);
  }
  const paused = (key: string) => key in input.dailyCommandCompletions || key in input.dailyCommandSkips || key in input.dailyCommandBlocks;
  const inProgress: ReportTicket[] = [];
  for (const key of plannedKeys) {
    const w = byKey.get(key);
    if (!w || paused(key) || isWorkItemDoneOrExcluded(w, index)) continue;
    inProgress.push(ticketFromWorkItem(w, data, { notes: [input.ticketWorkStates?.[key]?.status === "IN_PROGRESS" ? "in progress" : "planned today"] }));
  }
  for (const w of active) if (!plannedKeys.includes(w.key)) inProgress.push(ticketFromWorkItem(w, data, w.status === "In Progress" ? { notes: ["in progress"] } : {}));

  const pausedTicket = (key: string, at: string, reason: string | undefined, revisitOn: string | undefined): ReportTicket => {
    const w = byKey.get(key);
    const base: ReportTicket = w ? ticketFromWorkItem(w, data) : { key };
    const age = ageInBusinessDays(at, now);
    const waitsOn = w
      ? data.dependencies.filter((d) => d.workItemId === w.id && d.status === "unresolved").map((d) => [d.dependsOnTeam, d.description].filter(Boolean).join(": "))
      : [];
    return {
      ...base,
      ...(reason?.trim() ? { notes: [reason.trim()] } : {}),
      ...(age !== undefined ? { ageBusinessDays: age } : {}),
      ...(waitsOn.length > 0 ? { waitsOn } : {}),
      ...(revisitOn ? { revisitOn } : {}),
    };
  };
  const blocked = Object.values(input.dailyCommandBlocks)
    .sort((a, b) => a.blockedAt.localeCompare(b.blockedAt))
    .map((b) => pausedTicket(b.ticketKey, b.blockedAt, b.reason, b.revisitOn));
  const skipped = Object.values(input.dailyCommandSkips)
    .sort((a, b) => a.skippedAt.localeCompare(b.skippedAt))
    .map((s) => pausedTicket(s.ticketKey, s.skippedAt, s.reason, s.revisitOn));

  const review = buildDailyReview({
    workItems: data.workItems,
    identity,
    workRelevanceIndex: index,
    dailyCommandCompletions: input.dailyCommandCompletions,
    dailyCommandSkips: input.dailyCommandSkips,
    dailyCommandBlocks: input.dailyCommandBlocks,
    memoryEvents: input.memoryEvents,
    mentionEvents: input.mentionEvents,
    attentionState: input.attentionState,
    syncLog: input.syncLog,
    baselineAt: input.baselineAt,
    lastVisitAt: input.lastVisitAt,
    reviewAcks: input.reviewAcks,
    now,
  });
  const onToday = (iso: string | undefined) => !!iso && !Number.isNaN(new Date(iso).getTime()) && toLocalIso(new Date(iso)) === today;
  const newToday = review.newRows
    .map((r) => ({ ...r, reasons: r.reasons.filter((reason) => onToday(reason.at)) }))
    .filter((r) => r.reasons.length > 0)
    .map((r) => (r.workItem ? ticketFromWorkItem(r.workItem, data, { notes: [newReasonLabel(r.reasons)] }) : { key: r.ticketKey, notes: [newReasonLabel(r.reasons)] }));

  // "Awaiting my reply" = mentions of me in the last N days that I haven't resolved,
  // acknowledged or snoozed in Attention, on tickets not finished (here or in Jira). Jira
  // doesn't say whether I replied, so this is the honest proxy, not reply detection.
  const mentions = selectRecentMentions(input.mentionEvents, data.workItems, input.attentionState, now.getTime(), {
    windowHours: MENTION_REPLY_WINDOW_DAYS * 24,
    dailyCommandCompletions: input.dailyCommandCompletions,
    dailyCommandSkips: input.dailyCommandSkips,
    dailyCommandBlocks: input.dailyCommandBlocks,
  }).filter((m) => {
    if (input.attentionState[`MENTION:${slug(m.issueKey)}:${slug(m.commentId)}`]?.lifecycle === "ACKNOWLEDGED") return false;
    if ((input.mentionReplies || input.myTicketActivity) && isMentionReplied(m, input.mentionReplies ?? {}, input.myTicketActivity ?? {})) return false;
    return !(m.workItem && isWorkItemDoneOrExcluded(m.workItem, index));
  });
  const mentionsAwaitingReply = mentions.map((m) => {
    const who = m.commentAuthor?.trim() || "Someone";
    const excerpt = m.excerpt.trim().replace(/\s+/g, " ");
    const note = `${who}: "${excerpt.length > 80 ? `${excerpt.slice(0, 77)}…` : excerpt}"`;
    const ref = { commentId: m.commentId };
    return m.workItem ? ticketFromWorkItem(m.workItem, data, { notes: [note], mention: ref, ...(m.commentUrl ? { url: m.commentUrl } : {}) }) : { key: m.issueKey, notes: [note], mention: ref, ...(m.commentUrl ? { url: m.commentUrl } : {}) };
  });

  return {
    asOf: now.toISOString(),
    inProgress,
    blocked,
    skipped,
    newToday,
    mentionsAwaitingReply,
    openAssigned: active.map((w) => ticketFromWorkItem(w, data)),
  };
}

// ===== Daily report ====================================================================

/** A stored standup (local or from another device) is only trusted with every list present. */
export function isStandupState(v: unknown): v is StandupState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Partial<StandupState>;
  return [s.inProgress, s.blocked, s.skipped, s.newToday, s.mentionsAwaitingReply, s.openAssigned].every(Array.isArray);
}

export interface DailyReportView {
  date: string;
  generatedAt?: string;
  doneMine: ReportTicket[];
  inProgress: ReportTicket[];
  blocked: ReportTicket[];
  skipped: ReportTicket[];
  newToday: ReportTicket[];
  mentionsAwaitingReply: ReportTicket[];
  teamDone: ReportTicket[];
  removedFromScope: ReportTicket[];
  decisions: string[];
  /** False for a day with no standup snapshot: sections 2/5/6 are then empty, 3/4 come from
   *  that day's recorded events. */
  standupAvailable: boolean;
  /** Whether "mine" could be told apart from "team" (an identity is configured). */
  identityConfigured: boolean;
}

const IN_APP_DONE = new Set<MemoryEvent["kind"]>(["TICKET_COMPLETED", "ACTION_COMPLETED", "FOCUS_COMPLETED"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDay(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00");
  return Number.isNaN(d.getTime()) ? isoDate : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function ticketFromEvent(e: MemoryEvent, notes: string[] = []): ReportTicket {
  const title = e.ticketTitle ?? (e.ticketKey ? undefined : e.title);
  return {
    ...(e.ticketKey ? { key: e.ticketKey } : {}),
    ...(title ? { title } : {}),
    ...(e.ticketUrl ? { url: e.ticketUrl } : {}),
    ...(e.projectName ? { project: e.projectName } : {}),
    ...(e.clientName ? { client: e.clientName } : {}),
    ...(e.assigneeName ? { assignee: e.assigneeName } : {}),
    ...(e.sprint ? { sprint: e.sprint } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}

function jiraDatedNote(e: MemoryEvent): string {
  return e.datedBy === "detection" && e.detectedOn ? `in Jira (detected ${shortDay(e.detectedOn)})` : "in Jira";
}

/** Done (mine) for one day's events: Daily Command / Action / Focus completions plus Jira
 *  completions assigned to me — ONE line per ticket however many paths recorded it, labelled
 *  with every source. A ticket completed then reopened the same day is not listed. */
function doneFromEvents(events: MemoryEvent[], identity: PersonalRelationIdentity): { mine: ReportTicket[]; team: ReportTicket[] } {
  const identityConfigured = !!identity.accountId || !!identity.displayName;
  const mine = new Map<string, { ticket: ReportTicket; sources: Set<string>; completedAt: number }>();
  const reopenedAt = new Map<string, number>();
  const keyless: ReportTicket[] = [];
  const team: ReportTicket[] = [];
  events.forEach((e, i) => {
    if (e.kind === "TICKET_REOPENED" && e.ticketKey) reopenedAt.set(e.ticketKey, i);
    const inApp = IN_APP_DONE.has(e.kind);
    const inJira = e.kind === "JIRA_STATUS_COMPLETED";
    if (!inApp && !inJira) return;
    const isMine = inApp || (identityConfigured && matchesIdentity(e.assigneeId, e.assigneeName, identity));
    const source = inApp ? "via Daily Command" : jiraDatedNote(e);
    if (!isMine) {
      team.push(ticketFromEvent(e, [source]));
      return;
    }
    if (!e.ticketKey) {
      keyless.push(ticketFromEvent(e, [source]));
      return;
    }
    const existing = mine.get(e.ticketKey);
    if (existing) {
      existing.sources.add(source);
      if (inApp) existing.completedAt = i;
      // Fill context a later event has and the first one lacked.
      existing.ticket = { ...ticketFromEvent(e), ...existing.ticket };
    } else mine.set(e.ticketKey, { ticket: ticketFromEvent(e), sources: new Set([source]), completedAt: inApp ? i : -1 });
  });
  const mineList = Array.from(mine.entries())
    .filter(([key, m]) => {
      const reopened = reopenedAt.get(key);
      // Reopened after its last in-app completion, and Jira didn't also close it → not done.
      return reopened === undefined || reopened < m.completedAt || Array.from(m.sources).some((s) => s.startsWith("in Jira"));
    })
    .map(([, m]) => ({ ...m.ticket, notes: Array.from(m.sources) }));
  return { mine: [...mineList, ...keyless], team };
}

/** For a day without a standup snapshot: the skips/blocks RECORDED that day, still standing
 *  at the end of that day's events. */
function pausedFromEvents(events: MemoryEvent[]): { blocked: ReportTicket[]; skipped: ReportTicket[] } {
  const last = new Map<string, MemoryEvent>();
  for (const e of events) {
    if (!e.ticketKey) continue;
    if (["TICKET_BLOCKED", "TICKET_SKIPPED", "TICKET_UNBLOCKED", "TICKET_REACTIVATED", "TICKET_COMPLETED", "TICKET_REOPENED"].includes(e.kind)) last.set(e.ticketKey, e);
  }
  const blocked: ReportTicket[] = [];
  const skipped: ReportTicket[] = [];
  for (const e of Array.from(last.values())) {
    if (e.kind === "TICKET_BLOCKED") blocked.push(ticketFromEvent(e, e.reason ? [e.reason] : []));
    if (e.kind === "TICKET_SKIPPED") skipped.push(ticketFromEvent(e, e.reason ? [e.reason] : []));
  }
  return { blocked, skipped };
}

/** One day's report. `standup` overrides the snapshot's own (pass the live state for today). */
export function buildDailyReportView(snapshot: DailyReportSnapshot | undefined, date: string, identity: PersonalRelationIdentity, standup?: StandupState): DailyReportView {
  const events = snapshot?.events ?? [];
  const state = standup ?? (isStandupState(snapshot?.standup) ? snapshot!.standup : undefined);
  const { mine, team } = doneFromEvents(events, identity);
  const paused = state ? { blocked: state.blocked, skipped: state.skipped } : pausedFromEvents(events);
  return {
    date,
    ...(snapshot?.generatedAt ? { generatedAt: snapshot.generatedAt } : {}),
    doneMine: mine,
    inProgress: state?.inProgress ?? [],
    blocked: paused.blocked,
    skipped: paused.skipped,
    newToday: state?.newToday ?? [],
    mentionsAwaitingReply: state?.mentionsAwaitingReply ?? [],
    teamDone: team,
    removedFromScope: events.filter((e) => e.kind === "JIRA_REMOVED_FROM_SCOPE").map((e) => ticketFromEvent(e, [jiraDatedNote(e).replace("in Jira", "in Jira status")])),
    decisions: events.filter((e) => e.kind === "DECISION_MADE").map((e) => e.title),
    standupAvailable: !!state,
    identityConfigured: !!identity.accountId || !!identity.displayName,
  };
}

// ===== Rendering =======================================================================

export type ReportFormat = "markdown" | "slack" | "text";

function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeMarkdown(text: string): string {
  return text.replace(/([\\[\]*_`])/g, "\\$1");
}

function ticketDetails(t: ReportTicket): string[] {
  const details: string[] = [];
  if (t.ageBusinessDays !== undefined) details.push(t.ageBusinessDays === 0 ? "since today" : `${t.ageBusinessDays} business day${t.ageBusinessDays === 1 ? "" : "s"}`);
  for (const n of t.notes ?? []) if (n.trim()) details.push(n.trim());
  if (t.waitsOn && t.waitsOn.length > 0) details.push(`waits on ${t.waitsOn.join("; ")}`);
  if (t.revisitOn) details.push(`re-check ${shortDay(t.revisitOn)}`);
  return details;
}

/** One ticket line, e.g. markdown: "[PAY-12](url) Fix login — Payments · via Daily Command". */
export function formatTicketLine(t: ReportTicket, format: ReportFormat, options: { showAssignee?: boolean } = {}): string {
  const esc = format === "slack" ? escapeSlack : format === "markdown" ? escapeMarkdown : (s: string) => s;
  const keyPart = t.key
    ? format === "markdown"
      ? t.url ? `[${t.key}](${t.url})` : `**${t.key}**`
      : format === "slack"
        ? t.url ? `<${t.url}|${t.key}>` : `*${t.key}*`
        : t.key
    : "";
  const head = [keyPart, t.title ? esc(t.title) : ""].filter(Boolean).join(" ");
  const context = [t.project, options.showAssignee ? t.assignee : undefined].filter((v): v is string => !!v?.trim()).map(esc).join(" · ");
  const details = ticketDetails(t).map(esc);
  let line = head || esc(t.key ?? "");
  if (context) line += ` — ${context}`;
  if (details.length > 0) line += ` · ${details.join(" · ")}`;
  if (format === "text" && t.url) line += ` (${t.url})`;
  return line;
}

function heading(text: string, level: 1 | 2, format: ReportFormat): string {
  if (format === "markdown") return `${level === 1 ? "#" : "##"} ${text}`;
  if (format === "slack") return `*${escapeSlack(text)}*`;
  return level === 1 ? text.toUpperCase() : text;
}

function bullet(format: ReportFormat): string {
  return format === "slack" ? "•" : "-";
}

function section(lines: string[], title: string, tickets: ReportTicket[], format: ReportFormat, options: { showAssignee?: boolean; empty?: string } = {}) {
  lines.push(heading(`${title} (${tickets.length})`, 2, format));
  if (tickets.length === 0) lines.push(`${bullet(format)} ${options.empty ?? "None."}`);
  else lines.push(...tickets.map((t) => `${bullet(format)} ${formatTicketLine(t, format, options)}`));
  lines.push("");
}

export interface RenderOptions {
  /** Team work section on/off (default on). */
  includeTeam?: boolean;
}

export function renderDailyReport(report: DailyReportView, format: ReportFormat, options: RenderOptions = {}): string {
  const lines: string[] = [heading(`Daily Report — ${report.date}`, 1, format), ""];
  section(lines, "Done", report.doneMine, format);
  section(lines, "In progress / planned today", report.inProgress, format);
  section(lines, "Blocked", report.blocked, format);
  section(lines, "Skipped", report.skipped, format);
  section(lines, "New today", report.newToday, format);
  section(lines, "Mentions awaiting my reply", report.mentionsAwaitingReply, format);
  if (report.removedFromScope.length > 0) section(lines, "Removed from scope", report.removedFromScope, format, { showAssignee: true });
  if (report.decisions.length > 0) {
    lines.push(heading(`Decisions (${report.decisions.length})`, 2, format));
    lines.push(...report.decisions.map((d) => `${bullet(format)} ${format === "slack" ? escapeSlack(d) : format === "markdown" ? escapeMarkdown(d) : d}`), "");
  }
  if (options.includeTeam !== false) section(lines, "Team: done", report.teamDone, format, { showAssignee: true });
  if (!report.standupAvailable) {
    const note = "No standup snapshot was saved for this day — in progress / new / mentions are not available.";
    lines.push(format === "text" ? `(${note})` : `_${note}_`, "");
  }
  while (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

// ===== Weekly report ===================================================================

export type WeeklyReportMode = "workweek" | "calendar";
export type WeeklyGroupBy = "project" | "sprint";

/** Monday (local) of the week containing `isoDate`. */
export function mondayOf(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00");
  const offset = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  return addDays(isoDate, -offset);
}

/** The days a week covers: Mon–Fri, or Mon–Sun in "calendar" mode. */
export function weekDays(weekStartMonday: string, mode: WeeklyReportMode = "workweek"): string[] {
  return Array.from({ length: mode === "calendar" ? 7 : 5 }, (_, i) => addDays(weekStartMonday, i));
}

export interface WeeklyReportView {
  weekStart: string;
  weekEnd: string;
  mode: WeeklyReportMode;
  /** Days in the range that have a report. */
  reportedDays: string[];
  /** Days that SHOULD have one and don't — past/today weekdays only (a quiet weekend or a day
   *  that hasn't happened yet is not a gap). */
  missingDays: string[];
  totals: { doneMine: number; teamDone: number; blocked: number; skipped: number; newReceived: number; decisions: number };
  groupBy: WeeklyGroupBy;
  /** Done (mine) grouped by project (or sprint) — ticket lists, not just counts. */
  doneGroups: { name: string; tickets: ReportTicket[] }[];
  teamDone: ReportTicket[];
  carriedOver: ReportTicket[];
  blockers: ReportTicket[];
  skipped: ReportTicket[];
  newReceived: ReportTicket[];
  decisions: string[];
  nextWeek: ReportTicket[];
  /** The day whose standup state the "as of" sections come from (undefined = none). */
  stateAsOf?: string;
}

export interface WeeklyReportInput {
  weekStart: string;
  mode?: WeeklyReportMode;
  groupBy?: WeeklyGroupBy;
  dailyReports: Record<string, DailyReportSnapshot>;
  identity: PersonalRelationIdentity;
  /** Live standup state, used for "today" when the week includes today. */
  liveStandup?: { date: string; state: StandupState };
  /** Local YYYY-MM-DD; days after it are not gaps yet. Defaults to the real today. */
  today?: string;
}

function isWeekend(isoDate: string): boolean {
  const day = new Date(isoDate + "T00:00:00").getDay();
  return day === 0 || day === 6;
}

export function buildWeeklyReportView(input: WeeklyReportInput): WeeklyReportView {
  const mode = input.mode ?? "workweek";
  const groupBy = input.groupBy ?? "project";
  const days = weekDays(mondayOf(input.weekStart), mode);
  const weekStart = days[0];
  const weekEnd = days[days.length - 1];
  const views = days.map((date) => {
    const live = input.liveStandup?.date === date ? input.liveStandup.state : undefined;
    return { date, has: !!input.dailyReports[date] || !!live, view: buildDailyReportView(input.dailyReports[date], date, input.identity, live) };
  });
  const reportedDays = views.filter((v) => v.has).map((v) => v.date);
  const today = input.today ?? toLocalIso(new Date());
  const missingDays = views.filter((v) => !v.has && !isWeekend(v.date) && v.date <= today).map((v) => v.date);

  const dedupe = (tickets: ReportTicket[]) => {
    const seen = new Map<string, ReportTicket>();
    const keyless: ReportTicket[] = [];
    for (const t of tickets) {
      if (!t.key) keyless.push(t);
      else {
        const prev = seen.get(t.key);
        seen.set(t.key, prev ? { ...prev, notes: Array.from(new Set([...(prev.notes ?? []), ...(t.notes ?? [])])) } : t);
      }
    }
    return [...Array.from(seen.values()), ...keyless];
  };
  const doneMine = dedupe(views.flatMap((v) => v.view.doneMine));
  const teamDone = dedupe(views.flatMap((v) => v.view.teamDone)).filter((t) => !t.key || !doneMine.some((m) => m.key === t.key));
  const newReceived = dedupe(views.flatMap((v) => v.view.newToday));
  const decisions = views.flatMap((v) => v.view.decisions);

  const groups = new Map<string, ReportTicket[]>();
  for (const t of doneMine) {
    const name = (groupBy === "sprint" ? t.sprint : t.project) ?? (groupBy === "sprint" ? "No sprint" : "No project");
    groups.set(name, [...(groups.get(name) ?? []), t]);
  }
  const doneGroups = Array.from(groups.entries())
    .map(([name, tickets]) => ({ name, tickets }))
    .sort((a, b) => b.tickets.length - a.tickets.length || a.name.localeCompare(b.name));

  // "As of" sections come from the latest day in the week that has standup state.
  const latest = [...views].reverse().find((v) => v.view.standupAvailable);
  const stateView = latest?.view;
  const weekStartIso = new Date(weekStart + "T00:00:00").toISOString();
  const carriedOver = stateView ? dedupe([...stateView.inProgress, ...stateView.blocked]).filter((t) => !!t.since && t.since < weekStartIso) : [];
  const nextMonday = addDays(weekStart, 7);
  const revisitNextWeek = stateView
    ? [...stateView.blocked, ...stateView.skipped].filter((t) => t.revisitOn && t.revisitOn >= nextMonday && t.revisitOn < addDays(nextMonday, 7))
    : [];
  const openAssigned = latest ? (input.liveStandup?.date === latest.date ? input.liveStandup.state : input.dailyReports[latest.date]?.standup)?.openAssigned ?? [] : [];

  return {
    weekStart,
    weekEnd,
    mode,
    reportedDays,
    missingDays,
    totals: {
      doneMine: doneMine.length,
      teamDone: teamDone.length,
      blocked: stateView?.blocked.length ?? 0,
      skipped: stateView?.skipped.length ?? 0,
      newReceived: newReceived.length,
      decisions: decisions.length,
    },
    groupBy,
    doneGroups,
    teamDone,
    carriedOver,
    blockers: stateView?.blocked ?? [],
    skipped: stateView?.skipped ?? [],
    newReceived,
    decisions,
    nextWeek: dedupe([...openAssigned, ...revisitNextWeek]),
    ...(latest ? { stateAsOf: latest.date } : {}),
  };
}

export function renderWeeklyReport(report: WeeklyReportView, format: ReportFormat, options: RenderOptions = {}): string {
  const lines: string[] = [heading(`Weekly Report — ${report.weekStart} to ${report.weekEnd}`, 1, format), ""];
  const b = bullet(format);
  const t = report.totals;
  lines.push(heading("Totals", 2, format));
  lines.push(`${b} Done (mine): ${t.doneMine}`, `${b} New received: ${t.newReceived}`, `${b} Blocked: ${t.blocked}`, `${b} Skipped: ${t.skipped}`, `${b} Decisions: ${t.decisions}`);
  if (options.includeTeam !== false) lines.push(`${b} Team done: ${t.teamDone}`);
  lines.push(`${b} Days with a report: ${report.reportedDays.length}${report.missingDays.length > 0 ? ` (missing: ${report.missingDays.join(", ")})` : ""}`, "");

  lines.push(heading(`Done by ${report.groupBy} (${t.doneMine})`, 2, format));
  if (report.doneGroups.length === 0) lines.push(`${b} None.`);
  for (const g of report.doneGroups) {
    lines.push(format === "markdown" ? `**${escapeMarkdown(g.name)} (${g.tickets.length})**` : format === "slack" ? `*${escapeSlack(g.name)} (${g.tickets.length})*` : `${g.name} (${g.tickets.length})`);
    lines.push(...g.tickets.map((tk) => `${b} ${formatTicketLine(tk, format)}`));
  }
  lines.push("");
  const asOf = report.stateAsOf ? ` — as of ${report.stateAsOf}` : "";
  section(lines, `Carried over from before this week${asOf}`, report.carriedOver, format);
  section(lines, `Blockers${asOf}`, report.blockers, format);
  section(lines, `Skipped${asOf}`, report.skipped, format);
  section(lines, "New received this week", report.newReceived, format);
  lines.push(heading(`Decisions (${report.decisions.length})`, 2, format));
  lines.push(...(report.decisions.length === 0 ? [`${b} None.`] : report.decisions.map((d) => `${b} ${format === "slack" ? escapeSlack(d) : format === "markdown" ? escapeMarkdown(d) : d}`)), "");
  section(lines, "Next week (open assigned + scheduled re-checks)", report.nextWeek, format);
  if (options.includeTeam !== false) section(lines, "Team: done this week", report.teamDone, format, { showAssignee: true });
  while (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
