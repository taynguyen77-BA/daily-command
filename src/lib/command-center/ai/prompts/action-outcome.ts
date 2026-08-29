import type { FollowUpContext } from "../../types";

export function actionOutcomePrompt(ctx: FollowUpContext): string {
  return `You are reviewing follow-up intelligence for an IT Business Analyst / Product
Owner / Project Manager. This is NOT autonomous execution — you are only assessing what
happened, the user decides what to do next.

YESTERDAY'S RECOMMENDATION: ${ctx.yesterdayRecommendation}
ACTION TAKEN: ${ctx.actionTaken}
OUTCOME: ${ctx.outcome}

CURRENT STATE FACTS:
${ctx.currentStateFacts.length ? ctx.currentStateFacts.map((f) => `- ${f}`).join("\n") : "- (none provided)"}

CONSTRAINTS:
- Use only the facts above. Never invent what "probably" happened.
- If current-state facts are too thin, set insufficientEvidence: true.

REQUIRED OUTPUT SCHEMA (JSON only): { "assessment": string, "confidence": number, "insufficientEvidence": boolean }`;
}
