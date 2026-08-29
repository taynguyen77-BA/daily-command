import type { Action, PriorityScoreResult, WorkItem } from "../../types";

export function actionPlanPrompt(
  budgetMinutes: number,
  candidates: { item?: WorkItem; action?: Action; result?: PriorityScoreResult; estimateMinutes: number }[]
): string {
  return `You are an assistant to an IT Business Analyst / Product Owner / Project Manager
narrating a time-boxed action plan for a ${budgetMinutes}-minute window.

AVAILABLE FACTS: deterministic logic has already ranked and selected the candidates below by
priority, urgency, effort, and dependency risk, and the total already fits the time budget —
do not re-rank, add, or remove items.

${candidates
  .map((c, i) => {
    const title = c.item ? `${c.item.key} — ${c.item.title}` : c.action?.title ?? "Untitled";
    const reason = c.result?.reasoning ?? c.action?.why ?? "";
    return `${i + 1}. ${title} (${c.estimateMinutes} min) — ${reason}`;
  })
  .join("\n")}

CONSTRAINTS:
- Do not change the order, items, or minute estimates above.
- Never invent a reason not already given.

REQUIRED OUTPUT SCHEMA (JSON only): { "text": string } — a numbered plan, one line per item:
"N. <action> — <minutes> min".`;
}
