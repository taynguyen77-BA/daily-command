// V2.50 R1 — Report Narrative: a 3-5 sentence summary of a Daily / Weekly report that can be spoken at a standup or pasted into
// a work log (EN / VI). PURE: no I/O. The deterministic text is always available and never fabricates; AI only rewords it
// on demand, and every AI text is re-checked here (sentence count, ticket keys, numbers, oldest blocker, completion verbs).
//
//   report view -> buildNarrativeFacts() -> deterministicNarrative()           CALCULATED
//                                        -> (optional) AI -> narrativeViolations()  AI DRAFT or back to the line above

import { lockedFactViolations } from "./ai/locked-facts";
import { isInternalNote } from "./ai/report-rewrite";
import { blockedAging, type RiskSummary } from "./report-summary";
import type { DailyReportView, ReportTicket, WeeklyReportView } from "./reports";

export type NarrativeStyle = "standup" | "worklog";
export type NarrativeLanguage = "en" | "vi";
export type NarrativeKind = "daily" | "weekly";

export interface NarrativeItem {
  key: string;
  title?: string;
  project?: string;
}
export interface NarrativeBlockedItem extends NarrativeItem {
  ageBusinessDays?: number;
  waitingFor?: string;
  reason?: string;
}
export interface NarrativeCounts {
  done: number;
  inProgress: number;
  blocked: number;
  newReceived: number;
  mentionsAwaitingReply: number;
  overdueBlockers: number;
  decisions: number;
  projects: number;
  doneNotListed: number;
  carriedOver?: number;
  reportedDays?: number;
  missingDays?: number;
  slaBusinessDays?: number;
  /** Weekly: how many open assigned / re-check tickets next week has (the list is capped at 15). */
  nextWeek?: number;
}
/** Exactly the input of the `summarizeReport` AI task (task-registry.ts). */
export interface NarrativeFacts {
  kind: NarrativeKind;
  periodPhrase: string;
  style: NarrativeStyle;
  language: NarrativeLanguage;
  counts: NarrativeCounts;
  done: NarrativeItem[];
  inProgress: NarrativeItem[];
  /** Oldest blocker first. */
  blocked: NarrativeBlockedItem[];
  nextWeek?: NarrativeItem[];
  decisions: string[];
  risk?: { title: string; level: string };
}

export const NARRATIVE_LIMITS = { done: 40, inProgress: 25, blocked: 15, nextWeek: 15, decisions: 10 } as const;
export const MAX_NARRATIVE_KEYS = 6;
export const NARRATIVE_MAX_CHARS = 1000;

// ===== Sentence counting ================================================================

/** Splits on . ! ? … followed by whitespace and an uppercase letter (Latin or Vietnamese), a digit, a quote or a bracket.
 *  Never inside ticket keys, decimals (3.5), ISO dates, or e.g. / i.e. / vs. / etc. A trailing fragment counts as a sentence. */
