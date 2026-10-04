"use client";

// TaskRow — the ONE row for "a reference to a specific ticket, with its personal status and
// controls", used by every surface that shows a ticket: My Work (all views), Command Center,
// My Day, Your Delivery Focus cards, Daily Review, Priorities, Action Plan, Attention cards and
// the related-ticket blocks on Risk / Decision / Loop / Dependency / Change cards.
//
// Status is read through the canonical TicketWorkState (task-execution.ts
// resolveTicketExecutionState over store.ticketWorkStates) and every button calls
// store.setTicketStatus through its named wrappers — so a change made here is the same change
// on every other surface. Same action set everywhere:
//   Open in Jira · Start · Done · Block (+reason) · Skip (+reason) · Defer (+date)
//   + Reopen / Unblock / Reactivate / Stop when they apply.
// A surface may hide actions ONLY through the documented props (`readOnly`, `hideActions`) —
// see AUDIT_TASK_STATE.md §2.6 — never by omission.
//
// Split like the rest of this codebase's testable UI: TaskReferenceRowView is pure (explicit
// state + callbacks, renderable with react-dom/server in the offline test suite), and
// TaskReferenceRow / TaskRow is the thin connected wrapper.

import React, { useState, useSyncExternalStore } from "react";
import { commandCenterStore, type CommandCenterStore } from "@/lib/command-center/store";
import { formatExecutionRecord, resolveTicketExecutionState, type TaskExecutionState } from "@/lib/command-center/task-execution";
import { formatRelativeDateTime } from "@/lib/command-center/relative-time";
import { SKIP_REASONS, type FocusSignal, type SkipReason, type TaskReactivation, type TicketStatusSurface, type WorkItem } from "@/lib/command-center/types";
import { BlockReasonField, SkipReasonSelect } from "./ReasonPickers";
import { FirstSeenBadge, TicketLink } from "./TicketLink";
import { FollowUpDraft } from "./FollowUpDraft";
import { AskFollowUp } from "./AskFollowUp";
import { TicketBrief } from "./TicketBrief";
import { BaRequirementCheck } from "./BaRequirementCheck";
import { BA_CHECK_TYPES } from "@/lib/command-center/ai/ba-requirements";
import { blockedAgeBusinessDays, isBlockerOverdue } from "@/lib/command-center/blocker-followup";
import { needsFromOthersForBlockedTicket, type NeedsFromOthersRow } from "@/lib/command-center/communicate";
import { addDays, todayLocalIso } from "@/lib/command-center/date-utils";
import { workItemUpdatedStamp } from "@/lib/command-center/jira/updated-time";

/** Re-exported for existing importers; the list itself lives in types.ts (E3). */
export { SKIP_REASONS };

export interface TaskRowActions {
  onComplete: () => void;
  /** A4 — `revisitOn` (local YYYY-MM-DD) is optional: schedules a Daily Review re-check. */
  onSkip: (reason?: SkipReason, revisitOn?: string) => void;
  onBlock: (reason?: string, revisitOn?: string, pingOn?: string) => void;
  onReopen: () => void;
  onReactivateSkip: () => void;
  onUnblock: () => void;
  /** → IN_PROGRESS. Optional so hand-built action sets from before Start existed stay valid. */
  onStart?: () => void;
  /** IN_PROGRESS → TODO. */
  onStop?: () => void;
  /** → DEFERRED until `until` (local YYYY-MM-DD). */
  onDefer?: (until: string, reason?: string) => void;
}

/** The actions a surface may hide — only via the `hideActions` prop. */
export type TaskRowAction = "open" | "start" | "done" | "block" | "skip" | "defer";

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

/** The one status badge every surface shows for a ticket. */
const STATUS_BADGE: Record<TaskExecutionState["kind"], { label: string; tone: string }> = {
  active: { label: "To do", tone: "bg-surface2 text-text3" },
  "in-progress": { label: "In progress", tone: "bg-accent/15 text-accent2" },
  deferred: { label: "Deferred", tone: "bg-yellow/15 text-yellow" },
  completed: { label: "Done", tone: "bg-green/15 text-green" },
  "done-in-jira": { label: "Done in Jira", tone: "bg-green/15 text-green" },
  skipped: { label: "Skipped", tone: "bg-surface2 text-text3" },
  blocked: { label: "Blocked", tone: "bg-red/15 text-red" },
};

