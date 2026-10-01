"use client";

// My Work's data: Daily Review (New rows, Jira completions, reactivations) and the partitioned
// views (my-work.ts buildMyWork), over the same scoped/filtered data and the same
// TicketWorkState every other surface reads. Shared by the My Work page and the Command
// Center summary so the two can never disagree.

import { useMemo, useState } from "react";
import { buildDailyReview, type DailyReview } from "@/lib/command-center/daily-review";
import { buildMyWork, type MyWork } from "@/lib/command-center/my-work";
import { useCommandCenter } from "./use-command-center";

export function useMyWork(): { work: MyWork; review: DailyReview; now: Date } & ReturnType<typeof useCommandCenter> {
  const cc = useCommandCenter();
  const { state, filteredData, workRelevanceIndex, scopedMentionEvents, personalFocus, proactive, today, dailyCommandMaps } = cc;
  const [now] = useState(() => new Date());
  const identity = useMemo(() => ({ displayName: state.ownerName, accountId: state.personalIdentity?.accountId }), [state.ownerName, state.personalIdentity?.accountId]);

  const review = useMemo(
    () =>
      buildDailyReview({
        workItems: filteredData.workItems,
        identity,
        workRelevanceIndex,
        ...dailyCommandMaps,
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
    [filteredData.workItems, identity, workRelevanceIndex, dailyCommandMaps, state.memoryEvents, scopedMentionEvents, state.attentionState, state.syncLog, state.dailyReviewBaselineAt, state.dailyReviewLastVisitAt, state.dailyReviewAcks, now]
  );

  const work = useMemo(
    () =>
      buildMyWork({
        workItems: filteredData.workItems,
        identity,
        workRelevanceIndex,
        ticketWorkStates: state.ticketWorkStates,
        today,
        focusCandidates: personalFocus?.candidates,
        personalPlan: state.personalPlan,
        review,
        attentionItems: proactive?.attentionQueue,
      }),
    [filteredData.workItems, identity, workRelevanceIndex, state.ticketWorkStates, today, personalFocus?.candidates, state.personalPlan, review, proactive?.attentionQueue]
  );

  return { ...cc, work, review, now };
}
