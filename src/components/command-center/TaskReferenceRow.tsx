"use client";

// V2.26 — the ONE shared row for "a reference to a specific ticket, with its personal execution
// controls". Wraps TicketLink (Jira link) + FirstSeenBadge (sync provenance) + the recorded
// "<reason>, <when>" history label + the Complete / Skip(+reason) / Block(+reason) cluster,
// wired straight to store.ts's completeTicketInDailyCommand / skipTicketInDailyCommand /
// blockTicketInDailyCommand (and their reverses). Every page that references a concrete work
// item renders this instead of re-implementing its own link/buttons.
//
// Split like the rest of this codebase's testable UI: TaskReferenceRowView is pure (explicit
// state + callbacks, renderable with react-dom/server in the offline test suite), and
// TaskReferenceRow is the thin connected wrapper that reads the Daily Command maps from the
// store and calls its methods.

import React, { useState, useSyncExternalStore } from "react";
import { commandCenterStore } from "@/lib/command-center/store";
import { formatExecutionRecord, resolveTaskExecutionState, type TaskExecutionState } from "@/lib/command-center/task-execution";
import { formatRelativeDateTime } from "@/lib/command-center/relative-time";
import { BLOCK_REASON_SUGGESTIONS, type SkipReason, type TaskReactivation, type WorkItem } from "@/lib/command-center/types";
import { FirstSeenBadge, TicketLink } from "./TicketLink";

export const SKIP_REASONS: SkipReason[] = ["Team is handling it", "Not my action", "Waiting on another team", "Not relevant right now", "Other"];

export interface TaskRowActions {
  onComplete: () => void;
  onSkip: (reason?: SkipReason) => void;
  onBlock: (reason?: string) => void;
  onReopen: () => void;
  onReactivateSkip: () => void;
  onUnblock: () => void;
}

const REACTIVATION_COPY: Record<TaskReactivation["reason"], string> = {
  "new-mention-after-completion": "new comment after you marked this done",
  "new-mention-after-skip": "new comment after you skipped this",
  "new-mention-after-block": "new comment while this was blocked",
  "reassigned-after-completion": "reassigned to you after you marked this done",
  "reassigned-after-skip": "reassigned to you after you skipped this",
  "reassigned-after-block": "reassigned to you while this was blocked",
};

/** "↺ Reactivated — new comment after you marked this done". Deliberately a different color
 *  from FirstSeenBadge's "new today" accent so a returning ticket never reads as brand new. */
export function ReactivatedBadge({ reactivation, now }: { reactivation: TaskReactivation; now?: Date }) {
  const when = formatRelativeDateTime(reactivation.reactivatedAt, now);
  return (
    <span
      data-reactivated={reactivation.reason}
      title={when ? `Reactivated ${when}` : undefined}
      className="rounded bg-orange/15 px-1.5 py-0.5 text-[10px] font-medium text-orange"
    >
      ↺ Reactivated — {REACTIVATION_COPY[reactivation.reason]}
    </span>
  );
}

const STATE_TONE: Record<TaskExecutionState["kind"], string> = {
  active: "",
  completed: "text-green",
  "done-in-jira": "text-green",
  skipped: "text-text3",
  blocked: "text-red",
};

const BTN = "rounded border border-border px-2 py-1 text-xs text-text2 hover:border-accent hover:text-text";