export function TicketStatusBadge({ kind }: { kind: TaskExecutionState["kind"] }) {
  const b = STATUS_BADGE[kind];
  return (
    <span data-ticket-status={kind} className={`whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-3 tracking-wider ${b.tone}`}>
      {b.label}
    </span>
  );
}

/** Signal chips (Mention, Stale, Risk…) for a ticket row that merges several signals. */
export function SignalChips({ signals }: { signals?: FocusSignal[] }) {
  if (!signals || signals.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1" data-signal-chips={signals.length}>
      {signals.map((s) => (
        <span key={`${s.kind}:${s.candidateId}`} data-signal={s.kind} className="whitespace-nowrap rounded-md border border-border bg-surface2 px-1.5 py-0.5 text-[10px] font-medium leading-3 text-text2">
          {s.label}
          {(s.count ?? 1) > 1 ? ` ×${s.count}` : ""}
        </span>
      ))}
    </span>
  );
}

const STATE_TONE: Record<TaskExecutionState["kind"], string> = {
  active: "",
  "in-progress": "text-accent2",
  deferred: "text-yellow",
  completed: "text-green",
  "done-in-jira": "text-green",
  skipped: "text-text3",
  blocked: "text-red",
};

const BTN = "btn btn-sm btn-secondary";
const BTN_DONE = "btn btn-sm btn-success";
const BTN_GHOST = "btn btn-sm btn-ghost";
const FIELD = "rounded-md border border-border2 bg-surface px-2 py-1 text-xs text-text2 focus:border-accent";

/** Default labels, and the "ticket"-qualified ones used where the row sits next to other
 *  controls of a different kind (Action Plan's action-level buttons) — same actions either way. */
