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
  PersonalFocusCandidate,
  PersonalFocusFactor,
  PersonalFocusResult,
  PersonalFocusSourceType,
  ProjectFocusShare,
} from "./types";
import type { ProactiveIntelligence } from "./proactive";
import { daysBetween } from "./scoring";
import { projectName as lookupProjectName } from "./selectors";
import { detectDeadlineConflict } from "./deadline-conflict";

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

function resolveAttentionEntity(item: AttentionItem, data: CommandCenterData): ResolvedEntity {
  const ref = item.sourceRef;
  if (!ref) return { workItemIds: [] };

  if (ref.type === "decision") {
    const decision = data.decisions.find((d) => d.id === ref.id);
    const related = decision?.relatedWorkItemIds?.length ? data.workItems.filter((w) => decision.relatedWorkItemIds!.includes(w.id)) : [];
    return { projectId: decision?.projectId ?? related[0]?.projectId, workItemIds: related.map((w) => w.id), decisionId: decision?.id, dueDate: decision?.reviewDate };
  }
  if (ref.type === "risk") {
    const risk = data.risks.find((r) => r.title === ref.id);
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
  return { workItemIds: [] };
}

/** V1.7 §13, §15 — deterministic owner resolution over EVERY related record (not just the
 *  first one, which silently dropped disagreement in V1.6). More than one distinct explicit
 *  owner across the related action/work items is OWNER UNCLEAR — never guessed at, and
 *  never treated as explicit even if one of the disagreeing owners happens to match the
 *  configured identity (§13 "not allowed: name similarity guessing... because it looks
 *  important"). */
interface OwnerResolution {
  label?: string;
  ambiguous: boolean;
}

function resolveOwner(entity: ResolvedEntity, data: CommandCenterData): OwnerResolution {
  const owners = new Set<string>();
  if (entity.actionId) {
    const action = data.actions.find((a) => a.id === entity.actionId);
    if (action?.owner) owners.add(action.owner);
  }
  for (const wid of entity.workItemIds) {
    const owner = data.workItems.find((w) => w.id === wid)?.owner;
    if (owner) owners.add(owner);
  }
  if (owners.size === 0) return { label: undefined, ambiguous: false };
  if (owners.size === 1) return { label: Array.from(owners)[0], ambiguous: false };
  return { label: undefined, ambiguous: true };
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
  if (ownershipExplicit) return `Explicitly owned by you (${ownerLabel}).`;
  // V1.7 §14 — decision/action owner-match phrasing, distinct from a plain work-item owner.
  if (ownerAmbiguous) return "OWNER UNCLEAR — related items have more than one explicit owner, so this is not confidently assigned to anyone.";
  if (ownerLabel) return `Explicitly owned by ${ownerLabel}, not you.`;
  if (hasDecision) return "This decision requires your review — no explicit owner is recorded.";
  return "Relevant to your project, but ownership is not explicitly recorded.";
}

function buildFactors(params: {
  severity: AttentionSeverity;
  category: "DRIFT" | "RISK" | "DEPENDENCY" | "DECISION" | "ACTION" | "COMMUNICATION" | "LOOP";
  reviewUrgency?: "REVIEW" | "URGENT_REVIEW";
  ageDays?: number;
  dependencyHeat?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  isIneffectiveAction?: boolean;
  ownerLabel?: string;
  ownerAmbiguous?: boolean;
  ownerName?: string;
}): PersonalFocusFactor[] {
  const severityContribution: Record<AttentionSeverity, number> = { CRITICAL: 30, HIGH: 20, MEDIUM: 10, LOW: 4, INFO: 0 };
  // Decisions and stalled loops carry as much delivery impact as drift/risk — a decision
  // review is exactly the kind of DO_NOW item the product's own north star leads with.
  const deliveryImpact: Record<string, number> = { DRIFT: 15, RISK: 12, DECISION: 15, LOOP: 12, DEPENDENCY: 10, ACTION: 6, COMMUNICATION: 3 };

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

  if (params.ownerAmbiguous) {
    factors.push({ name: "Explicit ownership", contribution: 0, max: 10, available: true, detail: "OWNER UNCLEAR — related items disagree on owner" });
  } else if (!params.ownerName) {
    factors.push({ name: "Explicit ownership", contribution: 0, max: 10, available: false, detail: "Your identity is not set in Data & Settings" });
  } else if (!params.ownerLabel) {
    factors.push({ name: "Explicit ownership", contribution: 0, max: 10, available: false, detail: "No owner recorded on the underlying item" });
  } else {
    const explicit = params.ownerLabel === params.ownerName;
    factors.push({ name: "Explicit ownership", contribution: explicit ? 10 : 0, max: 10, available: true, detail: explicit ? `Owned by you (${params.ownerLabel})` : `Owned by ${params.ownerLabel}` });
  }

  return factors;
}

function estimateFor(sourceType: PersonalFocusSourceType, category: string, loopKind?: "no-action" | "outcome-pending"): number {
  if (sourceType === "loop") return ESTIMATE_HEURISTICS[`loop:${loopKind ?? "no-action"}`] ?? 15;
  return ESTIMATE_HEURISTICS[`attention:${category}`] ?? 10;
}

function candidateFromAttentionItem(item: AttentionItem, data: CommandCenterData, ownerName: string | undefined, today: string): PersonalFocusCandidate {
  const entity = resolveAttentionEntity(item, data);
  const { label: ownerLabel, ambiguous: ownerAmbiguous } = resolveOwner(entity, data);
  const ownershipExplicit = !ownerAmbiguous && !!ownerName && !!ownerLabel && ownerLabel === ownerName;
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
    ownerName,
  });
  const score = Math.round(factors.reduce((s, f) => s + f.contribution, 0));

  const projectId = entity.projectId;
  const projectNameResolved = projectId ? lookupProjectName(data, projectId) : undefined;

  const workItem = entity.workItemIds.length > 0 ? data.workItems.find((w) => w.id === entity.workItemIds[0]) : undefined;
  const isBlocked = item.category === "ACTION" && workItem?.blocked === true;

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
    category: isBlocked ? "BLOCKED" : classify(score, item.severity, ownershipExplicit),
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
  };
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
function candidateFromLoop(loop: DeliveryLoop, data: CommandCenterData, ownerName: string | undefined, attentionDecisionIds: Set<string>, today: string): PersonalFocusCandidate | null {
  if (loop.id.startsWith("radar-")) return null;
  if (attentionDecisionIds.has(loop.id)) return null;
  if (loop.health !== "STALLED" && loop.health !== "AT_RISK") return null;

  const decision = data.decisions.find((d: Decision) => d.id === loop.id);
  const relatedActions = data.actions.filter((a: Action) => a.relatedDecisionId === loop.id || (decision?.relatedActionIds ?? []).includes(a.id));
  const primaryAction = relatedActions[0];
  const workItem = primaryAction?.relatedWorkItemId ? data.workItems.find((w) => w.id === primaryAction.relatedWorkItemId) : undefined;
  const projectId = decision?.projectId ?? workItem?.projectId;

  // V1.7 §15 — the action owner and the work item's owner can legitimately disagree (e.g.
  // an action assigned to someone other than the blocked item's usual owner); treat that
  // disagreement the same way resolveOwner() does for attention-sourced candidates.
  const loopOwners = new Set([primaryAction?.owner, workItem?.owner].filter((o): o is string => !!o));
  const ownerAmbiguous = loopOwners.size > 1;
  const ownerLabel = ownerAmbiguous ? undefined : Array.from(loopOwners)[0];
  const ownershipExplicit = !ownerAmbiguous && !!ownerName && !!ownerLabel && ownerLabel === ownerName;
  const severity: AttentionSeverity = loop.health === "STALLED" ? "HIGH" : "MEDIUM";

  const factors = buildFactors({ severity, category: "LOOP", reviewUrgency: loop.health === "STALLED" ? "URGENT_REVIEW" : "REVIEW", ownerLabel, ownerAmbiguous, ownerName });
  const score = Math.round(factors.reduce((s, f) => s + f.contribution, 0));
  void today;

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
    category: classify(score, severity, ownershipExplicit),
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

export function computePersonalFocus(data: CommandCenterData, proactive: ProactiveIntelligence, ownerName: string | undefined, today: string): PersonalFocusResult {
  const eligibleAttention = proactive.attentionQueue.filter((i) => i.lifecycle !== "SNOOZED" && i.lifecycle !== "RESOLVED");
  const attentionDecisionIds = new Set(eligibleAttention.filter((i) => i.category === "DECISION" && i.sourceRef?.type === "decision").map((i) => i.sourceRef!.id));

  const fromAttention = eligibleAttention.map((item) => candidateFromAttentionItem(item, data, ownerName, today));
  const fromLoops = proactive.deliveryLoops
    .map((loop) => candidateFromLoop(loop, data, ownerName, attentionDecisionIds, today))
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
