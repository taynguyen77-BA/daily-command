// G4 — backup protection: a warning that the file holds client ticket data, an optional
// passphrase → AES-GCM (PBKDF2 ≥ 200k iterations, random salt/iv in the header); import detects
// encrypted files and asks for the passphrase; a wrong one → clear error, state untouched.
// Run through scripts/tests/run.mts (npm test).

import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getTodayIso, parseStoredState, type StoreState } from "../../src/lib/command-center/store";
import { createMemoryStateStorage } from "../../src/lib/command-center/state-persistence";
import { slug } from "../../src/lib/command-center/attention-queue";
import { addDays } from "../../src/lib/command-center/date-utils";
import { buildBackup, mergeImportedState, parseBackup, serializeBackup } from "../../src/lib/command-center/backup";
import { BACKUP_PBKDF2_ITERATIONS, decryptBackupText, encryptBackupText, ENCRYPTED_BACKUP_FORMAT, isEncryptedBackup } from "../../src/lib/command-center/backup-crypto";
import { BACKUP_DATA_WARNING, ExportBackupDialog } from "../../src/components/command-center/ExportBackupDialog";
import { ok } from "./harness.mts";
import { v226Actionable, v226ConfiguredStore, v226Tick } from "./helpers.mts";

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const comparable = (s: StoreState) => JSON.stringify({ t: s.ticketWorkStates, r: s.dailyReports, m: s.memoryEvents, l: s.syncLog, p: s.personalPlan, a: s.data.actions, w: s.data.workItems.map((x) => x.key) });

// ----- AC: encrypted round trip restores identical state; plaintext export still works -----
{
  const group = "G4 Encrypted backup";
  const { store, setJira } = v226ConfiguredStore({ stateStorage: createMemoryStateStorage(), stateChannel: null, stateFocusTargets: [] });
  setJira(["EN-1", "EN-2", "EN-3"].map((k) => v226Actionable(k)));
  await store.syncJira();
  const today = getTodayIso();
  store.blockTicketInDailyCommand("EN-1", "Waiting on the client's legal team", undefined, undefined, "my-work");
  store.deferTicket("EN-2", addDays(today, 2), undefined, "my-work");
  const plan = store.addPersonalPlanItem({ sourceType: "attention", sourceId: `ASSIGNMENT:${slug("jira-EN-3")}`, estimatedMinutes: 15, plannedDate: today, priority: 0 });
  store.completeFocusItem(plan, today);
  store.generateDailyReport(today, true);
  await v226Tick();
  const before = store.getSnapshot();
  const plain = serializeBackup(buildBackup(before, "2026-10-07T09:00:00.000Z"));

  const enc = await encryptBackupText(plain, "correct horse battery staple");
  const header = JSON.parse(enc);
  ok(group, isEncryptedBackup(enc) && !isEncryptedBackup(plain) && header.format === ENCRYPTED_BACKUP_FORMAT, "an encrypted file is recognised (and a plain one isn't)");
  ok(group, header.kdf.name === "PBKDF2" && header.kdf.hash === "SHA-256" && header.kdf.iterations >= 200_000 && header.kdf.iterations === BACKUP_PBKDF2_ITERATIONS && header.cipher.name === "AES-GCM", `AES-GCM with a PBKDF2-SHA-256 key, ${header.kdf.iterations} iterations`);
  ok(group, Buffer.from(header.kdf.salt, "base64").length === 16 && Buffer.from(header.cipher.iv, "base64").length === 12, "random 16-byte salt and 12-byte IV in the header");
  ok(group, !enc.includes("Waiting on the client") && !enc.includes("EN-1") && !enc.includes("Ticket EN"), "no client data is readable in the encrypted file");
  const enc2 = await encryptBackupText(plain, "correct horse battery staple");
  ok(group, JSON.parse(enc2).kdf.salt !== header.kdf.salt && JSON.parse(enc2).cipher.iv !== header.cipher.iv && JSON.parse(enc2).data !== header.data, "salt and IV are fresh every time (same input → different file)");

  const dec = await decryptBackupText(enc, "correct horse battery staple");
  ok(group, dec.ok && dec.text === plain, "the right passphrase gives back the exact file");
  store.resetAll();
  const parsed = dec.ok ? parseBackup(dec.text) : { ok: false as const, error: "" };
  ok(group, parsed.ok, "…which imports like any backup");
  if (parsed.ok) {
    store.adoptImportedState(mergeImportedState(store.getSnapshot(), parsed.state, new Date().toISOString()));
    ok(group, comparable(store.getSnapshot()) === comparable(before), "Export (encrypted) → Reset → Import restores identical ticket statuses, reports, history, plan and data");
  }
  const plainParsed = parseBackup(plain);
  ok(group, plainParsed.ok && comparable(plainParsed.state) === comparable(parseStoredState(JSON.stringify(before))), "plaintext export still works exactly as before");
}

