// V2.2 — Evidence -> Delivery Artifact (the COMMUNICATE layer).
//
// Pure assembly functions only, same discipline as query-router.ts/why-should-i-care.ts:
// every function here takes data the deterministic engines already computed (Proactive
// Intelligence, Personal Focus, Release Health, Decision Options, Why Should I Care
// content) and *renders* it into typed CALCULATED/EVIDENCE/UNKNOWN segments. Nothing here
// invents a fact, infers ownership/causality, or calls an AI provider — AI_DRAFT segments
// are added separately (see ArtifactEditor.tsx / ai/prompts/communication-artifact.ts) and
// are always a clearly distinct segment, never merged into a CALCULATED/EVIDENCE one (§5).

import { makeEvidence } from "./evidence";
import { makeEvidenceVersion } from "./ai/ai-cache";
import type { ProactiveIntelligence } from "./proactive";
import type { DerivedData } from "./selectors";
import type {
  ArtifactDraft,
  ArtifactSection,
  ArtifactSegment,
  ArtifactSegmentKind,
  ArtifactSourceRef,
  ArtifactType,
  AttentionItem,
  CommandCenterData,
  Decision,
  DecisionOptionsResult,
  Evidence,
  PersonalFocusResult,
  ReleaseHealth,
} from "./types";
import type { WhyShouldICareContent } from "./why-should-i-care";
import { deriveDontForget } from "./personal-focus";
import { computeReleaseHealth } from "./release-health";

const NO_UNKNOWN_TEXT = "No owner/deadline is available in the source data.";

function seg(kind: ArtifactSegmentKind, text: string, evidenceIds?: string[]): ArtifactSegment {
  return { kind, text, evidenceIds };
}

function section(heading: string, segments: ArtifactSegment[]): ArtifactSection {
  return { heading, segments };
}

function withEvidence(pool: Evidence[], content: string, sourceType: "manual" = "manual"): { seg: ArtifactSegment; evidence: Evidence } {
  const e = makeEvidence(content, sourceType);
  pool.push(e);
  return { seg: seg("EVIDENCE", content, [e.id]), evidence: e };
}

function finalizeDraft(type: ArtifactType, sourceContext: string, sections: ArtifactSection[], evidence: Evidence[], sourceRef?: ArtifactSourceRef): ArtifactDraft {
  const facts = sections.flatMap((s) => s.segments.map((sg) => sg.text));
  return {
    type,
    sourceContext,
    sections,
    evidence,
    evidenceVersion: makeEvidenceVersion(facts, evidence),
    sourceRef,
  };
}

// ===== Copy Safety (§15) =====

export interface ArtifactTrustSummary {
  calculatedCount: number;
  evidenceCount: number;
  aiDraftCount: number;
  userInputCount: number;
  unknownCount: number;
}

export function summarizeArtifactTrust(sections: ArtifactSection[]): ArtifactTrustSummary {
  const summary: ArtifactTrustSummary = { calculatedCount: 0, evidenceCount: 0, aiDraftCount: 0, userInputCount: 0, unknownCount: 0 };
  for (const s of sections) {
    for (const sgm of s.segments) {
      if (sgm.kind === "CALCULATED") summary.calculatedCount++;
      else if (sgm.kind === "EVIDENCE") summary.evidenceCount++;
      else if (sgm.kind === "AI_DRAFT") summary.aiDraftCount++;
      else if (sgm.kind === "USER_INPUT") summary.userInputCount++;
      else if (sgm.kind === "UNKNOWN") summary.unknownCount++;
    }
  }
  return summary;
}

// ===== Staleness (§17) =====

export function isArtifactStale(storedEvidenceVersion: string, freshEvidenceVersion: string): boolean {
  return storedEvidenceVersion !== freshEvidenceVersion;
}

