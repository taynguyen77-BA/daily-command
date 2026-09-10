// Personal Focus Engine (V1.6 §5-10, §27, §29-32). Fully deterministic — never calls
// Claude (§59). Consumes the existing V1.4/V1.5 engines (ProactiveIntelligence) rather than
// recomputing anything; candidates are references to real AttentionItems/DeliveryLoops, not
// a second task system (§12).
//
// SCORING MODEL (§6, documented, weights sum to 100 at max contribution):
//   Severity/urgency (0-30) + Delivery impact (0-15) + Decision urgency (0-15)
//   + Staleness (0-10) + Dependency danger (0-10) + Action-failure signal (0-10)
//   + Explicit ownership (0-10)
// A factor that does not apply to a given candidate (e.g. "decision urgency" on a RISK
// item) is marked `available: false` with contribution 0 — never silently assumed (§6).
//
// CATEGORIES (§7, documented, checked in order): BLOCKED (an ACTION-category candidate
// whose underlying work item is currently blocked — cannot progress) > DO_NOW (score >= 50,
// severity CRITICAL/HIGH, AND explicitly owned by the configured identity — §28 ownership
// is never inferred, so a high-impact item you don't explicitly own can never be DO_NOW)
// > DO_TODAY (score >= 30, or score >= 50 without explicit ownership) > WATCH (score >= 10)
// > DEFER. DONE is never produced here — it only exists in the reconciled personal plan
// (personal-plan.ts), since a resolved/snoozed item is already excluded from the queues
// this engine reads.

import type {
  Action,
  AttentionItem,
  AttentionSeverity,
  CommandCenterData,
  ContextSwitchWarning,
  Decision,
  DeliveryLoop,
  FocusCategory,
  FocusOverload,
  MentionEvent,
  PersonalFocusCandidate,
  PersonalFocusFactor,
  PersonalFocusResult,
  PersonalFocusSourceType,
  ProjectFocusShare,
  Risk,
  WorkItem,
} from "./types";
import type { ProactiveIntelligence } from "./proactive";
import { daysBetween } from "./scoring";
import { projectName as lookupProjectName } from "./selectors";
import { detectDeadlineConflict } from "./deadline-conflict";
import { isPersonalWorkEligible, resolveWorkRelevance, type WorkRelevanceIndex } from "./jira/work-relevance";
import { classifyPersonalRelation, matchesIdentity, type PersonalRelationIdentity } from "./personal-relation";

const CATEGORY_ORDER: Record<FocusCategory, number> = { DO_NOW: 0, DO_TODAY: 1, WATCH: 2, BLOCKED: 3, DEFER: 4, DONE: 5 };

/** §10 — documented heuristic defaults. Never presented as a measured fact; every UI
 *  surface labels this "ESTIMATED FOCUS". */
const ESTIMATE_HEURISTICS: Record<string, number> = {
  "attention:DRIFT": 15,
  "attention:RISK": 10,
  "attention:DEPENDENCY": 10,
  "attention:DECISION": 15,
  "attention:ACTION": 20,
  "attention:COMMUNICATION": 5,
  "attention:MENTION": 5, // reading and responding to a comment is quick
  "attention:ASSIGNMENT": 15, // reviewing a newly assigned item and planning the work
  "loop:no-action": 15,
  "loop:outcome-pending": 5,
};

interface ResolvedEntity {
  projectId?: string;
  workItemIds: string[];
  actionId?: string;
  decisionId?: string;
  dueDate?: string; // V1.7 §20 — earliest explicit due/review date found, never invented
}

/** V2.13 §4 (bug fix) — exported so proactive.ts can resolve AttentionItem.ticketKey/
 *  ticketUrl from the exact same sourceRef -> WorkItem logic, rather than a second
 *  implementation of "what work item does this attention item point at".
 *
 *  `allRisks` (bug fix, additive/optional — defaults to `data.risks` so every pre-existing
 *  call not yet updated behaves exactly as before) fixes a real, confirmed gap: a RISK
 *  sourceRef's `id` is the risk's TITLE (see attention-queue.ts), looked up against a risk
 *  list — but `data.risks` (the raw, pre-derived CommandCenterData) only ever contains
 *  MANUALLY-logged risks. Every auto-detected risk (risk-detection.ts's deterministic engine
 *  — the overwhelming majority of risks in any real or demo dataset) exists only in
 *  `derived.risks` ("manual + auto-detected, deduped by title" — see selectors.ts), so the old
 *  unconditional `data.risks.find(...)` silently failed for every auto-detected risk: no
 *  related work item was ever resolved, which meant a RISK-category candidate/attention item
 *  could never get a ticket link (§4) AND could never be gated by the Work Relevance Policy
 *  (§1) — the underlying WorkItem was invisible to this function, gate-or-link included. */