const LABELS = {
  plain: { open: "Open in Jira", start: "Start", stop: "Stop", complete: "Done", skipOpen: "Skip…", skip: "Skip", blockOpen: "Block…", block: "Block", deferOpen: "Defer…", defer: "Defer", reopen: "Reopen", reactivate: "Reactivate", unblock: "Unblock" },
  ticket: {
    open: "Open in Jira",
    start: "Start ticket",
    stop: "Stop ticket",
    complete: "Mark ticket done",
    skipOpen: "Skip ticket…",
    skip: "Skip ticket",
    blockOpen: "Block ticket…",
    block: "Block ticket",
    deferOpen: "Defer ticket…",
    defer: "Defer ticket",
    reopen: "Reopen ticket",
    reactivate: "Reactivate ticket",
    unblock: "Unblock ticket",
  },
};
const TICKET_TITLE = "Records this for the ticket — every list shows the same status. Jira itself is never changed.";

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
  ticketScoped = false,
  as = "li",
  followUpRows,
  blocker,
  showPingOn = false,
  hideActions,
  signals,
  newReason,
  stacked = false,
  initialPicker = null,
  extra,
}: {
  ticketKey: string;
  url?: string;
  title?: string;
  /** Jira's own status — a read-only overlay shown next to the personal status, never merged. */
  statusLabel?: string;
  firstSeenAt?: string;
  execution: TaskExecutionState;
  reactivation?: TaskReactivation;
  /** Omitted = read-only reference (link + state label, no buttons). */
  actions?: TaskRowActions;
  now?: Date;
  /** Extra context line under the record (e.g. Daily Review's completion source). */
  caption?: string;
  /** Qualify every button with "ticket" (e.g. "Mark ticket done") — for cards that also carry
   *  non-ticket controls. */
  ticketScoped?: boolean;
  as?: "li" | "div";
  /** C1 — blocked rows: the "Draft follow-up" message rows (who it waits on). */
  followUpRows?: NeedsFromOthersRow[];
  /** F2 — blocked rows: age in business days against the SLA; when set, the follow-up is the
   *  per-person "Ask" (copy / Slack after confirm) instead of the copy-only draft. */
  blocker?: { ageBusinessDays: number; slaBusinessDays: number };
  /** D5 — offer "Ping on <date>" in the Block picker (Follow-up reminders feature). */
  showPingOn?: boolean;
  /** The ONLY way a surface hides actions (documented in AUDIT_TASK_STATE.md §2.6). */
  hideActions?: TaskRowAction[];
  /** Signal chips when the row merges several signals (Your Delivery Focus / My Work). */
  signals?: FocusSignal[];
  /** Why the ticket is New (Daily Review / My Work "New"). */
  newReason?: string;
  /** Layout only: actions always sit under the ticket info (for rows inside narrow cards). */
  stacked?: boolean;
  /** Which picker starts open (render tests compare its options with Focus Session's). */
  initialPicker?: "skip" | "block" | "defer" | null;
  /** V2.37 I1 — extra content under the ticket info (the connected row's "Brief"). */
  extra?: React.ReactNode;
}) {
  const L = ticketScoped ? LABELS.ticket : LABELS.plain;
  const btnTitle = ticketScoped ? TICKET_TITLE : undefined;
  const hidden = new Set(hideActions ?? []);
  const [picker, setPicker] = useState<"skip" | "block" | "defer" | null>(initialPicker);
  const [skipReason, setSkipReason] = useState<SkipReason | "">("");
  const [blockReason, setBlockReason] = useState("");
  const [revisitOn, setRevisitOn] = useState("");
  const [pingOn, setPingOn] = useState("");
  const [deferUntil, setDeferUntil] = useState("");
  const revisitInput = (
    <input
      type="date"
      value={revisitOn}
      onChange={(e) => setRevisitOn(e.target.value)}
      aria-label="Re-check on (optional)"
      title="Re-check on (optional) — shows up in My Work that day; nothing changes until you act"
      className={FIELD}
    />
  );
  const record = formatExecutionRecord(execution, now);
  const Tag = as;
  const k = execution.kind;
  const can = {
    start: !!actions?.onStart && !hidden.has("start") && (k === "active" || k === "blocked" || k === "skipped" || k === "deferred"),
    stop: !!actions?.onStop && k === "in-progress",
    done: !hidden.has("done") && k !== "completed" && k !== "done-in-jira",
    block: !hidden.has("block") && k !== "completed" && k !== "done-in-jira" && k !== "blocked",
    skip: !hidden.has("skip") && k !== "completed" && k !== "done-in-jira" && k !== "skipped",
    defer: !!actions?.onDefer && !hidden.has("defer") && k !== "completed" && k !== "done-in-jira",
    reopen: k === "completed",
    reactivate: k === "skipped" || k === "deferred",
    unblock: k === "blocked",
  };
  const close = () => {
    setPicker(null);
    setRevisitOn("");
    setPingOn("");
    setBlockReason("");
    setDeferUntil("");
  };

  return (
    <Tag data-task-row={ticketKey} data-task-state={k} className={`flex flex-col gap-2 border-b border-border py-2.5 last:border-b-0 ${stacked ? "" : "sm:flex-row sm:items-center sm:justify-between sm:gap-4"}`}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text3">
          <TicketStatusBadge kind={k} />
          <TicketLink ticketKey={ticketKey} url={url} />
          {statusLabel && <span title="Jira status (read-only)">Jira: {statusLabel}</span>}
          <FirstSeenBadge firstSeenAt={firstSeenAt} now={now} />
          {reactivation && <ReactivatedBadge reactivation={reactivation} now={now} />}
          <SignalChips signals={signals} />
        </div>
        {title && <p className="mt-0.5 truncate text-sm font-medium text-text">{title}</p>}
        {record && (
          <p data-task-record className={`mt-0.5 text-xs ${STATE_TONE[k]}`}>
            {record}
          </p>
        )}
        {newReason && <p className="text-xs text-accent2">New: {newReason}</p>}
        {caption && <p className="text-xs text-text3">{caption}</p>}
        {k === "blocked" && blocker && (
          <p data-blocker-age className={`text-xs ${isBlockerOverdue(blocker.ageBusinessDays, blocker.slaBusinessDays) ? "font-medium text-red" : "text-text3"}`}>
            Blocked {blocker.ageBusinessDays} business day{blocker.ageBusinessDays === 1 ? "" : "s"}
            {isBlockerOverdue(blocker.ageBusinessDays, blocker.slaBusinessDays) ? ` — over the ${blocker.slaBusinessDays}-day SLA` : ` (SLA ${blocker.slaBusinessDays})`}
          </p>
        )}
        {k === "blocked" && followUpRows && (blocker ? <AskFollowUp rows={followUpRows} /> : <FollowUpDraft rows={followUpRows} />)}
        {extra}
      </div>

      {actions && k !== "done-in-jira" && (
        <div className={`flex flex-wrap items-center gap-1.5 ${stacked ? "" : "sm:max-w-[60%] sm:justify-end"}`}>
          {picker === null && (
            <>
              {url && !hidden.has("open") && (
                <a href={url} target="_blank" rel="noopener noreferrer" className={BTN_GHOST}>
                  {L.open}
                  <span aria-hidden="true">↗</span>
                </a>
              )}
              {can.unblock && (
                <button onClick={actions.onUnblock} title={btnTitle} className={BTN}>
                  {L.unblock}
                </button>
              )}
              {can.reactivate && (
                <button onClick={actions.onReactivateSkip} title={btnTitle} className={BTN}>
                  {L.reactivate}
                </button>
              )}
              {can.reopen && (
                <button onClick={actions.onReopen} title={btnTitle} className={BTN}>
                  {L.reopen}
                </button>
              )}
              {can.start && (
                <button onClick={actions.onStart} title={btnTitle} className={BTN}>
                  {L.start}
                </button>
              )}
              {can.stop && (
                <button onClick={actions.onStop} title={btnTitle} className={BTN}>
                  {L.stop}
                </button>
              )}
              {can.done && (
                <button onClick={actions.onComplete} title={btnTitle} className={BTN_DONE}>
                  {L.complete}
                </button>
              )}
              {can.block && (
                <button onClick={() => setPicker("block")} title={btnTitle} className={BTN}>
                  {L.blockOpen}
                </button>
              )}
              {can.skip && (
                <button onClick={() => setPicker("skip")} title={btnTitle} className={BTN}>
                  {L.skipOpen}
                </button>
              )}
              {can.defer && (
                <button onClick={() => setPicker("defer")} title={btnTitle} className={BTN}>
                  {L.deferOpen}
                </button>
              )}
            </>
          )}
          {picker === "skip" && (
            <>
              <SkipReasonSelect value={skipReason} onChange={setSkipReason} className={FIELD} />
              {revisitInput}
              <button onClick={() => { actions.onSkip(skipReason || undefined, revisitOn || undefined); close(); }} className={BTN}>
                {L.skip}
              </button>
              <button onClick={close} className={BTN_GHOST}>
                Cancel
              </button>
            </>
          )}
          {picker === "block" && (
            <>
              <BlockReasonField listId={`block-reasons-${ticketKey}`} value={blockReason} onChange={setBlockReason} className={`w-44 ${FIELD}`} />
              {revisitInput}
              {showPingOn && (
                <input
                  type="date"
                  value={pingOn}
                  onChange={(e) => setPingOn(e.target.value)}
                  aria-label="Ping on (optional)"
                  title="Ping on (optional) — a reminder to chase whoever this waits on (Daily Review + Slack)"
                  className={FIELD}
                />
              )}
              <button onClick={() => { actions.onBlock(blockReason || undefined, revisitOn || undefined, pingOn || undefined); close(); }} className={BTN}>
                {L.block}
              </button>
              <button onClick={close} className={BTN_GHOST}>
                Cancel
              </button>
            </>
          )}
          {picker === "defer" && actions.onDefer && (
            <>
              <input
                type="date"
                value={deferUntil}
                onChange={(e) => setDeferUntil(e.target.value)}
                aria-label="Defer until"
                title="Comes back to Today on this date (default: tomorrow)"
                className={FIELD}
              />
              <button onClick={() => { actions.onDefer!(deferUntil || addDays(todayLocalIso(), 1)); close(); }} className={BTN}>
                {L.defer}
              </button>
              <button onClick={close} className={BTN_GHOST}>
                Cancel
              </button>
            </>
          )}
        </div>
      )}
    </Tag>
  );
}

