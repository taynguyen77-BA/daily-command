// Attention Queue (V1.4 §22-26, §38-40; V1.5 §22-25) — the consolidator. Merges every
// proactive engine's output into one deduplicated, evidence-backed, lifecycle-aware list.
// An item's identity is deterministic (`${category}:${slug}`) so the same underlying
// problem never appears twice even though multiple engines may point at it.
//
// PRIORITY ORDER (§21, documented): DRIFT > RISK > DEPENDENCY > DECISION > ACTION >
// COMMUNICATION, and within each category, severity CRITICAL > HIGH > MEDIUM > LOW > INFO.
//
// NOISE CONTROL (§38): a dependency below MEDIUM heat, or a risk that is neither HIGH
// severity nor worsening/reopened, never becomes an attention item at all.
//
// LIFECYCLE (§39-40, V1.5 §22-24): persisted separately from any Jira/business status. NEW
// on first sight, then ACTIVE; ACKNOWLEDGED items stay acknowledged until the user
// resolves/snoozes them (cooldown) UNLESS a real new signal appears — severity increasing
// while acknowledged or snoozed re-escalates to RE_ESCALATED (never simply because time
// passed, §23), which then behaves like REOPENED (one cycle, then back to ACTIVE). SNOOZED
// items are hidden until `snoozedUntil` passes. RESOLVED (whether the user clicked Resolve
// or the underlying evidence disappeared on its own) stays resolved — like ACKNOWLEDGED,
// only a real severity increase re-escalates it — UNLESS the evidence genuinely disappeared
// and later came back, in which case it's a true REOPENED, not just a still-ongoing
// condition the user already resolved.

import type {
  ActionEffectivenessResult,
  Action,
  AttentionCategory,
  AttentionItem,
  AttentionItemState,
  AttentionSeverity,
  AttentionSourceRef,
  CommunicationPriorityResult,
  DecisionRadarItem,
  DeliveryDrift,
  DependencyRadarItem,
  MentionEvent,
  ReleaseDrift,
  Risk,
  RiskEscalation,
  StakeholderAttentionItem,
  WorkItem,
} from "./types";
import type { NewAssignmentEvent } from "./assignment-detection";

export function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60);
}

// V2.10 §2 — MENTION/ASSIGNMENT are appended after COMMUNICATION, never inserted; the six
// pre-existing categories keep their exact original order values.
const CATEGORY_ORDER: Record<AttentionCategory, number> = { DRIFT: 0, RISK: 1, DEPENDENCY: 2, DECISION: 3, ACTION: 4, COMMUNICATION: 5, MENTION: 6, ASSIGNMENT: 7 };
const SEVERITY_ORDER: Record<AttentionSeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };

interface RawItem {
  id: string;
  category: AttentionCategory;
  severity: AttentionSeverity;
  what: string;
  why: string;
  impact: string;
  nowWhat: string;
  evidence: string[];
  sourceRef?: AttentionSourceRef;
  relatedDecisionId?: string;
  ownershipExplicit?: boolean;
  // V2.17 §1a point 5 — set only for a MENTION raw item whose underlying ticket has resolved
  // to COMPLETED/EXCLUDED. Forces the lifecycle transition below straight to RESOLVED (an old,
  // unacknowledged mention on a now-done ticket implies no more action) while still keeping
  // the item present in `raw`/`items` — deliberately NOT simply omitted from `raw`, since that
  // would make it vanish from the Attention Queue entirely, contradicting §1b's "a MENTION
  // always surfaces" bypass (proactive.ts's gate no longer excludes MENTION by ticket status;
  // this is the one narrower exception, and it acts via lifecycle, not via exclusion).
  forceResolved?: boolean;
}

