"use client";

// V2.26 — Daily Review: one page for the morning check — what's new since I last looked,
// what I skipped, what's blocked, what got done. See daily-review.ts for the composition
// rules. Every row is the shared TaskReferenceRow (Jira link, recorded reason + time,
// Complete/Skip/Block — and Reactivate/Unblock/Reopen in the history blocks).
//
// A3 — opening (or refreshing) this page no longer records anything: "New" rows stay until
// explicitly acknowledged, per row ("Seen") or all at once ("Mark all reviewed"), and each
// row says why it is new.

import { useMemo, useState } from "react";
import { useCommandCenter } from "@/components/command-center/use-command-center";
import { EmptyState, Panel, SectionHeading, TrustLabel } from "@/components/command-center/ui";
import { TaskReferenceRow } from "@/components/command-center/TaskReferenceRow";
import { buildDailyReview, DAILY_REVIEW_COMPLETED_WINDOW_DAYS, type DailyReviewCompletedRow, newReasonLabel } from "@/lib/command-center/daily-review";
import { formatRelativeDateTime, formatRelativeDay } from "@/lib/command-center/relative-time";

function completedCaption(row: DailyReviewCompletedRow, now: Date): string {
  const source = row.sources.length === 2 ? "Jira + Daily Command" : row.sources[0] === "jira" ? "Jira" : "Daily Command";
  const when = row.sources.includes("daily-command") ? formatRelativeDateTime(row.at, now) : formatRelativeDay(row.day, now);
  return when ? `Source: ${source} · ${when}` : `Source: ${source}`;
}

function Block({ title, subtitle, count, empty, children, action }: { title: string; subtitle: string; count: number; empty: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section>
      <SectionHeading title={`${title} (${count})`} subtitle={subtitle} />
      {action && count > 0 && <div className="mb-2 flex justify-end">{action}</div>}
      {count === 0 ? <Panel className="p-4 text-sm text-text3">{empty}</Panel> : <Panel className="p-4"><ul>{children}</ul></Panel>}
    </section>
  );
}

export default function DailyReviewPage() {
  const { state, store, filteredData, workRelevanceIndex, scopedMentionEvents } = useCommandCenter();
  const [now] = useState(() => new Date());

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
        // A3 — the pinned baseline; the legacy last visit only until a sync has pinned one.
        baselineAt: state.dailyReviewBaselineAt,
        lastVisitAt: state.dailyReviewLastVisitAt,
        reviewAcks: state.dailyReviewAcks,
        now,
      }),
    [filteredData.workItems, state, workRelevanceIndex, scopedMentionEvents, now]
  );

  if (!state.loaded) {
    return <EmptyState title="No data yet" description="Sync Jira or load the demo dataset to start your daily review." onLoadDemo={() => store.loadDemoData()} />;
  }

  const baselineLabel =
    review.baseline.kind === "reviewed"
      ? `since ${formatRelativeDateTime(review.baseline.at, now)}`
      : review.baseline.kind === "last-visit"
      ? `since your last visit (${formatRelativeDateTime(review.baseline.at, now)})`
      : review.baseline.kind === "previous-sync"
        ? `since the sync before the latest one (${formatRelativeDateTime(review.baseline.at, now)}) — your first visit here`
        : "in your first Jira sync";
  const newSubtitle =
    review.baseline.kind === "first-sync" && state.syncLog.length === 0
      ? "No Jira sync recorded yet — first-seen times are recorded per sync, so nothing can be new until one runs."
      : `New tickets${review.personal ? " assigned to you" : ""}, reassignments to you and mentions of you ${baselineLabel}. Each stays here until you mark it seen; anything you completed, skipped or blocked is never listed.`;

  return (
    <div className="space-y-6 pb-16">
      <div>
        <SectionHeading title="Daily Review" subtitle="Morning check: what's new, what you skipped, what's blocked, what got done." />
        <TrustLabel kind="calculated" />
      </div>

      <Block
        title="New"
        subtitle={newSubtitle}
        count={review.newRows.length}
        empty="Nothing new to review."
        action={
          <button
            onClick={() => store.markDailyReviewSeen(review.newRows.map((r) => r.ticketKey))}
            className="rounded border border-border px-2 py-1 text-xs text-text2 hover:border-accent hover:text-text"
          >
            Mark all reviewed
          </button>
        }
      >
        {review.newRows.map((r) => (
          <li key={r.ticketKey} data-new-row={r.ticketKey} className="flex items-start gap-2 border-b border-border last:border-b-0">
            <div className="min-w-0 flex-1">
              {r.workItem ? (
                <TaskReferenceRow as="div" workItem={r.workItem} caption={newReasonLabel(r.reasons)} />
              ) : (
                <TaskReferenceRow as="div" ticketKey={r.ticketKey} caption={newReasonLabel(r.reasons)} />
              )}
            </div>
            <button
              onClick={() => store.markDailyReviewSeen([r.ticketKey])}
              title="Hide from New until something else happens on this ticket"
              className="mt-2 shrink-0 rounded px-2 py-1 text-xs text-text3 hover:bg-surface2 hover:text-text2"
            >
              Seen
            </button>
          </li>
        ))}
      </Block>

      <Block
        title="Due for re-check today"
        subtitle="Skipped or blocked tickets whose re-check day has come. They stay skipped/blocked everywhere else until you reactivate, unblock or complete them."
        count={review.dueForRecheck.length}
        empty="Nothing due for a re-check."
      >
        {review.dueForRecheck.map((r) =>
          r.workItem ? <TaskReferenceRow key={r.ticketKey} workItem={r.workItem} reactivation={r.reactivation} /> : <TaskReferenceRow key={r.ticketKey} ticketKey={r.ticketKey} reactivation={r.reactivation} />
        )}
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
