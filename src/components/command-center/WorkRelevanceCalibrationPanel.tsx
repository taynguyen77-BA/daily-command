"use client";

// V2.7 — Work Relevance Operational Calibration. Lives inside Data & Settings, right below
// the V2.5/V2.6 Jira Work Relevance Policy panel (§18 "do not create a new policy
// management page"). Every number here is deterministic arithmetic over the existing
// policy map, action-plan.ts candidate pool, and Action model — never AI, never a score,
// never an automatic policy change (§21-23, §34).

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  computeActionableCalibration,
  computeObserveCalibration,
  computePolicyReviewSignals,
  computeUnknownVisibility,
  computeWorkRelevanceDistribution,
  type PolicyReviewSignal,
} from "@/lib/command-center/jira/work-relevance-calibration";
import { computeExecutionPathStatusTable } from "@/lib/command-center/execution-path";
import { computeActionableSignals } from "@/lib/command-center/jira/work-relevance-signals";
import type { WorkRelevanceIndex } from "@/lib/command-center/jira/work-relevance";
import type { WorkItemCalibrationHistory } from "@/lib/command-center/jira/work-relevance-history";
import type { ProactiveIntelligence } from "@/lib/command-center/proactive";
import { WORK_RELEVANCE_VALUES, type CommandCenterData, type JiraProjectScope, type PersonalFocusResult } from "@/lib/command-center/types";
import { Panel, SectionHeading, TrustLabel } from "./ui";

