// V2.50 R1 — "Improve with AI" for the Report narrative, browser side and offline-testable:
//   redact the free text of the facts (patterns + custom-term aliases) -> provider.runTask("summarizeReport")
//   -> restore the aliases -> re-verify against the ORIGINAL facts (3-5 sentences, keys, numbers, oldest blocker, completion verbs).
// Any failure returns a typed reason; the caller keeps the calculated text.

import { narrativeViolations, type NarrativeFacts } from "../report-narrative";
import { RedactionSession, type CustomTerm } from "./redaction";
import type { AiFailureReason } from "./outcome";
import type { AIProvider } from "./provider";

export type ImproveNarrativeResult = { ok: true; text: string } | { ok: false; reason: AiFailureReason; httpStatus?: number; violations?: string[] };

/** Redacts every free-text field of the facts; keys, counts and enumerations are left alone. */
export function redactNarrativeFacts(f: NarrativeFacts, s: RedactionSession): NarrativeFacts {
  const item = <T extends { title?: string; project?: string }>(i: T): T => ({ ...i, ...(i.title ? { title: s.redact(i.title) } : {}), ...(i.project ? { project: s.redact(i.project) } : {}) });
  return {
    ...f,
    done: f.done.map(item),
    inProgress: f.inProgress.map(item),
    blocked: f.blocked.map((b) => ({ ...item(b), ...(b.waitingFor ? { waitingFor: s.redact(b.waitingFor) } : {}), ...(b.reason ? { reason: s.redact(b.reason) } : {}) })),
    ...(f.nextWeek ? { nextWeek: f.nextWeek.map(item) } : {}),
    decisions: f.decisions.map((d) => s.redact(d)),
    ...(f.risk ? { risk: { ...f.risk, title: s.redact(f.risk.title) } } : {}),
  };
}

export async function improveNarrative(args: { facts: NarrativeFacts; customTerms: CustomTerm[]; provider: Pick<AIProvider, "runTask"> }): Promise<ImproveNarrativeResult> {
  if (!args.provider.runTask) return { ok: false, reason: "unavailable" };
  const session = new RedactionSession(args.customTerms);
  const out = await args.provider.runTask("summarizeReport", redactNarrativeFacts(args.facts, session));
  if (!out.ok) return { ok: false, reason: out.reason, ...(out.httpStatus !== undefined ? { httpStatus: out.httpStatus } : {}) };
  const text = session.restore(out.data.text).trim();
  const violations = narrativeViolations(text, args.facts);
  if (violations.length > 0) return { ok: false, reason: "grounding", violations: violations.slice(0, 5) };
  return { ok: true, text };
}
