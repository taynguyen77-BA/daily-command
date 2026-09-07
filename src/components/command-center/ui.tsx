"use client";

import { useState, type HTMLAttributes, type ReactNode } from "react";
import type {
  ActionOutcomeStatus,
  AttentionCategory,
  AttentionLifecycle,
  AttentionSeverity,
  DecisionEffectivenessClass,
  DependencyHeat,
  DriftLevel,
  Evidence,
  FocusCategory,
  LoopHealth,
  ReasoningTrace,
  Severity,
  RiskLevel,
  TrajectoryLevel,
} from "@/lib/command-center/types";
import type { DecisionReviewStatus } from "@/lib/command-center/decision-radar";

const SEVERITY_STYLES: Record<Severity, string> = {
  CRITICAL: "bg-red/15 text-red border-red/30",
  HIGH: "bg-orange/15 text-orange border-orange/30",
  MEDIUM: "bg-yellow/15 text-yellow border-yellow/30",
  LOW: "bg-green/15 text-green border-green/30",
};

const RISK_STYLES: Record<RiskLevel, string> = {
  HIGH: "bg-red/15 text-red border-red/30",
  MEDIUM: "bg-orange/15 text-orange border-orange/30",
  LOW: "bg-yellow/15 text-yellow border-yellow/30",
};

export function SeverityBadge({ level }: { level: Severity }) {
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold tracking-wide ${SEVERITY_STYLES[level]}`}>
      {level}
    </span>
  );
}

export function RiskBadge({ level }: { level: RiskLevel }) {
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold tracking-wide ${RISK_STYLES[level]}`}>
      {level}
    </span>
  );
}

// ===== V1.4 — Proactive Delivery Intelligence badges =====

const ATTENTION_SEVERITY_STYLES: Record<AttentionSeverity, string> = {
  CRITICAL: "bg-red/15 text-red border-red/30",
  HIGH: "bg-orange/15 text-orange border-orange/30",
  MEDIUM: "bg-yellow/15 text-yellow border-yellow/30",
  LOW: "bg-green/15 text-green border-green/30",
  INFO: "bg-surface2 text-text3 border-border",
};

export function AttentionSeverityBadge({ severity }: { severity: AttentionSeverity }) {
  return <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold tracking-wide ${ATTENTION_SEVERITY_STYLES[severity]}`}>{severity}</span>;
}

const DRIFT_STYLES: Record<DriftLevel, string> = {
  SEVERE: "bg-red/15 text-red border-red/30",
  DRIFTING: "bg-orange/15 text-orange border-orange/30",
  WATCH: "bg-yellow/15 text-yellow border-yellow/30",
  STABLE: "bg-green/15 text-green border-green/30",
};

export function DriftBadge({ level }: { level: DriftLevel }) {
  return <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold tracking-wide ${DRIFT_STYLES[level]}`}>{level}</span>;
}

const TRAJECTORY_STYLES: Record<TrajectoryLevel, string> = {
  CRITICAL: "bg-red/15 text-red border-red/30",
  DRIFTING: "bg-orange/15 text-orange border-orange/30",
  WATCH: "bg-yellow/15 text-yellow border-yellow/30",
  ON_TRACK: "bg-green/15 text-green border-green/30",
  INSUFFICIENT_HISTORY: "bg-surface2 text-text3 border-border",
};

const TRAJECTORY_LABELS: Record<TrajectoryLevel, string> = {
  CRITICAL: "CRITICAL",
  DRIFTING: "DRIFTING",
  WATCH: "WATCH",
  ON_TRACK: "ON TRACK",
  INSUFFICIENT_HISTORY: "INSUFFICIENT HISTORY",
};

export function TrajectoryBadge({ level }: { level: TrajectoryLevel }) {
  return <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold tracking-wide ${TRAJECTORY_STYLES[level]}`}>{TRAJECTORY_LABELS[level]}</span>;
}

const HEAT_STYLES: Record<DependencyHeat, string> = {
  CRITICAL: "bg-red/15 text-red border-red/30",
  HIGH: "bg-orange/15 text-orange border-orange/30",
  MEDIUM: "bg-yellow/15 text-yellow border-yellow/30",
  LOW: "bg-green/15 text-green border-green/30",
};

export function HeatBadge({ heat }: { heat: DependencyHeat }) {
  return <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold tracking-wide ${HEAT_STYLES[heat]}`}>{heat}</span>;
}

