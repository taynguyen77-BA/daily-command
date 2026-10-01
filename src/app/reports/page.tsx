"use client";

// B3/B4 — Reports: any past Daily Report by date, any Weekly Report by week, each as ticket
// lists (key + Jira link + project) with Markdown / Slack / plain-text copy. Today's daily
// report is built live (standup state as of now); past days read the frozen snapshot. Close
// Day and Weekly Review keep their own buttons — this page is the browsable home for both.

import { useMemo, useState } from "react";
import { useCommandCenter } from "@/components/command-center/use-command-center";
import { EmptyState, Panel, SectionHeading } from "@/components/command-center/ui";
import {
  buildDailyReportView,
  buildWeeklyReportView,
  formatTicketLine,
  mondayOf,
  renderDailyReport,
  renderWeeklyReport,
  type ReportFormat,
  type ReportTicket,
  type WeeklyGroupBy,
} from "@/lib/command-center/reports";

const FORMATS: { format: ReportFormat; label: string }[] = [
  { format: "markdown", label: "Copy Markdown" },
  { format: "slack", label: "Copy Slack" },
  { format: "text", label: "Copy plain text" },
];
const BTN = "rounded border border-border px-2 py-1 text-xs text-text2 hover:border-accent hover:text-text";

function TicketList({ tickets, showAssignee = false, empty = "None." }: { tickets: ReportTicket[]; showAssignee?: boolean; empty?: string }) {
  if (tickets.length === 0) return <p className="text-sm text-text3">{empty}</p>;
  return (
    <ul className="space-y-1">
      {tickets.map((t, i) => (
        <li key={`${t.key ?? t.title}-${i}`} data-report-ticket={t.key} className="text-sm text-text2">
          {t.key && t.url ? (
            <a href={t.url} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
              {t.key}
            </a>
          ) : t.key ? (
            <span className="font-medium text-text">{t.key}</span>
          ) : null}{" "}
          {/* The rest of the line, exactly as the plain-text export prints it. */}
          {formatTicketLine({ ...t, key: undefined, url: undefined }, "text", { showAssignee })}
        </li>
      ))}
    </ul>
  );
}

function Section({ title, tickets, showAssignee, empty }: { title: string; tickets: ReportTicket[]; showAssignee?: boolean; empty?: string }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text3">
        {title} ({tickets.length})
      </h3>
      <TicketList tickets={tickets} showAssignee={showAssignee} empty={empty} />
    </div>
  );
}

function CopyButtons({ render }: { render: (format: ReportFormat) => string }) {
  const [copied, setCopied] = useState<ReportFormat | null>(null);
  return (
    <div className="flex flex-wrap gap-1.5">
      {FORMATS.map(({ format, label }) => (
        <button
          key={format}
          className={BTN}
          onClick={async () => {
            await navigator.clipboard.writeText(render(format));
            setCopied(format);
          }}
        >
          {copied === format ? "Copied ✓" : label}
        </button>
      ))}
    </div>
  );
}

