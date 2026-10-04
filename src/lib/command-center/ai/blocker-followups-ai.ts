// V2.38 J2 — AI version of "Ask": the blocked tickets grouped by person (the same
// needsFromOthersForBlockedTicket rows "Ask" uses), with age, SLA and — for allow-listed
// projects only — the last comment. One message per person in a Slack / Jira comment / email
// tone, with a suggested deadline from offered dates. Copy, or send through the existing
// channels (Slack with the same second confirmation; Jira via the write-back dialog; email as a
// draft) — nothing is sent on its own.

import { blockedAgeBusinessDays, isBlockerOverdue } from "../blocker-followup";
import { needsFromOthersForBlockedTicket } from "../communicate";
import { addDays } from "../date-utils";
import type { CommandCenterData, MentionEvent, TicketWorkState } from "../types";
import { isProjectAiAllowed, projectKeyOf, type AiDataProtectionSettings } from "./data-protection";
import { RedactionSession } from "./redaction";
import type { TaskInput } from "./task-registry";
import { nextWeekday } from "./when";

export type FollowUpChannel = "slack" | "jira" | "email";

export function deadlineOptionsFor(today: string): string[] {
  return Array.from(new Set([addDays(today, 1), addDays(today, 2), nextWeekday(today, 5), nextWeekday(today, 1)])).sort();
}

export function buildFollowUpInput(args: {
  states: Record<string, TicketWorkState>;
  data: Pick<CommandCenterData, "workItems" | "dependencies">;
  mentionEvents: MentionEvent[];
  settings: AiDataProtectionSettings;
  slaBusinessDays: number;
  today: string;
  channel: FollowUpChannel;
  /** Only these tickets (e.g. one row's Ask); all blocked tickets when omitted. */
  ticketKeys?: string[];
}): { input: TaskInput<"draftBlockerFollowUps">; session: RedactionSession; ticketsByPerson: Record<string, string[]> } | null {
  const session = new RedactionSession(args.settings.customTerms);
  const byKey = new Map(args.data.workItems.map((w) => [w.key, w]));
  const people = new Map<string, TaskInput<"draftBlockerFollowUps">["people"][number]["tickets"]>();
  for (const r of Object.values(args.states).sort((a, b) => a.ticketKey.localeCompare(b.ticketKey))) {
    if (r.status !== "BLOCKED" || (args.ticketKeys && !args.ticketKeys.includes(r.ticketKey))) continue;
    const w = byKey.get(r.ticketKey);
    const deps = w ? args.data.dependencies.filter((d) => d.workItemId === w.id && d.status === "unresolved") : [];
    const rows = needsFromOthersForBlockedTicket({ key: r.ticketKey, title: w?.title, dueDate: w?.dueDate }, r.reason, deps);
    const age = blockedAgeBusinessDays(r.updatedAt, args.today) ?? 0;
    const last = isProjectAiAllowed(args.settings, projectKeyOf(r.ticketKey))
      ? args.mentionEvents.filter((m) => m.issueKey === r.ticketKey).sort((a, b) => b.mentionedAt.localeCompare(a.mentionedAt))[0]
      : undefined;
    for (const row of rows) {
      const person = row.isUnknownPerson ? "Unknown" : row.person;
      const list = people.get(person) ?? [];
      if (list.some((t) => t.key === r.ticketKey)) continue;
      list.push({
        key: r.ticketKey,
        title: session.redact(w?.title ?? r.ticketKey).slice(0, 500),
        ...(r.reason ? { reason: session.redact(r.reason).slice(0, 500) } : {}),
        ageBusinessDays: age,
        overSla: isBlockerOverdue(age, args.slaBusinessDays),
        ...(last ? { lastComment: session.redact(`${last.commentAuthor ?? "Someone"}: ${last.excerpt}`).slice(0, 300) } : {}),
      });
      people.set(person, list);
    }
  }
  if (people.size === 0) return null;
  const list = Array.from(people.entries()).slice(0, 20).map(([person, tickets]) => ({ person, tickets: tickets.slice(0, 20) }));
  return {
    input: { today: args.today, channel: args.channel, slaBusinessDays: args.slaBusinessDays, deadlineOptions: deadlineOptionsFor(args.today), people: list },
    session,
    ticketsByPerson: Object.fromEntries(list.map((p) => [p.person, p.tickets.map((t) => t.key)])),
  };
}