/** The store's actions for one ticket key — every one a named wrapper over setTicketStatus.
 *  `surface` is recorded in the ticket's history; `store` is injectable for tests. */
export function storeActionsFor(ticketKey: string, surface: TicketStatusSurface = "command-center", store: CommandCenterStore = commandCenterStore): TaskRowActions {
  return {
    onComplete: () => store.completeTicketInDailyCommand(ticketKey, surface),
    onSkip: (reason, revisitOn) => store.skipTicketInDailyCommand(ticketKey, reason, revisitOn, surface),
    onBlock: (reason, revisitOn, pingOn) => store.blockTicketInDailyCommand(ticketKey, reason, revisitOn, pingOn, surface),
    onReopen: () => store.reopenTicketInDailyCommand(ticketKey, surface),
    onReactivateSkip: () => store.reactivateSkippedTicket(ticketKey, surface),
    onUnblock: () => store.unblockTicketInDailyCommand(ticketKey, surface),
    onStart: () => store.startTicket(ticketKey, surface),
    onStop: () => store.stopTicket(ticketKey, surface),
    onDefer: (until, reason) => store.deferTicket(ticketKey, until, reason, surface),
  };
}

/** Connected row. Pass a WorkItem when one is at hand (link, title, Jira status, provenance all
 *  come from it); otherwise a bare ticketKey/url. `finishedInJira` is the caller's own
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
  ticketScoped,
  as,
  surface = "command-center",
  hideActions,
  signals,
  newReason,
  stacked,
}: {
  workItem?: Pick<WorkItem, "key" | "sourceUrl" | "title" | "status" | "jiraStatusName" | "firstSeenAt">;
  ticketKey?: string;
  url?: string;
  title?: string;
  finishedInJira?: boolean;
  reactivation?: TaskReactivation;
  /** Documented hiding prop: no buttons at all (reference only). */
  readOnly?: boolean;
  showTitle?: boolean;
  caption?: string;
  ticketScoped?: boolean;
  as?: "li" | "div";
  /** Recorded in the ticket's history for every change made from this row. */
  surface?: TicketStatusSurface;
  /** Documented hiding prop: hides just these actions. */
  hideActions?: TaskRowAction[];
  signals?: FocusSignal[];
  newReason?: string;
  /** Layout only — see TaskReferenceRowView. */
  stacked?: boolean;
}) {
  const state = useSyncExternalStore(commandCenterStore.subscribe, commandCenterStore.getSnapshot, commandCenterStore.getServerSnapshot);
  const key = workItem?.key ?? ticketKey;
  if (!key) return null;
  const w = state.data.workItems.find((x) => x.key === key);
  const execution = resolveTicketExecutionState(key, state.ticketWorkStates, finishedInJira);
  let followUpRows: NeedsFromOthersRow[] | undefined;
  if (execution.kind === "blocked" && !readOnly) {
    const deps = w ? state.data.dependencies.filter((d) => d.workItemId === w.id && d.status === "unresolved") : [];
    followUpRows = needsFromOthersForBlockedTicket({ key, title: w?.title ?? workItem?.title ?? title, dueDate: w?.dueDate }, execution.reason, deps);
  }
  const jira = workItem ?? w;
  const blockedAt = execution.kind === "blocked" ? state.ticketWorkStates[key]?.updatedAt : undefined;
  const age = state.features.blockerFollowUp ? blockedAgeBusinessDays(blockedAt, todayLocalIso()) : undefined;
  return (
    <TaskReferenceRowView
      ticketKey={key}
      url={workItem?.sourceUrl ?? url ?? w?.sourceUrl}
      title={showTitle ? (workItem?.title ?? title ?? w?.title) : undefined}
      statusLabel={jira ? (jira.jiraStatusName ?? jira.status) : undefined}
      firstSeenAt={jira?.firstSeenAt}
      execution={execution}
      followUpRows={followUpRows}
      blocker={age !== undefined ? { ageBusinessDays: age, slaBusinessDays: state.blockerSlaBusinessDays } : undefined}
      showPingOn={state.features.followUpReminders}
      reactivation={reactivation}
      actions={readOnly ? undefined : storeActionsFor(key, surface)}
      caption={caption}
      ticketScoped={ticketScoped}
      as={as}
      hideActions={hideActions}
      signals={signals}
      newReason={newReason}
      stacked={stacked}
      extra={
        w?.sourceType === "jira" && (state.features.ticketBrief || (state.features.baRequirementCheck && BA_CHECK_TYPES.has(w.type))) ? (
          <>
            {state.features.ticketBrief && <TicketBrief ticketKey={key} workItemUpdated={workItemUpdatedStamp(w)} />}
            {state.features.baRequirementCheck && BA_CHECK_TYPES.has(w.type) && <BaRequirementCheck ticketKey={key} workItemUpdated={workItemUpdatedStamp(w)} />}
          </>
        ) : undefined
      }
    />
  );
}

/** Alias: the single TaskRow every surface renders. */
export const TaskRow = TaskReferenceRow;

/** V2.26 — the "tickets this card is about" block for cards whose entity links to concrete
 *  work items (risks, decisions, changes, dependencies, loops). Renders nothing when there
 *  are none — never an empty heading. */
export function RelatedTickets({ workItems, label = "Related tickets" }: { workItems?: WorkItem[]; label?: string }) {
  if (!workItems || workItems.length === 0) return null;
  return (
    <div className="mt-3 rounded-lg border border-border bg-surface2/60 px-3 py-1">
      <p className="eyebrow pt-2">{label}</p>
      <ul>
        {workItems.map((w) => (
          <TaskReferenceRow key={w.id} workItem={w} surface="related-ticket" />
        ))}
      </ul>
    </div>
  );
}
