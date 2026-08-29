// Natural Language Command Bar (BUILD REQUEST V1.3 §26). NOT a chatbot — a small set of
// recognized project questions, each deterministically routed to a handler that pulls real
// data. Claude only narrates the already-assembled facts (see ai/provider.ts answerQuery);
// it never decides what data to look at.

import { availableFixVersions } from "./filters";
import { buildPlan } from "./action-plan";
import { computeReleaseHealth } from "./release-health";
import { clientName } from "./selectors";
import { makeEvidence } from "./evidence";
import type { CommandCenterData, Evidence, EvidenceSourceType, PersonalDeliveryReviewFacts } from "./types";
import type { DerivedData } from "./selectors";
import type { ProactiveIntelligence } from "./proactive";
import type { PersonalFocusResult } from "./types";

export type QueryIntent =
  | "blocking"
  | "changed-today"
  | "risks-for"
  | "release-risk"
  | "next-actions"
  | "client-attention"
  // V1.4 §29 — proactive intents
  | "getting-worse"
  | "needs-attention"
  | "risks-escalating"
  | "dependencies-dangerous"
  | "decisions-to-revisit"
  | "who-to-contact"
  | "what-first"
  | "why-drifting"
  // V1.5 §37 — decision & action intelligence intents
  | "decisions-blocked"
  | "decisions-effective"
  | "actions-not-working"
  | "action-strategy"
  | "loops-stalled"
  | "did-yesterday-help"
  | "what-changed-after-decision"
  // V1.6 §36 — Personal Delivery Copilot intents
  | "personal-focus-today"
  | "personal-can-wait"
  | "personal-thirty-min"
  | "why-on-my-list"
  | "am-i-overloaded"
  | "what-did-i-work-on"
  | "what-did-i-skip"
  | "what-did-i-complete"
  | "which-projects-need-attention"
  | "where-spending-time"
  | "whats-blocking-focus"
  | "what-should-i-defer"
  // V2.2 §10 — Command Bar artifact intents. Deliberately NOT narrated through
  // answerFromRoute/answerQuery (see isArtifactIntent below) — these open the Artifact
  // Editor with a communicate.ts-built draft instead of an AI-narrated answer, so Command
  // Bar stays a deterministic router, never a chatbot.
  | "create-status-update"
  | "create-stakeholder-update"
  | "create-release-update"
  | "create-decision-brief"
  | "summarize-today"
  | "unrecognized";

export interface RoutedQuery {
  intent: QueryIntent;
  target?: string; // matched client/project name or fix version, if any
  minutes?: number;
}

// V2.0 §10 — the 30+ intents above are NOT being replaced or renamed (every existing
// query/handler keeps working); they're grouped into the 7 command families the spec asks
// for, purely for labeling/discoverability in the UI. This is a dispatch-surface label,
// not a new routing layer — classifyQuery()/answerFromRoute() below are unchanged.
// V2.2 §10 adds ARTIFACT — the 5 "create/draft/prepare/summarize an artifact" intents.
// Distinct from every other family: those are all narrated through answerFromRoute/
// answerQuery, these open the Artifact Editor directly (see CommandBar.tsx) and never
// produce an AI-narrated inline answer.
export type QueryFamily = "STATUS" | "PRIORITY" | "DECISION" | "ACTION" | "DELIVERY" | "PERSONAL" | "MEMORY" | "ARTIFACT";

const QUERY_FAMILY: Record<Exclude<QueryIntent, "unrecognized">, QueryFamily> = {
  "changed-today": "STATUS",
  "getting-worse": "STATUS",
  "needs-attention": "STATUS",
  "client-attention": "STATUS",
  "which-projects-need-attention": "STATUS",
  "where-spending-time": "STATUS",
  "risks-for": "STATUS",

  "what-first": "PRIORITY",
  "next-actions": "PRIORITY",
  "personal-focus-today": "PRIORITY",
  "whats-blocking-focus": "PRIORITY",
  "what-should-i-defer": "PRIORITY",
  "personal-can-wait": "PRIORITY",

  "decisions-to-revisit": "DECISION",
  "decisions-blocked": "DECISION",
  "decisions-effective": "DECISION",
  "why-on-my-list": "DECISION",

  "actions-not-working": "ACTION",
  "action-strategy": "ACTION",
  blocking: "ACTION",

  "release-risk": "DELIVERY",
  "why-drifting": "DELIVERY",
  "loops-stalled": "DELIVERY",
  "risks-escalating": "DELIVERY",
  "dependencies-dangerous": "DELIVERY",
  "who-to-contact": "DELIVERY",

  "am-i-overloaded": "PERSONAL",
  "personal-thirty-min": "PERSONAL",
  "what-did-i-complete": "PERSONAL",

  "what-changed-after-decision": "MEMORY",
  "did-yesterday-help": "MEMORY",
  "what-did-i-work-on": "MEMORY",
  "what-did-i-skip": "MEMORY",

  "create-status-update": "ARTIFACT",
  "create-stakeholder-update": "ARTIFACT",
  "create-release-update": "ARTIFACT",
  "create-decision-brief": "ARTIFACT",
  "summarize-today": "ARTIFACT",
};

