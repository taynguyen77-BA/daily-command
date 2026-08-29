// V1.7 §24-26 — AI Quality Evaluation. Deterministic, static analysis of an AI response's
// TEXT/SHAPE against the facts/evidence it was given — never a second model call (§24 "do
// not add more AI capabilities — evaluate existing ones"). Schema validity is already
// enforced by ai/schemas/index.ts at call time; this module evaluates CONTENT quality on
// top of that, which schema validation alone cannot catch (a response can be
// shape-valid and still use causal language, or invent a claim).

import type { AiEvaluationFinding, AiEvaluationResult, AiEvaluationSeverity } from "../types";

function finding(dimension: AiEvaluationFinding["dimension"], severity: AiEvaluationSeverity, detail: string, evidence?: string): AiEvaluationFinding {
  return { dimension, pass: severity !== "FAIL", severity, detail, evidence };
}

// §16, §42 — the exact causality-unsafe patterns the prompts are instructed to avoid.
const CAUSAL_LANGUAGE_PATTERNS = [/\bcaused\b/i, /\bled to\b/i, /\bresulted in\b/i, /\bbecause of (the|this) decision\b/i, /\bdue to (the|this) decision\b/i, /\btherefore\b.*\bdecision\b/i];

// §13, §28 — role/hierarchy words that would indicate an inferred organizational position
// rather than an explicit, supplied fact.
const OWNERSHIP_INFERENCE_PATTERNS = [/\bas the (ba|po|pm|business analyst|product owner|project manager)\b/i, /\bsince you are\b/i, /\byour manager\b/i, /\byou should delegate\b/i, /\byour management style\b/i];

function textOf(response: unknown): string {
  return JSON.stringify(response);
}

function evaluateCausalLanguage(response: unknown): AiEvaluationFinding {
  const text = textOf(response);
  const hit = CAUSAL_LANGUAGE_PATTERNS.find((p) => p.test(text));
  return finding("CAUSAL_LANGUAGE", hit ? "FAIL" : "PASS", hit ? `Matched causal-language pattern: ${hit}` : "No causal-language pattern matched.", hit ? String(hit) : undefined);
}

function evaluateOwnershipInference(response: unknown): AiEvaluationFinding {
  const text = textOf(response);
  const hit = OWNERSHIP_INFERENCE_PATTERNS.find((p) => p.test(text));
  return finding("OWNERSHIP_INFERENCE", hit ? "FAIL" : "PASS", hit ? `Matched ownership/hierarchy-inference pattern: ${hit}` : "No inferred-ownership/hierarchy language matched.", hit ? String(hit) : undefined);
}

/** Every evidence-reference-bearing response should reference at least some of what it was
 *  given when evidence was actually supplied — an empty reference list despite real
 *  evidence is a traceability gap, not necessarily wrong, but worth flagging. */
function evaluateEvidenceCoverage(evidenceProvided: string[], evidenceReferenced: string[]): AiEvaluationFinding {
  if (evidenceProvided.length === 0) {
    return finding("EVIDENCE_COVERAGE", "PASS", "No evidence was supplied, so none is expected to be referenced.");
  }
  const pass = evidenceReferenced.length > 0;
  return finding("EVIDENCE_COVERAGE", pass ? "PASS" : "FAIL", pass ? `${evidenceReferenced.length} of ${evidenceProvided.length} supplied evidence item(s) referenced.` : "Evidence was supplied but none was referenced in the response.");
}

/** V1.8 §10 — OVERCONFIDENT_OUTPUT: confidence should never be presented as high when
 *  almost nothing was supplied. Documented rule: confidence > 0.8 with fewer than 2
 *  fact/evidence inputs is a WARN (plausible but under-evidenced, not necessarily wrong);
 *  confidence > 0.8 with ZERO inputs is a FAIL (nothing at all to justify that confidence). */
