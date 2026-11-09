// V2.49 A1 — every AI call returns an explicit outcome: the data, or a typed failure reason. Pure, no I/O.
// Features label their output from THIS (their own call), never from the shared, mutable `provider.mode`.
// Carries only a reason + HTTP status + a violation count: never a prompt, an input or an output.

export type AiFailureReason =
  | "unavailable"
  | "budget"
  | "user-budget"
  | "grounding"
  | "truncated"
  | "invalid-output"
  | "refused"
  | "provider-error"
  | "network"
  | "bad-input";

export type AiOutcome<T> = { ok: true; data: T } | { ok: false; reason: AiFailureReason; httpStatus?: number; violationCount?: number };

export type AiFailure = Extract<AiOutcome<never>, { ok: false }>;

/** Failures that can succeed on a second try (the cause is not the data or the budget). */
export function isTransientAiFailure(reason: AiFailureReason | undefined): boolean {
  return reason === "network" || reason === "provider-error" || reason === "truncated";
}

/** Server answer (HTTP status + errorKind from the route's JSON) -> the failure reason. */
export function failureReasonFromResponse(status: number, errorKind?: string): AiFailureReason {
  if (status === 429) return errorKind === "user-budget-exhausted" ? "user-budget" : "budget";
  if (status === 422) return "grounding";
  if (errorKind === "budget-exhausted") return "budget";
  if (errorKind === "user-budget-exhausted") return "user-budget";
  if (errorKind === "grounding-rejected") return "grounding";
  if (errorKind === "truncated") return "truncated";
  if (errorKind === "refused") return "refused";
  if (errorKind === "invalid-output") return "invalid-output";
  if (status === 400 || errorKind === "bad-request") return "bad-input";
  return "provider-error";
}

const TEXT: Record<AiFailureReason, { title: string; nextStep: string }> = {
  unavailable: { title: "AI is not set up or not reachable", nextStep: "Data & Settings → AI provider → Test. The calculated text is shown." },
  budget: { title: "Today's AI budget is used up", nextStep: "Resets at midnight UTC; the calculated text is shown." },
  "user-budget": { title: "Your daily AI budget is used up", nextStep: "Resets at midnight UTC; the calculated text is shown." },
  grounding: { title: "The AI used a number, date or ticket key that is not in your data, so it was rejected", nextStep: "The calculated text is shown. Try again later or after the data changes." },
  truncated: { title: "The answer was cut off", nextStep: "The model ran out of output room. Pick a model with more room for this tier, or try again." },
  "invalid-output": { title: "The AI answer was not in the expected format", nextStep: "The calculated text is shown. Trying again usually works." },
  refused: { title: "The model declined this request", nextStep: "The calculated text is shown." },
  "provider-error": { title: "The AI provider returned an error", nextStep: "Data & Settings → AI provider → Test shows the cause (key, model id or gateway)." },
  network: { title: "Could not reach the AI service", nextStep: "Check your connection and try again; the calculated text is shown meanwhile." },
  "bad-input": { title: "This request could not be sent to the AI", nextStep: "The calculated text is shown." },
};

/** Plain language, English only (this is app chrome). */
export function explainAiFailure(reason: AiFailureReason, httpStatus?: number): { title: string; nextStep: string } {
  const t = TEXT[reason];
  return { title: httpStatus && reason === "provider-error" ? `${t.title} (HTTP ${httpStatus})` : t.title, nextStep: t.nextStep };
}
