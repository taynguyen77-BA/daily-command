"use client";

// E1 — backup download + the weekly reminder. A backup is a JSON file of the whole local state
// (backup.ts); the reminder appears on every page (it lives in the root layout via Header) once
// a week while cross-device sync is NOT active — the only other copy of this data would be
// another device's — and can be switched off in Data & Settings → Features.

import { useEffect, useState } from "react";
import { commandCenterStore, type CommandCenterStore } from "@/lib/command-center/store";
import { backupFileName, buildBackup, isBackupReminderDue, serializeBackup } from "@/lib/command-center/backup";
import { checkAppStateSyncStatus } from "@/lib/command-center/app-state-sync";
import { useCommandCenter } from "./use-command-center";

/** Downloads a backup of the current state and records when. */
export function downloadBackup(store: CommandCenterStore = commandCenterStore): void {
  const exportedAt = new Date().toISOString();
  const blob = new Blob([serializeBackup(buildBackup(store.getSnapshot(), exportedAt))], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = backupFileName(exportedAt);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  store.markBackupExported(exportedAt);
}

let crossDeviceStatus: Promise<boolean> | null = null;
/** Whether cross-device sync is configured AND this device is paired (fetched once per load). */
export function crossDeviceSyncActive(): Promise<boolean> {
  if (!crossDeviceStatus) crossDeviceStatus = checkAppStateSyncStatus().then((s) => s.configured && s.paired);
  return crossDeviceStatus;
}

export function useCrossDeviceSyncActive(): boolean | null {
  const [active, setActive] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void crossDeviceSyncActive().then((a) => {
      if (!cancelled) setActive(a);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return active;
}

export function BackupReminderBar() {
  const { state, store } = useCommandCenter();
  const crossDeviceActive = useCrossDeviceSyncActive();
  const due = isBackupReminderDue({
    enabled: state.features.backupReminder,
    crossDeviceActive,
    loaded: state.loaded,
    isDemo: state.isDemo,
    lastBackupAt: state.lastBackupAt,
    snoozedAt: state.backupReminderSnoozedAt,
    now: new Date(),
  });
  if (!due) return null;
  return (
    <div className="mx-auto mb-4 w-full max-w-shell px-4 sm:px-6" data-backup-reminder>
      <div className="flex flex-col gap-2 rounded-lg border border-yellow/40 bg-yellow/10 px-4 py-3 text-sm text-text sm:flex-row sm:items-center sm:justify-between" role="status">
        <p>
          <span className="font-semibold text-yellow">Back up your data.</span>{" "}
          {state.lastBackupAt ? `Last backup: ${new Date(state.lastBackupAt).toLocaleDateString()}.` : "You have never downloaded a backup."} Everything lives only in this browser — cross-device
          sync isn&apos;t on.
        </p>
        <div className="flex shrink-0 gap-2">
          <button onClick={() => downloadBackup(store)} className="btn btn-sm btn-primary">
            Download backup
          </button>
          <button onClick={() => store.snoozeBackupReminder()} className="btn btn-sm btn-ghost">
            Remind me next week
          </button>
        </div>
      </div>
    </div>
  );
}