/** Rebuilds a fresh draft from a saved artifact's `sourceRef` for the §17 staleness check.
 *  Only covers the source kinds that can be rebuilt from already-loaded data without a new
 *  AI call (see the ArtifactSourceRef doc comment in types.ts). Returns null when the ref
 *  is missing/unsupported (Decision Brief, Why Should I Care) or the underlying item is no
 *  longer present (e.g. an attention item that has since been resolved) — callers must
 *  report "staleness check unavailable" rather than fabricate a comparison. */
export function rebuildDraftFromSourceRef(
  sourceRef: ArtifactSourceRef | undefined,
  sourceContext: string,
  data: CommandCenterData,
  derived: DerivedData,
  proactive: ProactiveIntelligence,
  personalFocus: PersonalFocusResult | null,
  today: string
): ArtifactDraft | null {
  if (!sourceRef) return null;
  switch (sourceRef.type) {
    case "status":
      return buildStatusUpdateDraft(data, derived, proactive, personalFocus, today, sourceContext);
    case "todays-update":
      return buildTodaysUpdateDraft(data, proactive, personalFocus, today);
    case "attention": {
      const item = proactive.attentionQueue.find((i) => i.id === sourceRef.itemId);
      if (!item) return null;
      return buildStakeholderUpdateDraft({ kind: "attention", item }, sourceContext);
    }
    case "release": {
      if (!data.workItems.some((w) => w.fixVersion === sourceRef.fixVersion)) return null;
      const release = computeReleaseHealth(data, sourceRef.fixVersion, today);
      return buildReleaseUpdateDraft(release, data, sourceContext);
    }
    default:
      return null;
  }
}

// ===== Plain-text rendering (textarea default content / copy target) =====

export function renderArtifactText(sections: ArtifactSection[], aiDraftText?: string): string {
  const body = sections
    .map((s) => `${s.heading.toUpperCase()}\n${s.segments.map((sgm) => sgm.text).join("\n") || "(none)"}`)
    .join("\n\n");
  return aiDraftText ? `${body}\n\nSUGGESTED WORDING (AI DRAFT)\n${aiDraftText}` : body;
}

// ===== §4.1 / §11 — Daily Status Update =====

function statusOverall(proactive: ProactiveIntelligence): { seg: ArtifactSegment; evidence: Evidence[] } {
  const evidence: Evidence[] = proactive.drift.evidence.map((e) => makeEvidence(e, "manual"));
  const text = `Trajectory: ${proactive.trajectory.level.replace(/_/g, " ")}. Drift: ${proactive.drift.level} (score ${proactive.drift.score}/100).`;
  return { seg: seg("CALCULATED", text, evidence.map((e) => e.id)), evidence };
}

function statusWhatChanged(derived: DerivedData, evidence: Evidence[]): ArtifactSegment[] {
  const changes = derived.changes.slice(0, 5);
  if (changes.length === 0) return [seg("CALCULATED", "No meaningful changes detected.")];
  return changes.map((c) => withEvidence(evidence, `${c.entityLabel}: ${c.field} changed from "${c.before}" to "${c.after}"`).seg);
}

function statusTopRisks(proactive: ProactiveIntelligence, evidence: Evidence[]): ArtifactSegment[] {
  const escalating = proactive.riskEscalations.filter((r) => r.trend === "worsening" || r.reopened).slice(0, 5);
  if (escalating.length === 0) return [seg("CALCULATED", "No risks are currently escalating.")];
  return escalating.map((r) => withEvidence(evidence, `${r.riskTitle}: ${r.currentSeverity}${r.previousSeverity ? ` (was ${r.previousSeverity})` : ""}, open ${r.daysOpen}d`).seg);
}

function statusDecisionsNeeded(proactive: ProactiveIntelligence, evidence: Evidence[]): ArtifactSegment[] {
  const decisions = proactive.decisionRadar.slice(0, 5);
  if (decisions.length === 0) return [seg("CALCULATED", "No decisions currently need review.")];
  return decisions.map((d) => withEvidence(evidence, `${d.decision.title} — ${d.reviewUrgency === "URGENT_REVIEW" ? "urgent review" : "review"}: ${d.whyReview[0] ?? `stale ${d.stalenessDays}d`}`).seg);
}

