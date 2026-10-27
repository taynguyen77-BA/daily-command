"use client";

// P3.2 — "Awaiting you · 2d" / "Awaiting them · 3d" on a ticket row, and the "Needs a nudge" group on
// My Work. Both render through conversation-state.ts (conversationChip / nudgeList), so a ticket's chip
// and its place in the nudge list can never disagree.

import { useState } from "react";
import { conversationChip, nudgeList, type ConversationState } from "@/lib/command-center/conversation-state";
import { renderNeedsFromOthersText } from "@/lib/command-center/communicate";
import { todayLocalIso } from "@/lib/command-center/date-utils";
import { Panel, SectionHeading } from "./ui";
import { TicketLink } from "./TicketLink";

export function ConversationChipView({ conversation, today, slaBusinessDays }: { conversation: ConversationState | undefined; today: string; slaBusinessDays: number }) {
  const chip = conversationChip(conversation, today, slaBusinessDays);
  if (!chip) return null;
  const tone = chip.awaiting === "ME" ? "border-accent/40 text-accent" : chip.nudge ? "border-yellow/50 text-yellow" : "border-border text-text3";
  return (
    <span data-conversation-chip={chip.awaiting} data-nudge={chip.nudge ? "true" : undefined} title={chip.awaiting === "ME" ? "Someone replied after your last comment and it concerns you" : "Your comment is the latest and has had no reply"} className={`mt-1 inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[11px] ${tone}`}>
      {chip.text}
      {chip.nudge ? " · needs a nudge" : ""}
    </span>
  );
}

export function NeedsNudgeGroup({
  conversation,
  tickets,
  slaBusinessDays,
}: {
  conversation: Readonly<Record<string, ConversationState>> | undefined;
  tickets: readonly { key: string; title?: string; dueDate?: string; sourceUrl?: string }[];
  slaBusinessDays: number;
}) {
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const today = todayLocalIso();
  const rows = nudgeList(conversation, tickets, today, slaBusinessDays);
  if (rows.length === 0) return null;
  const urlOf = new Map(tickets.map((t) => [t.key, t.sourceUrl]));
  return (
    <section data-needs-nudge>
      <SectionHeading title={`Needs a nudge (${rows.length})`} subtitle={`Your comment was the last one and has waited longer than your ${slaBusinessDays}-business-day SLA. The draft is a starting point — check who to send it to.`} />
      <Panel className="p-4">
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.ticketKey} data-nudge-row={r.ticketKey}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <TicketLink ticketKey={r.ticketKey} url={urlOf.get(r.ticketKey)} className="font-mono text-xs text-text3" />
                {r.title && <span className="text-text">{r.title}</span>}
                <ConversationChipView conversation={conversation?.[r.ticketKey]} today={today} slaBusinessDays={slaBusinessDays} />
                <button onClick={() => setDraftFor(draftFor === r.ticketKey ? null : r.ticketKey)} className="btn btn-sm btn-secondary">
                  {draftFor === r.ticketKey ? "Hide draft" : "Draft nudge"}
                </button>
              </div>
              {draftFor === r.ticketKey && <pre className="mt-2 whitespace-pre-wrap rounded border border-border bg-surface2 p-3 text-xs text-text2">{renderNeedsFromOthersText([r.draftRow])}</pre>}
            </li>
          ))}
        </ul>
      </Panel>
    </section>
  );
}
