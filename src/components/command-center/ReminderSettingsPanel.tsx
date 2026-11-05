"use client";

// D4 — Data & Settings → Reminders: require a date when parking, delivery hour, weekends, escalation ladder, the "parked without a date"
// threshold, and "Send me a test reminder" (through the same Slack path as every other message). Existing installs keep "require" OFF.

import { useState } from "react";
import { sendReportToSlack } from "@/lib/command-center/notify-client";
import { asBriefingPrefs, validateBriefingTime } from "@/lib/command-center/briefing";
import { validateDeliveryHour } from "@/lib/command-center/reminder-model";
import { asReminderPrefs } from "@/lib/command-center/reminder-schedule";
import { getServerReminderStatus, subscribeServerReminderStatus } from "@/lib/command-center/reminder-sync";
import { Panel, SectionHeading } from "./ui";
import { useCommandCenter } from "./use-command-center";
import { useSyncExternalStore } from "react";

const FIELD = "w-16 rounded border border-border bg-surface2 px-2 py-1 text-sm";

export function ReminderSettingsPanel() {
  const { state, store } = useCommandCenter();
  const prefs = asReminderPrefs(state.reminderPrefs);
  const server = useSyncExternalStore(subscribeServerReminderStatus, getServerReminderStatus, getServerReminderStatus);
  const [hourText, setHourText] = useState(String(prefs.deliveryHourLocal));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const hourVerdict = validateDeliveryHour(Number(hourText));
  const briefing = asBriefingPrefs(state.briefingPrefs);
  const [briefingTime, setBriefingTime] = useState(briefing.time);
  const briefingVerdict = validateBriefingTime(briefingTime);

  const ladder = (i: 0 | 1 | 2, v: string) => {
    const next = [...prefs.ladder] as [number, number, number];
    next[i] = Number(v);
    store.setReminderPrefs({ ladder: next }); // invalid ladders (not strictly increasing, 1-60) keep the old one
  };

  return (
    <Panel className="p-5" data-reminder-settings>
      <SectionHeading title="Reminders" subtitle="Skipped, blocked and deferred tickets come back on the date you pick — in Slack too, even when the app is closed." />
      <div className="space-y-3 text-sm text-text2">
        <label className="flex items-start gap-2">
          <input type="checkbox" checked={prefs.requireReminderDate} onChange={(e) => store.setReminderPrefs({ requireReminderDate: e.target.checked })} className="mt-1" />
          <span>
            <span className="text-text">Ask for a reminder date when I skip, block or defer</span>
            <span className="block text-xs text-text3">ON: a date (or “No reminder”) is required, so nothing is parked and forgotten. New installs start with this ON; installs from before keep it OFF until you switch it on.</span>
          </span>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-text">Deliver reminders at</span>
          <input value={hourText} onChange={(e) => { setHourText(e.target.value); const n = Number(e.target.value); if (validateDeliveryHour(n).ok) store.setReminderPrefs({ deliveryHourLocal: n }); }} inputMode="numeric" className={FIELD} aria-label="Delivery hour (0-23)" />
          <span className="text-xs text-text3">:00 local time (0–23)</span>
          {!hourVerdict.ok && <span role="alert" className="text-xs text-red">{hourVerdict.message}</span>}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={prefs.skipWeekends} onChange={(e) => store.setReminderPrefs({ skipWeekends: e.target.checked })} />
          <span>A reminder due on a weekend goes out on Monday</span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-text">If I ignore it, remind again after</span>
          {([0, 1, 2] as const).map((i) => (
            <input key={i} defaultValue={prefs.ladder[i]} onBlur={(e) => ladder(i, e.target.value)} inputMode="numeric" className={FIELD} aria-label={`Escalation ${i + 1} (days)`} />
          ))}
          <span className="text-xs text-text3">days, then weekly. At most one message per ticket per day.</span>
        </div>
        <label className="flex items-center gap-2">
          <span className="text-text">List tickets parked without a date after</span>
          <input defaultValue={prefs.parkedWithoutDateDays} onBlur={(e) => store.setReminderPrefs({ parkedWithoutDateDays: Number(e.target.value) })} inputMode="numeric" className={FIELD} aria-label="Parked without a date threshold (days)" />
          <span className="text-xs text-text3">days</span>
        </label>
        <p className="text-xs text-text3">
          Channels: in-app always (Reminders page, Morning Mode). Slack when configured. Server reminders are {server.checked ? (server.active ? "ACTIVE (the browser does not send duplicates)" : "inactive — needs the server key-value store, Slack and the Jira account id") : "being checked…"}.
        </p>
        <div className="space-y-2 border-t border-border pt-3" data-briefing-settings>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={briefing.enabled} onChange={(e) => store.setBriefingPrefs({ enabled: e.target.checked })} className="mt-1" />
            <span>
              <span className="text-text">Send me a Morning briefing in Slack on workdays</span>
              <span className="block text-xs text-text3">Reminders due, your top next actions, tickets due within 2 days, mentions waiting for you and new high slip risks — one message, with ticket links. Off by default.</span>
            </span>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-text">At</span>
            <input value={briefingTime} onChange={(e) => { setBriefingTime(e.target.value); if (validateBriefingTime(e.target.value).ok) store.setBriefingPrefs({ time: e.target.value }); }} className="w-20 rounded border border-border bg-surface2 px-2 py-1 text-sm" aria-label="Briefing time (HH:mm)" />
            {!briefingVerdict.ok && <span role="alert" className="text-xs text-red">{briefingVerdict.message}</span>}
          </label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={briefing.skipWeekends} onChange={(e) => store.setBriefingPrefs({ skipWeekends: e.target.checked })} /><span>Skip weekends</span></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={briefing.skipIfEmpty} onChange={(e) => store.setBriefingPrefs({ skipIfEmpty: e.target.checked })} /><span>Send nothing on a day with nothing for me (otherwise a short “nothing needs you today” line)</span></label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="rounded border border-border px-3 py-1 text-sm" onClick={async () => {
            setMsg(null);
            const r = await sendReportToSlack("⏰ Test reminder — this is how your reminders will look: *1 reminder due today*\n• EXAMPLE-1 — Example ticket · Blocked: waiting on the API team · parked 3 days");
            setMsg(r.sent ? { ok: true, text: "Test reminder sent to Slack." } : { ok: false, text: `Not sent (${r.reason ?? "Slack is not configured"}).` });
          }}>Send me a test reminder</button>
          {msg && <span className={msg.ok ? "text-green" : "text-red"} role="status">{msg.text}</span>}
        </div>
      </div>
    </Panel>
  );
}