function statusActions(proactive: ProactiveIntelligence, personalFocus: PersonalFocusResult | null, evidence: Evidence[]): ArtifactSegment[] {
  const ineffective = proactive.actionEffectiveness.filter((r) => r.classification === "INEFFECTIVE").slice(0, 5);
  const inProgressCount = (personalFocus?.byCategory.DO_NOW.length ?? 0) + (personalFocus?.byCategory.DO_TODAY.length ?? 0);
  const out: ArtifactSegment[] = [];
  if (ineffective.length === 0) {
    out.push(seg("CALCULATED", "No ineffective actions detected."));
  } else {
    out.push(...ineffective.map((r) => withEvidence(evidence, `${r.actionTitle} — did not resolve the underlying issue.`).seg));
  }
  out.push(seg("CALCULATED", `${inProgressCount} action(s) currently planned for today.`));
  return out;
}

/** §4.1 canonical Daily Status Update — Overall/What changed/Top risks/Decisions needed/Actions/Next. */
export function buildStatusUpdateDraft(
  data: CommandCenterData,
  derived: DerivedData,
  proactive: ProactiveIntelligence,
  personalFocus: PersonalFocusResult | null,
  today: string,
  sourceContext = "Control Tower"
): ArtifactDraft {
  void data;
  void today;
  const evidence: Evidence[] = [];
  const overall = statusOverall(proactive);
  evidence.push(...overall.evidence);

  const next = personalFocus?.top3[0]?.nowWhat ?? proactive.first30Minutes[0]?.text ?? "No priority action currently identified.";

  const sections: ArtifactSection[] = [
    section("Overall", [overall.seg]),
    section("What changed", statusWhatChanged(derived, evidence)),
    section("Top risks", statusTopRisks(proactive, evidence)),
    section("Decisions needed", statusDecisionsNeeded(proactive, evidence)),
    section("Actions", statusActions(proactive, personalFocus, evidence)),
    section("Next", [seg("CALCULATED", next)]),
  ];
  return finalizeDraft("STATUS_UPDATE", sourceContext, sections, evidence, { type: "status" });
}

/** §11 "Create Today's Update" — same underlying facts as buildStatusUpdateDraft, laid out
 *  as TODAY/WATCH/DON'T FORGET/DECISIONS/ACTIONS/DELIVERY to match the Morning Brief it's
 *  triggered from. No new calculations — reuses personalFocus/proactive exactly as
 *  MorningBrief.tsx already does. */
export function buildTodaysUpdateDraft(
  data: CommandCenterData,
  proactive: ProactiveIntelligence,
  personalFocus: PersonalFocusResult | null,
  today: string
): ArtifactDraft {
  void data;
  void today;
  const evidence: Evidence[] = [];

  const top3 = personalFocus?.top3 ?? [];
  const todaySegs =
    top3.length > 0
      ? top3.map((c) => withEvidence(evidence, `${c.title}${c.projectName ? ` (${c.projectName})` : ""} — ${c.nowWhat}`).seg)
      : [seg("CALCULATED", "Nothing urgent — everything is within expected range.")];

  const watch = personalFocus?.byCategory.WATCH.slice(0, 5) ?? [];
  const watchSegs = watch.length > 0 ? watch.map((c) => seg("CALCULATED", `${c.title} — ${c.why}`)) : [seg("CALCULATED", "Nothing currently sitting on the watch list.")];

  const dontForget = personalFocus ? deriveDontForget(personalFocus) : [];
  const dontForgetSegs =
    dontForget.length > 0
      ? dontForget.map((c) => seg("CALCULATED", `${c.title}${c.projectName ? ` (${c.projectName})` : ""} — ${c.why}`))
      : [seg("CALCULATED", "Nothing important is being left behind today.")];

  const decisions = statusDecisionsNeeded(proactive, evidence);
  const actions = statusActions(proactive, personalFocus, evidence);
  const delivery = statusOverall(proactive);
  evidence.push(...delivery.evidence);

  const sections: ArtifactSection[] = [
    section("Today", todaySegs),
    section("Watch", watchSegs),
    section("Don't forget", dontForgetSegs),
    section("Decisions", decisions),
    section("Actions", actions),
    section("Delivery", [delivery.seg]),
  ];
  return finalizeDraft("STATUS_UPDATE", "Morning Brief", sections, evidence, { type: "todays-update" });
}

