"use client";

// F2 / F5 — the top of a Daily/Weekly Report: the overdue-blocker callout and the deterministic
// summary paragraph, with an optional "Polish with AI". A polished version is accepted only
// when it keeps every number and ticket key (checkPolishPreservesFacts); otherwise the original
// stays and the reason is shown. The polished text is used for copy/export once accepted.

import React, { useState } from "react";
import { getAIProvider } from "@/lib/command-center/ai";
import { checkPolishPreservesFacts } from "@/lib/command-center/report-summary";
import type { ReportTicket } from "@/lib/command-center/reports";

export type PolishFn = (summary: string) => Promise<string>;

export function OverdueBlockersCallout({ tickets, sla }: { tickets?: ReportTicket[]; sla?: number }) {
  if (!tickets || tickets.length === 0) return null;
  return (
    <p data-report-overdue className="rounded-md border border-red/40 bg-red/10 px-3 py-2 text-sm text-text">
      <span className="font-semibold text-red">⚠ {tickets.length} blocker{tickets.length === 1 ? "" : "s"} over the {sla}-business-day SLA:</span>{" "}
      {tickets.map((t) => `${t.key ?? t.title ?? "?"} (${t.ageBusinessDays}d)`).join(", ")}
    </p>
  );
}

export function ReportSummaryParagraph({
  summary,
  polished,
  onPolished,
  polish = (s) => getAIProvider().polishReportSummary(s),
}: {
  summary?: string;
  polished?: string;
  onPolished: (text: string | undefined) => void;
  polish?: PolishFn;
}) {
  const [status, setStatus] = useState<string | null>(null);
  if (!summary) return null;
  return (
    <div data-report-summary className="rounded-md border border-border bg-surface2 px-3 py-2">
      <p className="text-sm text-text">{polished ?? summary}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text3">
        <span>{polished ? "Polished with AI — same numbers and ticket keys." : "Calculated from the report below."}</span>
        {polished ? (
          <button className="btn btn-sm btn-ghost" onClick={() => onPolished(undefined)}>
            Show original
          </button>
        ) : (
          <button
            className="btn btn-sm btn-ghost"
            onClick={async () => {
              setStatus("Polishing…");
              try {
                const text = (await polish(summary)).trim();
                const refused = text === summary ? "The AI kept the summary as it is (Mock AI never rewrites)." : checkPolishPreservesFacts(summary, text);
                if (refused) setStatus(refused);
                else {
                  onPolished(text);
                  setStatus(null);
                }
              } catch {
                setStatus("AI unavailable — keeping the original summary.");
              }
            }}
          >
            Polish with AI
          </button>
        )}
        {status && <span>{status}</span>}
      </div>
    </div>
  );
}
