"use client";

// D4 — "Remind me" row for Skip / Block / Defer: chips [Tomorrow] [In 3 days] [Next Monday] [In 2 weeks], a custom date, a smart default,
// and "No reminder (I'll find it myself)". With the `requireReminderDate` setting on, confirming needs a date or "No reminder" — so a parked
// ticket can never vanish silently. Shared by every row that parks a ticket (TaskReferenceRow, Focus Session, Morning Mode).

import { useSyncExternalStore } from "react";
import { commandCenterStore } from "@/lib/command-center/store";
import { canConfirmParking } from "@/lib/command-center/reminder-model";
import { reminderChips, smartDefaultRemindOn } from "@/lib/command-center/reminder-schedule";
import { todayLocalIso } from "@/lib/command-center/date-utils";

const FIELD = "rounded-md border border-border2 bg-surface px-2 py-1 text-xs text-text";
const CHIP = "rounded-full border border-border px-2 py-0.5 text-[11px] text-text2 hover:bg-surface2";

export interface ReminderChoice { remindOn: string; noReminder: boolean }

/** The same decision the picker enforces — usable by a parent to disable its Confirm button. */
export function useReminderRequired(): boolean {
  const state = useSyncExternalStore(commandCenterStore.subscribe, commandCenterStore.getSnapshot, commandCenterStore.getServerSnapshot);
  return state.reminderPrefs?.requireReminderDate === true;
}

export function reminderConfirmable(choice: ReminderChoice, required: boolean, today: string = todayLocalIso()): { ok: boolean; message?: string } {
  const r = canConfirmParking({ require: required, remindOn: choice.remindOn || undefined, noReminder: choice.noReminder, today });
  return r.ok ? { ok: true } : { ok: false, message: r.message };
}

export function ReminderPicker({ status, value, noReminder, onChange, slaBusinessDays, jiraDueDate, label = "Remind me" }: {
  status: "BLOCKED" | "SKIPPED" | "DEFERRED";
  value: string;
  noReminder: boolean;
  onChange: (next: ReminderChoice) => void;
  slaBusinessDays?: number;
  jiraDueDate?: string;
  label?: string;
}) {
  const required = useReminderRequired();
  const today = todayLocalIso();
  const smart = smartDefaultRemindOn({ status, today, slaBusinessDays, jiraDueDate, chosenDate: status === "DEFERRED" ? value : undefined });
  const verdict = reminderConfirmable({ remindOn: value, noReminder }, required, today);
  return (
    <div data-reminder-picker className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      <span className="text-[11px] text-text3">{label}{required ? "" : " (optional)"}:</span>
      {reminderChips(today).map((c) => (
        <button key={c.id} type="button" className={CHIP} aria-pressed={!noReminder && value === c.date} onClick={() => onChange({ remindOn: c.date, noReminder: false })}>
          {c.label}
        </button>
      ))}
      <button type="button" className={CHIP} title="The date the app suggests for this kind of parking" onClick={() => onChange({ remindOn: smart, noReminder: false })} aria-pressed={!noReminder && value === smart}>
        Suggested · {smart}
      </button>
      <input type="date" min={today} value={noReminder ? "" : value} disabled={noReminder} onChange={(e) => onChange({ remindOn: e.target.value, noReminder: false })} aria-label="Re-check on (optional)" title="Re-check on (optional) — shows up in My Work and is sent to Slack that day; nothing changes until you act" className={FIELD} />
      <label className="flex items-center gap-1 text-[11px] text-text3">
        <input type="checkbox" checked={noReminder} onChange={(e) => onChange({ remindOn: e.target.checked ? "" : value, noReminder: e.target.checked })} />
        No reminder (I&apos;ll find it myself)
      </label>
      {!verdict.ok && <span role="alert" className="text-[11px] text-red">{verdict.message}</span>}
    </div>
  );
}