export function resolveAttentionEntity(item: AttentionItem, data: CommandCenterData, allRisks: Risk[] = data.risks): ResolvedEntity {
  const ref = item.sourceRef;
  if (!ref) return { workItemIds: [] };

  if (ref.type === "decision") {
    const decision = data.decisions.find((d) => d.id === ref.id);
    const related = decision?.relatedWorkItemIds?.length ? data.workItems.filter((w) => decision.relatedWorkItemIds!.includes(w.id)) : [];
    return { projectId: decision?.projectId ?? related[0]?.projectId, workItemIds: related.map((w) => w.id), decisionId: decision?.id, dueDate: decision?.reviewDate };
  }
  if (ref.type === "risk") {
    const risk = allRisks.find((r) => r.title === ref.id);
    const related = risk ? data.workItems.filter((w) => risk.sourceWorkItemIds.includes(w.id)) : [];
    return { projectId: related[0]?.projectId, workItemIds: related.map((w) => w.id) };
  }
  if (ref.type === "dependency") {
    const dep = data.dependencies.find((d) => d.id === ref.id);
    const workItem = dep ? data.workItems.find((w) => w.id === dep.workItemId) : undefined;
    return { projectId: workItem?.projectId, workItemIds: workItem ? [workItem.id] : [] };
  }
  if (ref.type === "action") {
    const action = data.actions.find((a) => a.id === ref.id);
    const workItem = action?.relatedWorkItemId ? data.workItems.find((w) => w.id === action.relatedWorkItemId) : undefined;
    return { projectId: workItem?.projectId, workItemIds: workItem ? [workItem.id] : [], actionId: action?.id, dueDate: action?.dueDate };
  }
  if (ref.type === "release") {
    const items = data.workItems.filter((w) => w.fixVersion === ref.id);
    return { projectId: items[0]?.projectId, workItemIds: items.map((w) => w.id) };
  }
  if (ref.type === "workItem") {
    // V2.10 §2 — MENTION/ASSIGNMENT items point directly at the real WorkItem the
    // comment/reassignment happened on, so they still get real project/due-date context
    // through this same resolution path even though their ownership is decided elsewhere
    // (see candidateFromAttentionItem's ownershipExplicit override below).
    const workItem = data.workItems.find((w) => w.id === ref.id);
    return { projectId: workItem?.projectId, workItemIds: workItem ? [workItem.id] : [], dueDate: workItem?.dueDate };
  }
  return { workItemIds: [] };
}

/** V1.7 §13, §15 — deterministic owner resolution over EVERY related record (not just the
 *  first one, which silently dropped disagreement in V1.6). More than one distinct explicit
 *  owner across the related action/work items is OWNER UNCLEAR — never guessed at, and
 *  never treated as explicit even if one of the disagreeing owners happens to match the
 *  configured identity (§13 "not allowed: name similarity guessing... because it looks
 *  important").
 *
 *  V2.10 §1 — `ownerId` is resolved the same way, in parallel, from `WorkItem.ownerId`
 *  (Action has no accountId equivalent, so an action's own `owner` never contributes an id).
 *  Populated unconditionally; callers decide whether to trust the id-based or name-based
 *  resolution (see isExplicitOwner below). */
interface OwnerResolution {
  label?: string;
  ambiguous: boolean;
  ownerId?: string;
  ownerIdAmbiguous: boolean;
}

function resolveOwner(entity: ResolvedEntity, data: CommandCenterData): OwnerResolution {
  const owners = new Set<string>();
  const ownerIds = new Set<string>();
  if (entity.actionId) {
    const action = data.actions.find((a) => a.id === entity.actionId);
    if (action?.owner) owners.add(action.owner);
  }
  for (const wid of entity.workItemIds) {
    const workItem = data.workItems.find((w) => w.id === wid);
    if (workItem?.owner) owners.add(workItem.owner);
    if (workItem?.ownerId) ownerIds.add(workItem.ownerId);
  }
  const ownerId = ownerIds.size === 1 ? Array.from(ownerIds)[0] : undefined;
  const ownerIdAmbiguous = ownerIds.size > 1;
  if (owners.size === 0) return { label: undefined, ambiguous: false, ownerId, ownerIdAmbiguous };
  if (owners.size === 1) return { label: Array.from(owners)[0], ambiguous: false, ownerId, ownerIdAmbiguous };
  return { label: undefined, ambiguous: true, ownerId, ownerIdAmbiguous };
}

/** V2.10 §1 — a lightweight identity view every candidate builder matches against. `ownerId`
 *  is the configured PersonalIdentity's Jira accountId, when set. */
export interface IdentityRef {
  displayName?: string;
  ownerId?: string;
}

/** V2.10 §1 — prefers accountId matching (stable, unique, never edited) over displayName
 *  matching (editable, non-unique across a multi-org Jira instance) whenever the configured
 *  identity has an accountId. Falls back to the pre-V2.10 displayName comparison only when
 *  it doesn't — zero behavior change for installations that never set one.
 *  V2.14 §1 — the actual field comparison is `matchesIdentity` (personal-relation.ts), shared
 *  with `classifyPersonalRelation` rather than re-derived here; this function still owns the
 *  ambiguity gate (`ownerIdAmbiguous`/`ambiguous`), which is specific to resolving ownership
 *  across possibly-several related records and has no equivalent in the single-WorkItem
 *  PersonalRelation classification. */
function isExplicitOwner(resolution: OwnerResolution, identity: IdentityRef): boolean {
  const ambiguous = identity.ownerId ? resolution.ownerIdAmbiguous : resolution.ambiguous;
  return !ambiguous && matchesIdentity(resolution.ownerId, resolution.label, { accountId: identity.ownerId, displayName: identity.displayName });
}

