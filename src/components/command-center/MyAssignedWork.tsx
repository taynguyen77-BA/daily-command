"use client";

// V2.19 — "MY ASSIGNED WORK": the full Jira-assignee population, distinct from "Your Delivery
// Focus" (curated/scored) — see assigned-work.ts's own top comment. Full assigned work does
// NOT mean full Personal Focus (§28 of the hardening spec): this surface only answers "what is
// assigned to me right now", never "what should I work on".
//
// V2.23 — adds a third bucket, SKIPPED, alongside the existing Active/Completed split: work
// the user has explicitly told Daily Command "I am not executing this right now" (another
// team owns it, etc). See assigned-work.ts's getSkippedAssignedWorkItems and types.ts's
// DailyCommandSkip for the full reasoning.
//
// V2.26 — a fourth bucket, BLOCKED (assigned-work.ts's getBlockedAssignedWorkItems), and every
// row now renders through the shared TaskReferenceRow: Jira link, first-seen provenance, and —
// in the history buckets — the recorded "<reason>, <when>" straight from
// dailyCommandCompletions/dailyCommandSkips/dailyCommandBlocks.

import { useMemo, useState } from "react";
import { getActiveAssignedWorkItems, getBlockedAssignedWorkItems, getCompletedAssignedWorkItems, getSkippedAssignedWorkItems } from "@/lib/command-center/assigned-work";
import { isWorkItemDoneOrExcluded } from "@/lib/command-center/jira/work-relevance";
import { computeMentionReactivations } from "@/lib/command-center/recent-mentions";
import type { TaskReactivation, WorkItem } from "@/lib/command-center/types";
import { useCommandCenter } from "./use-command-center";
import { Panel, SectionHeading, TrustLabel } from "./ui";
import { TaskReferenceRow } from "./TaskReferenceRow";

function HistoryBucket({
  label,
  items,
  open,
  onToggle,
  finishedInJira,
  reactivations,
}: {
  label: string;
  items: WorkItem[];
  open: boolean;
  onToggle: () => void;
  finishedInJira?: (item: WorkItem) => boolean;
  reactivations: Map<string, TaskReactivation>;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2">
      <button onClick={onToggle} aria-expanded={open} className="text-xs font-medium text-accent2 hover:underline">
        {open ? "Hide" : "Show"} {label} ({items.length})
      </button>
      {open && (
        <Panel className="mt-2 p-4">
          <ul>
            {items.map((item) => (
              <TaskReferenceRow key={item.id} workItem={item} finishedInJira={finishedInJira?.(item) ?? false} reactivation={reactivations.get(item.key)} />
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

export function MyAssignedWork() {
  const { state, filteredData, workRelevanceIndex, scopedMentionEvents } = useCommandCenter();
  const [showCompleted, setShowCompleted] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);
  const identity = { displayName: state.ownerName, accountId: state.personalIdentity?.accountId };
  const completedTicketKeys = useMemo(() => new Set(Object.keys(state.dailyCommandCompletions)), [state.dailyCommandCompletions]);
  const skippedTicketKeys = useMemo(() => new Set(Object.keys(state.dailyCommandSkips)), [state.dailyCommandSkips]);
  const blockedTicketKeys = useMemo(() => new Set(Object.keys(state.dailyCommandBlocks)), [state.dailyCommandBlocks]);
  const [showBlocked, setShowBlocked] = useState(false);

  const active = useMemo(
    () => getActiveAssignedWorkItems(filteredData.workItems, identity, workRelevanceIndex, completedTicketKeys, skippedTicketKeys, blockedTicketKeys),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredData.workItems, identity.displayName, identity.accountId, workRelevanceIndex, completedTicketKeys, skippedTicketKeys, blockedTicketKeys]
  );
  const blocked = useMemo(
    () => getBlockedAssignedWorkItems(filteredData.workItems, identity, workRelevanceIndex, blockedTicketKeys),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredData.workItems, identity.displayName, identity.accountId, workRelevanceIndex, blockedTicketKeys]
  );
  const completed = useMemo(
    () => getCompletedAssignedWorkItems(filteredData.workItems, identity, workRelevanceIndex, completedTicketKeys),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredData.workItems, identity.displayName, identity.accountId, workRelevanceIndex, completedTicketKeys]
  );
  const skipped = useMemo(
    () => getSkippedAssignedWorkItems(filteredData.workItems, identity, workRelevanceIndex, skippedTicketKeys),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredData.workItems, identity.displayName, identity.accountId, workRelevanceIndex, skippedTicketKeys]
  );

  // V2.26 — a history row whose ticket got a new comment after the user's own record says so
  // ("↺ Reactivated — …"). The ticket stays in its bucket: only Reopen/Reactivate/Unblock moves it.
  const reactivations = useMemo(
    () => computeMentionReactivations(scopedMentionEvents, state, state.attentionState),
    [scopedMentionEvents, state]
  );
  const hasIdentity = !!identity.displayName || !!identity.accountId;

  return (
    <section>
      <SectionHeading title="My Assigned Work" subtitle="Every Jira issue currently assigned to you — the full population, not a curated pick." />
      <div className="mb-2 flex items-center gap-2">
        <TrustLabel kind="calculated" />
      </div>
      {!hasIdentity ? (
        <Panel className="p-4 text-sm text-text3">
          Set your identity in{" "}
          <a href="/data-settings" className="text-accent2 hover:underline">
            Data &amp; Settings
          </a>{" "}
          to see your assigned work.
        </Panel>
      ) : active.length === 0 ? (
        <Panel className="p-4 text-sm text-text3">No active Jira work is currently assigned to you.</Panel>
      ) : (
        <Panel className="p-4">
          <ul>
            {active.map((item) => (
              <TaskReferenceRow key={item.id} workItem={item} />
            ))}
          </ul>
        </Panel>
      )}

      {hasIdentity && (
        <>
          <HistoryBucket label="blocked" reactivations={reactivations} items={blocked} open={showBlocked} onToggle={() => setShowBlocked((s) => !s)} />
          <HistoryBucket label="skipped" reactivations={reactivations} items={skipped} open={showSkipped} onToggle={() => setShowSkipped((s) => !s)} />
          <HistoryBucket
            label="completed"
            reactivations={reactivations}
            items={completed}
            open={showCompleted}
            onToggle={() => setShowCompleted((s) => !s)}
            finishedInJira={(item) => isWorkItemDoneOrExcluded(item, workRelevanceIndex)}
          />
        </>
      )}
    </section>
  );
}
