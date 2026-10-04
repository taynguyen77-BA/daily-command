// V2.38 J3 — Release Go/No-Go brief. The deterministic readiness rules decide which
// recommendations are allowed; the model may only choose within them (checked server-side and
// again here — a contradiction falls back to the deterministic brief). Numbers are locked.
//
// RULE TABLE (allowedRecommendations):
//   open P1 blocker                         → No-Go only
//   readiness NOT_READY                     → No-Go only
//   readiness AT_RISK                       → Go with conditions | No-Go
//   READY but open P1/P2 items              → Go with conditions | No-Go
//   READY, nothing high-priority open       → Go | Go with conditions | No-Go

import type { CommandCenterData, ReleaseDrift, ReleaseHealth } from "../types";
import { isInRelease } from "../release-health";
import type { AIProvider } from "./provider";
import { RELEASE_RECOMMENDATIONS, type ReleaseBriefResponse } from "./schemas";
import { lockedFactViolations, type TaskInput } from "./task-registry";
import { RedactionSession, type CustomTerm } from "./redaction";
import { collectStrings } from "./evaluation";

export type ReleaseRecommendation = (typeof RELEASE_RECOMMENDATIONS)[number];

export function allowedRecommendations(h: Pick<ReleaseHealth, "readiness" | "highPriorityIncompleteCount">, openP1BlockerCount: number): { allowed: ReleaseRecommendation[]; reasons: string[] } {
  if (openP1BlockerCount > 0) return { allowed: ["No-Go"], reasons: [`${openP1BlockerCount} open P1 blocker(s): the release cannot go.`] };
  if (h.readiness === "NOT_READY") return { allowed: ["No-Go"], reasons: ["Readiness is NOT_READY (completion under 50%, or 3+ blocked, or 3+ overdue)."] };
  if (h.readiness === "AT_RISK") return { allowed: ["Go with conditions", "No-Go"], reasons: ["Readiness is AT_RISK: an unconditional Go is not allowed."] };
  if (h.highPriorityIncompleteCount > 0) return { allowed: ["Go with conditions", "No-Go"], reasons: [`${h.highPriorityIncompleteCount} P1/P2 item(s) still open: an unconditional Go is not allowed.`] };
  return { allowed: [...RELEASE_RECOMMENDATIONS], reasons: [] };
}

export function buildReleaseBriefInput(h: ReleaseHealth, data: Pick<CommandCenterData, "workItems" | "risks">, drift: ReleaseDrift | undefined, customTerms: CustomTerm[]): { input: TaskInput<"releaseGoNoGo">; session: RedactionSession } {
  const session = new RedactionSession(customTerms);
  const items = data.workItems.filter((w) => isInRelease(w, h.fixVersion));
  const priorityOf = new Map(items.map((w) => [w.key, w.priority]));
  const blockerKeys = new Set((h.blockers ?? []).map((b) => b.key));
  const openP1BlockerCount = (h.blockers ?? []).filter((b) => priorityOf.get(b.key) === "P1").length;
  const rules = allowedRecommendations(h, openP1BlockerCount);
  const openRefs = (h.remainingByStatus ?? []).flatMap((g) => g.items).filter((r) => !blockerKeys.has(r.key));
  return {
    session,
    input: {
      fixVersion: h.fixVersion,
      facts: {
        completionPct: h.completionPct,
        completedItems: h.completedItems,
        totalItems: h.totalItems,
        readiness: h.readiness,
        blockedCount: h.blockedCount,
        overdueCount: h.overdueCount,
        unresolvedDependenciesCount: h.unresolvedDependenciesCount,
        highPriorityIncompleteCount: h.highPriorityIncompleteCount,
        openP1BlockerCount,
        deliveryConfidence: h.deliveryConfidence,
      },
      allowedRecommendations: rules.allowed,
      ruleReasons: rules.reasons,
      blockers: (h.blockers ?? []).slice(0, 50).map((b) => ({ key: b.key, title: session.redact(b.title).slice(0, 500), status: b.status, ...(priorityOf.get(b.key) ? { priority: priorityOf.get(b.key) } : {}), ...(b.blockerReason ? { reason: session.redact(b.blockerReason).slice(0, 500) } : {}) })),
      openItems: openRefs.slice(0, 100).map((r) => ({ key: r.key, title: session.redact(r.title).slice(0, 500), status: r.status, ...(priorityOf.get(r.key) ? { priority: priorityOf.get(r.key) } : {}) })),
      drift: drift ? [`drift level ${drift.level}`, ...drift.drivers].slice(0, 10).map((d) => session.redact(d).slice(0, 300)) : [],
      risks: data.risks.filter((r) => r.status === "open" && r.sourceWorkItemIds.some((id) => items.some((w) => w.id === id))).slice(0, 10).map((r) => session.redact(`${r.level}: ${r.title}`).slice(0, 300)),
    },
  };
}