/** V1.7 §20 — the nearest explicit due/review date among related records; undefined when
 *  none is recorded (never fabricated, §20). */
function resolveDueDate(entity: ResolvedEntity, data: CommandCenterData): string | undefined {
  const dates: string[] = [];
  if (entity.dueDate) dates.push(entity.dueDate);
  for (const wid of entity.workItemIds) {
    const due = data.workItems.find((w) => w.id === wid)?.dueDate;
    if (due) dates.push(due);
  }
  return dates.length > 0 ? dates.sort()[0] : undefined;
}

function whyOnMyList(ownerLabel: string | undefined, ownershipExplicit: boolean, ownerAmbiguous: boolean, hasDecision: boolean): string {
  // V2.10 §2 — MENTION/ASSIGNMENT candidates arrive with ownershipExplicit already true but
  // no resolved ownerLabel (there's no "owner" field to resolve — see resolveAttentionEntity's
  // "workItem" case); the original six categories can never reach this branch, since their
  // own ownershipExplicit computation requires a non-empty ownerLabel to begin with.
  if (ownershipExplicit) return ownerLabel ? `Explicitly owned by you (${ownerLabel}).` : "Explicitly yours — you were mentioned or newly assigned.";
  // V1.7 §14 — decision/action owner-match phrasing, distinct from a plain work-item owner.
  if (ownerAmbiguous) return "OWNER UNCLEAR — related items have more than one explicit owner, so this is not confidently assigned to anyone.";
  if (ownerLabel) return `Explicitly owned by ${ownerLabel}, not you.`;
  if (hasDecision) return "This decision requires your review — no explicit owner is recorded.";
  return "Relevant to your project, but ownership is not explicitly recorded.";
}

function buildFactors(params: {
  severity: AttentionSeverity;
  category: "DRIFT" | "RISK" | "DEPENDENCY" | "DECISION" | "ACTION" | "COMMUNICATION" | "LOOP" | "MENTION" | "ASSIGNMENT";
  reviewUrgency?: "REVIEW" | "URGENT_REVIEW";
  ageDays?: number;
  dependencyHeat?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  isIneffectiveAction?: boolean;
  ownerLabel?: string;
  ownerAmbiguous?: boolean;
  ownerName?: string;
  // V2.10 §1 — precomputed by isExplicitOwner() so this function never re-derives the
  // id-vs-displayName decision itself; it only renders the factor row.
  ownershipExplicit?: boolean;
}): PersonalFocusFactor[] {
  const severityContribution: Record<AttentionSeverity, number> = { CRITICAL: 30, HIGH: 20, MEDIUM: 10, LOW: 4, INFO: 0 };
  // Decisions and stalled loops carry as much delivery impact as drift/risk — a decision
  // review is exactly the kind of DO_NOW item the product's own north star leads with.
  // V2.10 §2 — a mention/new-assignment is exactly the kind of unambiguous personal signal
  // this scoring model already rewards most (comparable to DRIFT/DECISION), since ownership
  // is never in question for either (see ownershipExplicit's hardcoded true, above).
  const deliveryImpact: Record<string, number> = { DRIFT: 15, RISK: 12, DECISION: 15, LOOP: 12, DEPENDENCY: 10, ACTION: 6, COMMUNICATION: 3, MENTION: 12, ASSIGNMENT: 15 };

  const factors: PersonalFocusFactor[] = [
    { name: "Severity / urgency", contribution: severityContribution[params.severity], max: 30, available: true, detail: `Severity: ${params.severity}` },
    { name: "Delivery impact", contribution: deliveryImpact[params.category] ?? 0, max: 15, available: true, detail: `Category: ${params.category}` },
  ];

  if (params.reviewUrgency) {
    factors.push({
      name: "Decision urgency",
      contribution: params.reviewUrgency === "URGENT_REVIEW" ? 15 : 8,
      max: 15,
      available: true,
      detail: params.reviewUrgency === "URGENT_REVIEW" ? "Urgent review" : "Review recommended",
    });
  } else {
    factors.push({ name: "Decision urgency", contribution: 0, max: 15, available: false, detail: "Not a decision-review item" });
  }

  if (params.ageDays !== undefined) {
    factors.push({ name: "Staleness", contribution: Math.min(Math.max(params.ageDays, 0), 10), max: 10, available: true, detail: `Open ${params.ageDays} day(s)` });
  } else {
    factors.push({ name: "Staleness", contribution: 0, max: 10, available: false, detail: "No first-seen date available" });
  }

  if (params.dependencyHeat) {
    const heatScore: Record<string, number> = { CRITICAL: 10, HIGH: 6, MEDIUM: 3, LOW: 0 };
    factors.push({ name: "Dependency danger", contribution: heatScore[params.dependencyHeat] ?? 0, max: 10, available: true, detail: `Heat: ${params.dependencyHeat}` });
  } else {
    factors.push({ name: "Dependency danger", contribution: 0, max: 10, available: false, detail: "Not a dependency item" });
  }

  if (params.isIneffectiveAction !== undefined) {
    factors.push({ name: "Action-failure signal", contribution: params.isIneffectiveAction ? 10 : 0, max: 10, available: true, detail: params.isIneffectiveAction ? "A prior action did not resolve this" : "No prior ineffective action" });
  } else {
    factors.push({ name: "Action-failure signal", contribution: 0, max: 10, available: false, detail: "Not an action-effectiveness item" });
  }

  if (params.ownershipExplicit) {
    // V2.10 §2 — a MENTION/ASSIGNMENT candidate arrives with ownershipExplicit already true
    // and no resolved ownerLabel (there's no "owner" field involved — see
    // resolveAttentionEntity's "workItem" case); credit the full 10 points regardless.
    factors.push({ name: "Explicit ownership", contribution: 10, max: 10, available: true, detail: params.ownerLabel ? `Owned by you (${params.ownerLabel})` : "Explicitly yours" });
  } else if (params.ownerAmbiguous) {
    factors.push({ name: "Explicit ownership", contribution: 0, max: 10, available: true, detail: "OWNER UNCLEAR — related items disagree on owner" });
  } else if (!params.ownerName) {
    factors.push({ name: "Explicit ownership", contribution: 0, max: 10, available: false, detail: "Your identity is not set in Data & Settings" });
  } else if (!params.ownerLabel) {
    factors.push({ name: "Explicit ownership", contribution: 0, max: 10, available: false, detail: "No owner recorded on the underlying item" });
  } else {
    factors.push({ name: "Explicit ownership", contribution: 0, max: 10, available: true, detail: `Owned by ${params.ownerLabel}` });
  }

  return factors;
}

