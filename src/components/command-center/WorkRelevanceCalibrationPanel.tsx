"use client";

// V2.7 — Work Relevance Operational Calibration. Lives inside Data & Settings, right below
// the V2.5/V2.6 Jira Work Relevance Policy panel (§18 "do not create a new policy
// management page"). Every number here is deterministic arithmetic over the existing
// policy map, action-plan.ts candidate pool, and Action model — never AI, never a score,
// never an automatic policy change (§21-23, §34).

import { useMemo } from "react";
import Link from "next/link";
import {
  computeActionableCalibration,
  computeObserveCalibration,
  computePolicyReviewSignals,
  computeUnknownVisibility,
  computeWorkRelevanceDistribution,
  type PolicyReviewSignal,
} from "@/lib/command-center/jira/work-relevance-calibration";
import { computeCandidateGapSignals, computeExecutionPathStatusTable } from "@/lib/command-center/execution-path";
import type { WorkRelevanceIndex } from "@/lib/command-center/jira/work-relevance";
import { WORK_RELEVANCE_VALUES, type CommandCenterData, type JiraProjectScope } from "@/lib/command-center/types";
import { Panel, SectionHeading, TrustLabel } from "./ui";

const SIGNAL_STYLE: Record<PolicyReviewSignal["signalType"], string> = {
  REVIEW: "text-yellow",
  NONE: "text-text3",
  INSUFFICIENT_EVIDENCE: "text-text3",
};

