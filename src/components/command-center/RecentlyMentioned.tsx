"use client";

// V2.19 — "RECENTLY MENTIONED": a real last-24-hours rolling window over MentionEvents,
// distinct from the Attention Queue's MENTION category (lifecycle-based, no time decay — see
// recent-mentions.ts's own top comment). Answers "what recently involved me?", not "what's
// still unresolved" (that's the Attention Queue's job).

import { isMentionReplied } from "@/lib/command-center/mention-replies";
import type { MentionReply } from "@/lib/command-center/types";
import { useEffect, useMemo, useState } from "react";
import { selectRecentMentions, type RecentMention } from "@/lib/command-center/recent-mentions";
import { slug } from "@/lib/command-center/attention-queue";
import { mentionGroupLabel } from "@/lib/command-center/mention-grouping";
import { useCommandCenter } from "./use-command-center";
import { Panel, SectionHeading, TrustLabel } from "./ui";
import { TicketLink } from "./TicketLink";
import { ReactivatedBadge } from "./TaskReferenceRow";
import { MentionReplyDrafter } from "./MentionReplyDrafter";

function formatRecency(mentionedAt: string, nowMs: number): string {
  const ms = Math.max(0, nowMs - new Date(mentionedAt).getTime());
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function MentionRow({ mention, nowMs, onResolve, onComplete, replied, onReplied }: { mention: RecentMention; nowMs: number; onResolve: () => void; onComplete: () => void; replied?: MentionReply; onReplied?: () => void }) {
  return (
    <li className="border-b border-border py-2 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-text3">
          <TicketLink ticketKey={mention.issueKey} url={mention.commentUrl ?? mention.workItem?.sourceUrl} />
          <span>Mentioned {formatRecency(mention.mentionedAt, nowMs)}</span>
          {mention.groupCount > 1 && <span className="text-accent2">{mentionGroupLabel(mention.groupCount)}</span>}
          {mention.reactivation && <ReactivatedBadge reactivation={mention.reactivation} now={new Date(nowMs)} />}
          {replied && (
            <span data-mention-replied={replied.source} className="rounded bg-green/15 px-1.5 py-0.5 text-[10px] font-medium text-green">
              {replied.source === "jira" ? "✓ You replied in Jira" : "✓ Replied"}
            </span>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {onReplied && !replied && (
            <button onClick={onReplied} title="I've answered this — it leaves 'awaiting my reply'" className="btn btn-sm btn-secondary">
              Replied
            </button>
          )}
          <button onClick={onResolve} className="btn btn-sm btn-secondary">
            Mark read
          </button>
          <button onClick={onComplete} className="btn btn-sm btn-secondary">
            Mark ticket completed
          </button>
        </div>
      </div>
      {mention.workItem && <p className="mt-1 truncate text-sm text-text">{mention.workItem.title}</p>}
      <p className="mt-1 text-xs text-text2">{mention.commentAuthor ? `${mention.commentAuthor}: "${mention.excerpt}"` : `"${mention.excerpt}"`}</p>
      {!replied && (
        <div className="mt-1">
          <MentionReplyDrafter mention={{ issueKey: mention.issueKey, commentId: mention.commentId, author: mention.commentAuthor, excerpt: mention.excerpt, mentionedAt: mention.mentionedAt }} />
        </div>
      )}
    </li>
  );
}

export function RecentlyMentioned() {
  const { state, filteredData, scopedMentionEvents, store, dailyCommandMaps } = useCommandCenter();
  // A ticking `now` so the 24h window (and the relative "Xh ago" labels) stays correct across
  // a long-lived tab, not frozen at first render — recomputed only on an interval, never per
  // keystroke/render.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  const mentions = useMemo(
    // V2.26 — skips (previously never passed here, so a pre-skip mention wasn't suppressed in
    // this panel) and blocks are passed too, so the suppress-then-reactivate rule applies to
    // all three Daily Command states.
    () =>
      selectRecentMentions(scopedMentionEvents, filteredData.workItems, state.attentionState, nowMs, dailyCommandMaps),
    [scopedMentionEvents, filteredData.workItems, state.attentionState, nowMs, dailyCommandMaps]
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
                onComplete={() => store.completeTicketInDailyCommand(m.issueKey, "recent-mentions")}
                // D4 — reply tracking (manual, or auto-detected from my later comment).
                replied={state.features.mentionReplyTracking ? isMentionReplied(m, state.mentionReplies, state.myTicketActivity) : undefined}
                onReplied={state.features.mentionReplyTracking ? () => store.markMentionReplied(m.commentId, m.issueKey) : undefined}
              />
            ))}
          </ul>
        </Panel>
      )}
    </section>
  );
}
