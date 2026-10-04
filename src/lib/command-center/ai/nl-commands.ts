// V2.38 J5 — natural-language commands in the Command Bar ("defer all WF mentions to Monday",
// "block MCWS-123 waiting for API spec"). The model returns operations from an ALLOW-LISTED set
// (schemas COMMAND_OPS); this module resolves their targets against real data, deterministically:
//   - a ticket key must exist here; a project must match exactly one known project;
//   - a date must be a word we can resolve ("monday", "tomorrow", an ISO date…);
// anything unknown, ambiguous or empty becomes a clarification question — never a guess.
// The result is a preview diff; "Apply" runs it through the normal store APIs.

import type { CommandCenterData, MentionEvent, TicketWorkState, TicketWorkStatus, TicketStatusSurface } from "../types";
import type { AIProvider } from "./provider";
import { COMMAND_OPS, COMMAND_STATUSES, type CommandResponse } from "./schemas";
import { AI_SUGGESTED_PREFIX } from "./ticket-brief";
import { resolveWhen } from "./when";

export type ResolvedOperation =
  | { op: "setTicketStatus"; ticketKey: string; from: TicketWorkStatus; status: TicketWorkStatus; reason?: string; until?: string }
  | { op: "addAction"; title: string; ticketKey?: string; dueDate?: string };

export type CommandPlan = { kind: "preview"; operations: ResolvedOperation[] } | { kind: "clarify"; question: string };

const ALLOWED_OPS = new Set<string>(COMMAND_OPS);
const ALLOWED_STATUSES = new Set<string>(COMMAND_STATUSES);
const MAX_BULK = 50;

/** Quick pre-check: does this look like a command rather than a question? */
export function looksLikeCommand(q: string): boolean {
  return /^\s*(defer|block|unblock|skip|done|complete|finish|close|start|reopen|reactivate|move|mark|add (an )?action|remind me|create (an )?action)\b/i.test(q);
}

interface Ctx {
  data: Pick<CommandCenterData, "workItems" | "projects">;
  states: Record<string, TicketWorkState>;
  mentionEvents: MentionEvent[];
  /** Comment ids already answered (mention reply tracking). */
  repliedCommentIds: Set<string>;
  newKeys: string[];
  today: string;
}

function resolveProject(token: string | undefined, ctx: Ctx): { ok: true; key?: string } | { ok: false; question: string } {
  if (!token) return { ok: true };
  const t = token.trim().toLowerCase();
  const keys = Array.from(new Set(ctx.data.workItems.map((w) => w.key.split("-")[0])));
  const matches = keys.filter((k) => k.toLowerCase() === t);
  const byName = ctx.data.projects.filter((p) => p.name.toLowerCase().includes(t)).map((p) => ctx.data.workItems.find((w) => w.projectId === p.id)?.key.split("-")[0]).filter((k): k is string => !!k);
  const all = Array.from(new Set([...matches, ...(matches.length ? [] : byName)]));
  if (all.length === 1) return { ok: true, key: all[0] };
  if (all.length === 0) return { ok: false, question: `I don't know a project "${token}". Which project key do you mean?` };
  return { ok: false, question: `"${token}" matches several projects (${all.join(", ")}). Which one?` };
}

function statusOf(key: string, ctx: Ctx): TicketWorkStatus {
  return ctx.states[key]?.status ?? "TODO";
}

