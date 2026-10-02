"use client";

// E1 — Data & Settings "Backup & storage": whether the browser keeps this data persistently,
// Export backup (full state as JSON) and Import backup. Import is validate → preview counts →
// confirm, and merges by default (per-record LWW — backup.ts mergeImportedState); "Replace"
// is an explicit second choice. A file that fails validation shows why and changes nothing.

import { useEffect, useState } from "react";
import { Panel, SectionHeading } from "./ui";
import { useCommandCenter } from "./use-command-center";
import { downloadBackup, useCrossDeviceSyncActive } from "./BackupReminder";
import { backupCounts, mergeImportedState, parseBackup, replaceWithImportedState, type BackupCounts, type ParsedBackup } from "@/lib/command-center/backup";
import { ensurePersistentStorage, storagePersistenceLabel, type StoragePersistence } from "@/lib/command-center/storage-persistence";

const COUNT_LABELS: [keyof BackupCounts, string][] = [
  ["ticketStates", "Ticket statuses"],
  ["planItems", "Plan items"],
  ["actions", "Actions"],
  ["decisions", "Decisions"],
  ["attentionStates", "Attention states"],
  ["memoryEvents", "History events"],
  ["dailyReports", "Daily reports"],
  ["syncLogEntries", "Sync log entries"],
  ["workItems", "Work items"],
];

export function BackupPanel() {
  const { state, store } = useCommandCenter();
  const crossDeviceActive = useCrossDeviceSyncActive();
  const [persistence, setPersistence] = useState<StoragePersistence | null>(null);
  const [pending, setPending] = useState<Extract<ParsedBackup, { ok: true }> & { fileName: string } | null>(null);
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [importError, setImportError] = useState<string | null>(null);
  const [imported, setImported] = useState<string | null>(null);

  useEffect(() => {
    void ensurePersistentStorage().then(setPersistence);
  }, []);

  async function onFile(file: File | undefined) {
    setImportError(null);
    setImported(null);
    setPending(null);
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      setImportError("The file couldn't be read. Nothing was imported.");
      return;
    }
    const parsed = parseBackup(text);
    if (!parsed.ok) {
      setImportError(parsed.error);
      return;
    }
    setMode("merge");
    setPending({ ...parsed, fileName: file.name });
  }

  function confirmImport() {
    if (!pending) return;
    const current = store.getSnapshot();
    store.adoptImportedState(mode === "replace" ? replaceWithImportedState(current, pending.state) : mergeImportedState(current, pending.state, new Date().toISOString()));
    setImported(`${mode === "replace" ? "Replaced this device's data with" : "Merged"} ${pending.fileName}.`);
    setPending(null);
  }

  const local = backupCounts(state);

  return (
    <Panel className="p-5" data-backup-panel>
      <SectionHeading
        title="Backup & storage"
        subtitle="Everything here lives in this browser. Download a backup now and then — and before resetting — so clearing site data or switching laptops never loses your ticket statuses, reports and history."
      />
      <div className="space-y-1 text-sm text-text2">
        <p data-storage-persistence>{persistence ? storagePersistenceLabel(persistence) : "Storage: checking…"}</p>
        <p>Last backup: {state.lastBackupAt ? new Date(state.lastBackupAt).toLocaleString() : "never"}</p>
        <p>
          Cross-device sync:{" "}
          {crossDeviceActive === null ? "checking…" : crossDeviceActive ? "on — your other devices also hold this data" : "off — this browser holds the only copy"}
        </p>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button onClick={() => downloadBackup(store)} className="btn btn-primary">
          Export backup
        </button>
        <label className="btn btn-secondary cursor-pointer">
          Import backup…
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {importError && (
        <p role="alert" className="mt-3 text-sm text-red">
          {importError}
        </p>
      )}
      {imported && <p className="mt-3 text-sm text-green">{imported}</p>}

      {pending && (
        <div className="mt-4 rounded-md border border-border bg-surface2 p-3 text-sm" data-import-preview>
          <p className="text-text">
            <span className="font-mono">{pending.fileName}</span> — exported {new Date(pending.exportedAt).toLocaleString()}
            {pending.migratedFrom !== undefined && <span className="text-text3"> · from an older version (schema {pending.migratedFrom}), upgraded on import</span>}
          </p>
          <table className="mt-2 w-full text-xs text-text2">
            <thead>
              <tr className="text-left text-text3">
                <th className="font-normal" />
                <th className="font-normal">In backup</th>
                <th className="font-normal">On this device</th>
              </tr>
            </thead>
            <tbody>
              {COUNT_LABELS.map(([key, label]) => (
                <tr key={key}>
                  <td>{label}</td>
                  <td className="font-mono">{pending.counts[key]}</td>
                  <td className="font-mono">{local[key]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <fieldset className="mt-3 space-y-1 text-xs text-text2">
            <label className="flex items-start gap-2">
              <input type="radio" name="import-mode" checked={mode === "merge"} onChange={() => setMode("merge")} className="mt-0.5" />
              <span>
                <span className="text-text">Merge (recommended)</span> — per ticket/record, the newer change wins; nothing on this device is deleted.
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="import-mode" checked={mode === "replace"} onChange={() => setMode("replace")} className="mt-0.5" />
              <span>
                <span className="text-text">Replace</span> — this device&apos;s data becomes exactly the backup. Anything newer here is lost.
              </span>
            </label>
          </fieldset>
          <div className="mt-3 flex gap-2">
            <button onClick={confirmImport} className={mode === "replace" ? "rounded-md bg-red px-3 py-1.5 text-sm font-medium text-white" : "btn btn-primary"}>
              {mode === "replace" ? "Replace with backup" : "Merge backup"}
            </button>
            <button onClick={() => setPending(null)} className="btn btn-secondary">
              Cancel
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}