function estimateFor(sourceType: PersonalFocusSourceType, category: string, loopKind?: "no-action" | "outcome-pending"): number {
  if (sourceType === "loop") return ESTIMATE_HEURISTICS[`loop:${loopKind ?? "no-action"}`] ?? 15;
  return ESTIMATE_HEURISTICS[`attention:${category}`] ?? 10;
}

function candidateFromAttentionItem(
  item: AttentionItem,
  data: CommandCenterData,
  identity: IdentityRef,
  today: string,
  workRelevanceIndex: WorkRelevanceIndex | undefined,
  allRisks: Risk[] | undefined,
  relationIdentity: PersonalRelationIdentity,
  mentionedIssueKeys: ReadonlySet<string>,
  dailyCommandCompletedWorkItemIds?: ReadonlySet<string>
): PersonalFocusCandidate | null {
  const entity = resolveAttentionEntity(item, data, allRisks ?? data.risks);
  // V2.17 §1b — reverses V2.13 §1's "option 3b" for MENTION specifically: a mention always
  // surfaces regardless of the underlying ticket's Work Relevance classification, because a
  // mention is about a person waiting on a reply, not about the ticket's delivery state (same
  // reasoning as proactive.ts's Attention Queue gate above). ASSIGNMENT keeps the original
  // option-3b gating — that decision is V2.12 Task 1's territory, not touched here. A
  // COMPLETED/EXCLUDED ticket's mention is still excluded from My Day, just via a different
  // mechanism: attention-queue.ts auto-resolves it (RESOLVED lifecycle), and this file's own
  // `eligibleAttention` filter (see computePersonalFocus) already drops RESOLVED items before
  // they ever reach this function. The same forceResolved mechanism also covers a
  // Daily-Command-completed ticket's mention (see proactive.ts's completedOrExcludedWorkItemIds),
  // so MENTION never needs to consult `dailyCommandCompletedWorkItemIds` directly here either.
  const relevanceGate = item.category === "MENTION" ? "PASS" : evaluateWorkRelevanceGate(entity.workItemIds, data, workRelevanceIndex, dailyCommandCompletedWorkItemIds);
  if (relevanceGate === "EXCLUDE") return null;
  const resolution = resolveOwner(entity, data);
  const { label: ownerLabel } = resolution;
  // V2.10 §2 — MENTION/ASSIGNMENT items already carry a hardcoded, wired-directly
  // `ownershipExplicit: true` from attention-queue.ts (a mention/new-assignment IS an
  // explicit personal signal by construction — see that file's Task 2 comment) and never go
  // through the generic owner-resolution path the other six categories use.
  const ownershipExplicit = item.ownershipExplicit ?? isExplicitOwner(resolution, identity);
  // V2.10 §1 — once an accountId is configured, the id-based resolution is authoritative,
  // including for the "OWNER UNCLEAR" ambiguity signal shown in the factor breakdown.
  const ownerAmbiguous = item.ownershipExplicit !== undefined ? false : identity.ownerId ? resolution.ownerIdAmbiguous : resolution.ambiguous;
  const ageDays = Math.max(0, daysBetween(item.firstSeenDate, today));

  const factors = buildFactors({
    severity: item.severity,
    category: item.category,
    // attention-queue.ts sets a decision's AttentionItem severity to HIGH for URGENT_REVIEW
    // and MEDIUM for REVIEW (decision-radar.ts) — that mapping is the only reviewUrgency
    // signal available at this layer, so it's used directly rather than re-deriving it.
    reviewUrgency: item.category === "DECISION" ? (item.severity === "HIGH" ? "URGENT_REVIEW" : "REVIEW") : undefined,
    ageDays,
    dependencyHeat: item.category === "DEPENDENCY" ? severityToHeat(item.severity) : undefined,
    isIneffectiveAction: item.category === "ACTION" ? true : undefined,
    ownerLabel,
    ownerAmbiguous,
    ownerName: identity.displayName,
    ownershipExplicit,
  });
  const score = Math.round(factors.reduce((s, f) => s + f.contribution, 0));

  const projectId = entity.projectId;
  const projectNameResolved = projectId ? lookupProjectName(data, projectId) : undefined;

  const workItem = entity.workItemIds.length > 0 ? data.workItems.find((w) => w.id === entity.workItemIds[0]) : undefined;
  const isBlocked = item.category === "ACTION" && workItem?.blocked === true;
  const naturalCategory = isBlocked ? "BLOCKED" : classify(score, item.severity, ownershipExplicit);
  // V2.13 §4 (bug fix) — only exposed when exactly one work item is related; a decision or
  // risk touching several tickets never picks one arbitrarily and presents it as THE ticket.
  const singleWorkItem = entity.workItemIds.length === 1 ? workItem : undefined;
  // V2.14 §1 — intentionally independent of ownershipExplicit above (see this file's top
  // comment): classified directly from the primary related WorkItem's own ownerId/owner,
  // never from the ambiguity-aware resolution/hardcoded MENTION-ASSIGNMENT override used for
  // ownershipExplicit. Falls back to a relation-less stub (no ownerId/owner) when no work item
  // is related at all — classifyPersonalRelation still resolves that to a real, non-guessed
  // value (FOLLOWING when identity is configured, UNKNOWN when it isn't).
  const relation = classifyPersonalRelation(workItem ?? { id: item.id, ownerId: undefined, owner: undefined }, relationIdentity, mentionedIssueKeys, workItem?.key);

  return {
    id: `focus:attention:${item.id}`,
    sourceType: "attention",
    sourceId: item.id,
    title: item.what,
    projectId,
    projectName: projectNameResolved,
    why: item.why,
    nowWhat: item.nowWhat,
    evidence: item.evidence,
    category: applyRelevanceGate(relevanceGate, naturalCategory),
    score,
    factors,
    estimatedMinutes: estimateFor("attention", item.category),
    ownershipExplicit,
    ownerLabel,
    ownerAmbiguous,
    whyOnMyList: whyOnMyList(ownerLabel, ownershipExplicit, ownerAmbiguous, item.category === "DECISION"),
    severity: item.severity,
    dueDate: resolveDueDate(entity, data),
    actionId: entity.actionId,
    decisionId: entity.decisionId,
    attentionItemId: item.id,
    ticketKey: singleWorkItem?.key,
    ticketUrl: singleWorkItem?.sourceUrl,
    relation,
  };
}