export default function ReportsPage() {
  const { state, store, today } = useCommandCenter();
  const [tab, setTab] = useState<"daily" | "weekly">("daily");
  const [date, setDate] = useState(today);
  const [weekAnchor, setWeekAnchor] = useState(today);
  const [includeTeam, setIncludeTeam] = useState(true);
  const [groupBy, setGroupBy] = useState<WeeklyGroupBy>("project");
  const identity = useMemo(() => ({ displayName: state.personalIdentity?.displayName ?? state.ownerName, accountId: state.personalIdentity?.accountId }), [state.personalIdentity, state.ownerName]);

  // Today is always built live: today's events so far + the standup state as of now.
  const liveStandup = useMemo(() => (state.loaded ? store.buildLiveStandup() : undefined), [state, store]);
  const daily = useMemo(() => {
    const isToday = date === today;
    const snapshot = isToday ? { date, generatedAt: new Date().toISOString(), events: state.memoryEvents.filter((e) => e.date === date) } : state.dailyReports[date];
    return { snapshot, view: buildDailyReportView(snapshot, date, identity, isToday ? liveStandup : undefined) };
  }, [date, today, state.memoryEvents, state.dailyReports, identity, liveStandup]);

  const weekly = useMemo(
    () =>
      buildWeeklyReportView({
        weekStart: mondayOf(weekAnchor),
        mode: state.weeklyReportMode ?? "workweek",
        groupBy,
        dailyReports: { ...state.dailyReports, ...(daily.snapshot && date === today ? { [today]: daily.snapshot } : {}) },
        identity,
        today,
        ...(liveStandup ? { liveStandup: { date: today, state: liveStandup } } : {}),
      }),
    [weekAnchor, state.weeklyReportMode, state.dailyReports, groupBy, identity, liveStandup, daily.snapshot, date, today]
  );

  if (!state.loaded) {
    return <EmptyState title="No data yet" description="Sync Jira or load the demo dataset to start producing reports." onLoadDemo={() => store.loadDemoData()} />;
  }

  const v = daily.view;
  const w = weekly;
  return (
    <div className="space-y-6 pb-16">
      <SectionHeading title="Reports" subtitle="Standup-ready daily and weekly reports — ticket lists with Jira links, ready to paste into Slack or an update." />

      <div className="flex flex-wrap items-center gap-2">
        {(["daily", "weekly"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`${BTN} ${tab === t ? "border-accent text-text" : ""}`}>
            {t === "daily" ? "Daily" : "Weekly"}
          </button>
        ))}
        <label className="ml-2 flex items-center gap-1 text-xs text-text3">
          <input type="checkbox" checked={includeTeam} onChange={(e) => setIncludeTeam(e.target.checked)} /> Include team work
        </label>
      </div>

      {tab === "daily" ? (
        <Panel className="space-y-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm text-text2">
              Day
              <input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} className="rounded border border-border bg-surface px-1.5 py-1 text-xs" />
            </label>
            <CopyButtons render={(format) => renderDailyReport(v, format, { includeTeam })} />
          </div>
          {!daily.snapshot && date !== today ? (
            <p className="text-sm text-text3">No Daily Report was generated for {date}.</p>
          ) : (
            <>
              {!v.standupAvailable && <p className="text-xs text-text3">No standup snapshot was saved for this day — in progress / new / mentions are not available; blocked and skipped come from that day&apos;s recorded actions.</p>}
              {!v.identityConfigured && <p className="text-xs text-orange">Set your identity in Data &amp; Settings to tell your own Jira completions from the team&apos;s.</p>}
              <Section title="Done" tickets={v.doneMine} />
              <Section title="In progress / planned today" tickets={v.inProgress} />
              <Section title="Blocked" tickets={v.blocked} />
              <Section title="Skipped" tickets={v.skipped} />
              <Section title="New today" tickets={v.newToday} />
              <Section title="Mentions awaiting my reply" tickets={v.mentionsAwaitingReply} />
              {v.removedFromScope.length > 0 && <Section title="Removed from scope" tickets={v.removedFromScope} showAssignee />}
              {v.decisions.length > 0 && (
                <div>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text3">Decisions ({v.decisions.length})</h3>
                  <ul className="list-disc pl-5 text-sm text-text2">{v.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul>
                </div>
              )}
              {includeTeam && (
                <details>
                  <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-text3">Team: done ({v.teamDone.length})</summary>
                  <div className="mt-2">
                    <TicketList tickets={v.teamDone} showAssignee />
                  </div>
                </details>
              )}
            </>
          )}
        </Panel>
      ) : (
        <Panel className="space-y-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-3 text-sm text-text2">
              <label className="flex items-center gap-2">
                Week of
                <input type="date" value={weekAnchor} max={today} onChange={(e) => e.target.value && setWeekAnchor(e.target.value)} className="rounded border border-border bg-surface px-1.5 py-1 text-xs" />
              </label>
              <span className="text-xs text-text3">
                {w.weekStart} → {w.weekEnd} ({w.mode === "calendar" ? "7 days" : "Mon–Fri"})
              </span>
              <label className="flex items-center gap-1 text-xs">
                Group by
                <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as WeeklyGroupBy)} className="rounded border border-border bg-surface px-1.5 py-1 text-xs">
                  <option value="project">Project</option>
                  <option value="sprint" disabled={!state.jiraSprintFieldId}>
                    Sprint{state.jiraSprintFieldId ? "" : " (set the sprint field in Data & Settings)"}
                  </option>
                </select>
              </label>
            </div>
            <CopyButtons render={(format) => renderWeeklyReport(w, format, { includeTeam })} />
          </div>
          <p className="text-xs text-text3">
            Done {w.totals.doneMine} · New {w.totals.newReceived} · Blocked {w.totals.blocked} · Skipped {w.totals.skipped} · Decisions {w.totals.decisions}
            {includeTeam ? ` · Team done ${w.totals.teamDone}` : ""} · {w.reportedDays.length} day(s) with a report
            {w.missingDays.length > 0 ? ` (missing: ${w.missingDays.join(", ")})` : ""}
          </p>
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text3">Done by {w.groupBy} ({w.totals.doneMine})</h3>
            {w.doneGroups.length === 0 ? (
              <p className="text-sm text-text3">None.</p>
            ) : (
              w.doneGroups.map((g) => (
                <div key={g.name} className="mb-2">
                  <p className="text-sm font-medium text-text">
                    {g.name} ({g.tickets.length})
                  </p>
                  <TicketList tickets={g.tickets} />
                </div>
              ))
            )}
          </div>
          <Section title={`Carried over${w.stateAsOf ? ` (as of ${w.stateAsOf})` : ""}`} tickets={w.carriedOver} />
          <Section title="Blockers" tickets={w.blockers} />
          <Section title="Skipped" tickets={w.skipped} />
          <Section title="New received this week" tickets={w.newReceived} />
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text3">Decisions ({w.decisions.length})</h3>
            {w.decisions.length === 0 ? <p className="text-sm text-text3">None.</p> : <ul className="list-disc pl-5 text-sm text-text2">{w.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul>}
          </div>
          <Section title="Next week (open assigned + scheduled re-checks)" tickets={w.nextWeek} />
          {includeTeam && (
            <details>
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-text3">Team: done this week ({w.teamDone.length})</summary>
              <div className="mt-2">
                <TicketList tickets={w.teamDone} showAssignee />
              </div>
            </details>
          )}
        </Panel>
      )}
    </div>
  );
}