export interface AttentionQueueInputs {
  drift: DeliveryDrift;
  releaseDrift: ReleaseDrift[];
  riskEscalations: RiskEscalation[];
  openRisks: Risk[];
  dependencyRadar: DependencyRadarItem[];
  decisionRadar: DecisionRadarItem[];
  ineffectiveActions: { result: ActionEffectivenessResult; action: Action }[];
  stakeholderAttention: StakeholderAttentionItem[];
  communicationPriority: CommunicationPriorityResult[];
  // V2.10 §2 — both optional/additive: every pre-existing caller/test that never passes
  // these two behaves exactly as before (empty arrays, no MENTION/ASSIGNMENT items ever
  // produced). `workItems` is needed only to resolve a real WorkItem for the sourceRef these
  // two categories point at (see buildRawItems below) — never used by any of the six
  // pre-existing categories.
  mentionEvents?: MentionEvent[];
  newAssignments?: NewAssignmentEvent[];
  workItems?: WorkItem[];
  // V2.17 §1a point 5 — workItem ids whose Work Relevance has resolved to COMPLETED or
  // EXCLUDED, so a still-open MENTION tied to one of them can auto-resolve (see RawItem.
  // forceResolved above). Optional/additive: omitting it (every pre-existing caller) never
  // force-resolves anything, matching pre-V2.17 behavior exactly. Deliberately NOT threaded
  // to ASSIGNMENT — see this task's own scope note, that's V2.12 Task 1's territory.
  completedOrExcludedWorkItemIds?: ReadonlySet<string>;
}

/** V1.5 §25 — if a RISK/DEPENDENCY item's underlying work items are also related to a
 *  decision needing review, surface that link so the UI can show "Decision needed"
 *  alongside the plain category badge and let the user navigate Attention -> Decision. */
function findRelatedDecisionId(decisionRadar: DecisionRadarItem[], relatedWorkItemIds: string[]): string | undefined {
  if (relatedWorkItemIds.length === 0) return undefined;
  const ids = new Set(relatedWorkItemIds);
  return decisionRadar.find((d) => (d.decision.relatedWorkItemIds ?? []).some((id) => ids.has(id)))?.decisionId;
}