/** V2.13 §1 — Work Relevance gate, applied to every candidate that resolves to a real work
 *  item — DRIFT/RISK/DEPENDENCY/DECISION/ACTION/COMMUNICATION, loop-sourced candidates, and
 *  (option 3b) MENTION/ASSIGNMENT alike: the underlying ticket's status decides whether it's
 *  live personal work, regardless of which kind of signal is pointing at it.
 *
 *  "PASS" — at least one related work item is ACTIONABLE (or the concept doesn't apply, e.g.
 *  demo/local-import), or there's nothing to gate on (no related work item at all, e.g. an
 *  overall drift or communication signal) — candidate proceeds exactly as before.
 *  "FORCE_WATCH" — every related item is specifically OBSERVE: per its own definition
 *  ("visible as context but not treated as personal work"), this must never reach
 *  DO_NOW/DO_TODAY, but per V2.5 §14 the underlying attention/risk signal is still legitimate
 *  — so it's demoted to WATCH rather than dropped.
 *  "EXCLUDE" — every related item is WAITING/COMPLETED/EXCLUDED/UNKNOWN (or a mix with
 *  OBSERVE but never ACTIONABLE): none of those represent live personal work, so no candidate
 *  is produced at all — matching action-plan.ts's full exclusion for the same statuses. */
type RelevanceGate = "PASS" | "FORCE_WATCH" | "EXCLUDE";

/** V2.19 — `dailyCommandCompletedWorkItemIds` is an additive/optional trailing parameter: a
 *  work item the user has explicitly marked completed IN DAILY COMMAND (a fact distinct from
 *  its Jira status — see types.ts's DailyCommandCompletion) is excluded from active personal
 *  work the same way a Jira-COMPLETED/EXCLUDED item already is. Checked independently of
 *  Work Relevance (not merged into `relevances` below) so it applies even when no
 *  workRelevanceIndex is configured at all, or when the item's Jira status is still
 *  ACTIONABLE — Daily Command Completion is a standalone suppression, not a reclassification
 *  of the ticket's Jira-derived relevance. */
