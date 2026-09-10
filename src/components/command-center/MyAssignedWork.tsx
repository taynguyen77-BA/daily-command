"use client";

// V2.19 — "MY ASSIGNED WORK": the full Jira-assignee population, distinct from "Your Delivery
// Focus" (curated/scored) — see assigned-work.ts's own top comment. Full assigned work does
// NOT mean full Personal Focus (§28 of the hardening spec): this surface only answers "what is
// assigned to me right now", never "what should I work on".

import { useMemo, useState } from "react";
import { getActiveAssignedWorkItems, getCompletedAssignedWorkItems } from "@/lib/command-center/assigned-work";
import type { WorkItem } from "@/lib/command-center/types";
import { useCommandCenter } from "./use-command-center";
import { Panel, SectionHeading, TrustLabel } from "./ui";
import { TicketLink } from "./TicketLink";

/** `dailyCommandCompleted` (only meaningful when `finished` is true) distinguishes a
 *  reversible Daily Command Completion (this app's own record — Reopen is available) from a
 *  Jira-native completion (statusCategory "Done", or an explicit Work Relevance
 *  COMPLETED/EXCLUDED classification) — that state can only ever change in Jira itself, so
 *  this surface never offers a "Reopen" for it (§ never mutate Jira, §28). */
function AssignedWorkRow({
  item,
  finished,
  dailyCommandCompleted,
  onComplete,
  onReopen,
}: {
  item: WorkItem;
  finished: boolean;
  dailyCommandCompleted: boolean;
  onComplete: () => void;
  onReopen: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2 last:border-b-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-xs text-text3">
          <TicketLink ticketKey={item.key} url={item.sourceUrl} />
          <span>{item.jiraStatusName ?? item.status}</span>
        </div>
        <p className="truncate text-sm text-text">{item.title}</p>
      </div>
      {dailyCommandCompleted ? (
        <button onClick={onReopen} className="shrink-0 rounded border border-border px-2 py-1 text-xs text-text2 hover:border-accent hover:text-text">
          Reopen
        </button>
      ) : finished ? (
        <span className="shrink-0 text-xs text-text3">Completed in Jira</span>
      ) : (
        <button onClick={onComplete} className="shrink-0 rounded border border-border px-2 py-1 text-xs text-text2 hover:border-accent hover:text-text">
          Mark completed
        </button>
      )}
    </li>
  );
}

export function MyAssignedWork() {
  const { state, filteredData, workRelevanceIndex, store } = useCommandCenter();
  const [showCompleted, setShowCompleted] = useState(false);
  const identity = { displayName: state.ownerName, accountId: state.personalIdentity?.accountId };
  const completedTicketKeys = useMemo(() => new Set(Object.keys(state.dailyCommandCompletions)), [state.dailyCommandCompletions]);

  const active = useMemo(
    () => getActiveAssignedWorkItems(filteredData.workItems, identity, workRelevanceIndex, completedTicketKeys),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredData.workItems, identity.displayName, identity.accountId, workRelevanceIndex, completedTicketKeys]
  );
  const completed = useMemo(
    () => getCompletedAssignedWorkItems(filteredData.workItems, identity, workRelevanceIndex, completedTicketKeys),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredData.workItems, identity.displayName, identity.accountId, workRelevanceIndex, completedTicketKeys]
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
              <AssignedWorkRow
                key={item.id}
                item={item}
                finished={false}
                dailyCommandCompleted={false}
                onComplete={() => store.completeTicketInDailyCommand(item.key)}
                onReopen={() => store.reopenTicketInDailyCommand(item.key)}
              />
            ))}
          </ul>
        </Panel>
      )}

      {hasIdentity && completed.length > 0 && (
        <div className="mt-2">
          <button onClick={() => setShowCompleted((s) => !s)} aria-expanded={showCompleted} className="text-xs font-medium text-accent2 hover:underline">
            {showCompleted ? "Hide" : "Show"} completed ({completed.length})
          </button>
          {showCompleted && (
            <Panel className="mt-2 p-4">
              <ul>
                {completed.map((item) => (
                  <AssignedWorkRow
                    key={item.id}
                    item={item}
                    finished
                    dailyCommandCompleted={completedTicketKeys.has(item.key)}
                    onComplete={() => store.completeTicketInDailyCommand(item.key)}
                    onReopen={() => store.reopenTicketInDailyCommand(item.key)}
                  />
                ))}
              </ul>
            </Panel>
          )}
        </div>
      )}
    </section>
  );
}
