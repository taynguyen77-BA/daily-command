"use client";

// D4 — Reminder Center: every skipped / blocked / deferred ticket and when it comes back. Tabs: Due now · Upcoming · Parked without a date ·
// Snoozed · History. Every row is the shared TaskRow (Reactivate / Unblock / Done / Open in Jira / Draft ping come from it) plus inline
// reminder controls: Snooze, Change date, Stop reminding. Bulk select → bulk snooze / reactivate. Nothing here writes to Jira.

import { useMemo, useState } from "react";
import { TaskRow } from "@/components/command-center/TaskReferenceRow";
import { Panel, SectionHeading, TrustLabel } from "@/components/command-center/ui";
import { ProgressiveGrid } from "@/components/command-center/progressive-list";
import { useCommandCenter } from "@/components/command-center/use-command-center";
import { buildReminderCenter, SNOOZE_CHOICES, type ReminderRow } from "@/lib/command-center/reminder-center";
import { asReminderPrefs } from "@/lib/command-center/reminder-schedule";
import { validateRemindOn } from "@/lib/command-center/reminder-model";
import { getServerReminderStatus, subscribeServerReminderStatus } from "@/lib/command-center/reminder-sync";
import { useSyncExternalStore } from "react";

type Tab = "due" | "upcoming" | "parked" | "snoozed" | "history";
const TABS: { id: Tab; label: string }[] = [
  { id: "due", label: "Due now" },
  { id: "upcoming", label: "Upcoming" },
  { id: "parked", label: "Parked without a date" },
  { id: "snoozed", label: "Snoozed" },
  { id: "history", label: "History" },
];
const EMPTY: Record<Tab, string> = {
  due: "Nothing is due. When a skipped, blocked or deferred ticket reaches its reminder date it appears here (and in Slack at your delivery hour, even when the app is closed).",
  upcoming: "No upcoming reminders. When you Skip, Block or Defer a ticket, pick a “Remind me” date and it is listed here.",
  parked: "Nothing is parked without a date. Tickets parked with “No reminder” show up here once they are older than your threshold, so they cannot be forgotten.",
  snoozed: "Nothing is snoozed.",
  history: "No finished reminders yet.",
};
const BTN = "rounded-md border border-border px-2 py-1 text-xs text-text2 hover:bg-surface2";

function RowControls({ row, today, onSnooze, onDate, onStop }: { row: ReminderRow; today: string; onSnooze: (d: string) => void; onDate: (d: string) => string | null; onStop: () => void }) {
  const [date, setDate] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 pl-1 text-xs text-text3" data-reminder-controls={row.ticketKey}>
      <span>
        {row.snoozedUntil ? `Snoozed until ${row.snoozedUntil}` : row.remindOn ? `Remind on ${row.remindOn}` : "No reminder date"}
        {row.level > 0 ? ` · reminder ${row.level + 1}` : ""}
        {` · parked ${row.ageDays} day${row.ageDays === 1 ? "" : "s"}`}
        {row.lastRemindedOn ? ` · last reminded ${row.lastRemindedOn}` : ""}
      </span>
      <span aria-hidden>·</span>
      {SNOOZE_CHOICES(today).map((c) => (
        <button key={c.id} type="button" className={BTN} onClick={() => onSnooze(c.date)} title={`Snooze until ${c.date}`}>
          Snooze {c.label}
        </button>
      ))}
      <input type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} aria-label={`Change date for ${row.ticketKey}`} className="rounded border border-border bg-surface px-1.5 py-0.5 text-xs" />
      <button type="button" className={BTN} disabled={!date} onClick={() => setErr(onDate(date))}>
        Change date
      </button>
      <button type="button" className={BTN} onClick={onStop} title="Keeps the ticket parked, without a reminder date">
        Stop reminding
      </button>
      {err && <span role="alert" className="text-red">{err}</span>}
    </div>
  );
}

