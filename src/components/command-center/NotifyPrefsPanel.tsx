"use client";

// P3.5 — smart notifications: when and how Slack hears from you. The defaults (immediate, everything, no quiet
// hours, nothing muted) are exactly today's behaviour; nothing changes until you save something else. Applies to the
// scheduled server-side check, which needs the server notify check (PERSONAL_JIRA_ACCOUNT_ID + KV) to be active.

import { useState } from "react";
import { DEFAULT_NOTIFY_PREFS, IMMEDIATE_KINDS, type ImmediateKind, type NotifyMode, type NotifyPrefs } from "@/lib/command-center/notify-prefs";
import { saveNotifyPrefs, type SlackNotifyStatus } from "@/lib/command-center/notify-client";

const KIND_LABEL: Record<ImmediateKind, string> = { ASSIGNMENT_P1P2: "New P1/P2 assignment", MENTION_URGENT: "Urgent mention (P1/P2, overdue or blocked ticket)", ESCALATION: "Escalation (unanswered mention)" };

export function NotifyPrefsPanel({ status }: { status: SlackNotifyStatus | null }) {
  const saved = status?.prefs ?? DEFAULT_NOTIFY_PREFS;
  // Remount with fresh values once the server's prefs have loaded (keyed by their JSON).
  return <NotifyPrefsForm key={JSON.stringify(saved)} initial={saved} serverActive={status?.serverSideNotifyActive === true} />;
}

function NotifyPrefsForm({ initial, serverActive }: { initial: NotifyPrefs; serverActive: boolean }) {
  const [mode, setMode] = useState<NotifyMode>(initial.mode);
  const [quietOn, setQuietOn] = useState(!!initial.quietHours && initial.quietHours.start !== initial.quietHours.end);
  const [start, setStart] = useState(initial.quietHours?.start ?? "20:00");
  const [end, setEnd] = useState(initial.quietHours?.end ?? "08:00");
  const [kinds, setKinds] = useState<ImmediateKind[]>(initial.immediateKinds);
  const [muted, setMuted] = useState(initial.mutedProjects.join(", "));
  const [max, setMax] = useState(String(initial.maxPerRun));
  const [escalate, setEscalate] = useState(initial.escalateUnanswered);
  const [result, setResult] = useState<string | null>(null);

  async function save() {
    const maxPerRun = Math.max(0, Math.min(200, Math.floor(Number(max) || 0)));
    const prefs: NotifyPrefs = { mode, ...(quietOn ? { quietHours: { start, end } } : {}), immediateKinds: kinds, mutedProjects: muted.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean), maxPerRun, escalateUnanswered: escalate };
    const r = await saveNotifyPrefs(prefs);
    setResult(r.saved ? "Saved." : r.reason === "not-configured" ? "Not saved — the server has no KV store configured." : `Not saved — ${r.reason ?? "unknown error"}.`);
  }

  return (
    <div className="mt-4 border-t border-border pt-3 text-sm text-text2" data-notify-prefs>
      <p className="text-text">Smart notifications</p>
      {!serverActive && <p className="mt-1 text-xs text-yellow">These preferences apply to the scheduled server-side check, which is not active on this deployment (needs PERSONAL_JIRA_ACCOUNT_ID and a KV store).</p>}
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="flex items-center gap-2">
          Delivery
          <select value={mode} onChange={(e) => setMode(e.target.value as NotifyMode)} className="rounded border border-border bg-surface2 px-2 py-1 text-sm" aria-label="Delivery mode">
            <option value="immediate">Immediate (default)</option>
            <option value="digest-hourly">Hourly digest</option>
            <option value="digest-daily">Daily digest</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          Max separate messages per run
          <input type="number" min={0} max={200} value={max} onChange={(e) => setMax(e.target.value)} className="w-20 rounded border border-border bg-surface2 px-2 py-1 text-sm" aria-label="Max messages per run" />
          <span className="text-xs text-text3">0 = no limit</span>
        </label>
      </div>
      <label className="mt-2 flex flex-wrap items-center gap-2">
        <input type="checkbox" checked={quietOn} onChange={(e) => setQuietOn(e.target.checked)} /> Quiet hours
        <input type="time" value={start} onChange={(e) => setStart(e.target.value)} disabled={!quietOn} className="rounded border border-border bg-surface2 px-2 py-1 text-sm" aria-label="Quiet hours start" />
        to
        <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} disabled={!quietOn} className="rounded border border-border bg-surface2 px-2 py-1 text-sm" aria-label="Quiet hours end" />
        <span className="text-xs text-text3">your timezone; the end minute is not quiet; can cross midnight</span>
      </label>
      <fieldset className="mt-2">
        <legend className="text-xs text-text3">Always send at once, even in quiet hours or digest mode</legend>
        {IMMEDIATE_KINDS.map((k) => (
          <label key={k} className="mr-4 inline-flex items-center gap-1.5">
            <input type="checkbox" checked={kinds.includes(k)} onChange={(e) => setKinds(e.target.checked ? [...kinds, k] : kinds.filter((x) => x !== k))} /> {KIND_LABEL[k]}
          </label>
        ))}
      </fieldset>
      <label className="mt-2 flex flex-wrap items-center gap-2">
        Muted projects
        <input value={muted} onChange={(e) => setMuted(e.target.value)} placeholder="e.g. ABC, XYZ" className="w-56 rounded border border-border bg-surface2 px-2 py-1 text-sm" aria-label="Muted project keys" />
        <span className="text-xs text-text3">never notify</span>
      </label>
      <label className="mt-2 flex items-center gap-2">
        <input type="checkbox" checked={escalate} onChange={(e) => setEscalate(e.target.checked)} /> Re-announce a mention once if it is still unanswered after 2 business days
      </label>
      <div className="mt-3 flex items-center gap-3">
        <button onClick={save} className="btn btn-sm btn-secondary">Save preferences</button>
        {result && <span className="text-xs text-text3">{result}</span>}
      </div>
    </div>
  );
}
