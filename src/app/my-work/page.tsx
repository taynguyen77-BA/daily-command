"use client";

// My Work — every ticket that is mine to act on, in views that partition them (each ticket is
// in exactly one): Today · New · In progress · Blocked · Skipped/Deferred · Done (7 days).
// Absorbs Your Delivery Focus + My Day's agenda (Today), Daily Review (New, plus its re-check,
// follow-up and completion blocks) and My Assigned Work (every view). Every row is the shared
// TaskRow, reading the one TicketWorkState — a change made here is the same change on Command
// Center, Priorities, Action Plan and Attention. /focus and /daily-review redirect here.
//
// A3 — opening (or refreshing) this page records nothing: "New" rows stay until explicitly
// acknowledged, per row ("Seen") or all at once ("Mark all reviewed").

import { Suspense, useCallback, useMemo, useRef, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMyWork } from "@/components/command-center/use-my-work";
import { EmptyState, Panel, SectionHeading, TrustLabel } from "@/components/command-center/ui";
import { TaskRow } from "@/components/command-center/TaskReferenceRow";
import { YourDeliveryFocus } from "@/components/command-center/YourDeliveryFocus";
import { MyDayAgenda } from "@/components/command-center/MyDayAgenda";
import { DailyGuidancePanel } from "@/components/command-center/DailyGuidancePanel";
import { isMyWorkView, MY_WORK_DONE_WINDOW_DAYS, MY_WORK_VIEWS, type MyWorkRow, type MyWorkView } from "@/lib/command-center/my-work";
import { formatRelativeDateTime } from "@/lib/command-center/relative-time";
import { buildMorningBrief } from "@/lib/command-center/morning-brief";
import { dueFollowUps } from "@/lib/command-center/follow-up-reminders";
import { isMyActionItem } from "@/lib/command-center/personal-relation";
import type { TriageCommand, TriageRow } from "@/lib/command-center/triage-keys";
import { useTriageKeys } from "@/components/command-center/use-triage-keys";

const VIEW_SUBTITLE: Record<MyWorkView, string> = {
  today: "Your focus, today's plan, and every open ticket that is yours — ranked by its strongest signal.",
  new: "New tickets, reassignments to you and mentions of you since your last review. Each stays here until you mark it seen.",
  "in-progress": "Tickets you started.",
  blocked: "Not done — paused on something outside your control. Unblock when it moves.",
  skipped: "Still relevant, deliberately not now. A deferred ticket comes back to Today on its date.",
  done: `Marked done here, or detected as done in Jira — last ${MY_WORK_DONE_WINDOW_DAYS} days.`,
};

function doneCaption(row: MyWorkRow, now: Date): string | undefined {
  const sources = row.doneSources ?? (row.view.status === "DONE" ? [row.view.closedInJira ? "jira" : "daily-command"] : []);
  if (sources.length === 0) return undefined;
  const source = sources.length === 2 ? "Jira + Command Center" : sources[0] === "jira" ? "Jira" : "Command Center";
  const when = formatRelativeDateTime(row.view.since, now);
  return when ? `Source: ${source} · ${when}` : `Source: ${source}`;
}

