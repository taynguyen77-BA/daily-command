"use client";

// V2.50 R1 — the Report narrative: a 3-5 sentence summary of the day / week (standup or work-log style, EN / VI) above the
// report. CALCULATED by default (always there, no AI); "Improve with AI" is optional and on demand; editing makes it USER INPUT.
// A stored AI / edited text is kept per (kind, period, style, language) and marked stale when the report's facts change.

import { useEffect, useMemo, useState } from "react";
import { getAIProvider } from "@/lib/command-center/ai";
import { improveNarrative } from "@/lib/command-center/ai/report-narrative-flow";
import type { AiFailureReason } from "@/lib/command-center/ai/outcome";
import { buildDailyReportView, type DailyReportView, type WeeklyReportView } from "@/lib/command-center/reports";
import { buildNarrativeFacts, deterministicNarrative, narrativeFactsHash, narrativeStorageKey, countSentences, type NarrativeLanguage, type NarrativeStyle } from "@/lib/command-center/report-narrative";
import { AiFailureNote } from "./AiFailureNote";
import { TrustLabel } from "./ui";
import { useAiReadiness } from "./use-ai-readiness";
import { useCommandCenter } from "./use-command-center";

export type NarrativeReport = { kind: "daily"; view: DailyReportView } | { kind: "weekly"; view: WeeklyReportView };

