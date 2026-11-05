// D4 — client side of server reminders: mirrors the compact ReminderIndex to the server (debounced, only when it changed) and tells the
// rest of the app whether the SERVER is reminding, so the browser runner (follow-up-runner.ts) never sends a duplicate — the same
// pattern as serverSideNotifyActive. Best effort: any failure leaves the app working locally (Setup Health says why the server is inactive).

import { pairedAuthHeader } from "./device-pairing";
import type { CommandCenterStore } from "./store";
import { asReminderIndex, buildReminderIndex, indexSignature } from "./reminder-index";
import { asReminderPrefs } from "./reminder-schedule";

const ENDPOINT = "/api/command-center/reminders/index";
const DEBOUNCE_MS = 2_000;

export interface ServerReminderStatus { checked: boolean; active: boolean; kvConfigured: boolean; error?: string }
let status: ServerReminderStatus = { checked: false, active: false, kvConfigured: false };
const listeners = new Set<() => void>();
export const getServerReminderStatus = (): ServerReminderStatus => status;
export const isServerReminderActive = (): boolean => status.active;
export function subscribeServerReminderStatus(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function setStatus(next: ServerReminderStatus) {
  status = next;
  listeners.forEach((fn) => fn());
}

export async function pullServerReminders(fetchImpl: typeof fetch = fetch): Promise<ReturnType<typeof asReminderIndex>> {
  try {
    const res = await fetchImpl(ENDPOINT, { headers: { ...pairedAuthHeader() } });
    if (!res.ok) { setStatus({ checked: true, active: false, kvConfigured: false, error: `HTTP ${res.status}` }); return null; }
    const json = (await res.json()) as { active?: boolean; kvConfigured?: boolean; index?: unknown };
    setStatus({ checked: true, active: json.active === true, kvConfigured: json.kvConfigured === true });
    return asReminderIndex(json.index);
  } catch {
    setStatus({ checked: true, active: false, kvConfigured: false, error: "unreachable" });
    return null;
  }
}

let started = false;
export function initReminderMirror(store: CommandCenterStore, fetchImpl: typeof fetch = fetch): void {
  if (started || typeof window === "undefined") return;
  started = true;
  let lastSig = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const push = async () => {
    const s = store.getSnapshot();
    if (!s.loaded) return;
    const index = buildReminderIndex(s.ticketWorkStates, s.data.workItems, new Date().toISOString(), asReminderPrefs(s.reminderPrefs));
    const sig = indexSignature(index);
    if (sig === lastSig) return;
    try {
      const res = await fetchImpl(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", ...pairedAuthHeader() }, body: JSON.stringify({ index }) });
      if (res.ok) lastSig = sig;
    } catch {
      // retried on the next change / next load
    }
  };
  const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void push(), DEBOUNCE_MS); };
  void pullServerReminders(fetchImpl).then((server) => {
    if (server && server.items.length > 0) mergeServerProgress(store, server.items);
    schedule();
  });
  store.subscribe(schedule);
}

/** The cron's escalation progress (level / lastRemindedOn) flows back into the local records so the Reminder Center shows what was sent. */
function mergeServerProgress(store: CommandCenterStore, items: { ticketKey: string; level: number; lastRemindedOn?: string; remindOn?: string; status: string }[]) {
  for (const i of items) {
    if (!i.lastRemindedOn) continue;
    const local = store.getSnapshot().ticketWorkStates[i.ticketKey];
    if (!local || local.status !== i.status || local.reminder?.lastRemindedOn === i.lastRemindedOn) continue;
    if ((local.reminder?.lastRemindedOn ?? "") > i.lastRemindedOn) continue;
    store.updateTicketReminder(i.ticketKey, { kind: "sent", on: i.lastRemindedOn, level: i.level });
  }
}
