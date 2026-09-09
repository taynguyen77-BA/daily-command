"use client";

// V2.0 §1.4 — DecisionCard used to call getAIProvider() from a bare useEffect whenever a
// conflict candidate was passed in (i.e. once per conflicting decision in the rendered
// list, with zero user gesture). The conflict assessment is now strictly on-demand,
// behind an explicit click, routed through the entity cache (ai/ai-cache.ts).

import { useMemo, useState } from "react";
import { getAIProvider } from "@/lib/command-center/ai";
import { withAICache } from "@/lib/command-center/ai/ai-cache";
import { commandCenterStore, getTodayIso } from "@/lib/command-center/store";
import { projectDecisionImpact } from "@/lib/command-center/impact-projection";
import { reviewStatusFor } from "@/lib/command-center/decision-radar";
import { buildWhyShouldICare } from "@/lib/command-center/why-should-i-care";
import { buildStakeholderUpdateDraft } from "@/lib/command-center/communicate";
import type { Decision, DecisionConflictAssessment, DecisionConflictCandidate, DecisionEffectivenessClass, DecisionEffectivenessResult, DecisionRadarItem } from "@/lib/command-center/types";
import { AiProviderIndicator, AttentionSeverityBadge, ConfidenceTag, DecisionEffectivenessBadge, DecisionReviewStatusBadge, MetaPill, Panel, TrustLabel } from "./ui";
import { WhyShouldICareDrawer } from "./WhyShouldICareDrawer";
import { AskClaudeAbout } from "./AskClaudeAbout";
import { ArtifactEditor } from "./ArtifactEditor";

const OUTCOME_CLASSES: DecisionEffectivenessClass[] = ["EFFECTIVE", "PARTIALLY_EFFECTIVE", "INEFFECTIVE", "UNKNOWN"];