// ===== §4.2 — Stakeholder Update =====

export type StakeholderUpdateSource =
  | { kind: "attention"; item: AttentionItem }
  | { kind: "why-should-i-care"; content: WhyShouldICareContent; subjectTitle: string };

export function buildStakeholderUpdateDraft(source: StakeholderUpdateSource, sourceContext: string): ArtifactDraft {
  const evidence: Evidence[] = [];

  if (source.kind === "attention") {
    const { item } = source;
    const itemEvidence = item.evidence.map((e) => makeEvidence(e, "manual", item.id));
    evidence.push(...itemEvidence);
    const evidenceIds = itemEvidence.map((e) => e.id);
    const sections: ArtifactSection[] = [
      section("Subject", [seg("CALCULATED", item.what)]),
      section("Current situation", [seg("EVIDENCE", item.why, evidenceIds)]),
      section("Impact", [seg("EVIDENCE", item.impact, evidenceIds)]),
      section("What we need", [seg("CALCULATED", `A decision or response on: ${item.what}`)]),
      section("Next step", [seg("CALCULATED", item.nowWhat)]),
    ];
    return finalizeDraft("STAKEHOLDER_UPDATE", sourceContext, sections, evidence, { type: "attention", itemId: item.id });
  }

  const { content, subjectTitle } = source;
  evidence.push(...content.evidence);
  const evidenceIds = content.evidence.map((e) => e.id);
  const sections: ArtifactSection[] = [
    section("Subject", [seg("CALCULATED", subjectTitle)]),
    section(
      "Current situation",
      content.fact.length > 0 ? content.fact.map((f) => seg("CALCULATED", f, evidenceIds)).concat(seg("CALCULATED", content.signal)) : [seg("CALCULATED", content.signal)]
    ),
    section(
      "Impact",
      content.impact.insufficientEvidence
        ? [seg("CALCULATED", content.impact.unresolvedSignal), seg("UNKNOWN", "Insufficient evidence for a confident projection.")]
        : [seg("CALCULATED", content.impact.unresolvedSignal, evidenceIds)]
    ),
    section("What we need", [seg("CALCULATED", `A decision or response on: ${subjectTitle}`)]),
    section("Next step", [seg("CALCULATED", content.nextMove)]),
  ];
  if (content.unknown.length > 0) {
    sections.push(section("Unknown", content.unknown.map((u) => seg("UNKNOWN", u))));
  }
  return finalizeDraft("STAKEHOLDER_UPDATE", sourceContext, sections, evidence);
}

// ===== §4.3 — Release Update =====

