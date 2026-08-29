// BA/PO/PM Daily Command Center — core data model.
// Local-only V1: no auth, no multi-tenant, no backend. All state lives in the browser.

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type RiskLevel = "HIGH" | "MEDIUM" | "LOW";
export type WorkItemStatus = "Not Started" | "In Progress" | "Blocked" | "In Review" | "Done";
export type WorkItemType = "story" | "bug" | "task" | "production-issue" | "release";
// V1.2 §9 adds "recommended" | "accepted" | "in-progress" to the lifecycle (additive —
// existing code paths only ever produce "open"/"completed"/"deferred"/"snoozed"/"blocked").
export type ActionStatus = "open" | "recommended" | "accepted" | "in-progress" | "completed" | "deferred" | "snoozed" | "blocked";
export type CommAudience = "Client" | "Engineering" | "QA" | "Product" | "Management" | "Other";

export interface Client {
  id: string;
  name: string;
}

export interface Project {
  id: string;
  name: string;
  clientId: string;
  releaseDate?: string; // ISO date
  status: "on-track" | "at-risk" | "delayed" | "complete";
  // V1.3 §13 — source attribution (additive). Never fabricated: sourceUrl is only set
  // when a real base URL is configured, never guessed.
  sourceType?: EvidenceSourceType;
  sourceId?: string;
  sourceUrl?: string;
}

export interface Dependency {
  id: string;
  workItemId: string;
  description: string;
  dependsOnTeam: string;
  status: "unresolved" | "resolved";
  ownerId?: string;
  raisedDate: string; // ISO date
  resolvedDate?: string;
}

export interface Requirement {
  id: string;
  projectId: string;
  title: string;
  status: "draft" | "approved" | "changed" | "deprecated";
  businessImpact: 1 | 2 | 3 | 4 | 5;
  testCoveragePct?: number; // 0-100, undefined = no coverage tracked
}

export interface Risk {
  id: string;
  projectId: string;
  title: string;
  level: RiskLevel;
  reason: string;
  evidence: string[];
  potentialImpact: string;
  mitigation: string;
  status: "open" | "closed";
  confidence: number; // 0-1
  detectedAt: string; // ISO date
  sourceWorkItemIds: string[];
  auto?: boolean; // true = detected by the deterministic risk engine, not manually logged
}

// V1.2 widens Decision status to a richer memory-tracking set while keeping the original
// two values valid — old persisted data and existing call sites keep working unchanged.
// V1.5 §5 adds a full decision lifecycle (additive — nothing removed). The system never
// automatically moves a decision into a terminal status (EFFECTIVE/INEFFECTIVE/SUPERSEDED);
// every transition here is a human-initiated store.updateDecision()/confirm*() call.
export type DecisionStatus =
  | "pending"
  | "made"
  | "ACTIVE"
  | "AT_RISK"
  | "SUPERSEDED"
  | "REVISIT_REQUIRED"
  | "PROPOSED"
  | "UNDER_REVIEW"
  | "DECIDED"
  | "IMPLEMENTING"
  | "VALIDATING"
  | "EFFECTIVE"
  | "INEFFECTIVE"
  | "UNKNOWN";

export interface Decision {
  id: string;
  projectId: string;
  clientId?: string;
  title: string;
  status: DecisionStatus;
  description: string;
  dueDate?: string;
  // V1.2 Decision Memory additions (all optional/additive — see BUILD REQUEST V1.2 §6):
  date?: string; // when the decision was made
  context?: string;
  decision?: string; // the decision text itself, distinct from the short `title`
  owner?: string;
  impact?: string;
  relatedWorkItemIds?: string[];
  evidenceIds?: string[];
  // V1.5 §4, §8-14 — Decision Loop additions. All optional; legacy decisions never require them.
  options?: DecisionOption[]; // the option set considered, persisted for inspectability (§43)
  selectedOption?: string; // the chosen option's label
  expectedOutcome?: string;
  reviewDate?: string;
  outcome?: string; // free-text observed-outcome note
  outcomeStatus?: DecisionEffectivenessClass;
  relatedActionIds?: string[];
  relatedRiskIds?: string[];
  relatedDependencyIds?: string[];
}

/** V1.5 §8 — one AI-generated option for a decision. Never invents numeric outcomes (§8). */
export interface DecisionOption {
  id: string; // "A" | "B" | "C" | "D"
  label: string;
  rationale: string;
  upside: string;
  downside: string;
  dependencies: string[];
  risks: string[];
  evidence: string[];
  confidence: number;
}

export type DecisionEffectivenessClass = "EFFECTIVE" | "PARTIALLY_EFFECTIVE" | "INEFFECTIVE" | "UNKNOWN";

export interface Action {
  id: string;
  title: string;
  why: string;
  relatedWorkItemId?: string;
  owner?: string;
  status: ActionStatus;
  estimateMinutes: number;
  dueDate?: string;
  note?: string;
  createdAt: string;
  completedAt?: string;
  snoozedUntil?: string;
  outcome?: string; // V1.2 §9 — optional, recorded when the action is completed
  // V1.5 §17-19 — Action Loop additions. All optional/additive.
  expectedOutcome?: string;
  relatedDecisionId?: string;
  relatedRiskId?: string;
  relatedDependencyId?: string;
  outcomeDate?: string;
  outcomeStatus?: ActionOutcomeStatus;
  // V2.0 §8 — provenance, mirroring PersonalPlanItem.origin. Optional/additive: existing
  // persisted actions (created before this field existed) are simply undefined, which the
  // UI treats the same as "user" — never fabricated for pre-existing data.
  source?: "user" | "system-suggested";
}

/** V1.5 §18 — "What happened?" after completing an action. */
export type ActionOutcomeStatus = "RESOLVED" | "IMPROVED" | "PARTIALLY_IMPROVED" | "NO_CHANGE" | "WORSENED" | "UNKNOWN";

export interface Communication {
  id: string;
  workItemId?: string;
  audience: CommAudience;
  who: string;
  why: string;
  whatTheyNeedToKnow: string;
  suggestedMessage: string;
  status: "open" | "handled" | "snoozed";
  // V1.4 §17 additions — deterministic communication-priority ranking. Optional/additive.
  priority?: CommunicationPriority;
  when?: string;
}

export interface ChangeEvent {
  id: string;
  entityType: "WorkItem" | "Risk" | "Requirement" | "Project" | "Dependency";
  entityId: string;
  entityLabel: string;
  field: string;
  before: string;
  after: string;
  detectedAt: string;
  impact: string;
}