// ----- Wrong passphrase / damaged file → clear error, state untouched -----
{
  const group = "G4 Wrong passphrase";
  const plain = serializeBackup(buildBackup(parseStoredState("{}"), "2026-10-07T09:00:00.000Z"));
  const enc = await encryptBackupText(plain, "right-passphrase");
  const wrong = await decryptBackupText(enc, "wrong-passphrase");
  ok(group, !wrong.ok && wrong.error === "Wrong passphrase (or the file was altered). Nothing was imported.", "wrong passphrase → a clear message");
  const file = JSON.parse(enc);
  const tampered = JSON.stringify({ ...file, data: Buffer.from(Buffer.from(file.data, "base64").map((b, i) => (i === 5 ? b ^ 1 : b))).toString("base64") });
  ok(group, !(await decryptBackupText(tampered, "right-passphrase")).ok, "an altered file is rejected even with the right passphrase (GCM authentication)");
  ok(group, /header is damaged/.test(((await decryptBackupText(JSON.stringify({ ...file, kdf: { ...file.kdf, iterations: 1000 } }), "right-passphrase")) as { error: string }).error), "a header asking for too few iterations is refused");
  ok(group, /Enter the passphrase/.test(((await decryptBackupText(enc, "")) as { error: string }).error), "no passphrase → asks for it");
  let threw = false;
  try {
    await encryptBackupText(plain, "");
  } catch {
    threw = true;
  }
  ok(group, threw, "encrypting needs a passphrase");
  const panel = read("src/components/command-center/BackupPanel.tsx");
  ok(group, /if \(isEncryptedBackup\(text\)\) \{\s*setPassphrase\(""\);\s*setLocked\(/.test(panel) && /const r = await decryptBackupText\(locked\.raw, passphrase\);\s*if \(!r\.ok\) \{\s*setImportError\(r\.error\);\s*return;/.test(panel), "import detects an encrypted file, asks for the passphrase, and on failure shows the error and returns before anything is imported");
}

// ----- The export dialog -----
{
  const group = "G4 Export dialog";
  const html = renderToStaticMarkup(React.createElement(ExportBackupDialog, {}));
  ok(group, html.includes("client ticket data") && BACKUP_DATA_WARNING.includes("confidential"), "warns that the file contains client ticket data");
  ok(group, /aria-label="Backup passphrase \(optional\)"/.test(html) && />Download backup<\/button>/.test(html), "optional passphrase; without one it is the plain download");
  const src = read("src/components/command-center/ExportBackupDialog.tsx");
  ok(group, /disabled=\{busy \|\| \(!!pass && \(tooShort \|\| mismatch\)\)\}/.test(src) && /pass\.length < 8/.test(src), "a passphrase must be repeated and at least 8 characters");
  const reminder = read("src/components/command-center/BackupReminder.tsx");
  ok(group, /const body = passphrase \? await encryptBackupText\(plain, passphrase\) : plain;/.test(reminder) && /href="\/data-settings#backup"/.test(reminder), "the download encrypts when a passphrase is given; the weekly reminder opens the dialog instead of downloading directly");
  ok(group, /<ExportBackupDialog onDone=\{\(\) => setResetExporting\(false\)\}/.test(read("src/app/data-settings/page.tsx")), "Reset's 'Export backup first' uses the same dialog");
}
