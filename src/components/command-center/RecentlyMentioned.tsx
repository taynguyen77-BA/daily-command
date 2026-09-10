"use client";

// V2.19 — "RECENTLY MENTIONED": a real last-24-hours rolling window over MentionEvents,
// distinct from the Attention Queue's MENTION category (lifecycle-based, no time decay — see
// recent-mentions.ts's own top comment). Answers "what recently involved me?", not "what's
// still unresolved" (that's the Attention Queue's job).

import { useEffect, useMemo, useState } from "react";
import { selectRecentMentions, type RecentMention } from "@/lib/command-center/recent-mentions";
import { slug } from "@/lib/command-center/attention-queue";
import { mentionGroupLabel } from "@/lib/command-center/mention-grouping";
import { useCommandCenter } from "./use-command-center";
import { Panel, SectionHeading, TrustLabel } from "./ui";
import { TicketLink } from "./TicketLink";

function formatRecency(mentionedAt: string, nowMs: number): string {
  const ms = Math.max(0, nowMs - new Date(mentionedAt).getTime());
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function MentionRow({ mention, nowMs, onResolve, onComplete }: { mention: RecentMention; nowMs: number; onResolve: () => void; onComplete: () => void }) {
  return (
    <li className="border-b border-border py-2 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-text3">
          <TicketLink ticketKey={mention.issueKey} url={mention.commentUrl ?? mention.workItem?.sourceUrl} />
          <span>Mentioned {formatRecency(mention.mentionedAt, nowMs)}</span>
          {mention.groupCount > 1 && <span className="text-accent2">{mentionGroupLabel(mention.groupCount)}</span>}
        </div>
        <div className="flex shrink-0 gap-2">
          <button onClick={onResolve} className="rounded border border-border px-2 py-1 text-xs text-text2 hover:border-accent hover:text-text">
            Mark read
          </button>
          <button onClick={onComplete} className="rounded border border-border px-2 py-1 text-xs text-text2 hover:border-accent hover:text-text">
            Mark ticket completed
          </button>
        </div>
      </div>
      {mention.workItem && <p className="mt-1 truncate text-sm text-text">{mention.workItem.title}</p>}
      <p className="mt-1 text-xs text-text2">{mention.commentAuthor ? `${mention.commentAuthor}: "${mention.excerpt}"` : `"${mention.excerpt}"`}</p>
    </li>
  );
}

export function RecentlyMentioned() {
  const { state, filteredData, scopedMentionEvents, store } = useCommandCenter();
  // A ticking `now` so the 24h window (and the relative "Xh ago" labels) stays correct across
  // a long-lived tab, not frozen at first render — recomputed only on an interval, never per
  // keystroke/render.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  const mentions = useMemo(
    () => selectRecentMentions(scopedMentionEvents, filteredData.workItems, state.attentionState, nowMs, { dailyCommandCompletions: state.dailyCommandCompletions }),
    [scopedMentionEvents, filteredData.workItems, state.attentionState, nowMs, state.dailyCommandCompletions]
  );

  return (
    <section>
      <SectionHeading title="Recently Mentioned" subtitle="Jira comments that mentioned you in the last 24 hours." />
      <div className="mb-2 flex items-center gap-2">
        <TrustLabel kind="calculated" />
      </div>
      {mentions.length === 0 ? (
        <Panel className="p-4 text-sm text-text3">No Jira mentions in the last 24 hours.</Panel>
      ) : (
        <Panel className="p-4">
          <ul>
            {mentions.map((m) => (
              <MentionRow
                key={`${m.issueKey}:${m.commentId}`}
                mention={m}
                nowMs={nowMs}
                onResolve={() => store.resolveAttentionItem(`MENTION:${slug(m.issueKey)}:${slug(m.commentId)}`)}
                onComplete={() => store.completeTicketInDailyCommand(m.issueKey)}
              />
            ))}
          </ul>
        </Panel>
      )}
    </section>
  );
}