/** V2.2 §10 — true for the 5 artifact-creation intents; CommandBar.tsx uses this to route
 *  to the Artifact Editor instead of calling answerFromRoute/answerQuery. */
export function isArtifactIntent(intent: QueryIntent): boolean {
  return intent === "create-status-update" || intent === "create-stakeholder-update" || intent === "create-release-update" || intent === "create-decision-brief" || intent === "summarize-today";
}

export function familyForIntent(intent: QueryIntent): QueryFamily | undefined {
  return intent === "unrecognized" ? undefined : QUERY_FAMILY[intent];
}

function findTarget(query: string, candidates: string[]): string | undefined {
  const lower = query.toLowerCase();
  return candidates.find((c) => c && lower.includes(c.toLowerCase()));
}

export function classifyQuery(query: string, data: CommandCenterData): RoutedQuery {
  const q = query.trim().toLowerCase();
  const clientNames = data.clients.map((c) => c.name);
  const projectNames = data.projects.map((p) => p.name);
  const versions = availableFixVersions(data);

  // V2.2 §10 — checked first, same reasoning as the V1.4 block below: these must win over
  // the generic patterns (a plain "risk"/"decision" match would otherwise shadow them).
  if (/create status update|status update/.test(q)) {
    return { intent: "create-status-update" };
  }
  if (/draft stakeholder update|prepare stakeholder update|stakeholder update|draft update for/.test(q)) {
    return { intent: "create-stakeholder-update", target: findTarget(q, [...clientNames, ...projectNames]) };
  }
  if (/prepare release update|draft release update|release update/.test(q)) {
    return { intent: "create-release-update", target: findTarget(q, versions) };
  }
  if (/prepare decision brief|draft decision brief|decision brief/.test(q)) {
    return { intent: "create-decision-brief" };
  }
  if (/summarize today.?s delivery|summarize today|daily summary/.test(q)) {
    return { intent: "summarize-today" };
  }

  // V1.4 §29 — checked first, since several overlap generic V1.3 keywords ("risk", "what
  // should i do") and need to win over the broader existing patterns below.
  if (/getting worse|what.?s worse/.test(q)) {
    return { intent: "getting-worse" };
  }
  if (/(what needs|needs my) attention|attention queue/.test(q)) {
    return { intent: "needs-attention" };
  }
  if (/risk.*escalat|escalat.*risk/.test(q)) {
    return { intent: "risks-escalating" };
  }
  if (/dependenc.*danger|danger.*dependenc/.test(q)) {
    return { intent: "dependencies-dangerous" };
  }
  // V1.5 §37 — checked before the generic decision.*revisit pattern below folds them in.
  if (/decision.*block|block.*decision/.test(q)) {
    return { intent: "decisions-blocked" };
  }
  if (/decision.*(effective|worked)/.test(q)) {
    return { intent: "decisions-effective" };
  }
  // V2.1 §13 — "aren't working"/"isn't working" contractions were a real gap: they don't
  // contain the literal substring "not working" so they fell through to unrecognized.
  if (/action.*(not working|ineffective|not resolv|aren'?t working|isn'?t working)/.test(q)) {
    return { intent: "actions-not-working" };
  }
  if (/do differently|different approach|different strategy/.test(q)) {
    return { intent: "action-strategy" };
  }
  if (/loop.*stall|stalled.*loop|management loop/.test(q)) {
    return { intent: "loops-stalled" };
  }
  if (/did (yesterday|today).*(help|work)/.test(q)) {
    return { intent: "did-yesterday-help" };
  }
  if (/what changed after|changed after (the )?decision/.test(q)) {
    return { intent: "what-changed-after-decision", target: findTarget(q, data.decisions.map((d) => d.title)) };
  }
  if (/decision.*(revisit|review|stale)|(revisit|review).*decision/.test(q)) {
    return { intent: "decisions-to-revisit" };
  }
  // V1.6 §36 — checked before the generic patterns below, since several phrasings overlap
  // ("what should I do first", "what's most important").
  if (/focus on today|what('s| is) (most )?important for me|top 3|top three/.test(q)) {
    return { intent: "personal-focus-today" };
  }
  if (/what can wait|can this wait/.test(q)) {
    return { intent: "personal-can-wait" };
  }
  // V2.1 §13 — "what's my 30-minute plan?" (the product's own PERSONAL-family example
  // phrasing) didn't contain "finish"/"complete" and fell through to unrecognized.
  if (/finish.*30.?min|30.?min.*finish|complete.*30.?min|30.?min.*plan|plan.*30.?min|my 30.?min/.test(q)) {
    return { intent: "personal-thirty-min" };
  }
  if (/why (is this|.*on my list)/.test(q)) {
    return { intent: "why-on-my-list" };
  }
  if (/am i overloaded|too much (on my plate|to do)/.test(q)) {
    return { intent: "am-i-overloaded" };
  }
  if (/what did i (actually )?(work on|do)/.test(q) && !/complete/.test(q)) {
    return { intent: "what-did-i-work-on" };
  }
  if (/what did i skip/.test(q)) {
    return { intent: "what-did-i-skip" };
  }
  if (/what did i complete/.test(q)) {
    return { intent: "what-did-i-complete" };
  }
  if (/which (client|project)s? need(s)? my attention|projects? need attention/.test(q)) {
    return { intent: "which-projects-need-attention" };
  }
  if (/where am i spending|spending most of my time/.test(q)) {
    return { intent: "where-spending-time" };
  }
  if (/what.?s blocking my focus|blocking my focus/.test(q)) {
    return { intent: "whats-blocking-focus" };
  }
  if (/what should i defer/.test(q)) {
    return { intent: "what-should-i-defer" };
  }
  if (/who.*(contact|need to know)|contact.*who/.test(q)) {
    return { intent: "who-to-contact" };
  }
  if (/do first|first 30 minutes|first thing/.test(q)) {
    return { intent: "what-first" };
  }
  if (/why.*drift|drift.*why/.test(q)) {
    return { intent: "why-drifting" };
  }

  if (/block/.test(q)) {
    return { intent: "blocking", target: findTarget(q, [...clientNames, ...projectNames]) };
  }
  if (/what.*(changed|change)/.test(q)) {
    return { intent: "changed-today" };
  }
  if (/risk/.test(q) && /(release|version)/.test(q)) {
    return { intent: "release-risk", target: findTarget(q, versions) };
  }
  if (/risk/.test(q)) {
    return { intent: "risks-for", target: findTarget(q, [...clientNames, ...projectNames]) };
  }
  if (/what should i do|next \d+\s*min/.test(q)) {
    const minutesMatch = q.match(/(\d+)\s*min/);
    return { intent: "next-actions", minutes: minutesMatch ? Number(minutesMatch[1]) : 30 };
  }
  if (/which client|who needs attention|client.*attention/.test(q)) {
    return { intent: "client-attention" };
  }
  return { intent: "unrecognized" };
}

export interface QueryFacts {
  facts: string[];
  evidence: Evidence[];
  recommendedAction: string;
}

export function answerFromRoute(
  route: RoutedQuery,
  data: CommandCenterData,
  derived: DerivedData,
  today: string,
  sourceType: EvidenceSourceType,
  proactive?: ProactiveIntelligence,
  personalFocus?: PersonalFocusResult,
  personalReview?: PersonalDeliveryReviewFacts
): QueryFacts {
  const none = (msg: string): QueryFacts => ({ facts: [msg], evidence: [], recommendedAction: "No action needed right now." });
  if (!proactive && route.intent !== "unrecognized" && isProactiveIntent(route.intent)) {
    return { facts: ["Proactive intelligence is not available for this query."], evidence: [], recommendedAction: "" };
  }
  if (!personalFocus && route.intent !== "unrecognized" && isPersonalFocusIntent(route.intent)) {
    return { facts: ["Personal focus intelligence is not available for this query."], evidence: [], recommendedAction: "" };
  }
  if (!personalReview && route.intent !== "unrecognized" && isPersonalReviewIntent(route.intent)) {
    return { facts: ["Personal delivery history is not available for this query."], evidence: [], recommendedAction: "" };
  }

  switch (route.intent) {
    case "getting-worse": {
      const p = proactive!;
      const worse = [
        ...p.riskEscalations.filter((r) => r.trend === "worsening").map((r) => `Risk worsening: ${r.riskTitle} (${r.currentSeverity}, open ${r.daysOpen}d)`),
        ...p.dependencyRadar.filter((d) => d.heat === "HIGH" || d.heat === "CRITICAL").map((d) => `Dependency worsening: ${d.dependsOnTeam} (${d.heat})`),
        ...p.releaseDrift.filter((r) => r.level === "DRIFTING" || r.level === "SEVERE").map((r) => `Release ${r.fixVersion} drifting (${r.level})`),
      ];
      if (worse.length === 0) return none("Nothing is currently trending worse.");
      return { facts: worse.slice(0, 6), evidence: worse.slice(0, 6).map((f) => makeEvidence(f, sourceType)), recommendedAction: `Review: ${worse[0]}` };
    }
    case "needs-attention": {
      const items = proactive!.attentionQueue.filter((i) => i.lifecycle !== "SNOOZED" && i.lifecycle !== "RESOLVED").slice(0, 6);
      if (items.length === 0) return none("Nothing currently needs attention.");
      return {
        facts: items.map((i) => `${i.severity} ${i.category}: ${i.what} — ${i.why}`),
        evidence: items.flatMap((i) => i.evidence.map((e) => makeEvidence(e, sourceType))),
        recommendedAction: items[0].nowWhat,
      };
    }
    case "risks-escalating": {
      const escalating = proactive!.riskEscalations.filter((r) => r.trend === "worsening" || r.reopened);
      if (escalating.length === 0) return none("No risks are currently escalating.");
      return {
        facts: escalating.slice(0, 6).map((r) => `${r.riskTitle}: ${r.currentSeverity}${r.previousSeverity ? ` (was ${r.previousSeverity})` : ""}, open ${r.daysOpen}d`),
        evidence: escalating.slice(0, 6).map((r) => makeEvidence(r.escalationReason ?? r.riskTitle, sourceType)),
        recommendedAction: escalating[0].escalationReason ?? `Review ${escalating[0].riskTitle}.`,
      };
    }
    case "dependencies-dangerous": {
      const dangerous = proactive!.dependencyRadar.filter((d) => d.heat === "HIGH" || d.heat === "CRITICAL");
      if (dangerous.length === 0) return none("No dependencies are currently at HIGH/CRITICAL heat.");
      return {
        facts: dangerous.slice(0, 6).map((d) => `${d.dependsOnTeam}: ${d.heat} heat, blocking ${d.blockedItemCount} item(s), ${d.ageDays}d old`),
        evidence: dangerous.slice(0, 6).flatMap((d) => d.evidence.map((e) => makeEvidence(e, sourceType))),
        recommendedAction: dangerous[0].recommended,
      };
    }
    case "decisions-to-revisit": {
      const decisions = proactive!.decisionRadar;
      if (decisions.length === 0) return none("No decisions currently need review.");
      return {
        facts: decisions.slice(0, 6).map((d) => `${d.decision.title}: ${d.reasons.join("; ") || `stale for ${d.stalenessDays}d`}`),
        evidence: decisions.slice(0, 6).flatMap((d) => d.evidence),
        recommendedAction: `Review: ${decisions[0].decision.title}`,
      };
    }
    case "who-to-contact": {
      const comms = proactive!.communicationPriority.filter((c) => c.priority === "URGENT" || c.priority === "IMPORTANT");
      const stakeholders = proactive!.stakeholderAttention;
      if (comms.length === 0 && stakeholders.length === 0) return none("No one currently needs to be contacted.");
      const facts = [...comms.slice(0, 4).map((c) => `${c.priority}: ${c.who} — ${c.why} (${c.when})`), ...stakeholders.slice(0, 4).map((s) => s.reason)];
      return { facts, evidence: facts.map((f) => makeEvidence(f, sourceType)), recommendedAction: comms[0] ? `Contact ${comms[0].who} — ${comms[0].when}.` : stakeholders[0].reason };
    }
    case "what-first": {
      const first = proactive!.first30Minutes;
      if (first.length === 0) return none("No priority items fit the next 30 minutes.");
      return { facts: first.map((f) => f.text), evidence: first.map((f) => makeEvidence(f.text, sourceType)), recommendedAction: `Start with: ${first[0].text}` };
    }
    case "why-drifting": {
      const d = proactive!.drift;
      if (d.level === "STABLE") return none("Delivery is not currently drifting.");
      return {
        facts: [`Drift level: ${d.level} (score ${d.score}/100, ${d.trendQuality} trend)`, ...d.factors.map((f) => f.detail)],
        evidence: d.evidence.map((e) => makeEvidence(e, sourceType)),
        recommendedAction: "Review the drift drivers and confirm whether mitigation is needed.",
      };
    }
    case "decisions-blocked": {
      const blocked = proactive!.decisionRadar.filter((d) => d.reasons.some((r) => /blocker/i.test(r)));
      if (blocked.length === 0) return none("No decisions are currently blocked by open work.");
      return {
        facts: blocked.slice(0, 6).map((d) => `${d.decision.title}: ${d.reasons.find((r) => /blocker/i.test(r))}`),
        evidence: blocked.slice(0, 6).flatMap((d) => d.evidence),
        recommendedAction: `Review: ${blocked[0].decision.title}`,
      };
    }
    case "decisions-effective": {
      const effective = proactive!.decisionEffectiveness.filter((d) => d.classification === "EFFECTIVE");
      if (effective.length === 0) return none("No decisions have been classified effective yet.");
      const decisionById = new Map(data.decisions.map((d) => [d.id, d]));
      return {
        facts: effective.slice(0, 6).map((d) => `${decisionById.get(d.decisionId)?.title ?? d.decisionId}: ${d.observedChanges.join(" ")}`),
        evidence: effective.slice(0, 6).flatMap((d) => d.evidence.map((e) => makeEvidence(e, sourceType))),
        recommendedAction: "Continue monitoring these decisions' outcomes.",
      };
    }
    case "actions-not-working": {
      const ineffective = proactive!.actionEffectiveness.filter((r) => r.classification === "INEFFECTIVE");
      if (ineffective.length === 0) return none("No ineffective actions detected.");
      return {
        facts: ineffective.slice(0, 6).map((r) => `${r.actionTitle}: ${r.evidence[0] ?? "did not resolve the underlying issue"}`),
        evidence: ineffective.slice(0, 6).flatMap((r) => r.evidence.map((e) => makeEvidence(e, sourceType))),
        recommendedAction: `Try a different approach for: ${ineffective[0].actionTitle}`,
      };
    }
    case "action-strategy": {
      const ineffective = proactive!.actionEffectiveness.filter((r) => r.classification === "INEFFECTIVE");
      if (ineffective.length === 0) return none("No actions currently need a different strategy.");
      const top = ineffective[0];
      return {
        facts: [`Current approach did not resolve: ${top.actionTitle}`, ...top.evidence],
        evidence: top.evidence.map((e) => makeEvidence(e, sourceType)),
        recommendedAction: "Consider confirming the decision owner, adjusting scope, or escalating release impact instead of repeating the same action.",
      };
    }
    case "loops-stalled": {
      const stalled = proactive!.deliveryLoops.filter((l) => l.health === "STALLED");
      if (stalled.length === 0) return none("No management loops are currently stalled.");
      return {
        facts: stalled.slice(0, 6).map((l) => `${l.issue}: ${l.why}`),
        evidence: stalled.slice(0, 6).map((l) => makeEvidence(l.why, sourceType)),
        recommendedAction: stalled[0].nowWhat,
      };
    }
    case "did-yesterday-help": {
      const s = proactive!.outcomeScorecard;
      return {
        facts: [
          `Did it help: ${s.didTodayHelp}`,
          `Risks: ${s.risksDelta >= 0 ? "-" : "+"}${Math.abs(s.risksDelta)}`,
          `Blockers: ${s.blockersDelta >= 0 ? "-" : "+"}${Math.abs(s.blockersDelta)}`,
          `Confidence: ${s.confidenceDelta >= 0 ? "+" : ""}${s.confidenceDelta}`,
          `Actions: ${s.actionsCompleted} completed, ${s.actionsEffective} effective, ${s.actionsIneffective} ineffective`,
          s.controlEffectiveness,
        ],
        evidence: [makeEvidence(s.controlEffectiveness, sourceType)],
        recommendedAction: s.didTodayHelp === "NO" || s.didTodayHelp === "MIXED" ? "Review what's not working before tomorrow." : "Keep monitoring.",
      };
    }
    case "what-changed-after-decision": {
      const decision = route.target ? data.decisions.find((d) => d.title.toLowerCase() === route.target!.toLowerCase()) : undefined;
      if (!decision) return { facts: ["No matching decision found in the current data."], evidence: [], recommendedAction: "Name the decision more specifically." };
      const result = proactive!.decisionEffectiveness.find((d) => d.decisionId === decision.id);
      if (!result || result.observedChanges.length === 0) return none(`No measurable change observed yet after "${decision.title}".`);
      return {
        facts: result.observedChanges,
        evidence: result.evidence.map((e) => makeEvidence(e, sourceType)),
        recommendedAction: `Classification: ${result.classification}.`,
      };
    }
    // V1.6 §36-37
    case "personal-focus-today": {
      const top3 = personalFocus!.top3;
      if (top3.length === 0) return none("Nothing currently needs your personal focus.");
      return {
        facts: top3.map((c, i) => `${i + 1}. ${c.title}${c.projectName ? ` (${c.projectName})` : ""} — ${c.nowWhat} (~${c.estimatedMinutes}m)`),
        evidence: top3.flatMap((c) => c.evidence.map((e) => makeEvidence(e, sourceType))),
        recommendedAction: `Start with: ${top3[0].title}`,
      };
    }
    case "personal-can-wait": {
      const deferred = personalFocus!.byCategory.DEFER.concat(personalFocus!.byCategory.WATCH);
      if (deferred.length === 0) return none("Nothing is currently in Watch or Defer.");
      return {
        facts: deferred.slice(0, 6).map((c) => `${c.title} — ${c.category}`),
        evidence: [],
        recommendedAction: "These can wait — revisit them after today's DO NOW/DO TODAY items.",
      };
    }
    case "personal-thirty-min": {
      const plan = personalFocus!.thirtyMinutePlan;
      if (plan.length === 0) return none("No personal focus items fit the next 30 minutes.");
      return {
        facts: plan.map((c) => `${c.title} (${c.estimatedMinutes}m)`),
        evidence: plan.flatMap((c) => c.evidence.map((e) => makeEvidence(e, sourceType))),
        recommendedAction: `Total: ${personalFocus!.thirtyMinutePlanTotalMinutes} minute(s) across ${plan.length} item(s).`,
      };
    }
    case "why-on-my-list": {
      const top = personalFocus!.candidates.slice(0, 5);
      if (top.length === 0) return none("Nothing is currently on your personal focus list.");
      return {
        facts: top.map((c) => `${c.title}: ${c.whyOnMyList}`),
        evidence: [],
        recommendedAction: "",
      };
    }
    case "am-i-overloaded": {
      const overload = personalFocus!.overload;
      if (!overload) return none("You are not currently overloaded — no more than a manageable number of urgent items.");
      return { facts: [overload.reason], evidence: [], recommendedAction: overload.nowWhat };
    }
    case "what-did-i-work-on": {
      const r = personalReview!;
      return {
        facts: [`Completed ${r.completedCount} focus item(s) across ${r.projectsWorkedIn.join(", ") || "no projects"} over the last ${r.windowDays} day(s).`],
        evidence: [],
        recommendedAction: "",
      };
    }
    case "what-did-i-skip": {
      const r = personalReview!;
      if (r.skippedCount === 0) return none("You haven't skipped any focus items recently.");
      return {
        facts: [
          `${r.skippedCount} focus item(s) skipped over the last ${r.windowDays} day(s).`,
          ...r.stillRelevantSkipped.slice(0, 5).map((s) => `Still relevant: ${s.title}`),
        ],
        evidence: [],
        recommendedAction: r.stillRelevantSkipped.length > 0 ? `Still relevant: ${r.stillRelevantSkipped[0].title}` : "None of the skipped items are still relevant.",
      };
    }
    case "what-did-i-complete": {
      const r = personalReview!;
      return { facts: [`${r.completedCount} focus item(s) completed over the last ${r.windowDays} day(s).`], evidence: [], recommendedAction: "" };
    }
    case "which-projects-need-attention": {
      const balance = personalFocus!.projectBalance;
      if (balance.length === 0) return none("No project currently needs your personal attention.");
      return {
        facts: balance.map((p) => `${p.projectName}: ${p.itemCount} item(s) (${p.pct}%)`),
        evidence: [],
        recommendedAction: `Review ${balance[0].projectName} first.`,
      };
    }
    case "where-spending-time": {
      const balance = personalFocus!.projectBalance;
      if (balance.length === 0) return none("No personal-focus time is currently allocated to any project.");
      return { facts: balance.map((p) => `${p.projectName}: ${p.pct}%`), evidence: [], recommendedAction: "" };
    }
    case "whats-blocking-focus": {
      const blocked = personalFocus!.byCategory.BLOCKED;
      if (blocked.length === 0) return none("Nothing is currently blocking your focus.");
      return {
        facts: blocked.map((c) => `${c.title} — ${c.why}`),
        evidence: blocked.flatMap((c) => c.evidence.map((e) => makeEvidence(e, sourceType))),
        recommendedAction: blocked[0].nowWhat,
      };
    }
    case "what-should-i-defer": {
      const deferred = personalFocus!.byCategory.DEFER;
      if (deferred.length === 0) return none("Nothing currently qualifies as low-priority enough to defer.");
      return { facts: deferred.slice(0, 6).map((c) => c.title), evidence: [], recommendedAction: "" };
    }
    case "blocking": {
      const items = data.workItems.filter((w) => w.blocked && (!route.target || w.clientId === findClientId(data, route.target) || w.projectId === findProjectId(data, route.target)));
      if (items.length === 0) return { facts: ["No blocked items found."], evidence: [], recommendedAction: "No action needed right now." };
      return {
        facts: items.map((w) => `${w.key} — ${w.title} (${w.blockerReason ?? "blocked"})`),
        evidence: items.map((w) => makeEvidence(`${w.key}: ${w.blockerReason ?? "blocked"}`, sourceType, w.id)),
        recommendedAction: `Escalate the blocker on ${items[0].key} first — it has the highest priority score among blocked items.`,
      };
    }
    case "changed-today": {
      const changes = derived.changes.slice(0, 8);
      if (changes.length === 0) return { facts: ["No meaningful changes detected."], evidence: [], recommendedAction: "Nothing needs review from changes today." };
      return {
        facts: changes.map((c) => `${c.entityLabel}: ${c.field} changed from "${c.before}" to "${c.after}"`),
        evidence: changes.map((c) => makeEvidence(`${c.entityLabel} — ${c.field}: ${c.before} → ${c.after}`, sourceType, c.entityId)),
        recommendedAction: "Review the highest-impact change first.",
      };
    }
    case "risks-for": {
      const risks = derived.risks.filter((r) => !route.target || riskMatchesTarget(data, r, route.target));
      if (risks.length === 0) return { facts: ["No open risks found for this scope."], evidence: [], recommendedAction: "No action needed right now." };
      return {
        facts: risks.slice(0, 6).map((r) => `${r.level}: ${r.title} — ${r.reason}`),
        evidence: risks.slice(0, 6).flatMap((r) => r.evidence.map((e) => makeEvidence(e, sourceType, r.sourceWorkItemIds[0]))),
        recommendedAction: risks[0].mitigation,
      };
    }
    case "release-risk": {
      if (!route.target) return { facts: ["No matching release/fix version found in the current data."], evidence: [], recommendedAction: "Specify a valid fix version." };
      const health = computeReleaseHealth(data, route.target, today);
      return {
        facts: [
          `Completion: ${health.completionPct}%`,
          `Blocked: ${health.blockedCount}`,
          `Overdue: ${health.overdueCount}`,
          `Unresolved dependencies: ${health.unresolvedDependenciesCount}`,
          `Delivery confidence: ${health.deliveryConfidence}/100`,
          `Readiness: ${health.readiness}`,
        ],
        evidence: [makeEvidence(`Release ${route.target}: ${health.completionPct}% complete, ${health.blockedCount} blocked, ${health.overdueCount} overdue`, sourceType)],
        recommendedAction: health.topRiskTitle ? `Address: ${health.topRiskTitle}` : "Monitor release health; no dominant risk detected.",
      };
    }
    case "next-actions": {
      const plan = buildPlan(data, today, (route.minutes ?? 30) as 15 | 30 | 60 | 120 | 480);
      if (plan.length === 0) return { facts: ["No candidates fit this time window."], evidence: [], recommendedAction: "Try a longer time budget." };
      return {
        facts: plan.map((c) => `${c.title} (${c.estimateMinutes} min)`),
        evidence: plan.map((c) => makeEvidence(`${c.title} — priority score ${c.priorityScore}`, sourceType)),
        recommendedAction: `Start with: ${plan[0].title}`,
      };
    }
    case "client-attention": {
      // V1.4 §35 — prefer the richer Client Attention Map engine when available; falls
      // back to the original simple ranking so this intent still works without it.
      if (proactive && proactive.clientAttentionMap.length > 0) {
        const rows = proactive.clientAttentionMap;
        const worst = rows[0];
        return {
          facts: rows.map((r) => `${r.clientName}: confidence ${r.deliveryConfidence}/100 (${r.trend}), ${r.openDecisionsCount} open decision(s), ${r.criticalDependenciesCount} critical dependenc${r.criticalDependenciesCount === 1 ? "y" : "ies"}`),
          evidence: rows.map((r) => makeEvidence(`${r.clientName}: ${r.deliveryConfidence}/100`, sourceType)),
          recommendedAction: `Review ${worst.clientName} first.`,
        };
      }
      const byClient = new Map<string, number>();
      for (const s of derived.scores) {
        const item = data.workItems.find((w) => w.id === s.itemId);
        if (!item) continue;
        if (s.classification === "CRITICAL" || s.classification === "HIGH") {
          byClient.set(item.clientId, (byClient.get(item.clientId) ?? 0) + 1);
        }
      }
      const ranked = Array.from(byClient.entries()).sort((a, b) => b[1] - a[1]);
      if (ranked.length === 0) return { facts: ["No client currently has high-priority attention items."], evidence: [], recommendedAction: "No action needed right now." };
      const [topClientId, count] = ranked[0];
      const name = clientName(data, topClientId);
      return {
        facts: ranked.map(([id, c]) => `${clientName(data, id)}: ${c} attention-needing item(s)`),
        evidence: [makeEvidence(`${name} has ${count} CRITICAL/HIGH item(s)`, sourceType)],
        recommendedAction: `Review ${name} first.`,
      };
    }
    default:
      return { facts: [], evidence: [], recommendedAction: "" };
  }
}

function isProactiveIntent(intent: QueryIntent): boolean {
  return (
    intent === "getting-worse" ||
    intent === "needs-attention" ||
    intent === "risks-escalating" ||
    intent === "dependencies-dangerous" ||
    intent === "decisions-to-revisit" ||
    intent === "who-to-contact" ||
    intent === "what-first" ||
    intent === "why-drifting" ||
    intent === "decisions-blocked" ||
    intent === "decisions-effective" ||
    intent === "actions-not-working" ||
    intent === "action-strategy" ||
    intent === "loops-stalled" ||
    intent === "did-yesterday-help" ||
    intent === "what-changed-after-decision"
  );
}

function isPersonalFocusIntent(intent: QueryIntent): boolean {
  return (
    intent === "personal-focus-today" ||
    intent === "personal-can-wait" ||
    intent === "personal-thirty-min" ||
    intent === "why-on-my-list" ||
    intent === "am-i-overloaded" ||
    intent === "which-projects-need-attention" ||
    intent === "where-spending-time" ||
    intent === "whats-blocking-focus" ||
    intent === "what-should-i-defer"
  );
}

function isPersonalReviewIntent(intent: QueryIntent): boolean {
  return intent === "what-did-i-work-on" || intent === "what-did-i-skip" || intent === "what-did-i-complete";
}

function findClientId(data: CommandCenterData, name: string): string | undefined {
  return data.clients.find((c) => c.name.toLowerCase() === name.toLowerCase())?.id;
}
function findProjectId(data: CommandCenterData, name: string): string | undefined {
  return data.projects.find((p) => p.name.toLowerCase() === name.toLowerCase())?.id;
}
function riskMatchesTarget(data: CommandCenterData, risk: { sourceWorkItemIds: string[] }, target: string): boolean {
  const clientId = findClientId(data, target);
  const projectId = findProjectId(data, target);
  if (!clientId && !projectId) return true;
  return risk.sourceWorkItemIds.some((id) => {
    const item = data.workItems.find((w) => w.id === id);
    return item && (item.clientId === clientId || item.projectId === projectId);
  });
}