function MyWorkInner() {
  const searchParams = useSearchParams();
  const requested = searchParams?.get("view");
  const [view, setView] = useState<MyWorkView>(isMyWorkView(requested) ? requested : "today");
  const { state, store, work, review, now, personalFocus, proactive, today, filteredData, scopedMentionEvents, dailyCommandMaps } = useMyWork();
  const myActionItemsOnly = state.myActionItemsOnly.myDay;
  const reviewedRef = useRef(false);

  // §22 — "the user actually reviewed today's focus", at most once per day (was /focus's).
  useEffect(() => {
    if (reviewedRef.current || !state.loaded) return;
    if (!state.memoryEvents.some((e) => e.kind === "DAILY_FOCUS_REVIEWED" && e.date === today)) store.recordDailyFocusReviewed(today);
    reviewedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.loaded]);

  function selectView(v: MyWorkView) {
    setView(v);
    try {
      window.history.replaceState(null, "", `/my-work?view=${v}`);
    } catch {
      // no history API (server render) — the tab still switches
    }
  }

  // D1 — "Since yesterday 18:00: …" with jump links.
  const brief = useMemo(
    () =>
      state.features.morningBrief
        ? buildMorningBrief({
            workItems: filteredData.workItems,
            identity: { displayName: state.ownerName, accountId: state.personalIdentity?.accountId },
            mentionEvents: scopedMentionEvents,
            memoryEvents: state.memoryEvents,
            dailyCommandSkips: dailyCommandMaps.dailyCommandSkips,
            dailyCommandBlocks: dailyCommandMaps.dailyCommandBlocks,
            now,
          })
        : null,
    [state.features.morningBrief, state.ownerName, state.personalIdentity?.accountId, state.memoryEvents, filteredData.workItems, scopedMentionEvents, dailyCommandMaps, now]
  );

  // D5 — blocked tickets whose "ping on" date has come.
  const followUps = useMemo(() => (state.features.followUpReminders ? dueFollowUps(dailyCommandMaps.dailyCommandBlocks, today, filteredData.workItems) : []), [state.features.followUpReminders, dailyCommandMaps, today, filteredData.workItems]);

  const rows = work.views[view];
  // D2 — keyboard triage over the current view's rows, in page order.
  const triageRows: TriageRow[] = useMemo(
    () => rows.map((r) => ({ ticketKey: r.ticketKey, url: r.workItem?.sourceUrl, reviewable: view === "new", actionable: r.view.status !== "DONE" && !r.finishedInJira })),
    [rows, view]
  );
  const runTriage = useCallback(
    (cmd: TriageCommand) => {
      if (cmd.kind === "complete") store.completeTicketInDailyCommand(cmd.ticketKey, "keyboard");
      else if (cmd.kind === "skip") store.skipTicketInDailyCommand(cmd.ticketKey, undefined, undefined, "keyboard");
      else if (cmd.kind === "block") store.blockTicketInDailyCommand(cmd.ticketKey, undefined, undefined, undefined, "keyboard");
      else if (cmd.kind === "reviewed") store.markDailyReviewSeen([cmd.ticketKey]);
      else if (cmd.kind === "open") window.open(cmd.url, "_blank", "noopener");
    },
    [store]
  );
  const triageOn = state.loaded && state.features.keyboardTriage;
  const selected = useTriageKeys(triageOn, triageRows, runTriage);
  const ring = (i: number) => (triageOn && i === selected ? "rounded ring-1 ring-accent" : "");

  if (!state.loaded) {
    return <EmptyState title="No data yet" description="Sync Jira or load the demo dataset to see your work." onLoadDemo={() => store.loadDemoData()} />;
  }

  const hasIdentity = !!state.ownerName || !!state.personalIdentity?.accountId;
  const row = (r: MyWorkRow, i: number) => (
    <li key={r.ticketKey} data-my-work-row={r.ticketKey} data-triage-index={i} className={`flex items-start gap-2 border-b border-border last:border-b-0 ${ring(i)}`}>
      <div className="min-w-0 flex-1">
        <TaskRow
          as="div"
          ticketKey={r.ticketKey}
          workItem={r.workItem}
          finishedInJira={r.finishedInJira}
          reactivation={r.view.reactivation}
          signals={r.view.signals}
          newReason={r.view.newReason}
          caption={view === "done" ? doneCaption(r, now) : r.recheckDue ? "Re-check due today" : undefined}
          surface="my-work"
        />
      </div>
      {view === "new" && (
        <button onClick={() => store.markDailyReviewSeen([r.ticketKey])} title="Hide from New until something else happens on this ticket" className="mt-2 shrink-0 rounded px-2 py-1 text-xs text-text3 hover:bg-surface2 hover:text-text2">
          Seen
        </button>
      )}
    </li>
  );
  const visibleRows = myActionItemsOnly && view === "today" ? rows.filter((r) => r.sources.includes("assigned") || r.sources.includes("recorded") || isMyActionItem(personalFocus?.candidates.find((c) => c.ticketKey === r.ticketKey)?.relation)) : rows;

  const viewBody = (
    <>
        <SectionHeading title={`${view === "today" ? "My open tickets" : MY_WORK_VIEWS.find((v) => v.id === view)!.label} (${visibleRows.length})`} subtitle={VIEW_SUBTITLE[view]} />
        {view === "new" && visibleRows.length > 0 && (
          <div className="mb-2 flex justify-end">
            <button onClick={() => store.markDailyReviewSeen(review.newRows.map((r) => r.ticketKey))} className="rounded border border-border px-2 py-1 text-xs text-text2 hover:border-accent hover:text-text">
              Mark all reviewed
            </button>
          </div>
        )}
        {visibleRows.length === 0 ? (
          <Panel className="p-4 text-sm text-text3">{view === "new" ? "Nothing new to review." : "Nothing here."}</Panel>
        ) : (
          <Panel className="p-4">
            <ul>{visibleRows.map(row)}</ul>
          </Panel>
        )}
    </>
  );

  return (
    <div className="space-y-6 pb-16">
      <SectionHeading
        title="My Work"
        subtitle="Every ticket that is yours to act on — one status per ticket, the same on every page."
        action={
          <label className="flex items-center gap-1.5 text-xs text-text3">
            <input type="checkbox" checked={myActionItemsOnly} onChange={(e) => store.setMyActionItemsOnly("myDay", e.target.checked)} className="h-3.5 w-3.5" />
            My action items only
          </label>
        }
      />
      <TrustLabel kind="calculated" />

      {!hasIdentity && (
        <Panel className="border-accent/30 p-4 text-sm text-text2">
          Your identity is not set, so assigned work and ownership-based ranking can&apos;t be shown yet.{" "}
          <a href="/data-settings" className="font-medium text-accent2 hover:underline">Set it in Data & Settings</a>.
        </Panel>
      )}

      <div role="tablist" aria-label="My Work views" className="flex flex-wrap gap-1">
        {MY_WORK_VIEWS.map((v) => (
          <button
            key={v.id}
            role="tab"
            aria-selected={view === v.id}
            data-my-work-tab={v.id}
            onClick={() => selectView(v.id)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${view === v.id ? "bg-surface2 text-text" : "text-text3 hover:text-text2"}`}
          >
            {v.label} <span className="text-xs text-text3">({work.counts[v.id]})</span>
          </button>
        ))}
      </div>

      {triageOn && triageRows.length > 0 && (
        <p className="text-xs text-text3" data-triage-help>
          Keyboard: <kbd>J</kbd>/<kbd>K</kbd> move · <kbd>C</kbd> done · <kbd>S</kbd> skip · <kbd>B</kbd> block{view === "new" ? <> · <kbd>R</kbd> reviewed</> : null} · <kbd>O</kbd> open in Jira
        </p>
      )}

      {view === "today" && personalFocus && (
        <>
          <YourDeliveryFocus personalFocus={personalFocus} compact />
          <DailyGuidancePanel personalFocus={personalFocus} planItems={state.personalPlan.filter((p) => p.plannedDate === today)} outcomeScorecard={proactive?.outcomeScorecard} />
          <section>
            <SectionHeading title="My Agenda" subtitle="Today's plan — reconciled against live project state; plan changes are always surfaced, never silent." />
            <MyDayAgenda personalFocus={personalFocus} />
          </section>
        </>
      )}

      {view === "new" && brief && (
        <Panel className="p-4" data-morning-brief>
          <p className="text-sm text-text">
            <span className="font-medium">{brief.sinceLabel}:</span>{" "}
            {brief.counts.map((c, i) => (
              <span key={c.id}>
                {i > 0 && ", "}
                <a href={c.href} className={c.count > 0 ? "text-accent hover:underline" : "text-text3"}>
                  {c.count} {c.label}
                </a>
              </span>
            ))}
          </p>
        </Panel>
      )}

      {view === "blocked" && followUps.length > 0 && (
        <section id="review-followups">
          <SectionHeading title={`Follow-ups to send (${followUps.length})`} subtitle="Blocked tickets whose ping date has come — draft the follow-up from the row. (A Slack reminder goes out once per date when Slack is configured.)" />
          <Panel className="p-4">
            <ul>
              {followUps.map((f) => (
                <TaskRow key={f.ticketKey} ticketKey={f.ticketKey} workItem={filteredData.workItems.find((w) => w.key === f.ticketKey)} caption={`Ping due ${f.pingOn}`} surface="my-work" />
              ))}
            </ul>
          </Panel>
        </section>
      )}

      {view === "new" ? <section id="review-new">{viewBody}</section> : <section id={`my-work-${view}`}>{viewBody}</section>}

      {view === "new" && (
        // Re-checks due today live in their own view (Blocked / Skipped); listed here only as
        // a pointer so the morning check sees them — the rows themselves aren't duplicated.
        <section id="review-due">
          <SectionHeading title={`Due for re-check today (${review.dueForRecheck.length})`} subtitle="Skipped or blocked tickets whose re-check day has come — they stay skipped/blocked until you act." />
          {review.dueForRecheck.length === 0 ? (
            <Panel className="p-4 text-sm text-text3">Nothing due for a re-check.</Panel>
          ) : (
            <Panel className="flex flex-wrap gap-2 p-4 text-sm">
              {review.dueForRecheck.map((r) => (
                <button key={r.ticketKey} onClick={() => selectView(r.kind === "blocked" ? "blocked" : "skipped")} className="rounded border border-border px-2 py-1 text-xs text-text2 hover:border-accent hover:text-text">
                  {r.ticketKey} → {r.kind === "blocked" ? "Blocked" : "Skipped / Deferred"}
                </button>
              ))}
            </Panel>
          )}
        </section>
      )}
    </div>
  );
}

export default function MyWorkPage() {
  return (
    <Suspense fallback={null}>
      <MyWorkInner />
    </Suspense>
  );
}