export function ReportNarrative({ report, compact = false, onText }: { report: NarrativeReport; compact?: boolean; onText?: (text: string | undefined) => void }) {
  const { state, store, today } = useCommandCenter();
  const readiness = useAiReadiness("reportNarrativeAi");
  const { style, language } = state.reportNarrativePrefs;
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ reason: AiFailureReason; httpStatus?: number; detail?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const periodKey = report.kind === "daily" ? report.view.date : report.view.weekStart;
  const key = narrativeStorageKey(report.kind, periodKey, style, language);
  const allowed = state.aiDataProtection.allowedProjectKeys;
  const local = useMemo(() => buildNarrativeFacts({ kind: report.kind, view: report.view, style, language, today }).facts, [report, style, language, today]);
  const ai = useMemo(() => buildNarrativeFacts({ kind: report.kind, view: report.view, style, language, today, allowedProjects: allowed }), [report, style, language, today, allowed]);
  const calculated = useMemo(() => deterministicNarrative(local), [local]);
  const hash = useMemo(() => narrativeFactsHash(local), [local]);
  const stored = state.reportNarratives[key];
  const shown = draft ?? stored?.text ?? calculated;
  const stale = !!stored && stored.factsHash !== hash;
  const trust = stored?.source === "ai" ? "ai-draft" : stored?.source === "edited" ? "user-input" : "calculated";
  const flagOn = state.features.reportNarrativeAi;
  const canAi = flagOn && readiness.state === "READY";

  // Tell the parent (exports) what is visible. Hidden reports have no narrative.
  const noData = report.kind === "daily" && report.view.noData;
  const visible = noData ? undefined : shown;
  useEffect(() => onText?.(visible), [onText, visible]);

  if (noData) return null;

  const setPrefs = (next: Partial<{ style: NarrativeStyle; language: NarrativeLanguage }>) => {
    setDraft(null);
    setFailure(null);
    store.setReportNarrativePrefs({ style, language, ...next });
  };
  const commitEdit = () => {
    if (draft === null || draft === (stored?.text ?? calculated)) return setDraft(null);
    store.saveReportNarrative({ key, text: draft, source: "edited", factsHash: hash, createdAt: new Date().toISOString() });
    setDraft(null);
  };
  const run = async () => {
    setBusy(true);
    setFailure(null);
    const r = await improveNarrative({ facts: ai.facts, customTerms: state.aiDataProtection.customTerms, provider: getAIProvider() });
    if (r.ok) store.saveReportNarrative({ key, text: r.text, source: "ai", factsHash: hash, createdAt: new Date().toISOString(), tier: "default" });
    else setFailure({ reason: r.reason, httpStatus: r.httpStatus, detail: r.violations?.[0] });
    setBusy(false);
  };
  const seg = (active: boolean) => `btn btn-sm ${active ? "btn-secondary border-accent text-text" : "btn-ghost"}`;

  return (
    <div data-report-narrative data-narrative-source={trust} className="rounded-md border border-border bg-surface2 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text3">Summary</h3>
        <TrustLabel kind={trust} />
        <span className="ml-auto flex flex-wrap items-center gap-1">
          <button className={seg(style === "standup")} onClick={() => setPrefs({ style: "standup" })}>Standup</button>
          <button className={seg(style === "worklog")} onClick={() => setPrefs({ style: "worklog" })}>Work log</button>
          <button className={seg(language === "en")} onClick={() => setPrefs({ language: "en" })}>EN</button>
          <button className={seg(language === "vi")} onClick={() => setPrefs({ language: "vi" })}>VI</button>
        </span>
      </div>
      <textarea
        aria-label="Report summary"
        value={shown}
        onChange={(e) => { setDraft(e.target.value); setCopied(false); }}
        onBlur={commitEdit}
        rows={compact ? 3 : 4}
        className="mt-2 w-full rounded border border-border bg-surface p-2 text-sm text-text"
        data-narrative-text
      />
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text3">
        <button
          className="btn btn-sm btn-secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(shown);
            setCopied(true);
          }}
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
        {(stored || draft !== null) && (
          <button className="btn btn-sm btn-ghost" onClick={() => { setDraft(null); setFailure(null); store.clearReportNarrative(key); }}>
            Reset to calculated
          </button>
        )}
        {flagOn && (
          <button className="btn btn-sm btn-ghost" disabled={busy || !canAi} title={readiness.title} onClick={() => void run()} data-narrative-ai>
            {busy ? "Improving…" : stored?.source === "ai" ? "Regenerate with AI" : "Improve with AI"}
          </button>
        )}
        <span>
          {trust === "ai-draft" ? "AI wording — ticket keys and numbers checked against the report." : trust === "user-input" ? "Edited by you." : "Calculated from the report below."}
          {countSentences(shown) < 3 || countSentences(shown) > 5 ? ` (${countSentences(shown)} sentences)` : ""}
        </span>
      </div>
      {stale && (
        <p className="mt-1 text-xs text-orange" data-narrative-stale>
          Report changed since this summary was written —{" "}
          <button className="underline" onClick={() => { store.clearReportNarrative(key); setDraft(null); }}>
            show the calculated one
          </button>
          {canAi && (
            <>
              {" or "}
              <button className="underline" onClick={() => void run()}>Regenerate</button>
            </>
          )}
          .
        </p>
      )}
      {flagOn && ai.keyOnly > 0 && <p className="mt-1 text-xs text-text3">{ai.keyOnly} ticket{ai.keyOnly === 1 ? "" : "s"} summarized by key only — project not on the AI allow-list.</p>}
      {failure && (
        <div data-narrative-failure>
          <AiFailureNote reason={failure.reason} httpStatus={failure.httpStatus} />
          {failure.detail && <p className="text-xs text-text3">{failure.detail}.</p>}
        </div>
      )}
    </div>
  );
}

/** Today's narrative for the end-of-day flow (Close My Day): the same live daily view the Reports page builds, the same component. */
export function TodayReportNarrative({ compact = true }: { compact?: boolean }) {
  const { state, store, today } = useCommandCenter();
  const identity = useMemo(() => ({ displayName: state.personalIdentity?.displayName ?? state.ownerName, accountId: state.personalIdentity?.accountId }), [state.personalIdentity, state.ownerName]);
  const view = useMemo(() => {
    const server = state.dailyReports[today]?.server;
    const snapshot = { date: today, generatedAt: new Date().toISOString(), events: state.memoryEvents.filter((e) => e.date === today), ...(server ? { server } : {}) };
    return buildDailyReportView(snapshot, today, identity, state.loaded ? store.buildLiveStandup() : undefined, state.features.blockerFollowUp ? { blockerSlaBusinessDays: state.blockerSlaBusinessDays } : {});
  }, [state, store, today, identity]);
  return <ReportNarrative report={{ kind: "daily", view }} compact={compact} />;
}