export function buildReleaseUpdateDraft(release: ReleaseHealth, data: CommandCenterData, sourceContext = "Release Health"): ArtifactDraft {
  const evidence: Evidence[] = [];
  const releaseItemIds = new Set(data.workItems.filter((w) => w.fixVersion === release.fixVersion).map((w) => w.id));

  const openDeps = data.dependencies.filter((d) => d.status === "unresolved" && releaseItemIds.has(d.workItemId));
  const openDepsSegs =
    openDeps.length > 0
      ? openDeps.map((d) => withEvidence(evidence, `${d.description} (depends on ${d.dependsOnTeam})`).seg)
      : [seg("CALCULATED", "No open dependencies for this release.")];

  const decisions = data.decisions.filter(
    (d: Decision) => (d.relatedWorkItemIds ?? []).some((id) => releaseItemIds.has(id)) && !["SUPERSEDED", "EFFECTIVE", "INEFFECTIVE"].includes(d.status)
  );
  const decisionSegs = decisions.length > 0 ? decisions.map((d) => withEvidence(evidence, `${d.title} — ${d.status}`).seg) : [seg("CALCULATED", "No open decisions for this release.")];

  const blockerSegs: ArtifactSegment[] =
    release.blockedCount > 0
      ? [
          withEvidence(evidence, `${release.blockedCount} blocked item(s).`).seg,
          ...(release.topRiskTitle ? [withEvidence(evidence, release.topRiskTitle).seg] : []),
        ]
      : [seg("CALCULATED", "No blocking items detected.")];

  const sections: ArtifactSection[] = [
    section("Release", [seg("CALCULATED", release.fixVersion)]),
    section("Confidence", [seg("CALCULATED", `${release.deliveryConfidence}%`)]),
    section("Readiness", [seg("CALCULATED", release.readiness.replace(/_/g, " "))]),
    section("Key blockers", blockerSegs),
    section("Open dependencies", openDepsSegs),
    section("Decisions", decisionSegs),
    section("Next actions", [seg("CALCULATED", release.blockedCount > 0 ? "Resolve blocking items before continuing toward completion." : "Continue toward completion — no blocking items detected.")]),
  ];
  return finalizeDraft("RELEASE_UPDATE", sourceContext, sections, evidence, { type: "release", fixVersion: release.fixVersion });
}

// ===== §4.4 — Decision Brief =====

export function buildDecisionBriefDraft(item: AttentionItem, options: DecisionOptionsResult, sourceContext = "Decision Radar"): ArtifactDraft {
  const evidence: Evidence[] = item.evidence.map((e) => makeEvidence(e, "manual", item.id));
  const evidenceIds = evidence.map((e) => e.id);

  const optionSegs = options.options.map((o) =>
    seg("AI_DRAFT", `${o.id}. ${o.label} — ${o.rationale} (+ ${o.upside} / - ${o.downside})${o.id === options.recommendedOptionId ? " [AI-suggested]" : ""}`)
  );

  const sections: ArtifactSection[] = [
    section("Decision", [seg("CALCULATED", item.what)]),
    section("Why now", [seg("EVIDENCE", item.why, evidenceIds)]),
    section("Options", options.insufficientEvidence ? [seg("UNKNOWN", "Insufficient evidence to propose options.")] : optionSegs),
    section("Trade-offs", [seg("AI_DRAFT", options.tradeoffs)]),
    section("Evidence", item.evidence.map((e, i) => seg("EVIDENCE", e, [evidenceIds[i]]))),
    section("Recommended human decision", [seg("USER_INPUT", "(Not yet decided — record the human decision here.)")]),
  ];
  return finalizeDraft("DECISION_BRIEF", sourceContext, sections, evidence);
}

// ===== §13 — Needs From Others =====

export interface NeedsFromOthersRow {
  person: string;
  what: string;
  why: string;
  by: string;
  evidence: Evidence[];
  isUnknownPerson: boolean;
  isUnknownBy: boolean;
}

export function buildNeedsFromOthers(data: CommandCenterData, proactive: ProactiveIntelligence): NeedsFromOthersRow[] {
  void data;
  const rows: NeedsFromOthersRow[] = [];

  for (const c of proactive.communicationPriority.filter((c) => c.priority === "URGENT" || c.priority === "IMPORTANT")) {
    rows.push({
      person: c.who,
      what: c.what,
      why: c.why,
      by: c.when,
      evidence: [makeEvidence(`${c.who}: ${c.why}`, "manual")],
      isUnknownPerson: false,
      isUnknownBy: false,
    });
  }

  for (const s of proactive.stakeholderAttention.filter((s) => s.ownerKey === "unassigned")) {
    rows.push({
      person: "UNKNOWN",
      what: `Assign an owner (${s.role.replace(/_/g, " ").toLowerCase()}).`,
      why: s.reason,
      by: "UNKNOWN",
      evidence: [makeEvidence(s.reason, "manual")],
      isUnknownPerson: true,
      isUnknownBy: true,
    });
  }

  return rows;
}

