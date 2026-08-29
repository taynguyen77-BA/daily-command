"use client";

import { useState } from "react";
import { importFromCsv, importFromJson, importFromText, type ImportResult } from "@/lib/command-center/import";
import { getTodayIso } from "@/lib/command-center/store";
import { useCommandCenter } from "./use-command-center";
import { Panel, SectionHeading } from "./ui";

type Mode = "json" | "csv" | "text";

const PLACEHOLDERS: Record<Mode, string> = {
  json: `{\n  "workItems": [\n    { "key": "ACME-1", "title": "Confirm scope with client", "status": "Not Started", "priority": "P2", "businessImpact": 3 }\n  ]\n}`,
  csv: `key,title,status,priority,owner,dueDate,businessImpact\nACME-1,Confirm scope with client,Not Started,P2,,2026-09-01,3`,
  text: `- Confirm scope with client\n- [ ] Chase UAT sign-off from QA`,
};

export function DataImportPanel() {
  const { store } = useCommandCenter();
  const [mode, setMode] = useState<Mode>("json");
  const [text, setText] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);

  function runImport() {
    const today = getTodayIso();
    const parsed =
      mode === "json" ? importFromJson(text, today) : mode === "csv" ? importFromCsv(text, today) : importFromText(text, today);
    setResult(parsed);
    if (parsed.ok) store.importData(parsed);
  }

  return (
    <Panel className="p-5">
      <SectionHeading title="Import data" subtitle="JSON, CSV, or pasted text/Markdown. Nothing is sent anywhere — it stays in this browser." />

      <div className="mb-3 flex gap-1">
        {(["json", "csv", "text"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              setResult(null);
            }}
            aria-pressed={mode === m}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${mode === m ? "bg-surface2 text-text" : "text-text3 hover:text-text2"}`}
          >
            {m.toUpperCase()}
          </button>
        ))}
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={PLACEHOLDERS[mode]}
        className="h-40 w-full resize-y rounded-md border border-border bg-surface2 p-3 font-mono text-xs text-text2 placeholder:text-text3"
      />

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={runImport}
          disabled={!text.trim()}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent2 disabled:opacity-50"
        >
          Import
        </button>
        {result?.ok && (
          <span className="text-sm text-green">
            Imported {Object.values(result.addedCounts).reduce((a, b) => a + b, 0)} record(s).
          </span>
        )}
      </div>

      {result && !result.ok && (
        <div className="mt-3 rounded-md border border-red/30 bg-red/10 p-3 text-xs text-red">
          <p className="mb-1 font-semibold">Import failed — nothing was changed:</p>
          <ul className="space-y-0.5">
            {result.errors.map((e, i) => (
              <li key={i}>- {e}</li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
