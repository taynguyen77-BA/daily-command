"use client";

// V1.6 §8 — the card shape used across Top 3, the 30-minute plan, and My Day. TITLE /
// PROJECT / WHY IT MATTERS / WHY NOW / YOUR NEXT MOVE / EXPECTED IMPACT / ESTIMATED FOCUS /
// EVIDENCE / CONFIDENCE, plus [START FOCUS]. Never shows an unsupported fact (§8).

import { useMemo, useState } from "react";
import { makeEvidence } from "@/lib/command-center/evidence";
import { buildWhyShouldICare } from "@/lib/command-center/why-should-i-care";
import type { PersonalFocusCandidate, SkipReason } from "@/lib/command-center/types";
import { FocusCategoryBadge, Panel, RelationBadge, TrustLabel } from "./ui";
import { WhyShouldICareDrawer } from "./WhyShouldICareDrawer";
import { TicketLink } from "./TicketLink";

const SKIP_REASONS: SkipReason[] = ["Team is handling it", "Not my action", "Waiting on another team", "Not relevant right now", "Other"];

export function PersonalFocusCard({
  candidate,
  onStartFocus,
  onSkip,
}: {
  candidate: PersonalFocusCandidate;
  onStartFocus: (c: PersonalFocusCandidate) => void;
  // V2.23 — optional: only a candidate that resolves to exactly one real ticket
  // (candidate.ticketKey) can be skipped — a candidate with no single underlying ticket (e.g.
  // overall delivery drift) has nothing to skip, same "never fabricate a link" discipline as
  // candidate.ticketKey itself. Omitting onSkip (any pre-V2.23 caller) simply hides the button.
  onSkip?: (candidate: PersonalFocusCandidate, reason?: SkipReason) => void;
}) {
  const [showEvidence, setShowEvidence] = useState(false);
  const [skipReason, setSkipReason] = useState<SkipReason | "">("");

  // V2.0 §4/§11 — upgrades the old ad hoc "why is this on my list?" toggle into the shared
  // Why Should I Care drawer. No AI call here — a focus candidate's why/nowWhat are already
  // deterministic, so this is FACT/SIGNAL/IMPACT/UNKNOWN/NEXT MOVE with no "Ask Claude"
  // sub-section (there's no single bounded AI task that fits a generic candidate).
  const content = useMemo(
    () =>
      buildWhyShouldICare({
        fact: candidate.evidence,
        signal: candidate.why,
        impact: {
          currentCondition: `${candidate.title} is currently ${candidate.category.replace(/_/g, " ")}.`,
          unresolvedSignal: "If no intervention occurs, this item is expected to remain unresolved.",
          affectedEntities: [candidate.sourceId],
          evidence: [],
          confidence: 0.6,
          insufficientEvidence: candidate.evidence.length === 0,
        },
        unknown: candidate.ownerAmbiguous
          ? ["Ownership is unclear — related items disagree on owner."]
          : candidate.dueDate
            ? []
            : ["No explicit due/review date is recorded."],
        nextMove: candidate.nowWhat,
        evidence: candidate.evidence.map((e) => makeEvidence(e, "manual", candidate.sourceId)),
      }),
    [candidate]
  );

  return (
    <Panel className="p-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        {/* V2.17 Task 3 §2 — relation leads, matching every other My Day/Attention
            Queue/Priorities card. */}
        <RelationBadge relation={candidate.relation} />
        <FocusCategoryBadge category={candidate.category} />
        {candidate.projectName && <span className="text-xs text-text3">{candidate.projectName}</span>}
        {candidate.ticketKey && <TicketLink ticketKey={candidate.ticketKey} url={candidate.ticketUrl} className="text-xs text-text3" />}
      </div>
      <p className="font-display text-sm text-text">{candidate.title}</p>
      <p className="mt-1 text-xs text-text2">
        <span className="font-medium text-text3">Why now: </span>
        {candidate.why}
      </p>
      <p className="mt-1 text-xs text-text2">
        <span className="font-medium text-text3">Your next move: </span>
        {candidate.nowWhat}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text3">
        <TrustLabel kind="calculated" />
        <span>Estimated focus: {candidate.estimatedMinutes} min (heuristic)</span>
      </div>

      {/* V2.1 §11 — Personal Focus Trust Boundary. Shown for DO_NOW/DO_TODAY items so the
          evidence boundary behind the ranking is explicit, not just implied by the badge.
          Pure presentation over candidate.factors/ownerAmbiguous/dueDate — no new ranking
          logic, nothing computed here that personal-focus.ts didn't already compute. */}
      {(candidate.category === "DO_NOW" || candidate.category === "DO_TODAY") && (
        <div className="mt-2 rounded-md border border-border bg-surface2 p-2 text-xs">
          <p className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide text-text3">
            <TrustLabel kind="calculated" /> Why this is here
          </p>
          <dl className="space-y-0.5 text-text2">
            <div>
              <dt className="inline text-text3">Priority basis: </dt>
              <dd className="inline">{candidate.factors.find((f) => f.name === "Severity / urgency")?.detail ?? `Severity: ${candidate.severity}`}</dd>
            </div>
            <div>
              <dt className="inline text-text3">Ownership: </dt>
              <dd className="inline">
                {candidate.ownerAmbiguous
                  ? "OWNER UNCLEAR"
                  : candidate.ownershipExplicit
                    ? `Explicitly assigned to you${candidate.ownerLabel ? ` (${candidate.ownerLabel})` : ""}`
                    : candidate.ownerLabel
                      ? `Explicitly assigned to ${candidate.ownerLabel}, not you`
                      : "Not explicitly recorded"}
              </dd>
            </div>
            <div>
              <dt className="inline text-text3">Deadline: </dt>
              <dd className="inline">{candidate.dueDate ? `Due ${candidate.dueDate}` : "No explicit deadline recorded"}</dd>
            </div>
            {candidate.factors.find((f) => f.name === "Dependency danger")?.available && (
              <div>
                <dt className="inline text-text3">Dependency: </dt>
                <dd className="inline">{candidate.factors.find((f) => f.name === "Dependency danger")?.detail}</dd>
              </div>
            )}
            <div>
              <dt className="inline text-text3">Trust: </dt>
              <dd className="inline">CALCULATED</dd>
            </div>
          </dl>
          {candidate.ownerAmbiguous && (
            <p className="mt-2 rounded border border-yellow/30 bg-yellow/10 px-2 py-1 text-yellow">
              This item is intentionally not ranked as DO_NOW because related records have conflicting owners.
            </p>
          )}
        </div>
      )}

      <WhyShouldICareDrawer content={content} triggerLabel="Why is this on my list?" />
      <p className="mt-1 text-xs text-text2">{candidate.whyOnMyList}</p>

      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        <button onClick={() => setShowEvidence((s) => !s)} aria-expanded={showEvidence} className="font-medium text-accent2 hover:underline">
          {showEvidence ? "Hide evidence" : `Evidence (${candidate.evidence.length})`}
        </button>
      </div>
      {showEvidence && (
        <ul className="mt-2 space-y-0.5 rounded-md border border-border bg-surface2 p-2 text-xs text-text2">
          {candidate.evidence.length === 0 ? <li>- (no additional evidence)</li> : candidate.evidence.map((e, i) => <li key={i}>- {e}</li>)}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <button onClick={() => onStartFocus(candidate)} className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent2">
          Start Focus
        </button>
        {onSkip && candidate.ticketKey && (
          <>
            <select
              value={skipReason}
              onChange={(e) => setSkipReason(e.target.value as SkipReason | "")}
              aria-label="Skip reason (optional)"
              className="rounded-md border border-border bg-surface px-1.5 py-1.5 text-xs text-text2"
            >
              <option value="">No reason</option>
              {SKIP_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <button
              onClick={() => onSkip(candidate, skipReason || undefined)}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text2 hover:border-accent hover:text-text"
            >
              Skip
            </button>
          </>
        )}
      </div>
    </Panel>
  );
}
