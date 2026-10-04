// V2.38 J3 — Release Go/No-Go brief. Deep tier. The deterministic readiness rules decide which
// recommendations are ALLOWED (release-brief.ts allowedRecommendations); the model chooses
// within them and explains. Numbers are locked to the facts below.

import { untrustedBlock } from "../untrusted";
import type { TaskInput } from "../task-registry";

export function releaseGoNoGoPrompt(i: TaskInput<"releaseGoNoGo">): string {
  const f = i.facts;
  const items = (xs: { key: string; title: string; status: string; priority?: string; reason?: string }[]) =>
    xs.length ? xs.map((x) => `- ${x.key} [${x.status}${x.priority ? `, ${x.priority}` : ""}] ${untrustedBlock(`T_${x.key.replace(/-/g, "_")}`, x.title)}${x.reason ? ` reason: ${untrustedBlock(`R_${x.key.replace(/-/g, "_")}`, x.reason)}` : ""}`).join("\n") : "- none";
  return `You are preparing a Go/No-Go brief for release "${i.fixVersion}" for a delivery lead.

CALCULATED FACTS (deterministic — do not recompute or contradict):
- Completion: ${f.completionPct}% (${f.completedItems} of ${f.totalItems} done)
- Readiness (rule-based): ${f.readiness}
- Blocked: ${f.blockedCount} · Overdue: ${f.overdueCount} · Unresolved dependencies: ${f.unresolvedDependenciesCount}
- Open P1/P2 items: ${f.highPriorityIncompleteCount} · Open P1 blockers: ${f.openP1BlockerCount}
- Delivery confidence: ${f.deliveryConfidence}/100

ALLOWED RECOMMENDATIONS (from the readiness rules — you MUST pick one of these): ${i.allowedRecommendations.join(" | ")}
${i.ruleReasons.length ? `WHY SOME ARE NOT ALLOWED:\n${i.ruleReasons.map((r) => `- ${r}`).join("\n")}` : ""}

BLOCKERS:
${items(i.blockers)}

OTHER OPEN ITEMS:
${items(i.openItems)}

DRIFT SINCE THE LAST SNAPSHOT:
${i.drift.length ? i.drift.map((d) => `- ${d}`).join("\n") : "- none recorded"}

OPEN RISKS:
${i.risks.length ? i.risks.map((r) => `- ${r}`).join("\n") : "- none"}

CONSTRAINTS:
- recommendation must be one of the allowed values. "Go with conditions" needs concrete conditions.
- evidence: the ticket keys (from the lists above) your recommendation rests on.
- Never add or change a number, date or ticket key. communicationDraft: 3-6 sentences for stakeholders, no names.

REQUIRED OUTPUT SCHEMA (JSON only):
{ "recommendation": "Go" | "Go with conditions" | "No-Go", "conditions": string[], "evidence": string[], "risks": string[], "communicationDraft": string }`;
}
