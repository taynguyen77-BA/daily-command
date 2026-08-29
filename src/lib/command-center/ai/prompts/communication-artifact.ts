import type { ArtifactType } from "../../types";

const TONE_BY_TYPE: Record<ArtifactType, string> = {
  STATUS_UPDATE: "Informational, internal-facing status tone. No sign-off.",
  STAKEHOLDER_UPDATE: "External-facing, professional, concise — written for a stakeholder who doesn't see the underlying data.",
  RELEASE_UPDATE: "Go/no-go framing for a release decision-maker audience.",
  DECISION_BRIEF: "Neutral options framing — present the choice, never recommend one for the human.",
};

/** V2.2 §8 — COMMUNICATION_ARTIFACT. Drafts wording for a whole delivery artifact section
 *  from already-assembled facts/evidence (see communicate.ts) — never a second source of
 *  facts. Reviewed by the user before use; this text is always rendered as a clearly
 *  separate AI DRAFT segment (§5), never merged into the CALCULATED/EVIDENCE sections. */
export function communicationArtifactPrompt(type: ArtifactType, facts: string[], evidence: string[]): string {
  return `You are drafting the wording for a ${type.replace(/_/g, " ").toLowerCase()} on behalf of an IT Business
Analyst / Product Owner / Project Manager. This draft will be reviewed and edited by the
user before it is ever sent anywhere — never claim it has been sent, and never address a
specific named recipient.

AVAILABLE FACTS (use only these — never invent a date, commitment, number, owner, or
outcome that is not listed below):
${facts.map((f) => `- ${f}`).join("\n") || "- (none provided)"}

AVAILABLE EVIDENCE:
${evidence.map((e) => `- ${e}`).join("\n") || "- (none provided)"}

TONE: ${TONE_BY_TYPE[type]}

CONSTRAINTS:
- 3-6 sentences.
- Never use causal language ("caused", "led to", "resulted in") — describe conditions, not causes.
- Never infer an organizational role, hierarchy, or ownership ("as the PM", "your manager", "you should delegate").
- If the facts above are too thin to draft anything meaningful, set insufficientEvidence: true instead of guessing.
- For a DECISION_BRIEF, present the options neutrally — never tell the human which one to pick.

REQUIRED OUTPUT SCHEMA (JSON only): { "text": string, "confidence": number (0-1), "insufficientEvidence"?: boolean }`;
}