const CATEGORY_LABELS: Record<AttentionCategory, string> = {
  RISK: "Risk",
  DRIFT: "Drift",
  DEPENDENCY: "Dependency",
  DECISION: "Decision",
  ACTION: "Action",
  COMMUNICATION: "Communication",
  // V2.10 §2 — appended, never inserted into the original six.
  MENTION: "Mentioned",
  ASSIGNMENT: "Assigned",
};

export function CategoryBadge({ category }: { category: AttentionCategory }) {
  return <span className="inline-flex items-center rounded border border-border bg-surface2 px-2 py-0.5 text-xs font-medium text-text2">{CATEGORY_LABELS[category]}</span>;
}

const LIFECYCLE_STYLES: Record<AttentionLifecycle, string> = {
  NEW: "bg-accent/10 text-accent2 border-accent/30",
  ACTIVE: "bg-surface2 text-text2 border-border",
  ACKNOWLEDGED: "bg-surface2 text-text3 border-border",
  SNOOZED: "bg-surface2 text-text3 border-border",
  RESOLVED: "bg-green/15 text-green border-green/30",
  REOPENED: "bg-red/15 text-red border-red/30",
  RE_ESCALATED: "bg-red/15 text-red border-red/30",
};

export function LifecycleBadge({ lifecycle }: { lifecycle: AttentionLifecycle }) {
  return <span className={`inline-flex items-center rounded border px-1.5 py-0 text-[10px] font-medium tracking-wide ${LIFECYCLE_STYLES[lifecycle]}`}>{lifecycle}</span>;
}

// ===== V1.5 — Decision & Action Intelligence badges =====

const DECISION_EFFECTIVENESS_STYLES: Record<DecisionEffectivenessClass, string> = {
  EFFECTIVE: "bg-green/15 text-green border-green/30",
  PARTIALLY_EFFECTIVE: "bg-yellow/15 text-yellow border-yellow/30",
  INEFFECTIVE: "bg-red/15 text-red border-red/30",
  UNKNOWN: "bg-surface2 text-text3 border-border",
};

export function DecisionEffectivenessBadge({ classification }: { classification: DecisionEffectivenessClass }) {
  return <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold tracking-wide ${DECISION_EFFECTIVENESS_STYLES[classification]}`}>{classification.replace(/_/g, " ")}</span>;
}

const LOOP_HEALTH_STYLES: Record<LoopHealth, string> = {
  HEALTHY: "bg-green/15 text-green border-green/30",
  AT_RISK: "bg-yellow/15 text-yellow border-yellow/30",
  STALLED: "bg-red/15 text-red border-red/30",
  COMPLETED: "bg-accent/10 text-accent2 border-accent/30",
  UNKNOWN: "bg-surface2 text-text3 border-border",
};

export function LoopHealthBadge({ health }: { health: LoopHealth }) {
  return <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold tracking-wide ${LOOP_HEALTH_STYLES[health]}`}>{health.replace(/_/g, " ")}</span>;
}

const ACTION_OUTCOME_STYLES: Record<ActionOutcomeStatus, string> = {
  RESOLVED: "bg-green/15 text-green border-green/30",
  IMPROVED: "bg-green/15 text-green border-green/30",
  PARTIALLY_IMPROVED: "bg-yellow/15 text-yellow border-yellow/30",
  NO_CHANGE: "bg-surface2 text-text3 border-border",
  WORSENED: "bg-red/15 text-red border-red/30",
  UNKNOWN: "bg-surface2 text-text3 border-border",
};

export function ActionOutcomeBadge({ status }: { status: ActionOutcomeStatus }) {
  return <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold tracking-wide ${ACTION_OUTCOME_STYLES[status]}`}>{status.replace(/_/g, " ")}</span>;
}

// V2.0 §9 — decision review reminders. NOT_DUE_YET renders nothing (a decision with a
// review date that isn't in the reminder window yet has nothing to flag right now).
const REVIEW_STATUS_STYLES: Partial<Record<DecisionReviewStatus, string>> = {
  REVIEW_DUE: "bg-yellow/15 text-yellow border-yellow/30",
  REVIEW_SOON: "bg-surface2 text-text3 border-border",
  REVIEW_OVERDUE: "bg-red/15 text-red border-red/30",
  NO_REVIEW_DATE: "bg-surface text-text3 border-border",
};
const REVIEW_STATUS_LABELS: Partial<Record<DecisionReviewStatus, string>> = {
  REVIEW_DUE: "Review due",
  REVIEW_SOON: "Review soon",
  REVIEW_OVERDUE: "Review overdue",
  NO_REVIEW_DATE: "No review date",
};

export function DecisionReviewStatusBadge({ status }: { status: DecisionReviewStatus }) {
  if (status === "NOT_DUE_YET") return null;
  return <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${REVIEW_STATUS_STYLES[status]}`}>{REVIEW_STATUS_LABELS[status]}</span>;
}

