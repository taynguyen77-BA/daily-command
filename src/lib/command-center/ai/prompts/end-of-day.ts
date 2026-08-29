import type { Action, Risk } from "../../types";

export function endOfDayPrompt(completed: Action[], deferred: Action[], blocked: Action[], newRisks: Risk[]): string {
  return `You are closing out the day for an IT Business Analyst / Product Owner / Project Manager.

AVAILABLE FACTS:
- Completed (${completed.length}): ${completed.map((a) => a.title).join("; ") || "none"}
- Deferred (${deferred.length}): ${deferred.map((a) => a.title).join("; ") || "none"}
- Blocked (${blocked.length}): ${blocked.map((a) => a.title).join("; ") || "none"}
- New risks today (${newRisks.length}): ${newRisks.map((r) => r.title).join("; ") || "none"}

CONSTRAINTS:
- Ground every claim in the facts above. Never invent an item, owner, or cause.
- If there is no carry-over item to recommend starting with, say so plainly.

REQUIRED OUTPUT SCHEMA (JSON only): { "text": string } formatted as:
"TOMORROW'S STARTING POINT: <one sentence>\\n\\nCARRY-OVER ACTIONS:\\n<bulleted list>\\n\\nNEW RISKS:\\n<bulleted list>"`;
}