/** The deterministic brief (fallback, and what "no AI" shows): the most cautious allowed answer. */
export function deterministicReleaseBrief(input: TaskInput<"releaseGoNoGo">): ReleaseBriefResponse {
  const allowed = input.allowedRecommendations;
  const recommendation: ReleaseRecommendation = allowed.includes("No-Go") && (input.facts.readiness !== "READY" || input.facts.openP1BlockerCount > 0) ? "No-Go" : allowed.includes("Go") ? "Go" : allowed[0];
  const f = input.facts;
  return {
    recommendation,
    conditions: recommendation === "Go with conditions" ? input.openItems.filter((i) => i.priority === "P1" || i.priority === "P2").map((i) => `Close ${i.key}`).slice(0, 10) : [],
    evidence: [...input.blockers, ...input.openItems.filter((i) => i.priority === "P1")].map((x) => x.key).slice(0, 30),
    risks: input.risks.slice(0, 10),
    communicationDraft: `Release ${input.fixVersion}: ${f.completionPct}% complete (${f.completedItems} of ${f.totalItems}), ${f.blockedCount} blocked, ${f.overdueCount} overdue. Recommendation: ${recommendation}.`,
  };
}

/** Post-check in the browser too: an answer outside the rule table, citing a key that isn't an
 *  open item, or changing a number falls back to the deterministic brief. */
export function checkReleaseBrief(out: ReleaseBriefResponse, input: TaskInput<"releaseGoNoGo">): string[] {
  const v: string[] = [];
  if (!input.allowedRecommendations.includes(out.recommendation)) v.push(`"${out.recommendation}" contradicts the readiness rules`);
  const keys = new Set([...input.blockers, ...input.openItems].map((x) => x.key));
  for (const k of out.evidence) if (!keys.has(k)) v.push(`evidence ${k} is not an open item of this release`);
  v.push(...lockedFactViolations(collectStrings({ ...out, evidence: [] }).join("\n"), JSON.stringify(input)));
  return v;
}

export async function runReleaseBrief(input: TaskInput<"releaseGoNoGo">, session: RedactionSession, provider: Pick<AIProvider, "releaseGoNoGo" | "mode">): Promise<{ brief: ReleaseBriefResponse; usedAi: boolean; notice?: string }> {
  const out = await provider.releaseGoNoGo(input);
  if (provider.mode !== "claude") return { brief: session.restoreDeep(deterministicReleaseBrief(input)), usedAi: false, notice: "AI unavailable — deterministic brief from the readiness rules." };
  const problems = checkReleaseBrief(out, input);
  if (problems.length) return { brief: session.restoreDeep(deterministicReleaseBrief(input)), usedAi: false, notice: `The AI brief broke a rule (${problems.slice(0, 2).join("; ")}) — showing the deterministic brief.` };
  return { brief: session.restoreDeep(out), usedAi: true };
}
