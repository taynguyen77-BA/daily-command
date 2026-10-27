"use client";

// P3.3 — Data & Settings: the personal learning loop. Mode (off / shadow / on), the current adjustments
// with their evidence and sample size, "Reset learning" and a JSON export. LEARNED: derived from your own
// history; nothing here calls AI or the network.

import { useState } from "react";
import { learnedAdjustmentsFor } from "@/lib/command-center/scoring-context";
import { asLearnedMode, LEARN_MAX_DELTA, LEARN_MIN_SAMPLES, LEARN_WINDOW_DAYS } from "@/lib/command-center/learned-adjustments";
import { todayLocalIso } from "@/lib/command-center/date-utils";
import { Panel, SectionHeading, TrustLabel } from "./ui";
import { useCommandCenter } from "./use-command-center";

export function LearningPanel() {
  const { state, store } = useCommandCenter();
  const [confirmReset, setConfirmReset] = useState(false);
  const today = todayLocalIso();
  const mode = asLearnedMode(state.learnedPriority);
  const adjustments = learnedAdjustmentsFor(state, today);
  const v1 = (state.scoringModel ?? "v2") === "v1";

  function exportJson() {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), mode, windowDays: LEARN_WINDOW_DAYS, minSamples: LEARN_MIN_SAMPLES, resetAt: state.learningResetAt ?? null, adjustments }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `learned-priority-${today}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Panel className="p-5" data-learning-panel>
      <SectionHeading title="Personal learning" subtitle={`Adapts the Priority Score v2 ranking to how you actually work — from your own last ${LEARN_WINDOW_DAYS} days, at most ±${LEARN_MAX_DELTA} points, never with AI.`} action={<TrustLabel kind="learned" />} />
      <label className="mt-3 flex flex-wrap items-center gap-2 text-sm text-text2">
        <span className="text-text">Mode</span>
        <select value={mode} onChange={(e) => store.setLearnedPriority(asLearnedMode(e.target.value))} className="rounded border border-border bg-surface2 px-2 py-1 text-sm" aria-label="Learning mode">
          <option value="shadow">Shadow — compute and show, change nothing (default)</option>
          <option value="on">On — apply the adjustments to scores</option>
          <option value="off">Off</option>
        </select>
      </label>
      {v1 && <p className="mt-2 text-xs text-yellow">Learning only works with scoring model v2 (Features above); it has no effect while v1 is selected.</p>}
      {mode === "off" ? (
        <p className="mt-3 text-sm text-text3">Learning is off: no adjustments are computed or shown.</p>
      ) : adjustments.length === 0 ? (
        <p className="mt-3 text-sm text-text3">Not enough history yet — a group needs at least {LEARN_MIN_SAMPLES} decided appearances in Today before it can move a score. Nothing is guessed.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs text-text2">
            <thead>
              <tr className="text-text3">
                <th className="py-1 pr-3 font-medium">Group</th>
                <th className="py-1 pr-3 font-medium">Adjustment</th>
                <th className="py-1 pr-3 font-medium">n</th>
                <th className="py-1 font-medium">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {adjustments.map((a) => (
                <tr key={a.groupKey} className="border-t border-border align-top" data-learning-row={a.groupKey}>
                  <td className="py-1.5 pr-3">{a.projectLabel} · {a.issueType} · {a.priority} · {a.kind === "MENTION" ? "mentions" : "other"}</td>
                  <td className="py-1.5 pr-3 tabular text-text">{a.delta > 0 ? `+${a.delta}` : a.delta}{a.decayed ? " (decayed)" : ""}</td>
                  <td className="py-1.5 pr-3 tabular">{a.n}</td>
                  <td className="py-1.5">{a.evidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={exportJson} className="btn btn-sm btn-secondary">Export JSON</button>
        {confirmReset ? (
          <>
            <button onClick={() => { store.resetLearning(); setConfirmReset(false); }} className="btn btn-sm btn-secondary" data-learning-reset-confirm>Yes, reset learning</button>
            <button onClick={() => setConfirmReset(false)} className="btn btn-sm btn-secondary">Cancel</button>
          </>
        ) : (
          <button onClick={() => setConfirmReset(true)} className="btn btn-sm btn-secondary">Reset learning</button>
        )}
      </div>
      <p className="mt-2 text-xs text-text3">Resetting clears what was learned (scores return to their un-learned values) and records a memory event; your plans and ticket history are untouched.{state.learningResetAt ? ` Last reset: ${state.learningResetAt}.` : ""}</p>
    </Panel>
  );
}