function ConflictAssessment({ conflict }: { conflict: DecisionConflictCandidate }) {
  const [assessment, setAssessment] = useState<DecisionConflictAssessment | null>(null);
  const [cacheState, setCacheState] = useState<"cached" | "refreshed" | null>(null);
  const [mode, setMode] = useState<"mock" | "claude">("mock");
  const [loading, setLoading] = useState(false);

  async function assess() {
    if (loading) return;
    setLoading(true);
    try {
      const facts = conflict.reasons;
      const { value, cacheState: cs } = await withAICache("detectDecisionConflicts", `decision-conflict:${conflict.decision.id}`, facts, conflict.evidence, () =>
        getAIProvider().detectDecisionConflicts(conflict)
      );
      setAssessment(value);
      setCacheState(cs);
      setMode(getAIProvider().mode);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      {!assessment ? (
        <button onClick={assess} disabled={loading} className="text-xs font-medium text-orange hover:underline disabled:opacity-50">
          {loading ? "Assessing…" : "Ask Claude to assess this conflict"}
        </button>
      ) : (
        <div>
          <p className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide text-text3">
            <TrustLabel kind="ai-assessment" /> AI assessment
            {cacheState && <AiProviderIndicator state={cacheState === "cached" ? "CACHED" : mode === "mock" ? "MOCK_FALLBACK" : "REAL_CLAUDE"} />}
          </p>
          <p className="text-text2">{assessment.assessment}</p>
          <ConfidenceTag confidence={assessment.confidence} />
        </div>
      )}
    </div>
  );
}

export function DecisionCard({
  decision,
  conflict,
  radar,
  effectiveness,
}: {
  decision: Decision;
  conflict?: DecisionConflictCandidate;
  radar?: DecisionRadarItem;
  effectiveness?: DecisionEffectivenessResult;
}) {
  const [open, setOpen] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [creatingUpdate, setCreatingUpdate] = useState(false);
  const reviewStatus = useMemo(() => reviewStatusFor(decision, getTodayIso()), [decision]);

  const content = useMemo(
    () =>
      buildWhyShouldICare({
        fact: [`Status: ${decision.status}`, decision.date ? `Decided: ${decision.date}` : "No decision date recorded", ...(radar?.whyReview ?? [])],
        signal: radar?.whyReview?.join(" ") || "No active review signal from Decision Radar.",
        impact: projectDecisionImpact(decision),
        unknown: decision.reviewDate ? [] : ["No review date is set for this decision."],
        nextMove: radar?.needsAttention ? "Review, keep, or mark this decision superseded." : "No immediate action required.",
        evidence: radar?.evidence ?? [],
      }),
    [decision, radar]
  );

  return (
    <Panel className="p-4">
      <div className="mb-1 flex items-center gap-2">
        <MetaPill>{decision.status}</MetaPill>
        {decision.date && <span className="text-xs text-text3">{decision.date}</span>}
        {radar && radar.stalenessDays > 0 && <MetaPill>Unchanged {radar.stalenessDays}d</MetaPill>}
        {radar && <AttentionSeverityBadge severity={radar.reviewUrgency === "URGENT_REVIEW" ? "HIGH" : "MEDIUM"} />}
        {(reviewStatus === "REVIEW_DUE" || reviewStatus === "REVIEW_SOON" || reviewStatus === "REVIEW_OVERDUE") && <DecisionReviewStatusBadge status={reviewStatus} />}
        {decision.outcomeStatus && <MetaPill>Outcome: {decision.outcomeStatus}</MetaPill>}
      </div>
      <p className="font-display text-sm text-text">{decision.title}</p>
      {decision.decision && <p className="mt-1 text-sm text-text2">{decision.decision}</p>}
      {decision.expectedOutcome && (
        <p className="mt-1 text-xs text-text2">
          <span className="text-text3">Expected outcome: </span>
          {decision.expectedOutcome}
        </p>
      )}
      {decision.context && (
        <p className="mt-1 text-xs text-text2">
          <span className="text-text3">Context: </span>
          {decision.context}
        </p>
      )}
      {decision.impact && (
        <p className="mt-1 text-xs text-text2">
          <span className="text-text3">Impact: </span>
          {decision.impact}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-3 text-xs text-text3">
        {decision.owner && <span>Owner: {decision.owner}</span>}
        {decision.relatedWorkItemIds && decision.relatedWorkItemIds.length > 0 && (
          <span>Related items: {decision.relatedWorkItemIds.length}</span>
        )}
      </div>

      <WhyShouldICareDrawer content={content} onCreateUpdate={() => setCreatingUpdate(true)} />
      <AskClaudeAbout subject={decision.title} entityId={decision.id} facts={content.fact} evidence={content.evidence} />
      {creatingUpdate && (
        <ArtifactEditor
          draft={buildStakeholderUpdateDraft({ kind: "why-should-i-care", content, subjectTitle: decision.title }, `Decision: ${decision.title}`)}
          onClose={() => setCreatingUpdate(false)}
        />
      )}

      {conflict && (
        <div className="mt-3 rounded-md border border-orange/30 bg-orange/10 p-3">
          <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-xs font-medium text-orange hover:underline">
            {open ? "Hide" : "⚠ Potential conflict detected — why am I seeing this?"}
          </button>
          {open && (
            <div className="mt-2 space-y-2 text-xs">
              <div>
                <p className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide text-text3">
                  <TrustLabel kind="calculated" /> Evidence
                </p>
                <ul className="space-y-0.5 text-text2">
                  {conflict.evidence.map((e) => (
                    <li key={e.id}>- {e.content}</li>
                  ))}
                </ul>
              </div>
              <ConflictAssessment conflict={conflict} />
            </div>
          )}
        </div>
      )}

      {decision.options && decision.options.length > 0 && (
        <div className="mt-3 border-t border-border pt-3">
          <button onClick={() => setShowOptions((o) => !o)} aria-expanded={showOptions} className="text-xs font-medium text-accent2 hover:underline">
            {showOptions ? "Hide" : `View considered options (${decision.options.length})`}
          </button>
          {showOptions && (
            <ul className="mt-2 space-y-2 text-xs">
              {decision.options.map((opt) => (
                <li key={opt.id} className={`rounded border p-2 ${opt.label === decision.selectedOption ? "border-accent/50 bg-accent/5" : "border-border bg-surface2"}`}>
                  <p className="font-medium text-text">
                    {opt.id}. {opt.label} {opt.label === decision.selectedOption && "— selected"}
                  </p>
                  <p className="text-text2">{opt.rationale}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {effectiveness && effectiveness.observedChanges.length > 0 && !decision.outcomeStatus && (
        <div className="mt-3 rounded-md border border-border bg-surface2 p-3">
          <div className="mb-1 flex items-center gap-2">
            <TrustLabel kind="calculated" />
            <span className="text-xs font-semibold uppercase tracking-wide text-text3">Outcome check</span>
            <DecisionEffectivenessBadge classification={effectiveness.classification} />
          </div>
          <ul className="mt-1 space-y-0.5 text-xs text-text2">
            {effectiveness.observedChanges.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className="text-xs text-text3">Confirm outcome:</span>
            {OUTCOME_CLASSES.map((c) => (
              <button
                key={c}
                onClick={() => commandCenterStore.confirmDecisionOutcome(decision.id, c)}
                className="rounded border border-border px-2 py-1 text-[11px] text-text2 hover:border-accent hover:text-text"
              >
                {c.replace(/_/g, " ")}
              </button>
            ))}
          </div>
        </div>
      )}

      {radar?.needsAttention && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
          <span className="text-xs text-text3">V1.4 §12 — never changed automatically:</span>
          <button
            onClick={() => commandCenterStore.updateDecision(decision.id, { status: "REVISIT_REQUIRED" })}
            className="rounded-md border border-border px-2 py-1 text-xs font-medium text-text2 hover:border-accent hover:text-text"
          >
            Review
          </button>
          <button
            onClick={() => commandCenterStore.updateDecision(decision.id, { status: "ACTIVE" })}
            className="rounded-md border border-border px-2 py-1 text-xs font-medium text-text2 hover:border-accent hover:text-text"
          >
            Keep decision
          </button>
          <button
            onClick={() => commandCenterStore.updateDecision(decision.id, { status: "SUPERSEDED" })}
            className="rounded-md border border-border px-2 py-1 text-xs font-medium text-text2 hover:border-accent hover:text-text"
          >
            Mark superseded
          </button>
        </div>
      )}
    </Panel>
  );
}