export interface WorkItem {
  id: string;
  key: string; // e.g. "JPMC-123"
  title: string;
  projectId: string;
  clientId: string;
  type: WorkItemType;
  status: WorkItemStatus;
  priority: "P1" | "P2" | "P3" | "P4";
  owner?: string;
  dueDate?: string; // ISO date
  createdDate: string;
  lastUpdated: string; // ISO date
  blocked: boolean;
  blockerReason?: string;
  dependencyIds: string[];
  riskIds: string[];
  // Optional (V1.3 §17): a real Jira issue may not carry a business-impact-equivalent
  // field. Never inferred from priority — undefined means "not provided", and every
  // read site must say so rather than fabricating a mid-range value.
  businessImpact?: 1 | 2 | 3 | 4 | 5;
  uatCompletionPct?: number; // 0-100, relevant for release-type work
  scopeChangeCount: number;
  // V1.3 additions — additive, all optional.
  labels?: string[]; // Jira labels
  fixVersion?: string; // Jira fix version — the only "release" grouping V1.3 uses (§19)
  sourceType?: EvidenceSourceType;
  sourceId?: string; // e.g. Jira issue key
  sourceUrl?: string; // never fabricated — only set when a real base URL is configured
}

export interface DailySnapshot {
  date: string; // ISO date, day the snapshot was taken
  workItems: WorkItem[];
  risks: Risk[];
  requirements: Requirement[];
  dependencies: Dependency[];
  projects: Project[];
  // V1.2 §3 — computed metrics captured at snapshot time. Optional so old snapshots
  // (persisted before this field existed) remain valid; consumers treat a missing
  // metrics block as "no historical metrics available" rather than crashing.
  metrics?: SnapshotMetrics;
}

export interface SnapshotMetrics {
  attentionCount: number; // CRITICAL + HIGH priority items
  criticalCount: number;
  highRiskCount: number;
  blockedCount: number;
  overdueCount: number;
  deliveryConfidence: number;
  openDecisionsCount: number;
  unresolvedDependenciesCount: number;
  majorRiskTitles: string[]; // top HIGH-risk titles at snapshot time — lightweight, not full objects
  unresolvedDependencyTeams: string[]; // for recurring-pattern detection
  meaningfulChangeCount: number;
}

export interface PriorityFactor {
  name: string;
  contribution: number;
  max: number;
  detail: string;
}

export interface PriorityScoreResult {
  itemId: string;
  score: number;
  classification: Severity;
  factors: PriorityFactor[];
  confidence: number;
  reasoning: string;
}

export interface CommandCenterData {
  clients: Client[];
  projects: Project[];
  workItems: WorkItem[];
  requirements: Requirement[];
  risks: Risk[];
  dependencies: Dependency[];
  decisions: Decision[];
  actions: Action[];
  communications: Communication[];
}

export function emptyData(): CommandCenterData {
  return {
    clients: [],
    projects: [],
    workItems: [],
    requirements: [],
    risks: [],
    dependencies: [],
    decisions: [],
    actions: [],
    communications: [],
  };
}

// ===== V1.1 — Evidence & reasoning-trace model (AI Intelligence Hardening) =====
// Additive to the V1 model above. Every AI-generated insight can point back to the
// concrete data it was computed from, so a user can always ask "why am I seeing this?"
// and get the underlying facts, not just a claim.

export type EvidenceSourceType = "demo" | "manual" | "json" | "csv" | "text" | "jira";