export function splitSentences(text: string): string[] {
  const protectedText = text
    .replace(/(\d)\.(\d)/g, "$1\u0000$2")
    .replace(/\b(e\.g|i\.e|vs|etc|approx|incl)\.(?=\s)/gi, (m) => `${m.slice(0, -1)}\u0000`);
  return protectedText
    .split(/[.!?…]+(?=\s+["'“‘(\[]?[\p{Lu}\d])/u)
    .map((s) => s.replace(/\u0000/g, ".").trim())
    .filter((s) => /\S/.test(s));
}
export const countSentences = (text: string): number => splitSentences(text).length;

// ===== Facts ============================================================================

const KEY_RE = /\b[A-Z][A-Z0-9_]{1,19}-\d{1,9}\b/;
const projectKeyOf = (key: string): string => key.split("-")[0].toUpperCase();

/** A title / reason as one clause: no sentence punctuation (so the sentence count stays 3-5), single spaces, bounded. */
function clause(text: string | undefined, max: number): string | undefined {
  const t = (text ?? "").replace(/[.!?…]+(?=\s|$)/g, "").replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const periodPhraseOf = (kind: NarrativeKind, language: NarrativeLanguage, view: DailyReportView | WeeklyReportView, today: string): string => {
  if (kind === "daily") {
    const date = (view as DailyReportView).date;
    if (date === today) return language === "vi" ? "Hôm nay" : "Today";
    return language === "vi" ? `Ngày ${date}` : `On ${date}`;
  }
  const w = view as WeeklyReportView;
  const range = language === "vi" ? `${w.weekStart} đến ${w.weekEnd}` : `${w.weekStart} to ${w.weekEnd}`;
  const current = w.weekStart <= today && today <= w.weekEnd;
  return language === "vi" ? `${current ? "Tuần này" : "Tuần"} (${range})` : `${current ? "This week" : "The week"} (${range})`;
};

export interface BuildNarrativeFactsInput {
  kind: NarrativeKind;
  view: DailyReportView | WeeklyReportView;
  style: NarrativeStyle;
  language: NarrativeLanguage;
  /** Local YYYY-MM-DD. */
  today: string;
  /** Team work is never part of the narrative (counts included); kept explicit so a caller cannot ask for it by accident. */
  includeTeam?: false;
  /** AI path: project keys on the AI allow-list. Titles / reasons / waiting-for are kept ONLY for these projects; others are key + project name only.
   *  Omit for the local deterministic text, which may use every title. */
  allowedProjects?: readonly string[];
  risk?: RiskSummary;
}

export function buildNarrativeFacts(input: BuildNarrativeFactsInput): { facts: NarrativeFacts; keyOnly: number } {
  const { kind, view, style, language, today } = input;
  const allowed = input.allowedProjects ? new Set(input.allowedProjects.map((k) => k.toUpperCase())) : null;
  let keyOnly = 0;
  const withTitle = (key: string) => !allowed || allowed.has(projectKeyOf(key));
  const item = (t: ReportTicket, project?: string): NarrativeItem | null => {
    if (!t.key || !KEY_RE.test(t.key)) return null;
    const full = withTitle(t.key);
    if (!full) keyOnly++;
    const title = full ? clause(t.title, 80) : undefined;
    const proj = clause(project ?? t.project, 60);
    return { key: t.key, ...(title ? { title } : {}), ...(proj ? { project: proj } : {}) };
  };
  const items = (ts: ReportTicket[], max: number): NarrativeItem[] => ts.map((t) => item(t)).filter((x): x is NarrativeItem => !!x).slice(0, max);
  const blockedItem = (t: ReportTicket): NarrativeBlockedItem | null => {
    const base = item(t);
    if (!base) return null;
    const full = withTitle(t.key!);
    const reason = full ? clause((t.notes ?? []).find((n) => n.trim() && !isInternalNote(n)), 120) : undefined;
    const waitingFor = full ? clause(t.waitsOn?.[0], 120) : undefined;
    return { ...base, ...(t.ageBusinessDays !== undefined ? { ageBusinessDays: t.ageBusinessDays } : {}), ...(waitingFor ? { waitingFor } : {}), ...(reason ? { reason } : {}) };
  };

  let doneTickets: ReportTicket[];
  let inProgressTickets: ReportTicket[] = [];
  let blockedTickets: ReportTicket[];
  let counts: NarrativeCounts;
  let decisions: string[];
  let nextWeek: NarrativeItem[] | undefined;
  let doneItems: NarrativeItem[];
  let projectCount: number;

  if (kind === "daily") {
    const v = view as DailyReportView;
    doneTickets = v.doneMine;
    inProgressTickets = v.inProgress;
    blockedTickets = v.blocked;
    decisions = v.decisions;
    doneItems = items(doneTickets, NARRATIVE_LIMITS.done);
    projectCount = new Set(v.doneMine.map((t) => t.project).filter(Boolean)).size;
    counts = {
      done: v.doneMine.length,
      inProgress: v.inProgress.length,
      blocked: v.blocked.length,
      newReceived: v.newToday.length,
      mentionsAwaitingReply: v.mentionsAwaitingReply.length,
      overdueBlockers: v.overdueBlockers?.length ?? 0,
      decisions: v.decisions.length,
      projects: projectCount,
      doneNotListed: 0,
      ...(v.slaBusinessDays !== undefined ? { slaBusinessDays: v.slaBusinessDays } : {}),
    };
  } else {
    const w = view as WeeklyReportView;
    doneTickets = w.doneGroups.flatMap((g) => g.tickets);
    blockedTickets = w.blockers;
    decisions = w.decisions;
    const grouped = w.doneGroups.flatMap((g) => g.tickets.map((t) => item(t, w.groupBy === "project" && g.name !== "No project" ? g.name : undefined)));
    doneItems = grouped.filter((x): x is NarrativeItem => !!x).slice(0, NARRATIVE_LIMITS.done);
    projectCount = w.groupBy === "project" ? w.doneGroups.filter((g) => g.name !== "No project").length : new Set(doneTickets.map((t) => t.project).filter(Boolean)).size;
    nextWeek = items(w.nextWeek, NARRATIVE_LIMITS.nextWeek);
    counts = {
      done: w.totals.doneMine,
      inProgress: 0,
      blocked: w.blockers.length,
      newReceived: w.totals.newReceived,
      mentionsAwaitingReply: 0,
      overdueBlockers: 0,
      decisions: w.decisions.length,
      projects: projectCount,
      doneNotListed: 0,
      carriedOver: w.carriedOver.length,
      reportedDays: w.reportedDays.length,
      missingDays: w.missingDays.length,
      nextWeek: w.nextWeek.length,
    };
  }
  counts.doneNotListed = Math.max(0, counts.done - doneItems.length);
  const blocked = blockedAging(blockedTickets).map(blockedItem).filter((x): x is NarrativeBlockedItem => !!x).slice(0, NARRATIVE_LIMITS.blocked);
  const facts: NarrativeFacts = {
    kind,
    periodPhrase: periodPhraseOf(kind, language, view, today),
    style,
    language,
    counts,
    done: doneItems,
    inProgress: items(inProgressTickets, NARRATIVE_LIMITS.inProgress),
    blocked,
    ...(nextWeek ? { nextWeek } : {}),
    decisions: decisions.map((d) => clause(d, 300)).filter((d): d is string => !!d).slice(0, NARRATIVE_LIMITS.decisions),
    ...(input.risk ? { risk: { title: clause(input.risk.title, 300) ?? "", level: input.risk.level ?? "" } } : {}),
  };
  return { facts, keyOnly };
}

/** FNV-1a over the facts: a narrative stored for an older hash is "Report changed since". */
export function narrativeFactsHash(facts: NarrativeFacts): string {
  const text = JSON.stringify(facts);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** Everything the narrative may quote — the source text its keys and numbers are checked against (same content the AI prompt carries). */
export function narrativeSourceText(f: NarrativeFacts): string {
  const line = (i: NarrativeItem) => `${i.key}${i.title ? ` — ${i.title}` : ""}${i.project ? ` (${i.project})` : ""}`;
  return [
    f.periodPhrase,
    Object.entries(f.counts).map(([k, v]) => `${k}=${v}`).join(" "),
    ...f.done.map(line),
    ...f.inProgress.map(line),
    ...f.blocked.map((b) => `${line(b)}${b.ageBusinessDays !== undefined ? ` — ${b.ageBusinessDays} business days` : ""}${b.waitingFor ? ` — waiting for ${b.waitingFor}` : ""}${b.reason ? ` — ${b.reason}` : ""}`),
    ...(f.nextWeek ?? []).map(line),
    ...f.decisions,
    f.risk ? `${f.risk.title} ${f.risk.level}` : "",
  ].join("\n");
}

// ===== Deterministic narrative ===========================================================

const KEYS_GLOBAL = /\b[A-Z][A-Z0-9_]{1,19}-\d{1,9}\b/g;
const COMPLETION_VERB = /\b(completed|finished|done|closed|shipped)\b|hoàn thành|\bxong\b|đã đóng/i;

type Words = {
  ticket: (n: number) => string;
  and: string;
  more: (n: number) => string;
  completedStandup: (period: string, n: string, across: string, list: string) => string;
  completedWorklog: (period: string, n: string, across: string, list: string) => string;
  noneDone: (noun: string) => string;
  across: (p: number) => string;
  progressStandup: (n: string, list: string) => string;
  progressWorklog: (n: string, list: string) => string;
  noneProgress: string;
  blockedStandup: (it: string, age: string, why: string, total: number) => string;
  blockedWorklog: (it: string, age: string, total: number) => string;
  noneBlocked: string;
  attention: (parts: string[]) => string;
  mentions: (n: number) => string;
  overSla: (n: number, sla?: number) => string;
  decisions: (n: number) => string;
  weeklyTail: (carried: number, next: number, missing: number) => string;
};

const EN: Words = {
  ticket: (n) => `${n} ${n === 1 ? "ticket" : "tickets"}`,
  and: "and",
  more: (n) => `${n} more`,
  completedStandup: (p, n, a, l) => `${p} I completed ${n}${a}${l ? `, including ${l}` : ""}.`,
  completedWorklog: (p, n, a, l) => `${p} I completed ${n}${a}${l ? `: ${l}` : ""}.`,
  noneDone: (noun) => `No completed tickets are recorded for ${noun}.`,
  across: (p) => ` across ${p} projects`,
  progressStandup: (n, l) => `I'm continuing with ${n} in progress${l ? `, mainly ${l}` : ""}.`,
  progressWorklog: (n, l) => `I also progressed ${n}${l ? ` (${l})` : ""}.`,
  noneProgress: "Nothing is recorded as in progress.",
  blockedStandup: (it, age, why, total) => `${it} has been blocked${age}${why}${total > 1 ? `; ${total} tickets are blocked in total` : ""}.`,
  blockedWorklog: (it, age, total) => `${it} remained blocked${age ? ` (${age.replace(/^ for /, "")})` : ""}${total > 1 ? `; ${total} tickets are blocked in total` : ""}.`,
  noneBlocked: "No blockers are recorded.",
  attention: (parts) => `Needs attention: ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]}.`,
  mentions: (n) => `${n} ${n === 1 ? "mention is" : "mentions are"} awaiting my reply`,
  overSla: (n, sla) => `${n} ${n === 1 ? "blocker" : "blockers"} over ${sla ? `the ${sla}-business-day ` : ""}SLA`,
  decisions: (n) => `${n} ${n === 1 ? "decision" : "decisions"} recorded`,
  weeklyTail: (c, n, m) => `${c} ${c === 1 ? "ticket is" : "tickets are"} carried over from before this week and next week has ${n} open assigned or scheduled re-check${n === 1 ? "" : "s"}${m > 0 ? `; ${m} working ${m === 1 ? "day has" : "days have"} no report` : ""}.`,
};

const VI: Words = {
  ticket: (n) => `${n} ticket`,
  and: "và",
  more: (n) => `${n} ticket khác`,
  completedStandup: (p, n, a, l) => `${p} tôi đã hoàn thành ${n}${a}${l ? `, trong đó có ${l}` : ""}.`,
  completedWorklog: (p, n, a, l) => `${p} tôi đã hoàn thành ${n}${a}${l ? `: ${l}` : ""}.`,
  noneDone: (noun) => `Chưa ghi nhận ticket nào hoàn thành ${noun}.`,
  across: (p) => ` thuộc ${p} dự án`,
  progressStandup: (n, l) => `Tôi đang tiếp tục xử lý ${n} đang thực hiện${l ? `, chủ yếu là ${l}` : ""}.`,
  progressWorklog: (n, l) => `Tôi cũng đã làm tiếp ${n}${l ? ` (${l})` : ""}.`,
  noneProgress: "Không có ticket nào đang thực hiện.",
  blockedStandup: (it, age, why, total) => `${it} đang bị chặn${age}${why}${total > 1 ? `; tổng cộng ${total} ticket đang bị chặn` : ""}.`,
  blockedWorklog: (it, age, total) => `${it} vẫn bị chặn${age ? ` (${age.replace(/^ được /, "")})` : ""}${total > 1 ? `; tổng cộng ${total} ticket đang bị chặn` : ""}.`,
  noneBlocked: "Không có ticket nào bị chặn.",
  attention: (parts) => `Cần chú ý: ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} và ${parts[parts.length - 1]}` : parts[0]}.`,
  mentions: (n) => `${n} mention đang chờ tôi trả lời`,
  overSla: (n, sla) => `${n} ticket bị chặn quá SLA${sla ? ` ${sla} ngày làm việc` : ""}`,
  decisions: (n) => `${n} quyết định đã ghi nhận`,
  weeklyTail: (c, n, m) => `${c} ticket được chuyển tiếp từ trước tuần này và tuần sau có ${n} ticket được giao hoặc cần kiểm tra lại${m > 0 ? `; ${m} ngày làm việc chưa có báo cáo` : ""}.`,
};

const describe = (i: NarrativeItem): string => (i.title ? `${i.key} (${i.title})` : i.key);

function listItems(items: NarrativeItem[], max: number, w: Words, notListed = 0): string {
  const shown = items.slice(0, max).map(describe);
  const parts = notListed > 0 ? [...shown, w.more(notListed)] : shown;
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} ${w.and} ${parts[parts.length - 1]}`;
}

const periodNoun = (f: NarrativeFacts): string => {
  const p = f.periodPhrase;
  if (/^(Today|Hôm nay)$/.test(p)) return f.language === "vi" ? "hôm nay" : "today";
  if (/^On /.test(p)) return p.slice(3);
  if (/^Ngày /.test(p)) return p.slice(5);
  return p.charAt(0).toLowerCase() + p.slice(1);
};

/** Always 3-5 sentences, EN or VI, from the facts only: titles only when present, every number from COUNTS or a list, "N more" only from doneNotListed. */
export function deterministicNarrative(f: NarrativeFacts): string {
  const w = f.language === "vi" ? VI : EN;
  const c = f.counts;
  const out: string[] = [];
  const standup = f.style === "standup";

  // 1 — done
  if (c.done === 0) out.push(w.noneDone(periodNoun(f)));
  else {
    const list = listItems(f.done, 3, w, c.doneNotListed);
    const across = c.projects >= 2 ? w.across(c.projects) : "";
    out.push((standup ? w.completedStandup : w.completedWorklog)(f.periodPhrase, w.ticket(c.done), across, list));
  }
  // 2 — in progress (weekly reports carry no in-progress list: the sentence says so instead of guessing)
  if (f.kind === "weekly") out.push(f.language === "vi" ? "Báo cáo tuần không ghi nhận ticket đang thực hiện." : "The weekly report does not record tickets in progress.");
  else if (c.inProgress === 0) out.push(w.noneProgress);
  else out.push((standup ? w.progressStandup : w.progressWorklog)(w.ticket(c.inProgress), listItems(f.inProgress, 2, w)));
  // 3 — blockers (oldest first)
  const top = f.blocked[0];
  if (!top) out.push(w.noneBlocked);
  else if (standup) {
    const age = top.ageBusinessDays !== undefined ? (f.language === "vi" ? ` được ${top.ageBusinessDays} ngày làm việc` : ` for ${top.ageBusinessDays} business ${top.ageBusinessDays === 1 ? "day" : "days"}`) : "";
    const why = top.waitingFor ? (f.language === "vi" ? `, đang chờ ${top.waitingFor}` : `, waiting on ${top.waitingFor}`) : top.reason ? `: ${top.reason}` : "";
    out.push(w.blockedStandup(describe(top), age, why, c.blocked));
  } else {
    const age = top.ageBusinessDays !== undefined ? (f.language === "vi" ? ` được ${top.ageBusinessDays} ngày làm việc` : ` for ${top.ageBusinessDays} business ${top.ageBusinessDays === 1 ? "day" : "days"}`) : "";
    out.push(w.blockedWorklog(describe(top), age, c.blocked));
  }
  // 4 — attention (standup only; a work log has no requests)
  if (standup) {
    const parts: string[] = [];
    if (c.mentionsAwaitingReply > 0) parts.push(w.mentions(c.mentionsAwaitingReply));
    if (c.overdueBlockers > 0) parts.push(w.overSla(c.overdueBlockers, c.slaBusinessDays));
    if (c.decisions > 0) parts.push(w.decisions(c.decisions));
    if (parts.length > 0) out.push(w.attention(parts));
  }
  // 5 — weekly tail
  if (f.kind === "weekly") out.push(w.weeklyTail(c.carriedOver ?? 0, c.nextWeek ?? f.nextWeek?.length ?? 0, c.missingDays ?? 0));
  return out.join(" ");
}

// ===== Verification (server and browser share it) =========================================

/** Why an AI narrative must not be shown (empty = fine). `facts` is the task input. */
export function narrativeViolations(text: string, facts: NarrativeFacts): string[] {
  const v: string[] = [];
  const sentences = splitSentences(text);
  if (sentences.length < 3 || sentences.length > 5) v.push(`the narrative must have 3 to 5 sentences (it has ${sentences.length})`);
  if (text.length > NARRATIVE_MAX_CHARS) v.push(`the narrative is longer than ${NARRATIVE_MAX_CHARS} characters`);
  v.push(...lockedFactViolations(text, narrativeSourceText(facts)));
  const keys = Array.from(new Set(text.match(KEYS_GLOBAL) ?? []));
  if (keys.length > MAX_NARRATIVE_KEYS) v.push(`more than ${MAX_NARRATIVE_KEYS} ticket keys are mentioned`);
  const oldest = facts.blocked[0]?.key;
  if (oldest && !keys.includes(oldest)) v.push(`the oldest blocked ticket ${oldest} is not named`);
  const doneKeys = new Set(facts.done.map((d) => d.key));
  const blockedOnly = facts.blocked.map((b) => b.key).filter((k) => !doneKeys.has(k));
  for (const s of sentences) {
    if (!COMPLETION_VERB.test(s)) continue;
    for (const k of blockedOnly) if (s.includes(k)) v.push(`blocked ticket ${k} is described with a completion verb`);
  }
  return Array.from(new Set(v));
}

// ===== Stored narratives (optional state; old blobs load) =================================

export interface StoredNarrative {
  /** `${kind}:${periodKey}:${style}:${language}` */
  key: string;
  text: string;
  source: "ai" | "edited";
  factsHash: string;
  createdAt: string;
  /** "AI draft" provenance (tier only — never a prompt). */
  tier?: string;
}
export interface NarrativePrefs {
  style: NarrativeStyle;
  language: NarrativeLanguage;
}
export const DEFAULT_NARRATIVE_PREFS: NarrativePrefs = { style: "standup", language: "en" };
export const MAX_STORED_NARRATIVES = 90;

export const narrativeStorageKey = (kind: NarrativeKind, periodKey: string, style: NarrativeStyle, language: NarrativeLanguage): string => `${kind}:${periodKey}:${style}:${language}`;

export function asReportNarratives(raw: unknown): Record<string, StoredNarrative> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, StoredNarrative> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const s = v as Partial<StoredNarrative> | null;
    if (s && s.key === k && typeof s.text === "string" && (s.source === "ai" || s.source === "edited") && typeof s.factsHash === "string" && typeof s.createdAt === "string") out[k] = s as StoredNarrative;
  }
  return out;
}
export function asNarrativePrefs(raw: unknown): NarrativePrefs {
  const r = (raw ?? {}) as Partial<NarrativePrefs>;
  return { style: r.style === "worklog" ? "worklog" : "standup", language: r.language === "vi" ? "vi" : "en" };
}
/** Adds one narrative; the oldest (by createdAt) beyond MAX_STORED_NARRATIVES are evicted. */
export function putNarrative(all: Record<string, StoredNarrative>, n: StoredNarrative): Record<string, StoredNarrative> {
  const next = { ...all, [n.key]: n };
  const keys = Object.keys(next);
  if (keys.length > MAX_STORED_NARRATIVES) for (const k of keys.sort((a, b) => next[a].createdAt.localeCompare(next[b].createdAt)).slice(0, keys.length - MAX_STORED_NARRATIVES)) delete next[k];
  return next;
}