function evaluateWorkRelevanceGate(
  workItemIds: string[],
  data: CommandCenterData,
  workRelevanceIndex: WorkRelevanceIndex | undefined,
  dailyCommandCompletedWorkItemIds?: ReadonlySet<string>
): RelevanceGate {
  if (dailyCommandCompletedWorkItemIds && workItemIds.length > 0 && workItemIds.every((id) => dailyCommandCompletedWorkItemIds.has(id))) return "EXCLUDE";
  if (!workRelevanceIndex || workItemIds.length === 0) return "PASS";
  const items = workItemIds.map((id) => data.workItems.find((w) => w.id === id)).filter((w): w is WorkItem => !!w);
  if (items.length === 0) return "PASS";
  const relevances = items.map((item) => resolveWorkRelevance(item, workRelevanceIndex));
  if (relevances.some((r) => isPersonalWorkEligible(r))) return "PASS";
  if (relevances.every((r) => r === "OBSERVE")) return "FORCE_WATCH";
  return "EXCLUDE";
}

/** Applies a resolved gate to an already-computed natural category — only ever downgrades
 *  (DO_NOW/DO_TODAY -> WATCH), never upgrades a category the scoring model chose on its own
 *  (e.g. a naturally DEFER item stays DEFER, it's not bumped up to WATCH). */
function applyRelevanceGate(gate: RelevanceGate, naturalCategory: FocusCategory): FocusCategory {
  if (gate === "FORCE_WATCH" && (naturalCategory === "DO_NOW" || naturalCategory === "DO_TODAY")) return "WATCH";
  return naturalCategory;
}

function severityToHeat(severity: AttentionSeverity): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  if (severity === "CRITICAL") return "CRITICAL";
  if (severity === "HIGH") return "HIGH";
  return "MEDIUM";
}

/** Loops are only turned into a second candidate when the underlying decision isn't
 *  already represented by a DECISION attention item (decisionRadar → attentionQueue), to
 *  avoid showing the same problem twice (§12). Radar-only synthetic loops (`radar-*` ids)
 *  are always already covered by a DECISION attention item, so they're skipped here. */
function candidateFromLoop(
  loop: DeliveryLoop,
  data: CommandCenterData,
  identity: IdentityRef,
  attentionDecisionIds: Set<string>,
  today: string,
  workRelevanceIndex: WorkRelevanceIndex | undefined,
  relationIdentity: PersonalRelationIdentity,
  mentionedIssueKeys: ReadonlySet<string>,
  dailyCommandCompletedWorkItemIds?: ReadonlySet<string>
): PersonalFocusCandidate | null {
  if (loop.id.startsWith("radar-")) return null;
  if (attentionDecisionIds.has(loop.id)) return null;
  if (loop.health !== "STALLED" && loop.health !== "AT_RISK") return null;

  const decision = data.decisions.find((d: Decision) => d.id === loop.id);
  const relatedActions = data.actions.filter((a: Action) => a.relatedDecisionId === loop.id || (decision?.relatedActionIds ?? []).includes(a.id));
  const primaryAction = relatedActions[0];
  const workItem = primaryAction?.relatedWorkItemId ? data.workItems.find((w) => w.id === primaryAction.relatedWorkItemId) : undefined;
  const projectId = decision?.projectId ?? workItem?.projectId;

  // V2.13 §1 — same Work Relevance gate as candidateFromAttentionItem above, applied to the
  // one work item (if any) this loop resolves to.
  const relevanceGate = evaluateWorkRelevanceGate(workItem ? [workItem.id] : [], data, workRelevanceIndex, dailyCommandCompletedWorkItemIds);
  if (relevanceGate === "EXCLUDE") return null;

  // V1.7 §15 — the action owner and the work item's owner can legitimately disagree (e.g.
  // an action assigned to someone other than the blocked item's usual owner); treat that
  // disagreement the same way resolveOwner() does for attention-sourced candidates.
  const loopOwners = new Set([primaryAction?.owner, workItem?.owner].filter((o): o is string => !!o));
  const nameAmbiguous = loopOwners.size > 1;
  const ownerLabel = nameAmbiguous ? undefined : Array.from(loopOwners)[0];
  // V2.10 §1 — only the linked work item can carry an accountId; a manually-created Action
  // has no accountId equivalent, matching the WorkItem-only scope of Task 1.
  const loopOwnerIdAmbiguous = false; // at most one work item is ever linked here
  const resolution: OwnerResolution = { label: ownerLabel, ambiguous: nameAmbiguous, ownerId: workItem?.ownerId, ownerIdAmbiguous: loopOwnerIdAmbiguous };
  const ownershipExplicit = isExplicitOwner(resolution, identity);
  const ownerAmbiguous = identity.ownerId ? loopOwnerIdAmbiguous : nameAmbiguous;
  const severity: AttentionSeverity = loop.health === "STALLED" ? "HIGH" : "MEDIUM";

  const factors = buildFactors({
    severity,
    category: "LOOP",
    reviewUrgency: loop.health === "STALLED" ? "URGENT_REVIEW" : "REVIEW",
    ownerLabel,
    ownerAmbiguous,
    ownerName: identity.displayName,
    ownershipExplicit,
  });
  const score = Math.round(factors.reduce((s, f) => s + f.contribution, 0));
  void today;
  // V2.14 §1 — same independent classification as candidateFromAttentionItem above, from the
  // loop's own resolved workItem (if any), never from ownershipExplicit.
  const relation = classifyPersonalRelation(workItem ?? { id: loop.id, ownerId: undefined, owner: undefined }, relationIdentity, mentionedIssueKeys, workItem?.key);

  return {
    id: `focus:loop:${loop.id}`,
    sourceType: "loop",
    sourceId: loop.id,
    title: loop.issue,
    projectId,
    projectName: projectId ? lookupProjectName(data, projectId) : undefined,
    why: loop.why,
    nowWhat: loop.nowWhat,
    evidence: [loop.why],
    category: applyRelevanceGate(relevanceGate, classify(score, severity, ownershipExplicit)),
    score,
    factors,
    estimatedMinutes: estimateFor("loop", "LOOP", loop.health === "AT_RISK" ? "outcome-pending" : "no-action"),
    ownershipExplicit,
    ownerLabel,
    ownerAmbiguous,
    whyOnMyList: whyOnMyList(ownerLabel, ownershipExplicit, ownerAmbiguous, true),
    severity,
    dueDate: decision?.reviewDate ?? workItem?.dueDate,
    decisionId: decision?.id,
    ticketKey: workItem?.key,
    ticketUrl: workItem?.sourceUrl,
    relation,
  };
}