export default function RemindersPage() {
  const { state, store, today } = useCommandCenter();
  const prefs = asReminderPrefs(state.reminderPrefs);
  const server = useSyncExternalStore(subscribeServerReminderStatus, getServerReminderStatus, getServerReminderStatus);
  const view = useMemo(() => buildReminderCenter(state.ticketWorkStates, state.data.workItems, today, prefs), [state.ticketWorkStates, state.data.workItems, today, prefs]);
  const [tab, setTab] = useState<Tab>("due");
  const [project, setProject] = useState("");
  const [status, setStatus] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const lists: Record<Exclude<Tab, "history">, ReminderRow[]> = { due: view.dueNow, upcoming: view.upcoming, parked: view.parkedWithoutDate, snoozed: view.snoozed };
  const projects = Array.from(new Set(Object.values(lists).flat().map((r) => r.projectKey))).sort();
  const rows = tab === "history" ? [] : lists[tab].filter((r) => (!project || r.projectKey === project) && (!status || r.status === status));
  const counts: Record<Tab, number> = { due: view.dueNow.length, upcoming: view.upcoming.length, parked: view.parkedWithoutDate.length, snoozed: view.snoozed.length, history: view.history.length };
  const toggle = (k: string) => setPicked((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const bulkSnooze = (date: string) => { picked.forEach((k) => store.updateTicketReminder(k, { kind: "snooze", until: date })); setPicked(new Set()); };
  const bulkReactivate = () => {
    picked.forEach((k) => {
      const s = state.ticketWorkStates[k]?.status;
      if (s === "BLOCKED") store.unblockTicketInDailyCommand(k, "my-work");
      else store.reactivateSkippedTicket(k, "my-work");
    });
    setPicked(new Set());
  };

  return (
    <div className="space-y-4">
      <SectionHeading title="Reminders" subtitle="Skipped, blocked and deferred tickets — and when each one comes back. Parking a ticket never makes it disappear." />
      <p className="text-xs text-text3">
        <TrustLabel kind="user-input" /> Dates are yours; reminders go out at {String(prefs.deliveryHourLocal).padStart(2, "0")}:00 local{prefs.skipWeekends ? " (weekends move to Monday)" : ""}.{" "}
        {server.checked ? (server.active ? "Server reminders are active: Slack gets them even when this app is closed." : `Server reminders are inactive${server.kvConfigured ? " (needs Slack and the Jira account id configured)" : " (needs the server key-value store)"} — reminders show here and in Morning Mode only.`) : "Checking server reminders…"}
      </p>
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Reminder lists">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={`rounded-md border px-2.5 py-1 text-xs ${tab === t.id ? "border-accent bg-accent/10 text-text" : "border-border text-text2 hover:bg-surface2"}`}>
            {t.label} ({counts[t.id]})
          </button>
        ))}
      </div>
      {tab !== "history" && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-text2">
          <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Filter by project" className="rounded border border-border bg-surface px-2 py-1">
            <option value="">All projects</option>
            {projects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by state" className="rounded border border-border bg-surface px-2 py-1">
            <option value="">All states</option>
            <option value="BLOCKED">Blocked</option>
            <option value="SKIPPED">Skipped</option>
            <option value="DEFERRED">Deferred</option>
          </select>
          {picked.size > 0 && (
            <>
              <span>{picked.size} selected</span>
              {SNOOZE_CHOICES(today).map((c) => <button key={c.id} className={BTN} onClick={() => bulkSnooze(c.date)}>Snooze {c.label}</button>)}
              <button className={BTN} onClick={bulkReactivate}>Reactivate / unblock</button>
            </>
          )}
        </div>
      )}
      <Panel className="p-4">
        {tab === "history" ? (
          view.history.length === 0 ? <p className="text-sm text-text3">{EMPTY.history}</p> : (
            <ul className="space-y-1 text-sm">
              {view.history.map((h) => (
                <li key={h.ticketKey} className="text-text2"><span className="font-mono text-text">{h.ticketKey}</span>{h.title ? ` — ${h.title}` : ""} · was {h.was.toLowerCase()} · {h.via} on {h.closedOn}</li>
              ))}
            </ul>
          )
        ) : rows.length === 0 ? (
          <p className="text-sm text-text3">{EMPTY[tab]}</p>
        ) : (
          <ProgressiveGrid items={rows} as="ul" className="" resetKey={`${tab}|${project}|${status}`} noun="reminders" render={(r) => (
              <li key={r.ticketKey} className="border-b border-border last:border-b-0">
                <label className="flex items-center gap-2 pt-2 text-xs text-text3">
                  <input type="checkbox" checked={picked.has(r.ticketKey)} onChange={() => toggle(r.ticketKey)} aria-label={`Select ${r.ticketKey}`} />
                  {r.reason ? `Reason: ${r.reason}` : "Select"}
                </label>
                <TaskRow ticketKey={r.ticketKey} url={r.url} title={r.title} surface="my-work" as="div" />
                <RowControls
                  row={r}
                  today={today}
                  onSnooze={(d) => store.updateTicketReminder(r.ticketKey, { kind: "snooze", until: d })}
                  onDate={(d) => {
                    const v = validateRemindOn(d, today);
                    if (!v.ok) return v.message;
                    store.updateTicketReminder(r.ticketKey, { kind: "change-date", remindOn: d });
                    return null;
                  }}
                  onStop={() => store.updateTicketReminder(r.ticketKey, { kind: "stop" })}
                />
              </li>
            )} />
        )}
      </Panel>
    </div>
  );
}