function evaluateConfidenceConsistency(confidence: number, inputCount: number): AiEvaluationFinding {
  if (confidence > 0.8 && inputCount === 0) {
    return finding("CONFIDENCE_CONSISTENCY", "FAIL", `Confidence ${confidence} with zero input facts/evidence — nothing supports this confidence level.`, `confidence=${confidence}, inputCount=0`);
  }
  if (confidence > 0.8 && inputCount < 2) {
    return finding("CONFIDENCE_CONSISTENCY", "WARN", `Confidence ${confidence} looks high for only ${inputCount} input fact(s)/evidence item(s) — plausible but under-evidenced.`, `confidence=${confidence}, inputCount=${inputCount}`);
  }
  return finding("CONFIDENCE_CONSISTENCY", "PASS", `Confidence ${confidence} is consistent with ${inputCount} input fact(s)/evidence item(s).`);
}

function evaluateInsufficientEvidenceHandling(inputCount: number, insufficientEvidenceFlag: boolean | undefined): AiEvaluationFinding {
  if (inputCount > 0) return finding("INSUFFICIENT_EVIDENCE_HANDLING", "PASS", "Real input was supplied; insufficientEvidence is the response's own call.");
  const pass = insufficientEvidenceFlag === true;
  return finding("INSUFFICIENT_EVIDENCE_HANDLING", pass ? "PASS" : "FAIL", pass ? "No input facts/evidence were supplied and insufficientEvidence was correctly set." : "No input facts/evidence were supplied but insufficientEvidence was NOT set.");
}

/** Numeric claims (points/percent/days) in the narrative that don't appear (even loosely)
 *  in the supplied facts/evidence are a real, deterministic hallucination signal — the
 *  model can only have gotten a specific number from the facts it was given. */
function evaluateUnsupportedClaims(narrativeText: string, inputFacts: string[]): AiEvaluationFinding {
  const numericClaims = narrativeText.match(/\d+(\.\d+)?\s?(%|points?|days?|minutes?|mins?)\b/gi) ?? [];
  const factsBlob = inputFacts.join(" ");
  const unsupported = numericClaims.filter((claim) => !factsBlob.includes(claim.replace(/\s+/g, " ")));
  return finding(
    "UNSUPPORTED_CLAIMS",
    unsupported.length === 0 ? "PASS" : "FAIL",
    unsupported.length === 0 ? "Every numeric claim in the narrative also appears in the supplied facts." : `Numeric claim(s) not found verbatim in supplied facts: ${unsupported.join(", ")}`,
    unsupported.length > 0 ? unsupported.join(", ") : undefined
  );
}

export interface AiEvaluationInput {
  task: string;
  response: unknown;
  schemaValid: boolean;
  narrativeText: string; // the human-readable prose fields of the response, concatenated
  inputFacts: string[];
  inputEvidence: string[];
  evidenceReferenced?: string[]; // present only for schemas with an explicit evidence-reference field
  confidence: number;
  insufficientEvidenceFlag?: boolean;
}

export function evaluateAiResponse(input: AiEvaluationInput): AiEvaluationResult {
  const findings: AiEvaluationFinding[] = [
    finding("SCHEMA_VALIDITY", input.schemaValid ? "PASS" : "FAIL", input.schemaValid ? "Response matched its declared schema." : "Response failed schema validation."),
    evaluateCausalLanguage(input.response),
    evaluateOwnershipInference(input.response),
    evaluateConfidenceConsistency(input.confidence, input.inputFacts.length + input.inputEvidence.length),
    evaluateInsufficientEvidenceHandling(input.inputFacts.length + input.inputEvidence.length, input.insufficientEvidenceFlag),
    evaluateUnsupportedClaims(input.narrativeText, [...input.inputFacts, ...input.inputEvidence]),
  ];
  if (input.evidenceReferenced !== undefined) {
    findings.splice(2, 0, evaluateEvidenceCoverage(input.inputEvidence, input.evidenceReferenced));
  }

  return {
    task: input.task,
    findings,
    passCount: findings.filter((f) => f.severity === "PASS").length,
    warnCount: findings.filter((f) => f.severity === "WARN").length,
    failCount: findings.filter((f) => f.severity === "FAIL").length,
  };
}