function buildRawItems(inputs: AttentionQueueInputs): RawItem[] {
  const out: RawItem[] = [];

  if (inputs.drift.level === "DRIFTING" || inputs.drift.level === "SEVERE") {
    const topFactor = inputs.drift.factors[0];
    out.push({
      id: `DRIFT:overall`,
      category: "DRIFT",
      severity: inputs.drift.level === "SEVERE" ? "CRITICAL" : "HIGH",
      what: `Delivery drift is ${inputs.drift.level}`,
      why: topFactor ? `Because ${topFactor.detail.toLowerCase()}.` : "Because multiple delivery signals worsened since the previous snapshot.",
      impact: `Drift score ${inputs.drift.score}/100 (${inputs.drift.trendQuality} trend, ${inputs.drift.snapshotsUsed} snapshot(s)).`,
      nowWhat: "Review the drift drivers and confirm whether mitigation is needed today.",
      evidence: inputs.drift.evidence,
    });
  }

  for (const r of inputs.releaseDrift) {
    if (r.level !== "DRIFTING" && r.level !== "SEVERE") continue;
    out.push({
      id: `DRIFT:release-${slug(r.fixVersion)}`,
      category: "DRIFT",
      severity: r.level === "SEVERE" ? "CRITICAL" : "HIGH",
      what: `Release ${r.fixVersion} is drifting`,
      why: r.drivers[0] ? `Because ${r.drivers[0]}.` : "Because release health worsened since the previous snapshot.",
      impact: `Completion Δ${r.completionDelta}%, confidence Δ${r.confidenceDelta}.`,
      nowWhat: "Confirm release readiness with the release owner.",
      evidence: r.drivers,
      sourceRef: { type: "release", id: r.fixVersion },
    });
  }

  const riskByTitle = new Map(inputs.openRisks.map((r) => [r.title, r]));
  for (const esc of inputs.riskEscalations) {
    const isSignificant = esc.currentSeverity === "HIGH" || esc.trend === "worsening" || esc.reopened;
    if (!isSignificant) continue;
    const risk = riskByTitle.get(esc.riskTitle);
    const severity: AttentionSeverity = esc.reopened || (esc.currentSeverity === "HIGH" && esc.daysOpen >= 4) ? "CRITICAL" : esc.currentSeverity === "HIGH" ? "HIGH" : "MEDIUM";
    out.push({
      id: `RISK:${slug(esc.riskTitle)}`,
      category: "RISK",
      severity,
      what: esc.riskTitle,
      why: esc.escalationReason ?? `Because this risk remains open (${esc.daysOpen} day(s)).`,
      impact: risk?.potentialImpact ?? "Potential impact not available.",
      nowWhat: risk?.mitigation ?? "Review this risk and confirm mitigation.",
      evidence: [...(risk?.evidence ?? []), `Open ${esc.daysOpen} day(s), ${esc.evidenceCount} supporting item(s)`],
      sourceRef: { type: "risk", id: esc.riskTitle },
      relatedDecisionId: risk ? findRelatedDecisionId(inputs.decisionRadar, risk.sourceWorkItemIds) : undefined,
    });
  }

  for (const dep of inputs.dependencyRadar) {
    if (dep.heat === "LOW") continue;
    const severity: AttentionSeverity = dep.heat === "CRITICAL" ? "CRITICAL" : dep.heat === "HIGH" ? "HIGH" : "MEDIUM";
    out.push({
      id: `DEPENDENCY:${slug(dep.dependencyId)}`,
      category: "DEPENDENCY",
      severity,
      what: `Dependency on ${dep.dependsOnTeam}`,
      why: `Because ${dep.evidence[1] ?? `it has been unresolved for ${dep.ageDays} day(s)`}.`,
      impact: `Blocking ${dep.blockedItemCount} work item(s)${dep.blockedHighPriorityCount > 0 ? `, ${dep.blockedHighPriorityCount} high-priority` : ""}.`,
      nowWhat: dep.recommended,
      evidence: dep.evidence,
      sourceRef: { type: "dependency", id: dep.dependencyId },
    });
  }

  for (const item of inputs.decisionRadar) {
    const severity: AttentionSeverity = item.reviewUrgency === "URGENT_REVIEW" ? "HIGH" : "MEDIUM";
    out.push({
      id: `DECISION:${slug(item.decisionId)}`,
      category: "DECISION",
      severity,
      what: item.decision.title,
      why: item.whyReview.length > 0 ? `Because ${item.whyReview.join("; ")}.` : `Because it has not been revisited in ${item.stalenessDays} day(s) while related evidence accumulated.`,
      impact: "This decision may no longer reflect the current project state.",
      nowWhat: "Review this decision — REVIEW, KEEP DECISION, or MARK SUPERSEDED.",
      evidence: item.evidence.map((e) => e.content),
      sourceRef: { type: "decision", id: item.decisionId },
    });
  }

  for (const { result, action } of inputs.ineffectiveActions) {
    out.push({
      id: `ACTION:${slug(action.id)}`,
      category: "ACTION",
      severity: "MEDIUM",
      what: `Action did not resolve: ${action.title}`,
      why: "Because the related work item is still blocked after this action was completed.",
      impact: result.evidence[0] ?? "The underlying issue remains unresolved.",
      nowWhat: "Consider a different approach — repeating the same action hasn't worked.",
      evidence: result.evidence,
      sourceRef: { type: "action", id: action.id },
    });
  }

  for (const c of inputs.communicationPriority) {
    if (c.priority !== "URGENT" && c.priority !== "IMPORTANT") continue;
    out.push({
      id: `COMMUNICATION:${slug(c.communicationId)}`,
      category: "COMMUNICATION",
      severity: c.priority === "URGENT" ? "HIGH" : "MEDIUM",
      what: `Contact ${c.who}`,
      why: c.why,
      impact: c.what,
      nowWhat: `${c.what} — by ${c.when}.`,
      evidence: [`Priority: ${c.priority}`, `When: ${c.when}`],
      sourceRef: { type: "communication", id: c.communicationId },
    });
  }

  for (const s of inputs.stakeholderAttention) {
    out.push({
      id: `COMMUNICATION:stakeholder-${slug(s.ownerKey + "-" + s.reason)}`,
      category: "COMMUNICATION",
      severity: s.ownerKey === "unassigned" ? "HIGH" : "LOW",
      what: s.reason,
      why: `Because ${s.role.toLowerCase().replace("_", " ")} coverage is unclear.`,
      impact: `${s.relatedIds.length} related item(s) affected.`,
      nowWhat: s.ownerKey === "unassigned" ? "Assign an owner." : "Consider rebalancing ownership.",
      evidence: [s.reason],
    });
  }

  // V2.17 §1a — MENTION: one attention item per COMMENT, not per issue (see MentionEvent.
  // commentId's own comment for the full "why" — collapsing to one record per issue meant a
  // resolved mention could never truly stay resolved, and a genuinely new comment on an
  // already-handled issue silently overwrote the old one instead of surfacing as new). Each
  // comment now gets its own independent `${category}:${issueKey}:${commentId}` identity and
  // lifecycle. Display-layer grouping (folding several still-open comments on one ticket into
  // a single card) is a presentation concern handled by mention-grouping.ts, not here — the
  // underlying tracking stays comment-granular.
  const workItemByKey = new Map((inputs.workItems ?? []).map((w) => [w.key, w]));
  for (const m of inputs.mentionEvents ?? []) {
    const workItem = workItemByKey.get(m.issueKey);
    // V2.17 §1a point 5 — an old, unacknowledged mention on a ticket that has since resolved
    // to COMPLETED/EXCLUDED implies no more action; force it straight to RESOLVED (via the
    // lifecycle step below) rather than let it linger as if still open. Never applied to
    // ASSIGNMENT (see this task's own scope note below).
    const forceResolved = !!(workItem && inputs.completedOrExcludedWorkItemIds?.has(workItem.id));
    out.push({
      id: `MENTION:${slug(m.issueKey)}:${slug(m.commentId)}`,
      category: "MENTION",
      severity: "HIGH",
      what: `Mentioned in a comment on ${m.issueKey}`,
      why: m.commentAuthor ? `${m.commentAuthor} mentioned you in a comment.` : "You were mentioned in a comment.",
      impact: workItem?.title ?? m.issueKey,
      nowWhat: "Read the comment and respond if needed.",
      evidence: [m.commentAuthor ? `${m.commentAuthor}: "${m.excerpt}"` : `"${m.excerpt}"`],
      sourceRef: workItem ? { type: "workItem", id: workItem.id } : undefined,
      // §7 — a mention IS an explicit personal signal by construction (mentionEvents only
      // ever cover the configured identity's own accountId — see jira/mentions.ts). Wired
      // directly rather than through the generic owner-resolution path the other six
      // categories use (personal-focus.ts resolveOwner), which has no notion of "mentioned in
      // a comment" to resolve in the first place.
      ownershipExplicit: true,
      forceResolved,
    });
  }

  // V2.10 §2 — ASSIGNMENT: a genuinely NEW direct assignment to the configured identity,
  // detected by assignment-detection.ts as a snapshot-over-snapshot ownerId diff. Same
  // explicit-by-construction reasoning as MENTION above.
  for (const a of inputs.newAssignments ?? []) {
    out.push({
      id: `ASSIGNMENT:${slug(a.workItemId)}`,
      category: "ASSIGNMENT",
      severity: "HIGH",
      what: `Newly assigned: ${a.title}`,
      why: `${a.issueKey} was assigned to you since the last sync.`,
      impact: a.title,
      nowWhat: "Review this item and plan the work.",
      evidence: [`${a.issueKey} — assignee changed to you`],
      sourceRef: { type: "workItem", id: a.workItemId },
      ownershipExplicit: true,
    });
  }

  return out;
}