export function renderNeedsFromOthersText(rows: NeedsFromOthersRow[]): string {
  if (rows.length === 0) return "NEEDS FROM OTHERS\n(none currently)";
  return rows
    .map((r) => `NEEDS FROM OTHERS\n\nPerson/Team: ${r.person}${r.isUnknownPerson ? ` — ${NO_UNKNOWN_TEXT}` : ""}\nWhat I need: ${r.what}\nWhy: ${r.why}\nBy when: ${r.by}${r.isUnknownBy && !r.isUnknownPerson ? ` — ${NO_UNKNOWN_TEXT}` : ""}`)
    .join("\n\n---\n\n");
}

// ===== §12 — Meeting Mode =====

export interface MeetingModeQuestion {
  question: string;
  items: string[];
  evidence: Evidence[];
}

export interface MeetingModeBrief {
  questions: MeetingModeQuestion[];
  needsFromOthers: NeedsFromOthersRow[];
  whatShouldISay: string;
}

export function buildMeetingModeBrief(data: CommandCenterData, derived: DerivedData, proactive: ProactiveIntelligence, today: string): MeetingModeBrief {
  void today;
  const evidence: Evidence[] = [];

  const changedItems = derived.changes.slice(0, 6).map((c) => `${c.entityLabel}: ${c.field} changed from "${c.before}" to "${c.after}"`);
  changedItems.forEach((c) => evidence.push(makeEvidence(c, "manual")));

  const atRisk = proactive.riskEscalations
    .filter((r) => r.trend === "worsening" || r.reopened)
    .map((r) => `${r.riskTitle}: ${r.currentSeverity}, open ${r.daysOpen}d`);
  atRisk.forEach((a) => evidence.push(makeEvidence(a, "manual")));

  const needsDecision = proactive.decisionRadar.map((d) => `${d.decision.title} — ${d.reviewUrgency === "URGENT_REVIEW" ? "urgent review" : "review"}`);
  needsDecision.forEach((d) => evidence.push(makeEvidence(d, "manual")));

  const blocked = data.workItems.filter((w) => w.blocked).map((w) => `${w.key} — ${w.title}${w.blockerReason ? ` (${w.blockerReason})` : ""}`);
  blocked.forEach((b) => evidence.push(makeEvidence(b, "manual")));

  const needsFromOthers = buildNeedsFromOthers(data, proactive);

  const questions: MeetingModeQuestion[] = [
    { question: "What changed?", items: changedItems.length > 0 ? changedItems : ["Nothing meaningful changed since the last snapshot."], evidence },
    { question: "What is at risk?", items: atRisk.length > 0 ? atRisk : ["Nothing is currently escalating."], evidence },
    { question: "What needs a decision?", items: needsDecision.length > 0 ? needsDecision : ["No decisions currently need review."], evidence },
    { question: "What is blocked?", items: blocked.length > 0 ? blocked : ["Nothing is currently blocked."], evidence },
    {
      question: "What do I need from others?",
      items:
        needsFromOthers.length > 0
          ? needsFromOthers.map((r) => `${r.person}: ${r.what}${r.by !== "UNKNOWN" ? ` (by ${r.by})` : ""}`)
          : ["Nothing currently needed from others."],
      evidence,
    },
  ];

  const whatShouldISay = `Today: ${changedItems.length} change(s), ${atRisk.length} escalating risk(s), ${needsDecision.length} decision(s) needed, ${blocked.length} blocked item(s), ${needsFromOthers.length} item(s) needed from others.`;

  return { questions, needsFromOthers, whatShouldISay };
}

export function renderMeetingModeText(brief: MeetingModeBrief): string {
  const body = brief.questions.map((q) => `${q.question.toUpperCase()}\n${q.items.map((i) => `- ${i}`).join("\n")}`).join("\n\n");
  return `MEETING MODE\n\n${body}\n\nWHAT SHOULD I SAY?\n${brief.whatShouldISay}`;
}
