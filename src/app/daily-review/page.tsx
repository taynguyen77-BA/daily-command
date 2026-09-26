"use client";

// V2.26 — Daily Review: one page for the morning check — what's new since I last looked,
// what I skipped, what's blocked, what got done. See daily-review.ts for the composition
// rules. Every row is the shared TaskReferenceRow (Jira link, recorded reason + time,
// Complete/Skip/Block — and Reactivate/Unblock/Reopen in the history blocks).

import { useEffect, useMemo, useState } from "react";
import { useCommandCenter } from "@/components/command-center/use-command-center";
import { EmptyState, Panel, SectionHeading, TrustLabel } from "@/components/command-center/ui";
import { TaskReferenceRow } from "@/components/command-center/TaskReferenceRow";
import { buildDailyReview, DAILY_REVIEW_COMPLETED_WINDOW_DAYS, type DailyReviewCompletedRow } from "@/lib/command-center/daily-review";
import { formatRelativeDateTime, formatRelativeDay } from "@/lib/command-center/relative-time";

function completedCaption(row: DailyReviewCompletedRow, now: Date): string {
  const source = row.sources.length === 2 ? "Jira + Daily Command" : row.sources[0] === "jira" ? "Jira" : "Daily Command";
  const when = row.sources.includes("daily-command") ? formatRelativeDateTime(row.at, now) : formatRelativeDay(row.day, now);
  return when ? `Source: ${source} · ${when}` : `Source: ${source}`;
}

function Block({ title, subtitle, count, empty, children }: { title: string; subtitle: string; count: number; empty: string; children: React.ReactNode }) {
  return (
    <section>
      <SectionHeading title={`${title} (${count})`} subtitle={subtitle} />
      {count === 0 ? <Panel className="p-4 text-sm text-text3">{empty}</Panel> : <Panel className="p-4"><ul>{children}</ul></Panel>}
    </section>
  );
}

export default function DailyReviewPage() {
  const { state, store, filteredData, workRelevanceIndex, scopedMentionEvents } = useCommandCenter();
  const [now] = useState(() => new Date());
  // The PREVIOUS visit, captured once the persisted state has actually loaded (IndexedDB
  // hydration is async) — only then is this visit recorded. undefined = not captured yet.
  const [lastVisitAt, setLastVisitAt] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!state.loaded || lastVisitAt !== undefined) return;
    setLastVisitAt(state.dailyReviewLastVisitAt ?? null);
    store.markDailyReviewVisited();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.loaded]);

  const review = useMemo(
    () =>
      buildDailyReview({
        workItems: filteredData.workItems,
        identity: { displayName: state.ownerName, accountId: state.personalIdentity?.accountId },
        workRelevanceIndex,
        dailyCommandCompletions: state.dailyCommandCompletions,
        dailyCommandSkips: state.dailyCommandSkips,
        dailyCommandBlocks: state.dailyCommandBlocks,
        memoryEvents: state.memoryEvents,
        mentionEvents: scopedMentionEvents,
        attentionState: state.attentionState,
        syncLog: state.syncLog,
        lastVisitAt: lastVisitAt ?? undefined,
        now,
      }),
    [filteredData.workItems, state, workRelevanceIndex, scopedMentionEvents, lastVisitAt, now]
  );

  if (!state.loaded) {
    return <EmptyState title="No data yet" description="Sync Jira or load the demo dataset to start your daily review." onLoadDemo={() => store.loadDemoData()} />;
  }

  const baselineLabel =
    review.baseline.kind === "last-visit"
      ? `since your last visit (${formatRelativeDateTime(review.baseline.at, now)})`
      : review.baseline.kind === "previous-sync"
        ? `since the sync before the latest one (${formatRelativeDateTime(review.baseline.at, now)}) — your first visit here`
        : "in your first Jira sync";
  const newSubtitle =
    review.baseline.kind === "first-sync" && state.syncLog.length === 0
      ? "No Jira sync recorded yet — first-seen times are recorded per sync, so nothing can be new until one runs."
      : `Tickets first seen ${baselineLabel}${review.personal ? ", assigned to you" : ""}. Anything you already completed, skipped or blocked is never listed here.`;

  return (
    <div className="space-y-6 pb-16">
      <div>
        <SectionHeading title="Daily Review" subtitle="Morning check: what's new, what you skipped, what's blocked, what got done." />
        <TrustLabel kind="calculated" />
      </div>

      <Block
        title="New since your last visit"
        subtitle={newSubtitle}
        count={review.newSinceLastVisit.length}
        empty="Nothing new since your last visit."
      >
        {review.newSinceLastVisit.map((w) => (
          <TaskReferenceRow key={w.id} workItem={w} />
        ))}
      </Block>

      <Block title="Skipped" subtitle="Still relevant, deliberately not executing. Reactivate to bring one back." count={review.skipped.length} empty="Nothing skipped.">
        {review.skipped.map((r) =>
          r.workItem ? <TaskReferenceRow key={r.ticketKey} workItem={r.workItem} reactivation={r.reactivation} /> : <TaskReferenceRow key={r.ticketKey} ticketKey={r.ticketKey} reactivation={r.reactivation} />
        )}
      </Block>

      <Block title="Blocked" subtitle="Not done — paused on something outside your control. Unblock when it moves." count={review.blocked.length} empty="Nothing blocked.">
        {review.blocked.map((r) =>
          r.workItem ? <TaskReferenceRow key={r.ticketKey} workItem={r.workItem} reactivation={r.reactivation} /> : <TaskReferenceRow key={r.ticketKey} ticketKey={r.ticketKey} reactivation={r.reactivation} />
        )}
      </Block>

      <Block
        title="Completed recently"
        subtitle={`Last ${DAILY_REVIEW_COMPLETED_WINDOW_DAYS} days — marked done here, or detected as done in Jira.`}
        count={review.completedRecently.length}
        empty={`Nothing completed in the last ${DAILY_REVIEW_COMPLETED_WINDOW_DAYS} days.`}
      >
        {review.completedRecently.map((r) =>
          r.workItem ? (
            <TaskReferenceRow key={r.ticketKey} workItem={r.workItem} finishedInJira={r.sources.includes("jira")} reactivation={r.reactivation} caption={completedCaption(r, now)} />
          ) : (
            <TaskReferenceRow key={r.ticketKey} ticketKey={r.ticketKey} finishedInJira={r.sources.includes("jira")} reactivation={r.reactivation} caption={completedCaption(r, now)} />
          )
        )}
      </Block>
    </div>
  );
}