function classify(score: number, severity: AttentionSeverity, ownershipExplicit: boolean): FocusCategory {
  // Severity alone contributes up to 30 of 100 and explicit ownership up to 10, so a
  // CRITICAL/HIGH item you explicitly own reaches DO_NOW's floor from those two factors
  // plus a modest delivery-impact/staleness contribution — never from ownership or
  // severity alone (§28 — ownership is a gate, not the whole score).
  const urgent = severity === "CRITICAL" || severity === "HIGH";
  if (score >= 50 && urgent && ownershipExplicit) return "DO_NOW";
  if (score >= 30) return "DO_TODAY";
  if (score >= 10) return "WATCH";
  return "DEFER";
}

/** Greedy fill, same shape as action-plan.ts buildPlan(): highest score first, skip
 *  anything that doesn't fit the remaining budget (§9 — a documented greedy strategy is
 *  explicitly acceptable, not a generic knapsack solve). */
function buildThirtyMinutePlan(candidates: PersonalFocusCandidate[], budgetMinutes: number): PersonalFocusCandidate[] {
  const eligible = candidates.filter((c) => c.category !== "BLOCKED" && c.category !== "DEFER" && c.category !== "DONE");
  const plan: PersonalFocusCandidate[] = [];
  let remaining = budgetMinutes;
  for (const c of eligible) {
    if (c.estimatedMinutes <= remaining) {
      plan.push(c);
      remaining -= c.estimatedMinutes;
    }
  }
  return plan;
}

function detectOverload(candidates: PersonalFocusCandidate[]): FocusOverload | null {
  const doNow = candidates.filter((c) => c.category === "DO_NOW");
  const totalMinutes = doNow.reduce((s, c) => s + c.estimatedMinutes, 0);
  const triggered = (doNow.length >= 2 && totalMinutes > 30) || doNow.length >= 5;
  if (!triggered) return null;
  return {
    doNowCount: doNow.length,
    totalMinutes,
    reason: `You have ${doNow.length} urgent item(s) requiring approximately ${totalMinutes} minute(s).`,
    nowWhat: "Choose the 2 highest-impact items first — the rest will still be here after.",
  };
}

function detectContextSwitch(candidates: PersonalFocusCandidate[]): ContextSwitchWarning | null {
  const actionable = candidates.filter((c) => c.category === "DO_NOW" || c.category === "DO_TODAY");
  const projectIds = new Set(actionable.map((c) => c.projectId).filter((id): id is string => !!id));
  if (projectIds.size < 4) return null;
  const byProject = new Map<string, number>();
  for (const c of actionable) {
    if (!c.projectId) continue;
    byProject.set(c.projectId, (byProject.get(c.projectId) ?? 0) + 1);
  }
  const top = Array.from(byProject.entries()).sort((a, b) => b[1] - a[1])[0];
  const topName = top ? actionable.find((c) => c.projectId === top[0])?.projectName : undefined;
  return {
    itemCount: actionable.length,
    projectCount: projectIds.size,
    recommendation: topName ? `Consider completing the ${top![1]} ${topName} item(s) first before switching projects.` : "Consider grouping items by project before switching context.",
  };
}

function buildProjectBalance(candidates: PersonalFocusCandidate[]): ProjectFocusShare[] {
  const relevant = candidates.filter((c) => c.category !== "DEFER" && c.category !== "DONE");
  const total = relevant.length;
  if (total === 0) return [];
  const byProject = new Map<string, { name: string; count: number }>();
  for (const c of relevant) {
    const key = c.projectId ?? "unknown";
    const name = c.projectName ?? "Other";
    const entry = byProject.get(key) ?? { name, count: 0 };
    entry.count += 1;
    byProject.set(key, entry);
  }
  return Array.from(byProject.entries())
    .map(([projectId, { name, count }]) => ({ projectId, projectName: name, itemCount: count, pct: Math.round((count / total) * 100) }))
    .sort((a, b) => b.itemCount - a.itemCount);
}

/** V2.0 §6 — "DON'T FORGET": important unresolved items that didn't make the Top 3.
 *  A pure selector over the already-computed candidate list, not a new scoring pass —
 *  DO_NOW/DO_TODAY candidates beyond the Top 3, highest score first, bounded to a short
 *  list so it stays a glance-able reminder rather than a second priority list. */
