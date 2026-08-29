"use client";

// V2.1 §10 — "Before You Trust This Data": shown before Personal Focus / Control Tower so
// data quality is visible before strong personal recommendations. Purely derived from
// dataHealth's already-computed coverage percentages (buildBeforeYouTrustSummary in
// trust-diagnostic.ts) — no new scoring, no blended score, no new panel logic.

import Link from "next/link";
import type { TrustSummary } from "@/lib/command-center/trust-diagnostic";
import { Panel, TrustLabel } from "./ui";

const STATUS_STYLES: Record<TrustSummary["rows"][number]["status"], string> = {
  GOOD: "text-green",
  REVIEW: "text-yellow",
  LIMITED: "text-red",
};

export function BeforeYouTrustThisData({ summary }: { summary: TrustSummary }) {
  if (!summary.hasData) return null;

  return (
    <Panel className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <TrustLabel kind="calculated" />
        <span className="text-xs uppercase tracking-wide text-text3">Before You Trust This Data</span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        {summary.rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-2 rounded border border-border bg-surface2 px-2 py-1">
            <span className="text-text3">{r.label}</span>
            <span className="flex items-baseline gap-1.5">
              <span className="font-mono text-text">{r.value}</span>
              <span className={`text-[10px] font-semibold uppercase tracking-wide ${STATUS_STYLES[r.status]}`}>{r.status}</span>
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-text2">
        <span className="font-medium text-text3">Impact: </span>
        {summary.impact}
      </p>
      <p className="mt-1 text-xs">
        <span className="font-medium text-text3">Recommended: </span>
        {summary.recommended !== "None — no action needed." ? (
          <Link href="/data-settings" className="text-accent2 hover:underline">
            {summary.recommended}
          </Link>
        ) : (
          <span className="text-text2">{summary.recommended}</span>
        )}
      </p>
    </Panel>
  );
}