// V2.12 — for the status-level table, a NON-ACTIONABLE row's signal still uses V2.7's own
// REVIEW/NONE/INSUFFICIENT_EVIDENCE language unchanged (that concept — "this status has
// repeated user Actions even though it's classified WAITING/OBSERVE" — is a different,
// already-correctly-scoped question this fix does not touch). An ACTIONABLE row's signal
// column is instead driven by the new three-way taxonomy below.
const NON_ACTIONABLE_SIGNAL_STYLE: Record<PolicyReviewSignal["signalType"], string> = {
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
  workItemCalibrationHistory,
  proactive,
  personalFocus,
  today,
}: {
  data: CommandCenterData;
  isDemo: boolean;
  dataSourceIsJira: boolean;
  jiraConfigured: boolean | undefined;
  jiraProjectScope: JiraProjectScope;
  workRelevanceIndex: WorkRelevanceIndex;
  workItemCalibrationHistory: WorkItemCalibrationHistory;
  proactive: ProactiveIntelligence | null;
  personalFocus: PersonalFocusResult | null;
  today: string;
}) {
  const [expandedCandidateEvalStatus, setExpandedCandidateEvalStatus] = useState<string | null>(null);
  const projectKeys = jiraProjectScope.mode === "FOCUSED" ? jiraProjectScope.projectKeys : undefined;

  // §16 — real Jira + real user Action data only; synthetic (demo/import) data must never
  // be presented as if it reflects real operating behavior.
  const isSyntheticData = isDemo || !dataSourceIsJira;

  const distribution = useMemo(() => (isSyntheticData ? [] : computeWorkRelevanceDistribution(data, workRelevanceIndex, projectKeys)), [isSyntheticData, data, workRelevanceIndex, projectKeys]);
  const actionable = useMemo(() => (isSyntheticData ? null : computeActionableCalibration(data, workRelevanceIndex, today, projectKeys)), [isSyntheticData, data, workRelevanceIndex, today, projectKeys]);
  const observe = useMemo(() => (isSyntheticData ? null : computeObserveCalibration(data, workRelevanceIndex, today, projectKeys)), [isSyntheticData, data, workRelevanceIndex, today, projectKeys]);
  const unknown = useMemo(() => (isSyntheticData ? null : computeUnknownVisibility(data, workRelevanceIndex, projectKeys)), [isSyntheticData, data, workRelevanceIndex, projectKeys]);
  const signals = useMemo(() => (isSyntheticData ? [] : computePolicyReviewSignals(data, workRelevanceIndex, projectKeys)), [isSyntheticData, data, workRelevanceIndex, projectKeys]);
  // V2.12 — this fix's own scope is ACTIONABLE-status signals only (see work-relevance-
  // signals.ts). A non-ACTIONABLE REVIEW row (repeated user Actions on a WAITING/OBSERVE/etc
  // status) is a different, already-correctly-scoped classification-risk question, untouched
  // here — it keeps the "Review Policy" CTA it always had.
  const nonActionableReviewSignals = signals.filter((s) => s.signalType === "REVIEW" && s.currentRelevance !== "ACTIONABLE");
  // V2.8 §10 — extends the SAME status table with Candidates/Outcomes columns rather than
  // a parallel table; V2.11 §1 keyed by status name alone (global policy), so it merges
  // cleanly below.
  const executionPathRows = useMemo(
    () => (isSyntheticData ? [] : computeExecutionPathStatusTable(data, workRelevanceIndex, today, projectKeys)),
    [isSyntheticData, data, workRelevanceIndex, today, projectKeys]
  );
  const executionPathByKey = useMemo(() => new Map(executionPathRows.map((r) => [r.statusName, r])), [executionPathRows]);
  // V2.12 — replaces the old, single, conflated "ACTIONABLE + no candidate/action evidence
  // -> Review Policy" inference with three semantically distinct signals. See
  // jira/work-relevance-signals.ts for the full rationale and thresholds.
  const actionableSignals = useMemo(
    () =>
      isSyntheticData
        ? { policyReview: [], candidateEvaluation: [], executionGap: [] }
        : computeActionableSignals(data, workRelevanceIndex, workItemCalibrationHistory, today, projectKeys, proactive, personalFocus),
    [isSyntheticData, data, workRelevanceIndex, workItemCalibrationHistory, today, projectKeys, proactive, personalFocus]
  );
  const policyReviewStatusNames = useMemo(() => new Set(actionableSignals.policyReview.map((s) => s.statusName)), [actionableSignals.policyReview]);
  const candidateEvaluationStatusNames = useMemo(() => new Set(actionableSignals.candidateEvaluation.map((s) => s.statusName)), [actionableSignals.candidateEvaluation]);
  const executionGapStatusNames = useMemo(() => new Set(actionableSignals.executionGap.map((s) => s.statusName)), [actionableSignals.executionGap]);

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

          {/* §10 — Status-level calibration table. V2.11 §1 — one row per status name,
              aggregated across every project (the policy is global, so its evidence pool is
              too — e.g. an ACTIONABLE status with 2 linked Actions from one project and 1
              from another reports 3 total candidates for that status, not two rows). */}
          <div>
            <p className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-text3">
              <TrustLabel kind="calculated" /> Status-level calibration
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-xs">
                <caption className="sr-only">Per-status calibration: policy, observed item count, candidate pool entries, linked personal Actions, completions, outcomes, and any review signal.</caption>
                <thead>
                  <tr className="border-b border-border text-left text-text3">
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
                    const execRow = executionPathByKey.get(s.statusName);
                    // V2.12 — an ACTIONABLE row's signal comes from the new three-way
                    // taxonomy (never the old action-evidence-only REVIEW/NONE), so its
                    // funnel (Items -> Candidates -> Actions, Requirement 4) and its signal
                    // label always agree with the sections below.
                    let signalLabel = "—";
                    let signalStyle = "text-text3";
                    if (s.currentRelevance !== "ACTIONABLE") {
                      signalLabel = s.signalType === "INSUFFICIENT_EVIDENCE" ? "Insufficient evidence" : s.signalType === "REVIEW" ? "Review" : "—";
                      signalStyle = NON_ACTIONABLE_SIGNAL_STYLE[s.signalType];
                    } else if (policyReviewStatusNames.has(s.statusName)) {
                      signalLabel = "Policy review";
                      signalStyle = "text-yellow";
                    } else if (candidateEvaluationStatusNames.has(s.statusName)) {
                      signalLabel = "Candidate evaluation";
                      signalStyle = "text-text2";
                    } else if (executionGapStatusNames.has(s.statusName)) {
                      signalLabel = "Execution gap";
                      signalStyle = "text-yellow";
                    }
                    return (
                      <tr key={s.statusName} className="border-b border-border last:border-0">
                        <td className="py-1 pr-3 text-text">{s.statusName}</td>
                        <td className="py-1 pr-3 text-text2">{s.currentRelevance}</td>
                        <td className="py-1 pr-3 text-right text-text2">{s.observedItemCount}</td>
                        <td className="py-1 pr-3 text-right text-text2">{execRow?.candidateCount ?? "N/A"}</td>
                        <td className="py-1 pr-3 text-right text-text2">{s.actionEvidenceCount}</td>
                        <td className="py-1 pr-3 text-right text-text2">{s.completionEvidenceCount}</td>
                        <td className="py-1 pr-3 text-right text-text2">{execRow?.outcomeCount ?? 0}</td>
                        <td className={`py-1 ${signalStyle}`}>{signalLabel}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* V2.12 — Policy Review Signals. The ONLY signal type allowed the "Review Policy"
              CTA (see the V2.12 audit's confirmed bug: Candidate Evaluation used to render
              this same CTA too). Two sources feed this section, both real classification-
              risk evidence: (a) an ACTIONABLE status that's cleared the time-window +
              percentage + sample-size bar below (Requirement 1), and (b) a non-ACTIONABLE
              status with repeated user Actions (V2.7 §8-9, untouched by this fix). */}
          {(actionableSignals.policyReview.length > 0 || nonActionableReviewSignals.length > 0) && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-text3">Policy review signals</p>
              {actionableSignals.policyReview.map((s) => (
                <div key={`actionable-${s.statusName}`} className="rounded-md border border-yellow/30 bg-yellow/5 p-2.5 text-xs">
                  <p className="font-mono text-text">{s.statusName}</p>
                  <p className="mt-0.5 text-text3">
                    Current policy: <span className="text-text2">ACTIONABLE</span> for {s.daysActionable} day(s) · {s.observedItemCount} item(s) observed
                  </p>
                  <p className="mt-1 text-text2">{s.explanation}</p>
                  <Link href="/data-settings#jira-work-relevance-policy-panel" className="mt-2 inline-block font-medium text-accent2 hover:underline">
                    Review Policy
                  </Link>
                </div>
              ))}
              {nonActionableReviewSignals.map((s) => (
                <div key={`non-actionable-${s.statusName}`} className="rounded-md border border-yellow/30 bg-yellow/5 p-2.5 text-xs">
                  <p className="font-mono text-text">{s.statusName}</p>
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

          {/* V2.12 Requirement 2 — Candidate Evaluation Signal. Deliberately NEUTRAL/gray,
              never amber/warning: this is informational, not an alert, and must never show
              the "Review Policy" CTA (the confirmed bug this fix corrects). "View Items"
              expands the real, filtered item list inline rather than linking to a policy
              config screen. */}
          {actionableSignals.candidateEvaluation.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-text3">Candidate evaluation signals</p>
              {actionableSignals.candidateEvaluation.map((s) => {
                const expanded = expandedCandidateEvalStatus === s.statusName;
                const items = expanded ? data.workItems.filter((w) => w.sourceType === "jira" && w.status !== "Done" && w.jiraStatusName === s.statusName) : [];
                return (
                  <div key={s.statusName} className="rounded-md border border-border bg-surface2 p-2.5 text-xs">
                    <p className="font-mono text-text">{s.statusName}</p>
                    <p className="mt-1 text-text2">{s.explanation}</p>
                    <button
                      onClick={() => setExpandedCandidateEvalStatus(expanded ? null : s.statusName)}
                      className="mt-2 inline-block font-medium text-accent2 hover:underline"
                    >
                      {expanded ? "Hide items" : "View Items"}
                    </button>
                    {expanded && (
                      <ul className="mt-2 space-y-1 border-t border-border pt-2">
                        {items.map((item) =>
                          item.sourceUrl ? (
                            <li key={item.id}>
                              <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="text-accent2 hover:underline">
                                {item.key}
                              </a>{" "}
                              <span className="text-text2">{item.title}</span>
                            </li>
                          ) : (
                            <li key={item.id} className="text-text2">
                              {item.key} {item.title}
                            </li>
                          )
                        )}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* V2.12 Requirement 3 — Execution Gap Signal. Item-level triage ("Review Items"),
              not a policy question — these items already passed candidate evaluation, so
              "Review Policy" would misleadingly point at the wrong stage of the pipeline.
              Links straight to the real Jira issue when a source URL is configured. */}
          {actionableSignals.executionGap.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-text3">Execution gap signals</p>
              {actionableSignals.executionGap.map((s) => (
                <div key={s.itemId} className="rounded-md border border-yellow/30 bg-yellow/5 p-2.5 text-xs">
                  <p className="font-mono text-text">
                    {s.itemKey} <span className="text-text3">({s.statusName})</span>
                  </p>
                  <p className="mt-1 text-text2">{s.explanation}</p>
                  {data.workItems.find((w) => w.id === s.itemId)?.sourceUrl ? (
                    <a
                      href={data.workItems.find((w) => w.id === s.itemId)!.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-block font-medium text-accent2 hover:underline"
                    >
                      Review Item
                    </a>
                  ) : (
                    <span className="mt-2 block font-medium text-text3">Review Item — no Jira URL configured</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
