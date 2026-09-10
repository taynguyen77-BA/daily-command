"use client";

// V2.8 §4-9 — Execution Path Trace. A reusable, deterministic drawer answering "what
// happened to this Jira work after Daily Command determined it was relevant?" for one
// item. An OBSERVABILITY view, not a decision surface (§29) — it never recommends what to
// do next; Action Plan/Personal Focus/Command Bar already own that. Every line is read
// from execution-path.ts, which itself only reads existing engines — nothing here
// classifies, scores, or mutates state.

import { useState } from "react";
import { computeExecutionPathTrace, explainExecutionSurface, type ExecutionSurface } from "@/lib/command-center/execution-path";
import type { WorkRelevanceIndex } from "@/lib/command-center/jira/work-relevance";
import type { CommandCenterData, WorkItem } from "@/lib/command-center/types";
import type { ProactiveIntelligence } from "@/lib/command-center/proactive";
import type { PersonalFocusResult } from "@/lib/command-center/types";
import { TrustLabel } from "./ui";

function StepIcon({ state }: { state: "yes" | "no" | "na" }) {
  const style = state === "yes" ? "text-green" : state === "no" ? "text-text3" : "text-text3";
  return (
    <span className={`inline-block w-4 text-center font-mono ${style}`} aria-hidden="true">
      {state === "yes" ? "✓" : state === "no" ? "○" : "—"}
    </span>
  );
}

function TraceRow({
  state,
  label,
  detail,
  why,
}: {
  state: "yes" | "no" | "na";
  label: string;
  detail: string;
  why?: { onToggle: () => void; open: boolean; explanation?: string };
}) {
  return (
    <div className="py-1">
      <div className="flex items-start gap-2">
        <StepIcon state={state} />
        <div className="flex-1">
          <span className="text-text2">
            {label}: <span className="text-text">{detail}</span>
          </span>
          {why && (
            <button onClick={why.onToggle} aria-expanded={why.open} className="ml-2 text-[11px] font-medium text-accent2 hover:underline">
              {why.open ? "Hide why" : "Why?"}
            </button>
          )}
        </div>
      </div>
      {why?.open && why.explanation && <p className="ml-6 mt-1 rounded border border-border bg-surface p-2 text-text3">{why.explanation}</p>}
    </div>
  );
}

export function ExecutionPathTrace({
  item,
  data,
  today,
  workRelevanceIndex,
  proactive,
  personalFocus,
  dailyCommandCompletedWorkItemIds,
}: {
  item: WorkItem;
  data: CommandCenterData;
  today: string;
  workRelevanceIndex: WorkRelevanceIndex;
  proactive: ProactiveIntelligence | null;
  personalFocus: PersonalFocusResult | null;
  // V2.21 §3 — optional/additive: folds Daily Command Completion into the trace so it agrees
  // with Action Plan/Personal Focus about a completed item.
  dailyCommandCompletedWorkItemIds?: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  const [openWhy, setOpenWhy] = useState<ExecutionSurface | null>(null);

  // §6 — this trace only makes sense for a Jira-sourced item; a demo/local-import item has
  // no Jira status identity for Work Relevance to classify (matches WhyNotATaskDrawer's
  // own gate).
  if (item.sourceType !== "jira") return null;

  const trace = computeExecutionPathTrace(item, data, today, workRelevanceIndex, proactive, personalFocus, dailyCommandCompletedWorkItemIds);

  function toggleWhy(surface: ExecutionSurface) {
    setOpenWhy((cur) => (cur === surface ? null : surface));
  }

  const actionPlanWhy = openWhy === "ACTION_PLAN" ? explainExecutionSurface(item, trace, "ACTION_PLAN", workRelevanceIndex) : undefined;
  const personalFocusWhy = openWhy === "PERSONAL_FOCUS" ? explainExecutionSurface(item, trace, "PERSONAL_FOCUS", workRelevanceIndex) : undefined;
  const explicitActionWhy = openWhy === "EXPLICIT_ACTION" ? explainExecutionSurface(item, trace, "EXPLICIT_ACTION", workRelevanceIndex) : undefined;

  const summaryParts = [
    trace.relevance === "NOT_APPLICABLE" ? "N/A" : trace.relevance,
    `Candidate: ${trace.candidateEvaluation === "ELIGIBLE" ? "Eligible" : trace.candidateEvaluation === "NOT_ELIGIBLE" ? "Not eligible" : "N/A"}`,
    `Action: ${trace.actions.state === "EXISTS" ? `${trace.actions.actions.length}` : "0"}`,
    `Focus: ${trace.attention.presentInPersonalFocus ? "Present" : "Not present"}`,
    `Outcome: ${trace.outcome.recorded ? trace.outcome.count : "None"}`,
  ];

  return (
    <div className="mt-2">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-xs font-medium text-accent2 hover:underline">
        {open ? "Hide execution path" : `Execution path · ${summaryParts.join(" · ")}`}
      </button>
      {open && (
        <div className="mt-2 space-y-1 rounded-md border border-border bg-surface2 p-3 text-xs">
          <p className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide text-text3">
            <TrustLabel kind="calculated" /> Execution path
          </p>

          <TraceRow state="yes" label="Jira" detail={`synced (${item.jiraStatusName ?? item.status})`} />

          <TraceRow state={trace.relevance === "UNKNOWN" ? "no" : "yes"} label="Work relevance" detail={trace.relevance === "NOT_APPLICABLE" ? "N/A" : trace.relevance} />

          <TraceRow
            state={trace.candidateEvaluation === "ELIGIBLE" ? "yes" : trace.candidateEvaluation === "NOT_ELIGIBLE" ? "no" : "na"}
            label="Candidate evaluation"
            detail={trace.candidateEvaluation === "ELIGIBLE" ? "entered candidate pool" : trace.candidateEvaluation === "NOT_ELIGIBLE" ? "did not enter candidate pool" : "not applicable"}
          />

          <TraceRow
            state={trace.actionPlan === "SELECTED" ? "yes" : trace.actionPlan === "NOT_SELECTED" ? "no" : "na"}
            label="Action Plan"
            detail={trace.actionPlan === "SELECTED" ? "selected" : trace.actionPlan === "NOT_SELECTED" ? "not selected" : "not applicable"}
            why={{ onToggle: () => toggleWhy("ACTION_PLAN"), open: openWhy === "ACTION_PLAN", explanation: actionPlanWhy?.explanation }}
          />

          <TraceRow
            state={trace.actions.state === "EXISTS" ? "yes" : "no"}
            label="Explicit Action"
            detail={trace.actions.state === "EXISTS" ? `${trace.actions.actions.length} (${trace.actions.activeCount} active, ${trace.actions.completedCount} completed)` : "not created"}
            why={{ onToggle: () => toggleWhy("EXPLICIT_ACTION"), open: openWhy === "EXPLICIT_ACTION", explanation: explicitActionWhy?.explanation }}
          />

          <TraceRow
            state={trace.attention.presentInPersonalFocus ? "yes" : "no"}
            label="Personal Focus"
            detail={trace.attention.presentInPersonalFocus ? "present" : trace.attention.evidenceAvailable ? "not currently present" : "not enough evidence"}
            why={{ onToggle: () => toggleWhy("PERSONAL_FOCUS"), open: openWhy === "PERSONAL_FOCUS", explanation: personalFocusWhy?.explanation }}
          />

          <TraceRow state={trace.outcome.recorded ? "yes" : "no"} label="Outcome" detail={trace.outcome.recorded ? `recorded (${trace.outcome.count})` : "not recorded"} />
        </div>
      )}
    </div>
  );
}