/** V1.5 §23 — re-escalate only when there is a real new signal (severity worsened since
 *  the last recorded baseline). A missing baseline (pre-V1.5 state, or an item that was
 *  never previously computed) never re-escalates — there's nothing to compare against. */
function severityWorsened(prev: AttentionSeverity | undefined, curr: AttentionSeverity): boolean {
  if (!prev) return false;
  return SEVERITY_ORDER[curr] < SEVERITY_ORDER[prev];
}

export function buildAttentionQueue(
  inputs: AttentionQueueInputs,
  attentionState: Record<string, AttentionItemState>,
  today: string
): { items: AttentionItem[]; nextAttentionState: Record<string, AttentionItemState> } {
  const raw = buildRawItems(inputs);
  const nextAttentionState: Record<string, AttentionItemState> = { ...attentionState };
  const items: AttentionItem[] = [];

  for (const r of raw) {
    const prior = attentionState[r.id];
    let state: AttentionItemState;

    if (r.forceResolved) {
      // V2.17 §1a point 5 — idempotent terminal state, bypassing the normal NEW/ACTIVE/
      // ACKNOWLEDGED/re-escalation chain entirely: as long as the ticket stays COMPLETED/
      // EXCLUDED, this stays RESOLVED no matter how many syncs re-produce the raw item (never
      // flips to REOPENED just because `raw` still contains it — unlike the manually-resolved
      // path below, this isn't "the user asked to stop being bothered," it's "there is
      // structurally nothing left to do"). If the ticket's relevance later changes away from
      // COMPLETED/EXCLUDED, `forceResolved` stops being set and normal transition logic
      // resumes — a still-open mention on a since-un-completed ticket correctly reappears via
      // the ordinary "reappeared after RESOLVED" -> REOPENED path.
      state = prior?.lifecycle === "RESOLVED" ? { ...prior, lastSeenDate: today, lastSeverity: r.severity } : { lifecycle: "RESOLVED", firstSeenDate: prior?.firstSeenDate ?? today, lastSeenDate: today, lastSeverity: r.severity };
    } else if (!prior) {
      state = { lifecycle: "NEW", firstSeenDate: today, lastSeenDate: today, lastSeverity: r.severity };
    } else if (prior.lifecycle === "RESOLVED") {
      // `resolvedManually` (set only by the user's Resolve action, never by the
      // auto-resolve pass below) means the evidence never actually disappeared — the user
      // just asked to stop being bothered about it. Treat that like ACKNOWLEDGED (persist,
      // only a real severity increase re-escalates) so clicking Resolve isn't instantly
      // undone the moment the still-ongoing condition is recomputed. Without that flag, the
      // item got here only via genuine disappearance (see below), so reappearing in `raw`
      // now is a real REOPENED.
      state = prior.resolvedManually
        ? severityWorsened(prior.lastSeverity, r.severity)
          ? { lifecycle: "RE_ESCALATED", firstSeenDate: prior.firstSeenDate, lastSeenDate: today, lastSeverity: r.severity }
          : { ...prior, lastSeenDate: today, lastSeverity: r.severity }
        : { lifecycle: "REOPENED", firstSeenDate: prior.firstSeenDate, lastSeenDate: today, lastSeverity: r.severity };
    } else if (prior.lifecycle === "SNOOZED" && prior.snoozedUntil && prior.snoozedUntil > today) {
      state = { ...prior, lastSeenDate: today };
    } else if (prior.lifecycle === "SNOOZED") {
      // Snooze expired (§24) — return to ACTIVE unless severity increased while snoozed.
      state = severityWorsened(prior.lastSeverity, r.severity)
        ? { lifecycle: "RE_ESCALATED", firstSeenDate: prior.firstSeenDate, lastSeenDate: today, lastSeverity: r.severity }
        : { lifecycle: "ACTIVE", firstSeenDate: prior.firstSeenDate, lastSeenDate: today, lastSeverity: r.severity };
    } else if (prior.lifecycle === "NEW" || prior.lifecycle === "REOPENED" || prior.lifecycle === "RE_ESCALATED") {
      state = { lifecycle: "ACTIVE", firstSeenDate: prior.firstSeenDate, lastSeenDate: today, lastSeverity: r.severity };
    } else if (prior.lifecycle === "ACKNOWLEDGED") {
      // §22-23 — re-escalate only on a real severity increase, never on time alone.
      state = severityWorsened(prior.lastSeverity, r.severity)
        ? { lifecycle: "RE_ESCALATED", firstSeenDate: prior.firstSeenDate, lastSeenDate: today, lastSeverity: r.severity }
        : { ...prior, lastSeenDate: today, lastSeverity: r.severity };
    } else {
      // ACTIVE — steady-state.
      state = { ...prior, lastSeenDate: today, lastSeverity: r.severity };
    }

    nextAttentionState[r.id] = state;
    items.push({
      ...r,
      id: r.id,
      lifecycle: state.lifecycle,
      firstSeenDate: state.firstSeenDate,
      lastSeenDate: state.lastSeenDate,
      snoozedUntil: state.snoozedUntil,
    });
  }

  // Anything previously tracked but no longer produced by any engine has had its
  // underlying evidence disappear — auto-resolve it (unless still intentionally snoozed).
  const rawIds = new Set(raw.map((r) => r.id));
  for (const [id, prior] of Object.entries(attentionState)) {
    if (rawIds.has(id)) continue;
    if (prior.lifecycle === "SNOOZED" && prior.snoozedUntil && prior.snoozedUntil > today) continue;
    if (prior.lifecycle === "RESOLVED") continue;
    nextAttentionState[id] = { ...prior, lifecycle: "RESOLVED", lastSeenDate: prior.lastSeenDate };
  }

  items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]);

  return { items, nextAttentionState };
}
