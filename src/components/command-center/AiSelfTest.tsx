"use client";

// D3 — "Run AI self-test": runs the synthetic fixtures against the real model for this installation, shows one row per feature with a
// plain verdict and the first failing rubric item, and can copy the report. Needs an explicit confirm (it spends tokens).

import { useState } from "react";
import { pairedAuthHeader } from "@/lib/command-center/device-pairing";
import { estimateSelfTestTokens, formatSelfTestTable, type SelfTestReport, type SelfTestRow } from "@/lib/command-center/ai/selftest-shared";

const VERDICT: Record<SelfTestRow["outcome"], string> = { PASS: "text-green", WARN: "text-yellow", FAIL: "text-red", SKIPPED: "text-text3" };

/** Where to go when a row fails. */
function fixFor(r: SelfTestRow): string | null {
  switch (r.errorKind) {
    case "invalid-key": return "Replace the API key above (it was rejected).";
    case "permission": return "The key lacks permission — check the key's workspace in the Anthropic console.";
    case "model-not-found": return "Pick a valid model id above and Save & test.";
    case "rate-limited": case "budget-exhausted": return "Budget or rate limit reached — raise the daily budget or wait.";
    case "grounding-rejected": return "The fact check rejected the answer (invented date / number / name) — see AI health below for the reason.";
    case "invalid-output": return "The model's JSON did not match the schema even after one repair.";
    default: return r.outcome === "FAIL" ? "See AI health below and the recent failures above." : null;
  }
}

export function AiSelfTest({ configured, onDone }: { configured: boolean; onDone: () => void }) {
  const [mode, setMode] = useState<"quick" | "full">("quick");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<SelfTestReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const estimate = estimateSelfTestTokens(mode);

  const run = async () => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/command-center/ai/selftest", { method: "POST", headers: { "Content-Type": "application/json", ...pairedAuthHeader() }, body: JSON.stringify({ mode }) });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; report?: SelfTestReport; error?: string };
      if (res.status === 200 && json.report) setReport(json.report);
      else setError(json.error ?? `The self-test could not run (HTTP ${res.status}).`);
    } catch {
      setError("Could not reach the server.");
    }
    setBusy(false);
    onDone();
  };

  return (
    <div data-ai-selftest className="border-t border-border pt-3">
      <p className="text-text">AI self-test</p>
      <p className="text-xs text-text3">Runs synthetic examples (no client data) through every AI feature against the real model and checks language, placeholders, length and the fact check.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select value={mode} onChange={(e) => setMode(e.target.value === "full" ? "full" : "quick")} className="rounded border border-border bg-surface2 px-2 py-1 text-sm" aria-label="Self-test mode">
          <option value="quick">Quick — 5 core features (~{Math.round(estimateSelfTestTokens("quick") / 1000)}k tokens)</option>
          <option value="full">Full — every feature (~{Math.round(estimateSelfTestTokens("full") / 1000)}k tokens)</option>
        </select>
        {!confirming ? (
          <button type="button" disabled={!configured || busy} onClick={() => setConfirming(true)} className="rounded border border-border px-3 py-1 text-sm disabled:opacity-50">{busy ? "Running…" : "Run AI self-test"}</button>
        ) : (
          <>
            <span className="text-xs text-text2">This will use about {estimate.toLocaleString("en-US")} tokens.</span>
            <button type="button" onClick={() => void run()} className="rounded bg-accent px-3 py-1 text-sm font-semibold text-white">Confirm and run</button>
            <button type="button" onClick={() => setConfirming(false)} className="rounded border border-border px-3 py-1 text-sm">Cancel</button>
          </>
        )}
      </div>
      {!configured && <p className="mt-1 text-xs text-text3">Configure a key first.</p>}
      {error && <p className="mt-2 text-sm text-red" role="alert">{error}</p>}
      {report && (
        <div className="mt-2">
          <table className="w-full text-left text-xs" data-selftest-table>
            <thead className="text-text3"><tr><th>Feature</th><th>Verdict</th><th>Model</th><th>ms</th><th>Tokens</th><th>Detail</th></tr></thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="pr-2 text-text2">{r.label}</td>
                  <td className={`pr-2 font-semibold ${VERDICT[r.outcome]}`}>{r.outcome}</td>
                  <td className="pr-2 font-mono">{r.model}</td>
                  <td className="pr-2">{r.ms}</td>
                  <td className="pr-2">{r.inputTokens + r.outputTokens}</td>
                  <td className="text-text3">{r.note ?? ""}{fixFor(r) ? ` → ${fixFor(r)}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-text3">{report.totalTokens.toLocaleString("en-US")} tokens · est. ${report.estCostUsd.toFixed(4)} (estimate; prices verified {report.priceVerifiedOn}){report.ceilingReached ? " · token ceiling reached, remaining rows skipped" : ""}</p>
          <button type="button" className="mt-1 rounded border border-border px-2 py-0.5 text-xs" onClick={() => { void navigator.clipboard?.writeText(formatSelfTestTable(report)).then(() => setCopied(true)); }}>{copied ? "Copied" : "Copy report"}</button>
        </div>
      )}
    </div>
  );
}
