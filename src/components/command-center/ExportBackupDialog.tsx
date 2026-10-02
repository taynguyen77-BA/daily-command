"use client";

// G4 — the export step: says plainly what the file contains, and offers an optional passphrase
// (AES-GCM encryption, backup-crypto.ts). Used by Backup & storage and by Reset's "Export
// backup first".

import React, { useState } from "react";
import { commandCenterStore } from "@/lib/command-center/store";
import { downloadBackup } from "./BackupReminder";

export const BACKUP_DATA_WARNING =
  "This file contains your client ticket data — ticket keys and titles, people's names, comments you were mentioned in, reports and history. Store it like any confidential client document, or protect it with a passphrase.";

export function ExportBackupDialog({ onDone, onCancel }: { onDone?: () => void; onCancel?: () => void }) {
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = pass !== confirm;
  const tooShort = pass.length > 0 && pass.length < 8;
  return (
    <div data-export-backup-dialog className="mt-3 rounded-md border border-border bg-surface2 p-3 text-sm">
      <p role="note" className="text-text">
        <span className="font-semibold text-yellow">Heads-up:</span> {BACKUP_DATA_WARNING}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Passphrase (optional)" aria-label="Backup passphrase (optional)" autoComplete="new-password" className="w-48 rounded-md border border-border bg-surface px-2 py-1" />
        {pass && <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Repeat passphrase" aria-label="Repeat passphrase" autoComplete="new-password" className="w-48 rounded-md border border-border bg-surface px-2 py-1" />}
        {tooShort && <span className="text-orange">At least 8 characters.</span>}
        {pass && !tooShort && mismatch && confirm && <span className="text-orange">The two don&apos;t match.</span>}
      </div>
      <p className="mt-1 text-xs text-text3">{pass ? "Encrypted (AES-GCM). Without the passphrase the file can't be read — or restored. There is no recovery." : "No passphrase: a plain JSON file."}</p>
      <div className="mt-2 flex gap-2">
        <button
          disabled={busy || (!!pass && (tooShort || mismatch))}
          onClick={async () => {
            setBusy(true);
            try {
              await downloadBackup(commandCenterStore, pass || undefined);
              setStatus(pass ? "Encrypted backup downloaded." : "Backup downloaded.");
              setPass("");
              setConfirm("");
              onDone?.();
            } catch (err) {
              setStatus(err instanceof Error ? err.message : "Export failed.");
            } finally {
              setBusy(false);
            }
          }}
          className="btn btn-sm btn-primary disabled:opacity-50"
        >
          {busy ? "Preparing…" : pass ? "Download encrypted backup" : "Download backup"}
        </button>
        {onCancel && (
          <button onClick={onCancel} className="btn btn-sm btn-ghost">
            Cancel
          </button>
        )}
        {status && <span className="self-center text-xs text-text3">{status}</span>}
      </div>
    </div>
  );
}
