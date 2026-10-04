"use client";

// V2.37 I4 — "Rewrite for…" on a report. The deterministic report is the input; the AI may only
// rephrase and summarize. If the answer has a ticket key or number that isn't in the report
// (checked here and on the server), or AI is unavailable, the deterministic report is shown
// with a notice. Client update starts from a client-safe copy (report-rewrite.ts).

import { useState } from "react";
import { getAIProvider } from "@/lib/command-center/ai";
import { commandCenterStore } from "@/lib/command-center/store";
import { REPORT_AUDIENCES, rewriteReportFlow, rewriteSource, type ReportAudience, type RewriteResult } from "@/lib/command-center/ai/report-rewrite";
import type { DailyReportView, WeeklyReportView } from "@/lib/command-center/reports";
import { TrustLabel } from "./ui";

export function ReportRewrite({ report, includeTeam }: { report: { kind: "daily"; view: DailyReportView } | { kind: "weekly"; view: WeeklyReportView }; includeTeam: boolean }) {
  const [audience, setAudience] = useState<ReportAudience | null>(null);
  const [result, setResult] = useState<RewriteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const run = async (a: ReportAudience) => {
    setAudience(a);
    setBusy(true);
    setCopied(false);
    const source = rewriteSource(report, a, includeTeam);
    setResult(await rewriteReportFlow({ source, audience: a, customTerms: commandCenterStore.getSnapshot().aiDataProtection.customTerms, provider: getAIProvider() }));
    setBusy(false);
  };

  return (
    <div data-report-rewrite className="rounded-md border border-border bg-surface2 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <TrustLabel kind="ai-draft" />
        <span className="text-xs text-text3">Rewrite for…</span>
        {REPORT_AUDIENCES.map((a) => (
          <button key={a.id} onClick={() => void run(a.id)} disabled={busy} className={`btn btn-sm btn-secondary ${audience === a.id ? "border-accent text-text" : ""}`}>
            {a.label}
          </button>
        ))}
      </div>
      {audience === "client" && <p className="mt-1 text-xs text-text3">Client update leaves out team work, skipped items, mentions, names and any note starting with [internal] / internal:.</p>}
      {busy && <p className="mt-2 text-xs">Rewriting…</p>}
      {result && !busy && (
        <div className="mt-2">
          {result.notice && (
            <p role="status" data-rewrite-notice className="mb-1 text-xs text-orange">
              {result.notice}
            </p>
          )}
          <pre data-rewrite-text className="max-h-96 overflow-auto whitespace-pre-wrap rounded border border-border bg-surface p-2 text-xs text-text">
            {result.text}
          </pre>
          <div className="mt-1 flex items-center gap-2">
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(result.text);
                setCopied(true);
              }}
              className="btn btn-sm btn-secondary"
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
            <span className="text-xs text-text3">{result.usedAi ? "AI rewrite — ticket keys and numbers checked against the report." : "Deterministic report."}</span>
          </div>
        </div>
      )}
    </div>
  );
}