function targetKeys(target: NonNullable<CommandResponse["operations"][number]["target"]>, ctx: Ctx): { ok: true; keys: string[] } | { ok: false; question: string } {
  const known = new Set(ctx.data.workItems.map((w) => w.key));
  if (target.kind === "ticket") {
    const key = target.ticketKey?.trim().toUpperCase();
    if (!key || !known.has(key)) return { ok: false, question: `I can't find ticket ${target.ticketKey ?? "(none)"} here. Which ticket do you mean?` };
    return { ok: true, keys: [key] };
  }
  const proj = resolveProject(target.project, ctx);
  if (!proj.ok) return proj;
  const inProject = (k: string) => !proj.key || k.startsWith(`${proj.key}-`);
  let keys: string[] = [];
  if (target.kind === "mentions") keys = ctx.mentionEvents.filter((m) => !ctx.repliedCommentIds.has(m.commentId)).map((m) => m.issueKey);
  if (target.kind === "blocked") keys = Object.values(ctx.states).filter((s) => s.status === "BLOCKED").map((s) => s.ticketKey);
  if (target.kind === "in-progress") keys = Object.values(ctx.states).filter((s) => s.status === "IN_PROGRESS").map((s) => s.ticketKey);
  if (target.kind === "new") keys = ctx.newKeys;
  keys = Array.from(new Set(keys.filter((k) => known.has(k) && inProject(k)))).sort();
  if (keys.length === 0) return { ok: false, question: `Nothing matches "${target.kind}${proj.key ? ` in ${proj.key}` : ""}". Did you mean something else?` };
  if (keys.length > MAX_BULK) return { ok: false, question: `That matches ${keys.length} tickets — please narrow it down (e.g. by project).` };
  return { ok: true, keys };
}

/** Model output → a preview, or a clarification. Never throws, never guesses. */
export function resolveCommand(out: CommandResponse, ctx: Ctx): CommandPlan {
  if (out.clarification && out.operations.length === 0) return { kind: "clarify", question: out.clarification };
  if (out.operations.length === 0) return { kind: "clarify", question: "I couldn't turn that into an action. Try e.g. “block ABC-12 waiting for the API spec” or “defer all ABC mentions to Monday”." };
  const operations: ResolvedOperation[] = [];
  for (const op of out.operations) {
    if (!ALLOWED_OPS.has(op.op)) return { kind: "clarify", question: `"${op.op}" is not something commands can do.` };
    if (op.op === "addAction") {
      if (!op.title?.trim()) return { kind: "clarify", question: "What should the action say?" };
      let ticketKey: string | undefined;
      if (op.target) {
        const t = targetKeys(op.target, ctx);
        if (!t.ok) return { kind: "clarify", question: t.question };
        if (t.keys.length !== 1) return { kind: "clarify", question: "Which single ticket is this action for?" };
        ticketKey = t.keys[0];
      }
      const dueDate = resolveWhen(op.when, ctx.today);
      if (op.when && !dueDate) return { kind: "clarify", question: `When is "${op.when}"? Use a day like Monday, tomorrow, or a date.` };
      operations.push({ op: "addAction", title: op.title.trim(), ...(ticketKey ? { ticketKey } : {}), ...(dueDate ? { dueDate } : {}) });
      continue;
    }
    if (!op.status || !ALLOWED_STATUSES.has(op.status)) return { kind: "clarify", question: "Which status should it get?" };
    if (!op.target) return { kind: "clarify", question: "Which ticket(s) do you mean?" };
    const t = targetKeys(op.target, ctx);
    if (!t.ok) return { kind: "clarify", question: t.question };
    const until = resolveWhen(op.when, ctx.today);
    if (op.status === "DEFERRED" && !until) return { kind: "clarify", question: op.when ? `When is "${op.when}"? Use a day like Monday, tomorrow, or a date.` : "Defer until when?" };
    for (const key of t.keys) {
      const from = statusOf(key, ctx);
      if (from === op.status) continue; // already there — not part of the diff
      operations.push({ op: "setTicketStatus", ticketKey: key, from, status: op.status, ...(op.reason?.trim() ? { reason: op.reason.trim() } : {}), ...(until && op.status !== "DONE" ? { until } : {}) });
    }
  }
  if (operations.length === 0) return { kind: "clarify", question: "Everything you named is already in that state — nothing to change." };
  return { kind: "preview", operations };
}

export async function planCommand(command: string, ctx: Ctx, provider: Pick<AIProvider, "parseCommand">, knownProjects: { key: string; name?: string }[]): Promise<CommandPlan> {
  const out = await provider.parseCommand({ today: ctx.today, command: command.slice(0, 500), knownProjects: knownProjects.slice(0, 200) });
  return resolveCommand(out, ctx);
}