export interface Evidence {
  id: string;
  sourceType: EvidenceSourceType;
  sourceId?: string; // id of the WorkItem/Risk/Requirement/etc this evidence was read from
  title?: string;
  content: string; // a single human-readable fact, e.g. "Due date: 2026-09-03"
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

/**
 * The shape every AI-generated explanation must conform to (BUILD REQUEST V1.1 §4, §7).
 * `facts` are deterministic values pulled straight from the data (never invented).
 * `inference` is what the AI concluded from those facts. `recommendation` is the
 * suggested next step. `confidence` must never be presented as certainty.
 * `insufficientEvidence` is set instead of guessing when the underlying data is too thin.
 */
export interface ReasoningTrace {
  facts: string[];
  evidence: Evidence[];
  inference: string;
  recommendation: string;
  confidence: number; // 0-1
  insufficientEvidence?: boolean;
}

// ===== V1.2 — Project Memory & Decision Intelligence =====
// Additive to V1/V1.1. Nothing here replaces the deterministic engines — it's a thin
// historical layer (snapshotHistory) plus a few narrow interpretation types.

export type TrendDirection = "improving" | "stable" | "deteriorating";

export interface MetricDelta {
  label: string;
  before: number;
  after: number;
  delta: number;
  direction: TrendDirection;
}

export interface HealthTrend {
  hasHistory: boolean;
  overall: TrendDirection;
  deltas: MetricDelta[];
  gettingBetter: string[]; // deterministic fact strings, e.g. "Blocked items: 6 → 4 (-2)"
  gettingWorse: string[];
}

/** BUILD REQUEST V1.2 §5 — Claude's trend narration. Never invents historical facts;
 *  set insufficientHistory instead of guessing when there's nothing to compare against. */
export interface TrendInterpretation {
  whatChanged: string;
  whyItMatters: string;
  likelyImpact: string;
  recommendedResponse: string;
  confidence: number;
  insufficientHistory?: boolean;
}

/** BUILD REQUEST V1.2 §8 — deterministic preconditions for a possible decision conflict. */
export interface DecisionConflictCandidate {
  decision: Decision;
  reasons: string[]; // objective facts only, e.g. "2 blockers on related items"
  evidence: Evidence[];
}

/** Claude's narration of a conflict candidate — calibrated language only ("potential
 *  conflict" / "may need review"), never a flat assertion that a decision is invalid. */
export interface DecisionConflictAssessment {
  assessment: string;
  confidence: number;
  insufficientEvidence?: boolean;
}

/** BUILD REQUEST V1.2 §11 — a fully deterministic recurring-pattern finding. */
export interface RecurringPattern {
  id: string;
  kind: "risk" | "dependency-team" | "overdue-trend" | "scope-change";
  title: string;
  occurrences: number;
  evidence: Evidence[];
  confidence: number;
}

/** BUILD REQUEST V1.2 §10 — deterministic facts fed to analyzeActionOutcomes(). */
export interface FollowUpContext {
  yesterdayRecommendation: string;
  actionTaken: string;
  outcome: string;
  currentStateFacts: string[];
}

// ===== V1.3 — Live Project Intelligence (Jira as a data source) =====
// Jira is a SOURCE, normalized into the model above — nothing here duplicates WorkItem/
// Project. This section only adds the app-level concepts needed to manage that source:
// which one is active, sync bookkeeping, filters, release rollups, and the AI context
// builder's output shape.

export type DataSourceType = "demo" | "local-import" | "jira";

export type JiraErrorKind =
  | "not-configured"
  | "invalid-url"
  | "auth-failure"
  | "permission-failure"
  | "rate-limited"
  | "network-error"
  | "malformed-response"
  | "unknown";

/** V1.3 §35 — lightweight sync observability, not a heavy platform.
 *  V1.7 §8, §29 additions — durationMs/scopeChangesDetected/warnings are all optional so
 *  pre-V1.7 persisted state loads unchanged; `warnings` is populated only for real,
 *  specific conditions (e.g. result-set truncation), never a generic catch-all.
 *  V1.8 §17 additions — pages/changelogRequests/previousDataPreserved, same optionality
 *  guarantee for pre-V1.8 state. Raw Jira responses are never persisted here or anywhere. */
export interface JiraSyncState {
  lastSyncStartedAt?: string;
  lastSyncCompletedAt?: string;
  lastSyncStatus: "never" | "success" | "failed";
  lastSyncError?: string;
  lastSyncErrorKind?: JiraErrorKind;
  recordsFetched?: number;
  recordsCreated?: number;
  recordsUpdated?: number;
  recordsUnchanged?: number;
  durationMs?: number;
  scopeChangesDetected?: number;
  projectsDiscovered?: number;
  warnings?: string[];
  pages?: number;
  changelogRequests?: number;
  /** true only on a FAILED sync — confirms existing local data was left untouched (§16). */
  previousDataPreserved?: boolean;
}

/** V1.3 §9 — the compact global context filter. All fields undefined = "All". */
export interface GlobalFilters {
  clientId?: string;
  projectId?: string;
  fixVersion?: string;
  timeRangeDays?: 1 | 7 | 14 | 30;
}

export type Freshness = "fresh" | "aging" | "stale" | "unknown";

/** V1.3 §20 — deterministic release readiness. Thresholds live in release-health.ts,
 *  documented there; Claude may explain this but never override it (§20). */
export type ReleaseReadiness = "READY" | "AT_RISK" | "NOT_READY";

export interface ReleaseHealth {
  fixVersion: string;
  totalItems: number;
  completedItems: number;
  completionPct: number;
  blockedCount: number;
  overdueCount: number;
  unresolvedDependenciesCount: number;
  highPriorityIncompleteCount: number;
  avgUatCompletionPct?: number;
  deliveryConfidence: number;
  readiness: ReleaseReadiness;
  topRiskTitle?: string;
}

/** V1.3 §23 — the compact, token-conscious context handed to Claude. Never the raw Jira
 *  payload; never credentials. */
export interface AIContext {
  clientFilter?: string;
  projectFilter?: string;
  currentMetrics: SnapshotMetrics;
  previousMetrics?: SnapshotMetrics;
  topScores: { key: string; title: string; score: number; classification: Severity }[];
  topRisks: { title: string; level: RiskLevel; reason: string }[];
  meaningfulChanges: { entityLabel: string; field: string; before: string; after: string }[];
  activeDecisions: { title: string; status: DecisionStatus }[];
  recentActionOutcomes: { title: string; outcome: string }[];
  source: { type: DataSourceType; lastSyncedAt?: string; baseUrlHost?: string };
  // V1.4 §27-28 additions — small, optional, token-conscious (same capping as the fields
  // above). Absent rather than empty when there's nothing proactive to report.
  drift?: { level: string; score: number; trendQuality: string };
  topRiskEscalations?: { title: string; severity: string; trend: string; daysOpen: number }[];
  topDependencyRadar?: { description: string; team: string; heat: string }[];
  topAttentionItems?: { category: string; severity: string; what: string; why: string }[];
}

/** V1.3 §26 — one query, one grounded answer. Not a chat transcript. */
export interface QueryAnswer {
  answer: string;
  evidence: Evidence[];
  recommendedAction: string;
  confidence: number;
  insufficientEvidence?: boolean;
}

// ===== V1.4 — Proactive Delivery Intelligence =====
// Additive to V1/V1.1/V1.2/V1.3. Every concept below is computed by a deterministic
// engine (see delivery-drift.ts, risk-escalation.ts, dependency-radar.ts, decision-radar.ts,
// action-effectiveness.ts, stakeholder-radar.ts, release-drift.ts, client-attention-map.ts,
// attention-queue.ts, first-30-minutes.ts, memory-events.ts). Claude only narrates these
// facts (see ai/prompts/proactive-assessment.ts, ai/prompts/project-story.ts) — it never
// computes a level, score, or classification itself.

export type DriftLevel = "STABLE" | "WATCH" | "DRIFTING" | "SEVERE";
export type TrajectoryLevel = "ON_TRACK" | "WATCH" | "DRIFTING" | "CRITICAL" | "INSUFFICIENT_HISTORY";
export type TrendQuality = "insufficient" | "early-signal" | "moderate" | "strong";

export interface DriftFactor {
  name: string;
  contribution: number; // signed — positive worsens drift, negative improves it
  detail: string;
}

/** V1.4 §4 — deterministic delivery-drift score. Weighting documented in delivery-drift.ts. */
export interface DeliveryDrift {
  level: DriftLevel;
  score: number; // 0-100, higher = more drift
  factors: DriftFactor[];
  evidence: string[];
  trend: TrendDirection;
  confidence: number;
  trendQuality: TrendQuality;
  snapshotsUsed: number;
}

/** V1.4 §6-7 — multi-point trajectory classification over available snapshotHistory. */
export interface DeliveryTrajectory {
  level: TrajectoryLevel;
  trendQuality: TrendQuality;
  snapshotsUsed: number;
}

/** V1.4 §8-9 — risk escalation + aging, reconstructed from snapshotHistory. */
export interface RiskEscalation {
  riskId: string;
  riskTitle: string;
  currentSeverity: RiskLevel;
  previousSeverity?: RiskLevel;
  daysOpen: number;
  evidenceCount: number;
  trend: "worsening" | "stable" | "improving";
  escalationReason?: string;
  reopened: boolean;
}

export type DependencyHeat = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** V1.4 §10-11 — Dependency Radar + Dependency Heat. */
export interface DependencyRadarItem {
  dependencyId: string;
  description: string;
  dependsOnTeam: string;
  ownerId?: string;
  ageDays: number;
  blockedItemCount: number;
  blockedHighPriorityCount: number;
  releaseProximity?: { fixVersion: string; daysToRelease: number };
  linkedRiskLevel?: RiskLevel;
  heat: DependencyHeat;
  recommended: string;
  evidence: string[];
}

/** V1.4 §12-13 — Decision Radar. Wraps DecisionConflictCandidate with staleness.
 *  V1.5 §6-7 adds reviewUrgency/whyReview/confidence — richer signal, same never-touches-
 *  status guarantee. */
export interface DecisionRadarItem {
  decisionId: string;
  decision: Decision;
  reasons: string[];
  stalenessDays: number;
  newEvidenceCount: number;
  needsAttention: boolean;
  evidence: Evidence[];
  // V1.5 additions — items in this array always need at least REVIEW (NO_REVIEW_NEEDED
  // decisions are simply absent, same filtering convention as V1.4's needsAttention).
  reviewUrgency: "REVIEW" | "URGENT_REVIEW";
  whyReview: string[];
  confidence: number;
}

export type ActionEffectivenessClass = "EFFECTIVE" | "PARTIALLY_EFFECTIVE" | "INEFFECTIVE" | "UNKNOWN";

/** V1.4 §14-15 — Action Effectiveness / Action Loop Health. */
export interface ActionEffectivenessResult {
  actionId: string;
  actionTitle: string;
  classification: ActionEffectivenessClass;
  evidence: string[];
}

export type StakeholderRole = "OWNER" | "DECISION_MAKER" | "DEPENDENCY_OWNER" | "ACTION_OWNER";

/** V1.4 §16 — lightweight stakeholder intelligence, not a CRM. No inferred hierarchy. */
export interface StakeholderAttentionItem {
  ownerKey: string; // owner name, or "unassigned"
  ownerLabel: string;
  role: StakeholderRole;
  reason: string;
  relatedIds: string[];
}

export type CommunicationPriority = "URGENT" | "IMPORTANT" | "INFORM" | "NO_ACTION";

/** V1.4 §17 — deterministic WHO/WHY/WHAT/WHEN communication ranking. */
export interface CommunicationPriorityResult {
  communicationId: string;
  priority: CommunicationPriority;
  who: string;
  why: string;
  what: string;
  when: string;
}

export type AttentionCategory = "RISK" | "DRIFT" | "DEPENDENCY" | "DECISION" | "ACTION" | "COMMUNICATION";
export type AttentionSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
/** V1.4 §39, extended V1.5 §22 — attention lifecycle is deliberately separate from Jira
 *  issue status; it represents "does the user still need to pay attention?", not the
 *  underlying record's own status field. RE_ESCALATED (V1.5) fires only when a real new
 *  signal (severity increase) appears on an already-acknowledged/snoozed item — never
 *  simply because time passed (§23). */
export type AttentionLifecycle = "NEW" | "ACTIVE" | "ACKNOWLEDGED" | "SNOOZED" | "RESOLVED" | "REOPENED" | "RE_ESCALATED";

/** V1.5 §25 — points an attention item back at the real underlying record so a UI action
 *  (e.g. "What Should I Do?") can look the entity up again. `id` is the entity's own
 *  stable identifier (risk title, dependency id, decision id, action id, or fix version —
 *  never the volatile attention-item id itself). */
export interface AttentionSourceRef {
  type: "risk" | "dependency" | "decision" | "action" | "release" | "communication";
  id: string;
}

/** V1.4 §22-26 — one consolidated, deduplicated attention item. `id` is deterministic
 *  (`${category}:${entityId}`) so the same underlying problem never appears twice. */
export interface AttentionItem {
  id: string;
  category: AttentionCategory;
  severity: AttentionSeverity;
  what: string;
  why: string; // "WHY NOW?" — §25
  impact: string;
  nowWhat: string;
  evidence: string[];
  lifecycle: AttentionLifecycle;
  firstSeenDate: string;
  lastSeenDate: string;
  snoozedUntil?: string;
  // V1.5 additions — both optional/additive.
  sourceRef?: AttentionSourceRef;
  relatedDecisionId?: string; // §25 — "this is fundamentally a decision, not just a risk"
}

/** Persisted per attention item, keyed by AttentionItem.id — see store.ts StoreState.attentionState. */
export interface AttentionItemState {
  lifecycle: AttentionLifecycle;
  firstSeenDate: string;
  lastSeenDate: string;
  snoozedUntil?: string;
  acknowledgedAt?: string;
  // V1.5 §22-24 additions — both optional/additive. `lastSeverity` is the re-escalation
  // baseline: comparison only happens when a prior value is known, so pre-V1.5 persisted
  // state (no lastSeverity recorded) never re-escalates until it's observed once.
  lastSeverity?: AttentionSeverity;
  snoozedAt?: string;
  snoozeReason?: string;
}

/** V1.4 §34 — Release Drift, extends Release Health with a snapshot-over-snapshot delta. */
export interface ReleaseDrift {
  fixVersion: string;
  level: DriftLevel;
  completionDelta: number;
  blockedDelta: number;
  confidenceDelta: number;
  scopeDelta: number;
  drivers: string[];
}

/** V1.4 §35 — Client Attention Map. A prioritization view, not portfolio management. */
export interface ClientAttentionRow {
  clientId: string;
  clientName: string;
  deliveryConfidence: number;
  trend: TrendDirection;
  topRiskTitle?: string;
  openDecisionsCount: number;
  criticalDependenciesCount: number;
}

/** V1.4 §41-42 — a meaningful, human-readable Project Memory event. Not every recomputed
 *  UI value — only transitions worth remembering. */
export interface MemoryEvent {
  id: string;
  date: string;
  kind:
    | "drift-transition"
    | "risk-escalation"
    | "dependency-escalation"
    | "decision-review"
    | "action-outcome"
    | "reopened"
    | "release-drift"
    // V1.5 §44 — decision/action-loop events, emitted at the point of action (store.ts),
    // not reconstructed from snapshots (decisions/actions were never snapshotted).
    | "DECISION_MADE"
    | "ACTION_STARTED"
    | "ACTION_COMPLETED"
    | "ACTION_OUTCOME"
    | "DECISION_OUTCOME"
    | "LOOP_STALLED"
    | "LOOP_COMPLETED"
    | "RE_ESCALATED"
    // V1.6 §22 — Personal Delivery Memory. Only meaningful transitions, never every click.
    | "FOCUS_STARTED"
    | "FOCUS_COMPLETED"
    | "FOCUS_BLOCKED"
    | "FOCUS_SKIPPED"
    | "DAILY_PLAN_CREATED"
    | "DAILY_PLAN_UPDATED"
    | "DAILY_FOCUS_REVIEWED";
  title: string;
  impact: string;
  evidence: string[];
}

/** V1.4 §32-33 — a single labeled Jira changelog field change. Never used to infer actual
 *  business scope — always surfaced as "Scope-related Jira change detected." */
export interface ScopeSignal {
  workItemId: string;
  field: string;
  before: string;
  after: string;
  detectedAt: string;
}

/** V1.4 §27 — the general shape for every proactive AI narration (drift, risk aging,
 *  dependency radar). ASSESSMENT / IMPACT / RECOMMENDATION / CONFIDENCE, never a bare fact. */
export interface ProactiveAssessment {
  assessment: string;
  impact: string;
  recommendation: string;
  confidence: number;
  insufficientEvidence?: boolean;
}

/** V1.4 §43 — the AI-narrated Project Story. Every sentence must trace to evidence;
 *  insufficientHistory is set rather than inventing a narrative arc. */
export interface ProjectStoryResult {
  narrative: string;
  confidence: number;
  insufficientHistory?: boolean;
}

// ===== V1.5 — Decision & Action Intelligence =====
// Additive to V1-V1.4. The central closed loop: OBSERVE -> DETECT -> UNDERSTAND -> DECIDE
// -> ACT -> MEASURE -> LEARN. Every engine here is deterministic (delivery-loops.ts,
// decision-effectiveness.ts, outcome-scorecard.ts); Claude only explains options and
// interprets outcomes (ai/prompts/decision-options.ts, ai/prompts/outcome-interpretation.ts)
// — it never selects an option, never marks a decision effective, never executes anything.

export type LoopHealth = "HEALTHY" | "AT_RISK" | "STALLED" | "COMPLETED" | "UNKNOWN";

/** V1.5 §26-29 — one visible Decision -> Action -> Outcome management loop. */
export interface DeliveryLoop {
  id: string;
  issue: string;
  decision?: { id?: string; title: string; status: DecisionStatus | "Under review" };
  action?: { id: string; title: string; status: ActionStatus };
  outcomeStatus?: DecisionEffectivenessClass | ActionEffectivenessClass;
  health: LoopHealth;
  why: string;
  nowWhat: string;
}

/** V1.5 §14-16 — deterministic decision-effectiveness classification. Every sentence in
 *  `observedChanges` uses causality-safe wording ("X changed after the decision was
 *  implemented"), never a causal claim ("the decision caused X") — §16. */
export interface DecisionEffectivenessResult {
  decisionId: string;
  classification: DecisionEffectivenessClass;
  observedChanges: string[];
  evidence: string[];
}

/** V1.5 §32-34 — pure arithmetic, no AI (§32). `didTodayHelp` and `controlEffectiveness`
 *  are observations, never causal claims (§33). Never used to rank people (§34). */
export interface OutcomeScorecard {
  risksDelta: number;
  blockersDelta: number;
  confidenceDelta: number;
  dependenciesDelta: number;
  actionsCompleted: number;
  actionsEffective: number;
  actionsIneffective: number;
  didTodayHelp: "YES" | "MIXED" | "NO" | "UNKNOWN";
  controlEffectiveness: string;
}

/** V1.5 §40 — AI Decision Schema: Claude proposes options, the human selects one. */
export interface DecisionOptionsResult {
  summary: string;
  options: DecisionOption[];
  recommendedOptionId?: string;
  tradeoffs: string;
  confidence: number;
  insufficientEvidence?: boolean;
}

/** V1.5 §41 — AI Outcome Schema. Explicitly prohibited from causal claims (§16, §42). */
export interface OutcomeInterpretation {
  summary: string;
  observedChanges: string[];
  limitations: string;
  assessment: string;
  recommendation: string;
  confidence: number;
}

// ===== V1.6 — Personal Delivery Copilot =====
// Additive to V1-V1.5. Turns project intelligence into a focused personal agenda without
// creating a second task/project-management system — every PersonalFocusCandidate/
// PersonalPlanItem below is a reference (sourceType + sourceId) back to an existing
// AttentionItem/DeliveryLoop/Decision/Action, never a copy. The ranking/categorization
// engine (personal-focus.ts) is fully deterministic (§59 — no per-item AI calls); the one
// AI capability (generateDailyGuidance) is on-demand and narrates already-computed facts.

export type FocusCategory = "DO_NOW" | "DO_TODAY" | "WATCH" | "DEFER" | "BLOCKED" | "DONE";

/** §6 — every ranking dimension is documented and can be explicitly unavailable (never a
 *  silently-assumed default). Weights are constants in personal-focus.ts, summing to 100. */
export interface PersonalFocusFactor {
  name: string;
  contribution: number;
  max: number;
  available: boolean;
  detail: string;
}

export type PersonalFocusSourceType = "attention" | "loop";

/** §5, §8, §27 — one ranked, evidence-backed candidate for personal focus. Never a copy of
 *  the underlying record — `sourceType`/`sourceId` always point back to the real
 *  AttentionItem or DeliveryLoop it was derived from. */
export interface PersonalFocusCandidate {
  id: string; // deterministic: `focus:${sourceType}:${sourceId}`
  sourceType: PersonalFocusSourceType;
  sourceId: string;
  title: string;
  projectId?: string;
  projectName?: string;
  why: string; // WHY NOW
  nowWhat: string; // YOUR NEXT MOVE
  evidence: string[];
  category: FocusCategory;
  score: number;
  factors: PersonalFocusFactor[];
  estimatedMinutes: number; // §10 — always a documented heuristic, never a measured fact
  ownershipExplicit: boolean;
  ownerLabel?: string;
  // V1.7 §15 — set when the candidate's underlying record(s) carry more than one distinct
  // explicit owner (e.g. a decision touching several work items with different owners).
  // An ambiguous item can never be ownershipExplicit, regardless of whether one of the
  // disagreeing owners happens to match the configured identity (§13 — no guessing).
  ownerAmbiguous?: boolean;
  whyOnMyList: string; // §27
  severity: AttentionSeverity;
  // V1.7 §20 — resolved only from an explicit field (WorkItem.dueDate / Decision.reviewDate);
  // never invented when absent (§20 "Do NOT invent due dates").
  dueDate?: string;
  // Reuse hooks (§19) — set when the candidate resolves to a real Action/Decision, so
  // Focus Session's [COMPLETE] can call the existing V1.5 flow instead of a new one.
  actionId?: string;
  decisionId?: string;
  attentionItemId?: string;
}

/** §29 — a workload observation, never an emotional/psychological inference. */
export interface FocusOverload {
  doNowCount: number;
  totalMinutes: number;
  reason: string;
  nowWhat: string;
}

/** §32 — descriptive only, never a productivity judgment. */
export interface ContextSwitchWarning {
  itemCount: number;
  projectCount: number;
  recommendation: string;
}

/** §31 — "Attention by project", descriptive only, never labeled "performance". */
export interface ProjectFocusShare {
  projectId: string;
  projectName: string;
  itemCount: number;
  pct: number;
}

export interface PersonalFocusResult {
  candidates: PersonalFocusCandidate[]; // all, sorted by score desc
  top3: PersonalFocusCandidate[];
  thirtyMinutePlan: PersonalFocusCandidate[];
  thirtyMinutePlanTotalMinutes: number;
  byCategory: Record<FocusCategory, PersonalFocusCandidate[]>;
  overload: FocusOverload | null;
  contextSwitch: ContextSwitchWarning | null;
  projectBalance: ProjectFocusShare[];
  // V1.7 §20 — null only means "no explicit-due-date items form a real conflict"; a
  // present-but-insufficientEvidence result distinguishes that from "not enough due-date
  // data to tell" (see deadline-conflict.ts).
  deadlineConflict: DeadlineConflict | null;
}

/** §18 — Focus Session's own ephemeral execution state. READY/CANCELLED are never
 *  persisted; the other four map 1:1 onto PersonalPlanItem.status transitions. */
export type FocusSessionState = "READY" | "IN_PROGRESS" | "BLOCKED" | "COMPLETED" | "SKIPPED" | "CANCELLED";

/** §13 — deliberately minimal: a reference plus planning metadata, never a copy of the
 *  source object. Existing project state (via sourceType+sourceId) remains the source of
 *  truth for everything else (title, evidence, severity, etc — re-derived at read time). */
export type PersonalPlanItemStatus = "planned" | "in-progress" | "completed" | "blocked" | "skipped" | "deferred";

/** V1.7 §18 — planning metadata only, never a task status. Purely descriptive of how the
 *  item entered the plan. */
export type PlanItemOrigin = "system-suggested" | "user-added" | "carried-forward";

/** V1.7 §22 — a minimal snapshot of the live candidate at the moment it was planned, kept
 *  only so reconciliation can detect a *meaningful* change (became urgent, became blocked,
 *  changed project, ownership changed) without re-deriving a guess. Still just metadata —
 *  never a copy of the underlying source object (§12). */
export interface PersonalPlanItemSnapshot {
  category: FocusCategory;
  projectId?: string;
  ownershipExplicit: boolean;
}

export interface PersonalPlanItem {
  id: string;
  sourceType: PersonalFocusSourceType;
  sourceId: string;
  priority: number; // rank at time of planning, for "Why this order?" (§35)
  position: number; // user-controlled order within plannedDate (§34 — human control wins)
  plannedDate: string; // ISO date
  status: PersonalPlanItemStatus;
  estimatedMinutes: number;
  addedAt: string; // ISO datetime
  completedAt?: string;
  note?: string;
  // V1.7 additions — all optional so pre-V1.7 persisted plan items remain valid (§41).
  origin?: PlanItemOrigin;
  pinned?: boolean; // §17 — a pinned item is never silently displaced or removed
  snapshot?: PersonalPlanItemSnapshot;
  // V2.0 §7 — captured when a Focus Session item is marked Blocked. Both optional/additive;
  // a blocked item with neither set (pre-V2.0 data, or a user who skipped the capture step)
  // remains valid — the UI just shows no reason rather than inventing one.
  blockedReason?: string;
  blockedNote?: string;
}

/** §50 — plan reconciliation verdict for one persisted PersonalPlanItem. */
export type PlanReconciliationAction = "KEEP" | "UPDATE" | "REMOVE" | "REVIEW";

export interface PlanReconciliationEntry {
  planItemId: string;
  action: PlanReconciliationAction;
  reason: string;
  // V1.7 §23 — a pinned item that would otherwise be REMOVEd instead reports REVIEW with
  // this flag set, so the UI can require an explicit [REMOVE]/[KEEP ANYWAY] choice rather
  // than folding it into a bulk "Clean Up" — a pinned item is never silently removed.
  pinnedNeedsReview?: boolean;
}

/** §51-52 — an unfinished plan item from a previous day that is still relevant today. */
export interface CarryForwardSuggestion {
  planItem: PersonalPlanItem;
  candidate: PersonalFocusCandidate;
  reason: string;
}

/** §23 — deterministic personal pattern detection. Evidence-first, descriptive only —
 *  never a trait/performance judgment (e.g. "3 high-priority items were deferred this
 *  week", never "you are bad at prioritization"). */
export type PersonalPatternKind = "repeatedly-skipped" | "repeatedly-blocked" | "repeatedly-deferred-decisions" | "project-concentration" | "important-items-deferred";

export interface PersonalPattern {
  id: string;
  kind: PersonalPatternKind;
  title: string;
  occurrences: number;
  evidence: string[];
}

/** §46-49 — "My Delivery Review". Every number here is arithmetic over PersonalPlanItem
 *  history + existing V1.4/V1.5 outcome classifications — never a productivity score (§46). */
export interface PersonalDeliveryReviewFacts {
  windowDays: number;
  plannedCount: number;
  completedCount: number;
  blockedCount: number;
  skippedCount: number;
  deferredCount: number;
  projectsWorkedIn: string[];
  effectiveActionsCount: number;
  ineffectiveActionsCount: number;
  decisionsReviewedCount: number;
  patterns: PersonalPattern[];
  stillRelevantSkipped: { title: string; sourceType: PersonalFocusSourceType; sourceId: string }[];
  noLongerRelevantSkipped: string[];
}

/** §38-39 — AI Daily Guidance. Strict schema; narrates only what it's given (§40 AI safety). */
export interface DailyGuidanceResult {
  summary: string;
  topFocus: string[];
  watch: string[];
  recommendation: string;
  evidenceReferences: string[];
  confidence: number;
  insufficientEvidence?: boolean;
}

// ===== V1.7 — Real-World Delivery Copilot Hardening =====
// Additive to V1-V1.6. No new intelligence engine — every module here hardens an existing
// one (Jira conformance, ownership, plan reconciliation, AI trust) rather than computing a
// new kind of fact.

/** V1.7 §11 — a lightweight local identity, never an auth/account system. `id` is a stable
 *  locally-generated identifier (not a Jira accountId — nothing in the domain model stores
 *  one); ownership matching still compares against `displayName` exactly, same as V1.6's
 *  ownerName, just structured for future extension (§13). */
export interface PersonalIdentity {
  id: string;
  displayName: string;
  email?: string;
}

/** V1.7 §7 — SUPPORTED/PARTIALLY_SUPPORTED/UNSUPPORTED are properties of this app's Jira
 *  integration code, not of any one sync's data — computed once, not per-sync. UNKNOWN is
 *  reserved for a field this report doesn't yet classify. */
export type JiraFieldSupportLevel = "SUPPORTED" | "PARTIALLY_SUPPORTED" | "UNSUPPORTED" | "UNKNOWN";

export interface JiraFieldSupport {
  field: string;
  level: JiraFieldSupportLevel;
  detail: string;
}

/** V1.7 §4 — one conformance capability check, run against fixtures (or, when a live Jira
 *  is configured, the same code path against the real API — see jira/conformance.ts).
 *  V1.9 §5 — extended to a 5-way classification so a check can honestly report something
 *  short of a clean PASS/FAIL: PARTIAL (works, but coverage is incomplete — e.g. changelog
 *  enrichment only covering a prioritized subset), UNSUPPORTED (the environment genuinely
 *  doesn't provide the capability, not a defect), UNKNOWN (capability could not be
 *  established at all, e.g. a probe request itself was rejected). Never collapsed into
 *  PASS — §5 "Do not turn PARTIAL or UNKNOWN into PASS." NOT_RUN is kept for any check that
 *  legitimately never executes in a given mode (e.g. a live-only check during fixture mode). */
export type JiraConformanceStatus = "PASS" | "PARTIAL" | "UNSUPPORTED" | "FAIL" | "UNKNOWN" | "NOT_RUN";

export interface JiraConformanceCheck {
  capability: string;
  status: JiraConformanceStatus;
  detail: string;
}

/** V1.8 §5 — cursor-based (nextPageToken) vs classic (startAt) Jira search pagination.
 *  Capability cannot be known without asking the instance; UNKNOWN is a first-class,
 *  honestly-reported outcome, never silently assumed either way. */
export type JiraSearchCapability = "SUPPORTED" | "UNSUPPORTED" | "UNKNOWN";

export interface JiraCapabilityResult {
  capability: JiraSearchCapability;
  detail: string;
}

/** V1.8 §6 — the Jira Data Contract: per-sync, per-field classification of what the
 *  CURRENTLY FETCHED SAMPLE actually contains — distinct from JiraFieldSupport above,
 *  which describes the app's CODE capability regardless of any one sync's data.
 *  MISSING_IN_SAMPLE means "Jira can return this field, but none of the current sample
 *  populated it" — never converted into false completeness (§6). */
export type JiraDataContractLevel = "SUPPORTED" | "PARTIALLY_SUPPORTED" | "UNSUPPORTED" | "MISSING_IN_SAMPLE";

export interface JiraDataContractFieldResult {
  field: string;
  level: JiraDataContractLevel;
  detail: string;
}

export interface JiraDataContractReport {
  generatedAt: string;
  sampleSize: number;
  fields: JiraDataContractFieldResult[];
}

/** V1.9 §7 — Real Data Shape Discovery. Never changes a mapping decision itself — purely
 *  observational evidence about what a fetched sample's field VALUES actually look like. */
export type ShapeCategory = "EXPECTED" | "NEW_VARIATION" | "UNSUPPORTED" | "AMBIGUOUS" | "BUG";

export interface ShapeObservation {
  field: string;
  observedValue: string;
  occurrences: number;
  category: ShapeCategory;
  detail: string;
}

export interface ShapeDiscoveryReport {
  generatedAt: string;
  sampleSize: number;
  observations: ShapeObservation[];
}

/** V1.9 §8 — Mapping Drift Report. Per observed source value: current mapping and whether
 *  it hit an explicit rule (SUPPORTED) or the documented fallback default (UNKNOWN). */
export type MappingConfidence = "SUPPORTED" | "UNKNOWN";

export interface MappingDriftValue {
  observedValue: string;
  occurrences: number;
  mappedTo: string;
  confidence: MappingConfidence;
  reason?: string;
}

export interface MappingDriftFieldReport {
  field: "Priority" | "Status" | "Issue type";
  values: MappingDriftValue[];
}

export interface MappingDriftReport {
  generatedAt: string;
  sampleSize: number;
  fields: MappingDriftFieldReport[];
}

/** V1.7 §6 — the Jira Conformance Report. `source` distinguishes a fixture-driven run
 *  (always available, no credentials needed) from a live run (only possible when a real
 *  Jira is configured) — the UI must never present a fixture run as live validation.
 *  V1.8 §4 additions are all optional so a pre-V1.8 stored/cached report shape still
 *  loads unchanged; never a credential-bearing field among them (§4, §30). */
// V2.1 §7 — "live" is NEVER inferred merely because credentials/config were passed in; it
// requires an actual successful HTTP round-trip that proves a real Jira environment was
// reached. "live-failed" is the honest third state: credentials were configured and a live
// attempt was genuinely made, but the round-trip itself failed — this must never be
// reported as "fixtures" (fixtures were never used) nor as "live" (nothing was verified).
export type JiraConformanceSource = "fixtures" | "live" | "live-failed";

export interface JiraConformanceReport {
  source: JiraConformanceSource;
  // V2.1 §7 — explicit execution metadata, additive to `source`/`generatedAt`.
  mode: "FIXTURE" | "LIVE";
  startedAt: string;
  completedAt: string;
  generatedAt: string;
  checks: JiraConformanceCheck[];
  fieldSupport: JiraFieldSupport[];
  credentialSafety: string;
  modeLabel?: "FIXTURE MODE" | "LIVE JIRA MODE" | "LIVE ATTEMPT FAILED";
  liveAttemptFailed?: boolean;
  jiraHostname?: string;
  projectsDiscovered?: number;
  issuesFetched?: number;
  paginationBehavior?: string;
  changelogBehavior?: string;
  durationMs?: number;
  truncated?: boolean;
  cursorCapability?: JiraCapabilityResult;
  dataContract?: JiraDataContractReport;
  shapeDiscovery?: ShapeDiscoveryReport;
  mappingDrift?: MappingDriftReport;
}

/** V1.7 §20-21 — a deterministic observation, never a productivity judgment (§21). Only
 *  produced from explicit due dates/review dates — never invented (§20). */
export interface DeadlineConflict {
  windowHours: number;
  itemCount: number;
  totalEstimatedMinutes: number;
  availableBudgetMinutes: number;
  reason: string;
  nowWhat: string;
  insufficientEvidence?: boolean;
}

/** V1.7 §24-26 — deterministic, non-AI evaluation of an already-produced AI response. This
 *  is static analysis of text/shape, never a second model call (§24 "do not add more AI
 *  capabilities — evaluate existing ones"). */
export type AiEvaluationDimension =
  | "SCHEMA_VALIDITY"
  | "EVIDENCE_COVERAGE"
  | "CAUSAL_LANGUAGE"
  | "OWNERSHIP_INFERENCE"
  | "UNSUPPORTED_CLAIMS"
  | "CONFIDENCE_CONSISTENCY"
  | "INSUFFICIENT_EVIDENCE_HANDLING";

/** V1.8 §10-11 — a real quality gate, not just pass/fail: OVERCONFIDENT_OUTPUT and similar
 *  borderline conditions warrant a WARN rather than forcing a binary choice between "fine"
 *  and "reject". `pass` is kept for backward compatibility (`pass = severity !== "FAIL"`). */
export type AiEvaluationSeverity = "PASS" | "WARN" | "FAIL";

export interface AiEvaluationFinding {
  dimension: AiEvaluationDimension;
  pass: boolean;
  severity: AiEvaluationSeverity;
  detail: string;
  evidence?: string;
}

export interface AiEvaluationResult {
  task: string;
  findings: AiEvaluationFinding[];
  passCount: number;
  warnCount: number;
  failCount: number;
}

/** V1.8 §13 — AI fallback transparency tri-state. Distinct from `mode` (which only says
 *  which provider produced THIS result): REAL_CLAUDE and MOCK_FALLBACK both have
 *  ANTHROPIC_API_KEY configured, but MOCK_FALLBACK means this specific call still fell back
 *  (network/schema/malformed-output failure); CLAUDE_UNAVAILABLE means no key is configured
 *  at all, so every call in this session is expected to be Mock. The UI must never make
 *  Mock output look like real Claude output (§13).
 *
 *  V2.1 §6, §14 — CALL_FAILED and VALIDATION_FAILED split the two genuinely distinct
 *  failure reasons that used to be collapsed into MOCK_FALLBACK: CALL_FAILED means the
 *  request itself failed (network error, non-200, or the API reported an error) — Claude
 *  was never meaningfully consulted; VALIDATION_FAILED means a response WAS received but
 *  didn't pass schema validation. Never show "Claude error" when the real state is simply
 *  "not configured" (CLAUDE_UNAVAILABLE) — these five states must stay distinguishable. */
export type AiProviderState = "REAL_CLAUDE" | "MOCK_FALLBACK" | "CLAUDE_UNAVAILABLE" | "CALL_FAILED" | "VALIDATION_FAILED";

/** V1.7 §27 — one AI call's trace. Never persists the raw prompt/credentials — just enough
 *  to answer "did this call use Claude or Mock, and did its output pass validation?".
 *  V1.8 §13 — `providerState` is additive/optional so a pre-V1.8 trace entry shape is
 *  unaffected. */
export interface AiCallTrace {
  id: string;
  timestamp: string;
  task: string;
  mode: "mock" | "claude";
  schemaValid: boolean;
  fallbackUsed: boolean;
  evidenceReferenceCount: number;
  providerState?: AiProviderState;
}

/** V1.8 §7 — actionable data-health remediation. One entry per dimension that has
 *  something to remediate; a fully healthy dimension produces no entry. `affectedItemIds`
 *  always points at real WorkItem ids already in the domain model — never invented work. */
export interface DataHealthRemediationItem {
  dimension: string;
  what: string;
  whyItMatters: string;
  whatToDo: string;
  affectedItemIds: string[];
}

/** V1.7 §30-31 — Data Health. Explicit dimensions, never a single blended score (§31).
 *  V1.8 §7 — `remediation` is additive/optional so a pre-V1.8 caller/shape is unaffected. */
export interface DataHealth {
  freshness: Freshness;
  sourceType: DataSourceType;
  ownershipCoveragePct: number;
  dueDateCoveragePct: number;
  releaseCoveragePct: number;
  scopeHistoryCoverage: "full" | "partial" | "none";
  totalWorkItems: number;
  remediation?: DataHealthRemediationItem[];
}

// ===== V2.2 — Evidence -> Delivery Artifact (the COMMUNICATE layer) =====
// Additive to every prior version. An Artifact is a rendering/assembly of facts the
// deterministic engines already computed (see communicate.ts) plus, optionally, AI-drafted
// wording and user edits — never a new source of truth. §5 "never merge these silently":
// every section is a list of typed segments so CALCULATED/EVIDENCE/AI_DRAFT/USER_INPUT/
// UNKNOWN are always visually and structurally distinct, never fused into one blob.

export type ArtifactType = "STATUS_UPDATE" | "STAKEHOLDER_UPDATE" | "RELEASE_UPDATE" | "DECISION_BRIEF";

export type ArtifactSegmentKind = "CALCULATED" | "EVIDENCE" | "AI_DRAFT" | "USER_INPUT" | "UNKNOWN";

export interface ArtifactSegment {
  kind: ArtifactSegmentKind;
  text: string;
  evidenceIds?: string[]; // ids into ArtifactDraft.evidence — backs the Evidence Drawer (§14)
}

export interface ArtifactSection {
  heading: string;
  segments: ArtifactSegment[];
}

/** Points a saved artifact back at the live inputs it can be rebuilt from, for the §17
 *  staleness check. Only the cheap-to-rebuild-from-live-data source kinds are covered
 *  (rebuilding a Decision Brief would require a fresh AI call, which staleness detection
 *  must never trigger on its own) — anything else is simply reported as "not checkable"
 *  rather than faked (see communicate.ts rebuildDraftFromSourceRef). */
export type ArtifactSourceRef =
  | { type: "status" }
  | { type: "todays-update" }
  | { type: "attention"; itemId: string }
  | { type: "release"; fixVersion: string };

/** A freshly-assembled, not-yet-saved artifact. Pure output of communicate.ts — no AI call
 *  has necessarily happened yet (AI_DRAFT segments are absent until the user asks). */
export interface ArtifactDraft {
  type: ArtifactType;
  sourceContext: string; // e.g. "Control Tower", "Decision Radar: <title>", "Meeting Mode"
  sections: ArtifactSection[];
  evidence: Evidence[];
  evidenceVersion: string; // from ai/ai-cache.ts's makeEvidenceVersion — staleness basis (§17)
  sourceRef?: ArtifactSourceRef;
}

/** A saved artifact (§16 Artifact History). `editedText` is the user's own edited plain
 *  text once they've touched the textarea — first-class, never overwritten silently. */
export interface ArtifactRecord extends ArtifactDraft {
  id: string;
  createdAt: string; // ISO
  aiDraftText?: string;
  aiDraftMode?: "mock" | "claude";
  editedText?: string;
}

export const DATA_SCHEMA_VERSION = 5;