export function deriveDontForget(result: Pick<PersonalFocusResult, "candidates" | "top3">, limit = 5): PersonalFocusCandidate[] {
  const top3Ids = new Set(result.top3.map((c) => c.id));
  return result.candidates.filter((c) => !top3Ids.has(c.id) && (c.category === "DO_NOW" || c.category === "DO_TODAY")).slice(0, limit);
}

/** V2.10 §1 — `ownerId` is an additive, optional trailing parameter (the configured
 *  identity's Jira accountId, if any) so every pre-existing call site — none of which pass
 *  a 5th argument — keeps working unchanged; omitting it reproduces pre-V2.10 behavior
 *  exactly (displayName-only matching, per isExplicitOwner above).
 *  V2.13 §1 — `workRelevanceIndex` is likewise additive/optional: omitting it (or passing an
 *  empty index) reproduces the pre-V2.13 gate-less behavior exactly, matching how
 *  action-plan.ts already treats a missing index as a no-op.
 *  `allRisks` (bug fix, additive/optional — defaults to `data.risks`, see
 *  resolveAttentionEntity's own comment above) fixes RISK-category candidates being unable to
 *  resolve their underlying work item at all when the risk was auto-detected rather than
 *  manually logged — the overwhelming majority of risks in practice — which silently broke
 *  both the ticket link (§4) and the Work Relevance gate (§1) for that whole category.
 *  Pass `derived.risks` (selectors.ts's "manual + auto-detected, deduped" list); omitting it
 *  reproduces the pre-fix (manual-risks-only) behavior exactly.
 *  V2.14 §1 — `mentionEvents` is likewise additive/optional, threaded through only to build
 *  `mentionedIssueKeys` for PersonalRelation classification; omitting it just means no
 *  candidate can ever classify as MENTIONED/ASSIGNED_AND_MENTIONED (identical to how
 *  computeProactiveIntelligence already treats a missing `mentionEvents` as a no-op). */
export function computePersonalFocus(
  data: CommandCenterData,
  proactive: ProactiveIntelligence,
  ownerName: string | undefined,
  today: string,
  ownerId?: string,
  workRelevanceIndex?: WorkRelevanceIndex,
  allRisks?: Risk[],
  mentionEvents?: MentionEvent[],
  // V2.19 — additive/optional trailing parameter, same no-op-when-omitted contract as every
  // parameter above: WorkItem ids the user has explicitly marked completed IN DAILY COMMAND
  // (see types.ts's DailyCommandCompletion / store.ts's dailyCommandCompletions, keyed by
  // ticket key there and resolved to WorkItem ids by the caller). Omitting it reproduces
  // pre-V2.19 behavior exactly — nothing is ever excluded on this basis.
  dailyCommandCompletedWorkItemIds?: ReadonlySet<string>
): PersonalFocusResult {
  const identity: IdentityRef = { displayName: ownerName, ownerId };
  // V2.14 §1 — built once per render (never re-scanned per candidate), per Task 1.
  const relationIdentity: PersonalRelationIdentity = { displayName: ownerName, accountId: ownerId };
  const mentionedIssueKeys = new Set((mentionEvents ?? []).map((m) => m.issueKey));
  const eligibleAttention = proactive.attentionQueue.filter((i) => i.lifecycle !== "SNOOZED" && i.lifecycle !== "RESOLVED");
  const attentionDecisionIds = new Set(eligibleAttention.filter((i) => i.category === "DECISION" && i.sourceRef?.type === "decision").map((i) => i.sourceRef!.id));

  const fromAttention = eligibleAttention
    .map((item) => candidateFromAttentionItem(item, data, identity, today, workRelevanceIndex, allRisks, relationIdentity, mentionedIssueKeys, dailyCommandCompletedWorkItemIds))
    .filter((c): c is PersonalFocusCandidate => c !== null);
  const fromLoops = proactive.deliveryLoops
    .map((loop) => candidateFromLoop(loop, data, identity, attentionDecisionIds, today, workRelevanceIndex, relationIdentity, mentionedIssueKeys, dailyCommandCompletedWorkItemIds))
    .filter((c): c is PersonalFocusCandidate => c !== null);

  const candidates = [...fromAttention, ...fromLoops].sort((a, b) => b.score - a.score || CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]);

  const top3 = candidates.filter((c) => c.category !== "BLOCKED" && c.category !== "DEFER").slice(0, 3);
  const thirtyMinutePlan = buildThirtyMinutePlan(candidates, 30);
  const thirtyMinutePlanTotalMinutes = thirtyMinutePlan.reduce((s, c) => s + c.estimatedMinutes, 0);

  const byCategory: Record<FocusCategory, PersonalFocusCandidate[]> = { DO_NOW: [], DO_TODAY: [], WATCH: [], DEFER: [], BLOCKED: [], DONE: [] };
  for (const c of candidates) byCategory[c.category].push(c);

  return {
    candidates,
    top3,
    thirtyMinutePlan,
    thirtyMinutePlanTotalMinutes,
    byCategory,
    overload: detectOverload(candidates),
    contextSwitch: detectContextSwitch(candidates),
    deadlineConflict: detectDeadlineConflict(candidates, today),
    projectBalance: buildProjectBalance(candidates),
  };
}