type CommandStore = {
  setTicketStatus(key: string, status: TicketWorkStatus, opts: { surface: TicketStatusSurface; reason?: string; until?: string }): boolean;
  addAction(a: { title: string; why: string; estimateMinutes: number; dueDate?: string; relatedWorkItemId?: string }): string;
};

/** "Apply" — runs the previewed operations through the normal store APIs, nothing else. */
export function applyCommandPlan(store: CommandStore, ops: ResolvedOperation[], command: string, workItemIdFor: (key: string) => string | undefined): number {
  let n = 0;
  for (const o of ops) {
    if (o.op === "setTicketStatus") {
      if (store.setTicketStatus(o.ticketKey, o.status, { surface: "ai-command", reason: `${AI_SUGGESTED_PREFIX}${o.reason ?? command.slice(0, 200)}`, ...(o.until ? { until: o.until } : {}) })) n++;
    } else {
      const wid = o.ticketKey ? workItemIdFor(o.ticketKey) : undefined;
      store.addAction({ title: o.title, why: `Command: ${command.slice(0, 200)}`, estimateMinutes: 15, ...(o.dueDate ? { dueDate: o.dueDate } : {}), ...(wid ? { relatedWorkItemId: wid } : {}) });
      n++;
    }
  }
  return n;
}

// ----- deterministic parser (the mock provider; also works without AI) -----

const VERB_STATUS: [RegExp, (typeof COMMAND_STATUSES)[number]][] = [
  [/^(defer|postpone|push|move)\b/i, "DEFERRED"],
  [/^unblock\b/i, "IN_PROGRESS"],
  [/^block\b/i, "BLOCKED"],
  [/^skip\b/i, "SKIPPED"],
  [/^(done|complete|finish|close|mark (?:as )?done)\b/i, "DONE"],
  [/^(start|begin)\b/i, "IN_PROGRESS"],
  [/^(reopen|reactivate)\b/i, "TODO"],
];

export function parseCommandDeterministic(command: string): CommandResponse {
  const c = command.trim();
  const action = /^(?:add|create) (?:an )?action:?\s+(.+?)(?:\s+(?:for|on)\s+([A-Z][A-Z0-9_]+-\d+))?(?:\s+by\s+(\S+(?:\s\w+)?))?$/i.exec(c);
  if (action) return { operations: [{ op: "addAction", title: action[1], ...(action[2] ? { target: { kind: "ticket", ticketKey: action[2] } } : {}), ...(action[3] ? { when: action[3] } : {}) }] };
  const verb = VERB_STATUS.find(([re]) => re.test(c));
  if (!verb) return { operations: [], clarification: "I couldn't turn that into an action. Try e.g. “block ABC-12 waiting for the API spec” or “defer all ABC mentions to Monday”." };
  const status = verb[1];
  const keys = c.match(/\b[A-Z][A-Z0-9_]+-\d+\b/g) ?? [];
  const when = /\b(?:to|until|till|on)\s+((?:next |this )?\w+|\d{4}-\d{2}-\d{2})\s*$/i.exec(c)?.[1];
  const reason = /\b(?:waiting (?:for|on)|because|reason:?)\s+(.+)$/i.exec(c)?.[0];
  const bulk = /\ball\s+(?:(\S+)\s+)?(mentions|blocked|new|in[- ]progress)\b/i.exec(c);
  const base = { op: "setTicketStatus" as const, status, ...(when && status === "DEFERRED" ? { when } : {}), ...(reason ? { reason } : {}) };
  if (keys.length) return { operations: keys.map((k) => ({ ...base, target: { kind: "ticket" as const, ticketKey: k } })) };
  if (bulk) return { operations: [{ ...base, target: { kind: bulk[2].toLowerCase().replace(" ", "-") as "mentions" | "blocked" | "new" | "in-progress", ...(bulk[1] ? { project: bulk[1] } : {}) } }] };
  return { operations: [], clarification: "Which ticket(s) do you mean? Name a key (ABC-12) or say e.g. “all ABC mentions”." };
}
