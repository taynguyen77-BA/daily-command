// Natural Language Command Bar (BUILD REQUEST V1.3 §26). NOT a chatbot — a small set of
// recognized project questions, each deterministically routed to a handler that pulls real
// data. Claude only narrates the already-assembled facts (see ai/provider.ts answerQuery);
// it never decides what data to look at.

import { availableFixVersions } from "./filters";
import { buildPlan } from "./action-plan";
import { computeReleaseHealth } from "./release-health";
import { clientName } from "./selectors";
import { makeEvidence } from "./evidence";
import { explainWorkItemRelevance, listStatusesByRelevance, listUnclassifiedJiraStatuses, workItemsByRelevance, type WorkRelevanceIndex } from "./jira/work-relevance";
import { computePolicyReviewSignals, computeWorkRelevanceDistribution } from "./jira/work-relevance-calibration";
import { computeExecutionPathTrace, listCandidatePoolActionableItems, listJiraItemsInPersonalFocus } from "./execution-path";
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
  // V2.5 §17 — Work Relevance & Jira Status Policy intents. Deterministic lookups over
  // WorkItem.jiraStatusName + the Work Relevance Policy index — never routed through AI.
  | "jira-status-context"
  | "jira-status-waiting"
  | "jira-statuses-unclassified"
  // V2.6 §17 — "which statuses are actionable?" is a POLICY-vocabulary question (which
  // (project, status) pairs are currently classified ACTIONABLE), distinct from
  // "next-actions" ("what do I need to work on?", which lists actual candidate work items).
  | "jira-statuses-actionable"
  // V2.7 §19 — Work Relevance Operational Calibration intents. Deterministic reads over
  // jira/work-relevance-calibration.ts — never AI, never a mutation.
  | "work-relevance-calibration-summary"
  | "policy-review-signals"
  | "actionable-low-personal-work"
  | "observed-statuses-with-actions"
  // V2.8 §17 — Execution Path & Work Signal Calibration intents. Deterministic reads over
  // execution-path.ts — never AI, never a mutation, never an automatic Action.
  | "execution-path-for-item"
  | "candidate-pool-actionable-items"
  | "jira-items-in-personal-focus"
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

  "jira-status-context": "STATUS",
  "jira-status-waiting": "STATUS",
  "jira-statuses-unclassified": "STATUS",
  "jira-statuses-actionable": "STATUS",
  "work-relevance-calibration-summary": "STATUS",
  "policy-review-signals": "STATUS",
  "actionable-low-personal-work": "STATUS",
  "observed-statuses-with-actions": "STATUS",
  "execution-path-for-item": "STATUS",
  "candidate-pool-actionable-items": "STATUS",
  "jira-items-in-personal-focus": "STATUS",

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
  // V2.5 §18 — capture a mentioned Jira issue key (e.g. "why isn't JPMC-123 on my list?")
  // so answerFromRoute can answer via the deterministic Work Relevance explanation when the
  // item isn't a personal-focus candidate at all, not just explain items already on it.
  if (/why (is this|.*on my list)/.test(q)) {
    return { intent: "why-on-my-list", target: findTarget(q, data.workItems.map((w) => w.key)) };
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
  // V2.7 §19 — Work Relevance Operational Calibration intents. Checked before V2.6's
  // "which statuses are actionable?" pattern below: "actionable statuses producing little
  // personal work" contains the substring "actionable statuses" and would otherwise be
  // misrouted to jira-statuses-actionable.
  if (/how is my work relevance( policy)? performing|work relevance (performance|calibration)/.test(q)) {
    return { intent: "work-relevance-calibration-summary" };
  }
  if (/actionable statuses?.*(little|low|no) personal work|actionable.*producing little/.test(q)) {
    return { intent: "actionable-low-personal-work" };
  }
  if (/which statuses need (a )?(policy )?review|policy review signals?|statuses?.*worth reviewing/.test(q)) {
    return { intent: "policy-review-signals" };
  }
  if (/which observed statuses have actions|observed statuses.*(have )?actions/.test(q)) {
    return { intent: "observed-statuses-with-actions" };
  }
  // V2.8 §17 — Execution Path & Work Signal Calibration intents. "Candidate pool" checked
  // before the generic "actionable statuses" patterns above/below since it also contains
  // the substring "actionable".
  if (/execution (path|flow|trace)|where is .* in my execution/.test(q)) {
    return { intent: "execution-path-for-item", target: findTarget(q, data.workItems.map((w) => w.key)) };
  }
  if (/(actionable|which).*candidate pool|candidate pool.*actionable/.test(q)) {
    return { intent: "candidate-pool-actionable-items" };
  }
  if (/(jira )?items? .*in personal focus because of jira|jira work.*(in )?personal focus|personal focus.*because of jira/.test(q)) {
    return { intent: "jira-items-in-personal-focus" };
  }
  // V2.5 §17 — checked before the generic patterns below (e.g. "what should i do") so
  // status-context/waiting/unclassified questions are never misrouted to next-actions.
  if (/not classified|unclassified/.test(q)) {
    return { intent: "jira-statuses-unclassified" };
  }
  // V2.6 §17 — a policy-vocabulary question ("which statuses are actionable?"), checked
  // before the generic next-actions pattern below so it's never misrouted to a work-item
  // list ("what do I need to work on?").
  if (/which statuses? (are|is) actionable|actionable statuses/.test(q)) {
    return { intent: "jira-statuses-actionable" };
  }
  if (/what('s| is) waiting|waiting on (me|us)|things? (are )?waiting/.test(q)) {
    return { intent: "jira-status-waiting" };
  }
  // V2.6 §17 — "what is being observed?" is the spec's own worked example; it has no
  // specific status keyword to match, so it lists every currently-OBSERVE item (same
  // handler as "what's in UAT?" with an empty keyword — see the jira-status-context case).
  if (/what('s| is) (currently )?(being )?observed|observation.?only/.test(q)) {
    return { intent: "jira-status-context" };
  }
  {
    const statusContextMatch = q.match(/what('s| is) in ([a-z0-9 /_-]+)\??$/);
    if (statusContextMatch) {
      return { intent: "jira-status-context", target: statusContextMatch[2].trim() };
    }
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
  // V2.5 §17 — "What do I need to work on?" is the spec's own worked example for the
  // ACTIONABLE-only surface; it didn't match the existing "what should i do" phrasing.
  if (/what should i do|next \d+\s*min|what do i need to (work on|do)|what.*need.*work on/.test(q)) {
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
  personalReview?: PersonalDeliveryReviewFacts,
  workRelevanceIndex?: WorkRelevanceIndex
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
      // V2.5 §18 — a named Jira issue not on personal-focus at all (the common case: its
      // status was classified OBSERVE/WAITING/etc.) gets the deterministic Work Relevance
      // explanation instead of a generic "nothing is on your list" — this is the trust
      // requirement the whole feature exists for ("why isn't Daily Command showing my
      // ticket?" -> "because this status is classified as delivery context").
      if (route.target) {
        const item = data.workItems.find((w) => w.key.toLowerCase() === route.target!.toLowerCase());
        if (item && item.sourceType === "jira") {
          const explanation = explainWorkItemRelevance(item, workRelevanceIndex ?? new Map());
          return {
            facts: [explanation.answer],
            evidence: [],
            recommendedAction: explanation.relevance === "UNKNOWN" ? "Classify this status in Data & Settings → Jira Work Relevance Policy." : "",
          };
        }
      }
      const top = personalFocus!.candidates.slice(0, 5);
      if (top.length === 0) return none("Nothing is currently on your personal focus list.");
      return {
        facts: top.map((c) => `${c.title}: ${c.whyOnMyList}`),
        evidence: [],
        recommendedAction: "",
      };
    }
    // V2.5 §17 — status-context/waiting/unclassified: plain deterministic lookups over
    // WorkItem.jiraStatusName + the Work Relevance Policy index. Never routed through AI,
    // and distinct from "next-actions" below, which asks a completely different question
    // ("what do I need to work on?" vs. "what's in this delivery/process state?").
    case "jira-status-context": {
      const idx = workRelevanceIndex ?? new Map();
      const observeItems = workItemsByRelevance(data, idx, "OBSERVE");
      const keyword = route.target?.trim().toLowerCase();
      const matched = keyword ? observeItems.filter((w) => (w.jiraStatusName ?? "").toLowerCase().includes(keyword)) : observeItems;
      if (matched.length === 0) {
        return none(keyword ? `No items are currently classified OBSERVE matching "${route.target}".` : "No items are currently classified OBSERVE.");
      }
      return {
        facts: matched.slice(0, 8).map((w) => `${w.key} — ${w.title} (${w.jiraStatusName})`),
        evidence: matched.slice(0, 8).map((w) => makeEvidence(`${w.key}: ${w.jiraStatusName}`, sourceType, w.id)),
        recommendedAction: "This is delivery/process context — not a personal task.",
      };
    }
    case "jira-status-waiting": {
      const idx = workRelevanceIndex ?? new Map();
      const items = workItemsByRelevance(data, idx, "WAITING");
      if (items.length === 0) return none("Nothing is currently classified WAITING.");
      return {
        facts: items.slice(0, 8).map((w) => `${w.key} — ${w.title} (${w.jiraStatusName})`),
        evidence: items.slice(0, 8).map((w) => makeEvidence(`${w.key}: ${w.jiraStatusName}`, sourceType, w.id)),
        recommendedAction: "Waiting on another party or process — no immediate action required.",
      };
    }
    case "jira-statuses-unclassified": {
      const idx = workRelevanceIndex ?? new Map();
      const rows = listUnclassifiedJiraStatuses(data, idx);
      if (rows.length === 0) return none("Every observed Jira status is currently classified.");
      return {
        facts: rows.map((r) => `${r.projectKey}: "${r.status}" has not been classified.`),
        evidence: [],
        recommendedAction: "Classify these in Data & Settings → Jira Work Relevance Policy.",
      };
    }
    // V2.6 §17 — the POLICY vocabulary itself (which (project, status) pairs are
    // classified ACTIONABLE), not the work items currently in that state.
    case "jira-statuses-actionable": {
      const idx = workRelevanceIndex ?? new Map();
      const rows = listStatusesByRelevance(data, idx, "ACTIONABLE");
      if (rows.length === 0) return none("No Jira status is currently classified ACTIONABLE.");
      return {
        facts: rows.map((r) => `${r.projectKey}: "${r.status}" is classified ACTIONABLE.`),
        evidence: [],
        recommendedAction: "Review or change this in Data & Settings → Jira Work Relevance Policy.",
      };
    }
    // V2.7 §4 — the deterministic distribution, never a blended "work relevance score".
    case "work-relevance-calibration-summary": {
      const idx = workRelevanceIndex ?? new Map();
      const rows = computeWorkRelevanceDistribution(data, idx);
      if (rows.length === 0) return none("No Jira-sourced work items are currently in scope to calibrate against.");
      return {
        facts: rows.map((r) => `${r.projectKey}: ACTIONABLE ${r.counts.ACTIONABLE} · WAITING ${r.counts.WAITING} · OBSERVE ${r.counts.OBSERVE} · COMPLETED ${r.counts.COMPLETED} · EXCLUDED ${r.counts.EXCLUDED} · UNKNOWN ${r.counts.UNKNOWN}`),
        evidence: [],
        recommendedAction: "Review the full calibration breakdown in Data & Settings → Work Relevance Calibration.",
      };
    }
    // V2.7 §8-11 — deterministic REVIEW signals only; never a claim that the policy is wrong.
    case "policy-review-signals": {
      const idx = workRelevanceIndex ?? new Map();
      const signals = computePolicyReviewSignals(data, idx).filter((s) => s.signalType === "REVIEW");
      if (signals.length === 0) return none("No status currently shows a policy review signal.");
      return {
        facts: signals.map((s) => `${s.projectKey}: "${s.statusName}" (${s.currentRelevance}) — ${s.explanation}`),
        evidence: [],
        recommendedAction: "This may be worth reviewing in Data & Settings → Work Relevance Calibration. The policy is not changed automatically.",
      };
    }
    // V2.7 §8 Signal B — ACTIONABLE statuses with zero linked personal-work evidence.
    case "actionable-low-personal-work": {
      const idx = workRelevanceIndex ?? new Map();
      const signals = computePolicyReviewSignals(data, idx).filter((s) => s.currentRelevance === "ACTIONABLE" && s.signalType === "REVIEW");
      if (signals.length === 0) return none("No ACTIONABLE status currently shows a review signal — every ACTIONABLE status with enough evidence has at least one linked Action.");
      return {
        facts: signals.map((s) => `${s.projectKey}: "${s.statusName}" — ${s.explanation}`),
        evidence: [],
        recommendedAction: "This may be worth reviewing — it does not mean the policy is wrong.",
      };
    }
    // V2.7 §8 Signal A — any observed status (any policy) with linked user Actions.
    case "observed-statuses-with-actions": {
      const idx = workRelevanceIndex ?? new Map();
      const rows = computePolicyReviewSignals(data, idx).filter((s) => s.actionEvidenceCount > 0);
      if (rows.length === 0) return none("No observed Jira status currently has a linked Action.");
      return {
        facts: rows.map((s) => `${s.projectKey}: "${s.statusName}" (${s.currentRelevance}) — ${s.actionEvidenceCount} linked Action(s), ${s.completionEvidenceCount} completed.`),
        evidence: [],
        recommendedAction: "",
      };
    }
    // V2.8 §4-6 — one item's full execution trace, narrated as plain facts. §17's own
    // suggested fallback line for unsupported ambiguity when no issue key is named.
    case "execution-path-for-item": {
      if (!route.target) {
        return { facts: ["I need a project, issue key, or status to answer that precisely."], evidence: [], recommendedAction: "" };
      }
      const item = data.workItems.find((w) => w.key.toLowerCase() === route.target!.toLowerCase());
      if (!item || item.sourceType !== "jira") {
        return { facts: [`No Jira work item matching "${route.target}" was found in the current scope.`], evidence: [], recommendedAction: "" };
      }
      const idx = workRelevanceIndex ?? new Map();
      const trace = computeExecutionPathTrace(item, data, today, idx, proactive ?? null, personalFocus ?? null);
      return {
        facts: [
          `${item.key} — Jira status "${item.jiraStatusName ?? item.status}", Work Relevance ${trace.relevance === "NOT_APPLICABLE" ? "N/A" : trace.relevance}.`,
          `Candidate evaluation: ${trace.candidateEvaluation === "ELIGIBLE" ? "entered candidate pool" : trace.candidateEvaluation === "NOT_ELIGIBLE" ? "did not enter candidate pool" : "not applicable"}.`,
          `Action Plan: ${trace.actionPlan === "SELECTED" ? "selected" : trace.actionPlan === "NOT_SELECTED" ? "not selected" : "not applicable"}.`,
          `Explicit Action: ${trace.actions.state === "EXISTS" ? `${trace.actions.actions.length} (${trace.actions.activeCount} active, ${trace.actions.completedCount} completed)` : "none"}.`,
          `Personal Focus: ${trace.attention.presentInPersonalFocus ? "present" : trace.attention.evidenceAvailable ? "not currently present" : "not enough evidence"}.`,
          `Outcome: ${trace.outcome.recorded ? `recorded (${trace.outcome.count})` : "not recorded"}.`,
        ],
        evidence: [],
        recommendedAction: "",
      };
    }
    // V2.8 §17 — Stage 3 (Candidate Evaluation) aggregate, distinct from V2.6's
    // jira-statuses-actionable (policy vocabulary) and next-actions (all candidate work).
    case "candidate-pool-actionable-items": {
      const idx = workRelevanceIndex ?? new Map();
      const items = listCandidatePoolActionableItems(data, idx, today);
      if (items.length === 0) return none("No ACTIONABLE Jira item is currently in the candidate pool.");
      return {
        facts: items.slice(0, 8).map((w) => `${w.key} — ${w.title}`),
        evidence: items.slice(0, 8).map((w) => makeEvidence(`${w.key} entered the candidate pool`, sourceType, w.id)),
        recommendedAction: "",
      };
    }
    // V2.8 §17, §33 — the exact question V2.7 flagged as an open product hypothesis: which
    // Jira-sourced items are ACTUALLY connected (via real Attention/Loop evidence) to
    // Personal Focus right now. Never implies more Jira items SHOULD be there.
    case "jira-items-in-personal-focus": {
      const rows = listJiraItemsInPersonalFocus(data, proactive ?? null, personalFocus ?? null);
      if (rows.length === 0) return none("No Jira-sourced item is currently connected to Personal Focus.");
      return {
        facts: rows.slice(0, 8).map(({ item, candidate }) => `${item.key} — ${candidate.whyOnMyList || candidate.why}`),
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
      const plan = buildPlan(data, today, (route.minutes ?? 30) as 15 | 30 | 60 | 120 | 480, workRelevanceIndex);
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