export function TaskReferenceRowView({
  ticketKey,
  url,
  title,
  statusLabel,
  firstSeenAt,
  execution,
  reactivation,
  actions,
  now,
  caption,
  as = "li",
}: {
  ticketKey: string;
  url?: string;
  title?: string;
  statusLabel?: string;
  firstSeenAt?: string;
  execution: TaskExecutionState;
  reactivation?: TaskReactivation;
  /** Omitted = read-only reference (link + state label, no buttons). */
  actions?: TaskRowActions;
  now?: Date;
  /** Extra context line under the record (e.g. Daily Review's completion source). */
  caption?: string;
  as?: "li" | "div";
}) {
  const [picker, setPicker] = useState<"skip" | "block" | null>(null);
  const [skipReason, setSkipReason] = useState<SkipReason | "">("");
  const [blockReason, setBlockReason] = useState("");
  const record = formatExecutionRecord(execution, now);
  const Tag = as;

  return (
    <Tag data-task-row={ticketKey} data-task-state={execution.kind} className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2 last:border-b-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-xs text-text3">
          <TicketLink ticketKey={ticketKey} url={url} />
          {statusLabel && <span>{statusLabel}</span>}
          <FirstSeenBadge firstSeenAt={firstSeenAt} now={now} />
          {reactivation && <ReactivatedBadge reactivation={reactivation} now={now} />}
        </div>
        {title && <p className="truncate text-sm text-text">{title}</p>}
        {record && (
          <p data-task-record className={`text-xs ${STATE_TONE[execution.kind]}`}>
            {record}
          </p>
        )}
        {caption && <p className="text-xs text-text3">{caption}</p>}
      </div>

      {actions && execution.kind !== "done-in-jira" && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {execution.kind === "active" && picker === null && (
            <>
              <button onClick={actions.onComplete} className={BTN}>
                Mark completed
              </button>
              <button onClick={() => setPicker("skip")} className={BTN}>
                Skip…
              </button>
              <button onClick={() => setPicker("block")} className={BTN}>
                Block…
              </button>
            </>
          )}
          {execution.kind === "active" && picker === "skip" && (
            <>
              <select
                value={skipReason}
                onChange={(e) => setSkipReason(e.target.value as SkipReason | "")}
                aria-label="Skip reason (optional)"
                className="rounded border border-border bg-surface px-1.5 py-1 text-xs text-text2"
              >
                <option value="">No reason</option>
                {SKIP_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <button onClick={() => { actions.onSkip(skipReason || undefined); setPicker(null); }} className={BTN}>
                Skip
              </button>
              <button onClick={() => setPicker(null)} className="px-1 text-xs text-text3 hover:text-text2">
                Cancel
              </button>
            </>
          )}
          {execution.kind === "active" && picker === "block" && (
            <>
              <input
                value={blockReason}
                onChange={(e) => setBlockReason(e.target.value)}
                list={`block-reasons-${ticketKey}`}
                placeholder="Blocked on… (optional)"
                aria-label="Block reason (optional)"
                maxLength={200}
                className="w-44 rounded border border-border bg-surface px-1.5 py-1 text-xs text-text2"
              />
              <datalist id={`block-reasons-${ticketKey}`}>
                {BLOCK_REASON_SUGGESTIONS.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
              <button onClick={() => { actions.onBlock(blockReason || undefined); setPicker(null); setBlockReason(""); }} className={BTN}>
                Block
              </button>
              <button onClick={() => setPicker(null)} className="px-1 text-xs text-text3 hover:text-text2">
                Cancel
              </button>
            </>
          )}
          {execution.kind === "completed" && (
            <button onClick={actions.onReopen} className={BTN}>
              Reopen
            </button>
          )}
          {execution.kind === "skipped" && (
            <>
              <button onClick={actions.onReactivateSkip} className={BTN}>
                Reactivate
              </button>
              <button onClick={actions.onComplete} className={BTN}>
                Mark completed
              </button>
            </>
          )}
          {execution.kind === "blocked" && (
            <>
              <button onClick={actions.onUnblock} className={BTN}>
                Unblock
              </button>
              <button onClick={actions.onComplete} className={BTN}>
                Mark completed
              </button>
            </>
          )}
        </div>
      )}
    </Tag>
  );
}

/** The store's actions for one ticket key — the three Daily Command setters and their reverses. */
export function storeActionsFor(ticketKey: string): TaskRowActions {
  return {
    onComplete: () => commandCenterStore.completeTicketInDailyCommand(ticketKey),
    onSkip: (reason) => commandCenterStore.skipTicketInDailyCommand(ticketKey, reason),
    onBlock: (reason) => commandCenterStore.blockTicketInDailyCommand(ticketKey, reason),
    onReopen: () => commandCenterStore.reopenTicketInDailyCommand(ticketKey),
    onReactivateSkip: () => commandCenterStore.reactivateSkippedTicket(ticketKey),
    onUnblock: () => commandCenterStore.unblockTicketInDailyCommand(ticketKey),
  };
}

/** Connected row. Pass a WorkItem when one is at hand (link, title, status, provenance all come
 *  from it); otherwise a bare ticketKey/url. `finishedInJira` is the caller's own
 *  isWorkItemDoneOrExcluded verdict, when it has one. */
export function TaskReferenceRow({
  workItem,
  ticketKey,
  url,
  title,
  finishedInJira = false,
  reactivation,
  readOnly = false,
  showTitle = true,
  caption,
  as,
}: {
  workItem?: Pick<WorkItem, "key" | "sourceUrl" | "title" | "status" | "jiraStatusName" | "firstSeenAt">;
  ticketKey?: string;
  url?: string;
  title?: string;
  finishedInJira?: boolean;
  reactivation?: TaskReactivation;
  readOnly?: boolean;
  showTitle?: boolean;
  caption?: string;
  as?: "li" | "div";
}) {
  const state = useSyncExternalStore(commandCenterStore.subscribe, commandCenterStore.getSnapshot, commandCenterStore.getServerSnapshot);
  const key = workItem?.key ?? ticketKey;
  if (!key) return null;
  return (
    <TaskReferenceRowView
      ticketKey={key}
      url={workItem?.sourceUrl ?? url}
      title={showTitle ? (workItem?.title ?? title) : undefined}
      statusLabel={workItem ? (workItem.jiraStatusName ?? workItem.status) : undefined}
      firstSeenAt={workItem?.firstSeenAt}
      execution={resolveTaskExecutionState(key, state, finishedInJira)}
      reactivation={reactivation}
      actions={readOnly ? undefined : storeActionsFor(key)}
      caption={caption}
      as={as}
    />
  );
}

/** V2.26 — the "tickets this card is about" block for cards whose entity links to concrete
 *  work items (risks, decisions, changes, dependencies, loops). Renders nothing when there
 *  are none — never an empty heading. */
export function RelatedTickets({ workItems, label = "Related tickets" }: { workItems?: WorkItem[]; label?: string }) {
  if (!workItems || workItems.length === 0) return null;
  return (
    <div className="mt-2 rounded-md border border-border bg-surface2 px-3 py-1">
      <p className="pt-1 text-[10px] font-semibold uppercase tracking-wide text-text3">{label}</p>
      <ul>
        {workItems.map((w) => (
          <TaskReferenceRow key={w.id} workItem={w} />
        ))}
      </ul>
    </div>
  );
}