export function WorkRelevanceCalibrationPanel({
  data,
  isDemo,
  dataSourceIsJira,
  jiraConfigured,
  jiraProjectScope,
  workRelevanceIndex,
  today,
}: {
  data: CommandCenterData;
  isDemo: boolean;
  dataSourceIsJira: boolean;
  jiraConfigured: boolean | undefined;
  jiraProjectScope: JiraProjectScope;
  workRelevanceIndex: WorkRelevanceIndex;
  today: string;
}) {
  const projectKeys = jiraProjectScope.mode === "FOCUSED" ? jiraProjectScope.projectKeys : undefined;

  // §16 — real Jira + real user Action data only; synthetic (demo/import) data must never
  // be presented as if it reflects real operating behavior.
  const isSyntheticData = isDemo || !dataSourceIsJira;

  const distribution = useMemo(() => (isSyntheticData ? [] : computeWorkRelevanceDistribution(data, workRelevanceIndex, projectKeys)), [isSyntheticData, data, workRelevanceIndex, projectKeys]);
  const actionable = useMemo(() => (isSyntheticData ? null : computeActionableCalibration(data, workRelevanceIndex, today, projectKeys)), [isSyntheticData, data, workRelevanceIndex, today, projectKeys]);
  const observe = useMemo(() => (isSyntheticData ? null : computeObserveCalibration(data, workRelevanceIndex, today, projectKeys)), [isSyntheticData, data, workRelevanceIndex, today, projectKeys]);
  const unknown = useMemo(() => (isSyntheticData ? null : computeUnknownVisibility(data, workRelevanceIndex, projectKeys)), [isSyntheticData, data, workRelevanceIndex, projectKeys]);
  const signals = useMemo(() => (isSyntheticData ? [] : computePolicyReviewSignals(data, workRelevanceIndex, projectKeys)), [isSyntheticData, data, workRelevanceIndex, projectKeys]);
  const reviewSignals = signals.filter((s) => s.signalType === "REVIEW");
  // V2.8 §10 — extends the SAME status table with Candidates/Outcomes columns rather than
  // a parallel table; keyed the same way (project::status) so it merges cleanly below.
  const executionPathRows = useMemo(
    () => (isSyntheticData ? [] : computeExecutionPathStatusTable(data, workRelevanceIndex, today, projectKeys)),
    [isSyntheticData, data, workRelevanceIndex, today, projectKeys]
  );
  const executionPathByKey = useMemo(() => new Map(executionPathRows.map((r) => [`${r.projectKey}::${r.statusName}`, r])), [executionPathRows]);
  // V2.8 §11 Signal C — a distinct pipeline stage (candidate evaluation) from V2.7's Policy
  // Review Signals (action evidence); shown separately so the two never blur together.
  const candidateGapSignals = useMemo(
    () => (isSyntheticData ? [] : computeCandidateGapSignals(data, workRelevanceIndex, today, projectKeys)),
    [isSyntheticData, data, workRelevanceIndex, today, projectKeys]
  );

  if (!jiraConfigured) {
    return (
      <Panel className="p-5" id="work-relevance-calibration-panel">
        <SectionHeading title="Work Relevance Calibration" subtitle="Is your Work Relevance Policy matching how you actually work? Deterministic evidence, never a score." />
        <p className="text-sm text-text3">Calibration is available for Jira data. Configure Jira above to enable it.</p>
      </Panel>
    );
  }

  return (
    <Panel className="p-5" id="work-relevance-calibration-panel">
      <SectionHeading title="Work Relevance Calibration" subtitle="Is your Work Relevance Policy matching how you actually work? Deterministic evidence, never a score." />

      {isSyntheticData ? (
        <p className="rounded-md border border-yellow/30 bg-yellow/5 p-2.5 text-sm text-text2">
          Calibration unavailable for synthetic data. This requires a real Jira sync plus real Action history — demo or local-import data cannot represent real operating behavior.
        </p>
      ) : distribution.length === 0 ? (
        <p className="text-sm text-text3">No Jira-sourced work items observed yet in the current scope — sync Jira first.</p>
      ) : (
        <div className="space-y-4 text-sm">
          {/* §4 — Policy Effectiveness Snapshot */}
          <div>
            <p className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-text3">
              <TrustLabel kind="calculated" /> Distribution by project
            </p>
            <div className="space-y-2">
              {distribution.map((row) => (
                <div key={row.projectKey} className="rounded-md border border-border bg-surface2 p-2.5 text-xs">
                  <p className="mb-1 font-mono text-text">
                    {row.projectKey} <span className="text-text3">({row.totalItems} item{row.totalItems === 1 ? "" : "s"})</span>
                  </p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-text2">
                    {WORK_RELEVANCE_VALUES.map((v) => (
                      <span key={v}>
                        {v} <span className="font-display text-text">{row.counts[v]}</span>
                        {row.totalItems > 0 && <span className="text-text3"> ({Math.round((row.counts[v] / row.totalItems) * 100)}%)</span>}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* §5 — Actionable Work Calibration */}
          {actionable && (
            <div className="rounded-md border border-border bg-surface2 p-2.5 text-xs">
              <p className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide text-text3">
                <TrustLabel kind="calculated" /> Actionable calibration
              </p>
              <p className="text-text2">
                {actionable.actionableItemCount} Jira item(s) classified ACTIONABLE → {actionable.candidatePoolCount} entered the candidate pool → {actionable.actedOnCount} were explicitly acted on
                → {actionable.completedCount} completed.
              </p>
              <p className="mt-1 text-text3">
                These items were classified ACTIONABLE; the counts above are direct evidence of what became explicit personal work, not a claim about why.
              </p>
            </div>
          )}

          {/* §6 — Observe Calibration */}
          {observe && (
            <div className="rounded-md border border-border bg-surface2 p-2.5 text-xs">
              <p className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide text-text3">
                <TrustLabel kind="calculated" /> Observe calibration
              </p>
              <p className="text-text2">
                {observe.observeItemCount} Jira item(s) classified OBSERVE — {observe.outsidePersonalWorkCount} remained outside inferred personal work, {observe.policyViolationCount} policy violation(s)
                detected.
              </p>
              <p className="mt-1 text-text3">OBSERVE items remain visible in Priorities, delivery context, and risk/decision/dependency intelligence — this is about automatic personal-work inference only.</p>
            </div>
          )}

          {/* §7 — Unknown Visibility */}
          {unknown && (
            <div className="rounded-md border border-border bg-surface2 p-2.5 text-xs">
              <p className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide text-text3">
                <TrustLabel kind="calculated" /> Unknown
              </p>
              <p className="text-text2">
                {unknown.statusCount} observed Jira status(es), {unknown.affectedItemCount} affected item(s).
              </p>
              <p className="mt-1 text-text3">These statuses have not been classified. For safety they are not treated as actionable work.</p>
            </div>
          )}

          {/* §10 — Status-level calibration table */}
          <div>
            <p className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-text3">
              <TrustLabel kind="calculated" /> Status-level calibration
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-xs">
                <caption className="sr-only">Per-status calibration: policy, observed item count, candidate pool entries, linked personal Actions, completions, outcomes, and any review signal.</caption>
                <thead>
                  <tr className="border-b border-border text-left text-text3">
                    <th scope="col" className="py-1 pr-3 font-semibold">Project</th>
                    <th scope="col" className="py-1 pr-3 font-semibold">Status</th>
                    <th scope="col" className="py-1 pr-3 font-semibold">Policy</th>
                    <th scope="col" className="py-1 pr-3 text-right font-semibold">Items</th>
                    <th scope="col" className="py-1 pr-3 text-right font-semibold">Candidates</th>
                    <th scope="col" className="py-1 pr-3 text-right font-semibold">Actions</th>
                    <th scope="col" className="py-1 pr-3 text-right font-semibold">Completed</th>
                    <th scope="col" className="py-1 pr-3 text-right font-semibold">Outcomes</th>
                    <th scope="col" className="py-1 font-semibold">Signal</th>
                  </tr>
                </thead>
                <tbody>
                  {signals.map((s) => {
                    const execRow = executionPathByKey.get(`${s.projectKey}::${s.statusName}`);
                    return (
                      <tr key={`${s.projectKey}::${s.statusName}`} className="border-b border-border last:border-0">
                        <td className="py-1 pr-3 font-mono text-text3">{s.projectKey}</td>
                        <td className="py-1 pr-3 text-text">{s.statusName}</td>
                        <td className="py-1 pr-3 text-text2">{s.currentRelevance}</td>
                        <td className="py-1 pr-3 text-right text-text2">{s.observedItemCount}</td>
                        <td className="py-1 pr-3 text-right text-text2">{execRow?.candidateCount ?? "N/A"}</td>
                        <td className="py-1 pr-3 text-right text-text2">{s.actionEvidenceCount}</td>
                        <td className="py-1 pr-3 text-right text-text2">{s.completionEvidenceCount}</td>
                        <td className="py-1 pr-3 text-right text-text2">{execRow?.outcomeCount ?? 0}</td>
                        <td className={`py-1 ${SIGNAL_STYLE[s.signalType]}`}>{s.signalType === "INSUFFICIENT_EVIDENCE" ? "Insufficient evidence" : s.signalType === "REVIEW" ? "Review" : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* §8-9 — Policy Review Signals: neutral evidence language, never a causal claim. */}
          {reviewSignals.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-text3">Policy review signals</p>
              {reviewSignals.map((s) => (
                <div key={`${s.projectKey}::${s.statusName}`} className="rounded-md border border-yellow/30 bg-yellow/5 p-2.5 text-xs">
                  <p className="font-mono text-text">
                    {s.projectKey} — {s.statusName}
                  </p>
                  <p className="mt-0.5 text-text3">
                    Current policy: <span className="text-text2">{s.currentRelevance}</span>
                  </p>
                  <p className="mt-1 text-text2">{s.explanation}</p>
                  <Link href="/data-settings#jira-work-relevance-policy-panel" className="mt-2 inline-block font-medium text-accent2 hover:underline">
                    Review Policy
                  </Link>
                </div>
              ))}
            </div>
          )}

          {/* V2.8 §11 Signal C — a distinct pipeline stage from Policy Review Signals above:
              candidate EVALUATION, not action evidence. Never claims "policy is too broad". */}
          {candidateGapSignals.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-text3">Candidate evaluation signals</p>
              {candidateGapSignals.map((s) => (
                <div key={`${s.projectKey}::${s.statusName}`} className="rounded-md border border-yellow/30 bg-yellow/5 p-2.5 text-xs">
                  <p className="font-mono text-text">
                    {s.projectKey} — {s.statusName}
                  </p>
                  <p className="mt-1 text-text2">{s.explanation}</p>
                  <Link href="/data-settings#jira-work-relevance-policy-panel" className="mt-2 inline-block font-medium text-accent2 hover:underline">
                    Review Policy
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