// ===== V1.6 — Personal Delivery Copilot badges =====

const FOCUS_CATEGORY_STYLES: Record<FocusCategory, string> = {
  DO_NOW: "bg-red/15 text-red border-red/30",
  DO_TODAY: "bg-orange/15 text-orange border-orange/30",
  WATCH: "bg-yellow/15 text-yellow border-yellow/30",
  DEFER: "bg-surface2 text-text3 border-border",
  BLOCKED: "bg-surface2 text-text3 border-border",
  DONE: "bg-green/15 text-green border-green/30",
};

const FOCUS_CATEGORY_LABELS: Record<FocusCategory, string> = {
  DO_NOW: "Do Now",
  DO_TODAY: "Do Today",
  WATCH: "Watch",
  DEFER: "Defer",
  BLOCKED: "Blocked",
  DONE: "Done",
};

export function FocusCategoryBadge({ category }: { category: FocusCategory }) {
  return <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold tracking-wide ${FOCUS_CATEGORY_STYLES[category]}`}>{FOCUS_CATEGORY_LABELS[category]}</span>;
}

export function Panel({ children, className = "", ...rest }: { children: ReactNode; className?: string } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`rounded-lg border border-border bg-surface ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function SectionHeading({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <div>
        <h2 className="font-display text-lg text-text">{title}</h2>
        {subtitle && <p className="text-sm text-text3">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  onLoadDemo,
}: {
  title: string;
  description: string;
  onLoadDemo: () => void;
}) {
  return (
    <Panel className="flex flex-col items-center gap-4 px-8 py-16 text-center">
      <div className="text-4xl">◎</div>
      <div>
        <h3 className="font-display text-lg text-text">{title}</h3>
        <p className="mt-1 max-w-md text-sm text-text3">{description}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <button
          onClick={onLoadDemo}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent2"
        >
          Load Demo Data
        </button>
        <a
          href="/data-settings"
          className="rounded-md border border-border px-4 py-2 text-sm font-medium text-text2 hover:border-accent hover:text-text"
        >
          Paste Data
        </a>
        <a
          href="/data-settings"
          className="rounded-md border border-border px-4 py-2 text-sm font-medium text-text2 hover:border-accent hover:text-text"
        >
          Import JSON
        </a>
      </div>
    </Panel>
  );
}

/**
 * V1.1 §7 reasoning trace — "Why am I seeing this?" expands to FACTS / EVIDENCE /
 * INFERENCE / RECOMMENDATION / CONFIDENCE. `evidence` (plain strings) is kept for
 * simple deterministic-only call sites (e.g. raw scoring factors); pass `trace` for
 * an AI-generated ReasoningTrace to get the full five-part breakdown.
 */
export function WhyDrawer({
  evidence,
  reasoning,
  trace,
}: {
  evidence?: string[];
  reasoning?: string;
  trace?: ReasoningTrace;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-xs font-medium text-accent2 hover:underline">
        {open ? "Hide" : "Why am I seeing this?"}
      </button>
      {open && (
        <div className="mt-2 space-y-3 rounded-md border border-border bg-surface2 p-3 text-xs text-text2">
          {trace ? (
            <ReasoningTraceBlock trace={trace} />
          ) : (
            <>
              {reasoning && <p className="text-text">{reasoning}</p>}
              {evidence && (
                <div>
                  <p className="mb-1 flex items-center gap-1 font-medium text-text3">
                    <TrustLabel kind="evidence" /> Evidence
                  </p>
                  <ul className="space-y-0.5">
                    {evidence.map((e, i) => (
                      <li key={i}>- {e}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ReasoningTraceBlock({ trace }: { trace: ReasoningTrace }) {
  return (
    <div className="space-y-3">
      {trace.insufficientEvidence && (
        <p className="rounded border border-yellow/30 bg-yellow/10 px-2 py-1 text-yellow">
          Insufficient evidence — this is a best-effort read, not a confident conclusion.
        </p>
      )}
      <div>
        <p className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide text-text3">
          <TrustLabel kind="calculated" /> Facts
        </p>
        <ul className="space-y-0.5">
          {trace.facts.length ? trace.facts.map((f, i) => <li key={i}>- {f}</li>) : <li>- (none provided)</li>}
        </ul>
      </div>
      {trace.evidence.length > 0 && (
        <div>
          <p className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide text-text3">
            <TrustLabel kind="evidence" /> Evidence
          </p>
          <ul className="space-y-0.5">
            {trace.evidence.map((e: Evidence) => (
              <li key={e.id}>- {e.content}</li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <p className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide text-text3">
          <TrustLabel kind="ai-assessment" /> Inference
        </p>
        <p className="text-text">{trace.inference}</p>
      </div>
      <div>
        <p className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide text-text3">
          <TrustLabel kind="ai-recommendation" /> Recommendation
        </p>
        <p className="text-text">{trace.recommendation}</p>
      </div>
      <ConfidenceTag confidence={trace.confidence} />
    </div>
  );
}

/** V1.1 §15, extended V1.2 §16 / V1.3 §42 — never let an AI assessment read as factual
 *  system state, and always distinguish a Jira-sourced or historical fact from a live one.
 *  V2.2 §5 adds "ai-draft"/"user-input"/"unknown" — the remaining three Artifact Trust
 *  Model kinds, so every artifact segment can be labeled with this one shared component. */
export function TrustLabel({ kind }: { kind: "calculated" | "ai-assessment" | "ai-recommendation" | "evidence" | "history" | "source" | "ai-draft" | "user-input" | "unknown" }) {
  const styles: Record<typeof kind, string> = {
    calculated: "bg-surface text-text3 border-border",
    "ai-assessment": "bg-accent/10 text-accent2 border-accent/30",
    "ai-recommendation": "bg-accent/10 text-accent2 border-accent/30",
    evidence: "bg-surface text-text3 border-border",
    history: "bg-surface text-text3 border-border",
    source: "bg-surface text-text3 border-border",
    "ai-draft": "bg-accent/10 text-accent2 border-accent/30",
    "user-input": "bg-green/10 text-green border-green/30",
    unknown: "bg-yellow/10 text-yellow border-yellow/30",
  };
  const labels: Record<typeof kind, string> = {
    calculated: "Calculated",
    "ai-assessment": "AI assessment",
    "ai-recommendation": "AI recommendation",
    evidence: "Evidence",
    history: "History",
    source: "Source",
    "ai-draft": "AI draft",
    "user-input": "User input",
    unknown: "Unknown",
  };
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0 text-[10px] normal-case tracking-normal ${styles[kind]}`}>
      {labels[kind]}
    </span>
  );
}

export function ConfidenceTag({ confidence }: { confidence: number }) {
  return <span className="text-xs text-text3">Confidence: {Math.round(confidence * 100)}%</span>;
}

/** V1.8 §13 — AI fallback transparency. A single, contextual tri-state indicator so Mock
 *  output can never be mistaken for real Claude output — deliberately not repeated on
 *  every AI-generated card (§13 "do not create a disruptive warning on every card"). */
export function AiProviderIndicator({ state }: { state: "REAL_CLAUDE" | "MOCK_FALLBACK" | "CLAUDE_UNAVAILABLE" | "CACHED" | "CALL_FAILED" | "VALIDATION_FAILED" }) {
  const styles: Record<typeof state, string> = {
    REAL_CLAUDE: "bg-green/10 text-green border-green/30",
    MOCK_FALLBACK: "bg-yellow/10 text-yellow border-yellow/30",
    CLAUDE_UNAVAILABLE: "bg-surface text-text3 border-border",
    // V2.0 §3 — a cached AI result must never read as a freshly-calculated fact; this is
    // the visible "AI assessment — cached" vs "— refreshed" distinction from the spec.
    CACHED: "bg-surface text-text3 border-border",
    // V2.1 §6/§14 — the two distinct fallback reasons that used to both read "Mock
    // fallback": the request itself failed, vs. a response arrived but failed validation.
    CALL_FAILED: "bg-red/10 text-red border-red/30",
    VALIDATION_FAILED: "bg-orange/10 text-orange border-orange/30",
  };
  const labels: Record<typeof state, string> = {
    REAL_CLAUDE: "Real Claude",
    MOCK_FALLBACK: "Mock fallback",
    CLAUDE_UNAVAILABLE: "Claude unavailable",
    CACHED: "Cached result",
    CALL_FAILED: "Call failed",
    VALIDATION_FAILED: "Response invalid",
  };
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0 text-[10px] normal-case tracking-normal ${styles[state]}`}>
      {labels[state]}
    </span>
  );
}
