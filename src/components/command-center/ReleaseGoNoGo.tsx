"use client";

// V2.38 J3 — Release Go/No-Go brief on a Release Health card. The readiness rules decide which
// recommendations are allowed (release-brief.ts); the AI picks within them, numbers locked.
// A rule-breaking answer falls back to the deterministic brief with a notice. Display + copy only.

import { useState, useSyncExternalStore } from "react";
import { commandCenterStore, previousSnapshotOf } from "@/lib/command-center/store";
import { getAIProvider } from "@/lib/command-center/ai";
import { buildReleaseBriefInput, runReleaseBrief } from "@/lib/command-center/ai/release-brief";
import { computeReleaseDrift } from "@/lib/command-center/release-drift";
import type { ReleaseBriefResponse } from "@/lib/command-center/ai/schemas";
import type { CommandCenterData, ReleaseHealth } from "@/lib/command-center/types";
import { todayLocalIso } from "@/lib/command-center/date-utils";
import { TrustLabel } from "./ui";

const TONE: Record<ReleaseBriefResponse["recommendation"], string> = { Go: "text-green", "Go with conditions": "text-orange", "No-Go": "text-red" };

export function ReleaseGoNoGo({ release, data }: { release: ReleaseHealth; data: CommandCenterData }) {
  const state = useSyncExternalStore(commandCenterStore.subscribe, commandCenterStore.getSnapshot, commandCenterStore.getServerSnapshot);
  const [result, setResult] = useState<{ brief: ReleaseBriefResponse; usedAi: boolean; notice?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!state.features.releaseGoNoGo) return null;

  const run = async () => {
    setBusy(true);
    const s = commandCenterStore.getSnapshot();
    const drift = computeReleaseDrift([release], previousSnapshotOf(s), todayLocalIso(), undefined, data.workItems)[0];
    const { input, session } = buildReleaseBriefInput(release, data, drift, s.aiDataProtection.customTerms);
    setResult(await runReleaseBrief(input, session, getAIProvider()));
    setBusy(false);
  };

  return (
    <div data-release-go-no-go={release.fixVersion} className="mt-3 rounded-md border border-border bg-surface2 p-2 text-xs text-text2">
      <div className="flex flex-wrap items-center gap-2">
        <TrustLabel kind="ai-assessment" />
        <button onClick={() => void run()} disabled={busy} className="btn btn-sm btn-secondary">
          {busy ? "Preparing…" : result ? "Refresh Go/No-Go" : "Go/No-Go brief"}
        </button>
      </div>
      {result && (
        <div className="mt-2 space-y-1">
          {result.notice && <p className="text-orange">{result.notice}</p>}
          <p className={`text-sm font-semibold ${TONE[result.brief.recommendation]}`} data-release-recommendation={result.brief.recommendation}>
            {result.brief.recommendation}
          </p>
          {result.brief.conditions.length > 0 && (
            <div>
              <p className="font-semibold text-text3">Conditions</p>
              <ul className="list-disc pl-4">{result.brief.conditions.map((c, i) => <li key={i}>{c}</li>)}</ul>
            </div>
          )}
          {result.brief.evidence.length > 0 && <p><span className="font-semibold text-text3">Evidence:</span> {result.brief.evidence.join(", ")}</p>}
          {result.brief.risks.length > 0 && (
            <div>
              <p className="font-semibold text-text3">Risks</p>
              <ul className="list-disc pl-4">{result.brief.risks.map((c, i) => <li key={i}>{c}</li>)}</ul>
            </div>
          )}
          <p className="font-semibold text-text3">Communication draft</p>
          <p className="whitespace-pre-wrap">{result.brief.communicationDraft}</p>
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(`${release.fixVersion}: ${result.brief.recommendation}\n\n${result.brief.communicationDraft}`);
              setCopied(true);
            }}
            className="btn btn-sm btn-ghost"
          >
            {copied ? "Copied ✓" : "Copy draft"}
          </button>
        </div>
      )}
    </div>
  );
}
