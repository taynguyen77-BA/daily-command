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

// ===== V2.36 H5 — Grounding guard ======================================================
// Every AI output that references a ticket key, a person, a number or a date must match the
// facts it was given. Deterministic, run server-side on every model answer (server-runner.ts):
// a violation → one retry with the violations listed → still violating → rejected, and the
// browser falls back to the deterministic text. "Supplied facts" = the exact text the model
// was shown (the server-built prompt), so anything the model could legitimately have read is
// allowed and anything else is invented.

export interface GroundingResult {
  ok: boolean;
  violations: string[];
}

const TICKET_KEY = /\b[A-Z][A-Z0-9_]{1,19}-\d{1,9}\b/g;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const WORDY_DATE = new RegExp(`\\b(?:(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})(?:\\s+\\d{4})?)\\b`, "gi");
const MONTH_INDEX: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const PLACEHOLDER = /\[[A-Z_]+_\d+\]/g;
const uniq = (a: string[]): string[] => Array.from(new Set(a));
// Capitalized words that are not names — headings, weekdays, months, product nouns.
const NOT_A_NAME = new Set(
  "the a an and or but if this that these those it its i we you they he she hi hello team next last first new open done blocked status sprint release ticket tickets jira project client clients summary risk risks gap gaps question questions action actions decision decisions recommendation recommended tomorrow today yesterday week weekly daily monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december executive what why how when where who carry over starting point priorities priority focus watch plan high medium low critical outcome assessment impact acceptance criteria description comment comments linked issue issues story epic bug task subtask dev qa uat api ui ux product owner manager analyst business no none not overall confidence trend evidence fact facts option options upside downside tradeoffs please note also however because given based per".split(" ")
);

/** Every string value in a JSON-like output (structured numeric fields like confidence are
 *  not narrative and are not checked here). */
export function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(collectStrings);
  return [];
}

function wordyDateKey(m: string): string | null {
  const parts = m.toLowerCase().replace(/(st|nd|rd|th)\b/g, "").match(/[a-z]+|\d+/g) ?? [];
  const month = parts.find((p) => /[a-z]/.test(p));
  const day = parts.find((p) => /^\d{1,2}$/.test(p));
  if (!month || !day) return null;
  const mi = MONTH_INDEX[month.slice(0, 3)];
  return mi ? `${String(mi).padStart(2, "0")}-${day.padStart(2, "0")}` : null;
}

function normalizeNumber(n: string): string {
  const v = Number(n.replace(/,/g, ""));
  return Number.isFinite(v) ? String(v) : n;
}

export function checkGrounding(output: unknown, suppliedText: string): GroundingResult {
  const violations: string[] = [];
  const outText = collectStrings(output).join("\n");
  const facts = suppliedText;

  // 1. Ticket keys
  const factKeys = new Set(facts.match(TICKET_KEY) ?? []);
  for (const k of uniq(outText.match(TICKET_KEY) ?? [])) {
    if (!factKeys.has(k)) violations.push(`ticket key ${k} is not in the supplied facts`);
  }

  // 2. Dates (ISO, and "Oct 3" / "3 October" style matched by month-day)
  const factIso = new Set(facts.match(ISO_DATE) ?? []);
  const factMonthDays = new Set<string>(Array.from(factIso).map((d) => d.slice(5)));
  for (const m of facts.match(WORDY_DATE) ?? []) {
    const k = wordyDateKey(m);
    if (k) factMonthDays.add(k);
  }
  for (const d of uniq(outText.match(ISO_DATE) ?? [])) {
    if (!factIso.has(d)) violations.push(`date ${d} is not in the supplied facts`);
  }
  for (const m of uniq(outText.match(WORDY_DATE) ?? [])) {
    const k = wordyDateKey(m);
    if (k && !factMonthDays.has(k)) violations.push(`date "${m}" is not in the supplied facts`);
  }

  // 3. Numbers — after removing keys, dates and placeholders (their digits are checked above).
  //    List numbering at the start of a line ("1. …") is formatting, not a claim.
  const strip = (t: string) => t.replace(TICKET_KEY, " ").replace(ISO_DATE, " ").replace(WORDY_DATE, " ").replace(PLACEHOLDER, " ");
  const numbersIn = (t: string) => (t.match(/(?<![\w.])\d[\d,]*(?:\.\d+)?/g) ?? []).map(normalizeNumber);
  const factNumbers = new Set(numbersIn(strip(facts)));
  const outForNumbers = strip(outText).replace(/^\s*\d+[.)]\s/gm, " ");
  for (const n of uniq(numbersIn(outForNumbers))) {
    if (!factNumbers.has(n)) violations.push(`number ${n} is not in the supplied facts`);
  }

  // 4. People — "@Name" mentions, and capitalized "First Last" pairs where neither word appears
  //    anywhere in the facts (a real name the model read always shares a word with the facts).
  const factsLower = facts.toLowerCase();
  for (const m of uniq(outText.match(/@[A-Za-z][\w.-]{1,40}/g) ?? [])) {
    if (!factsLower.includes(m.slice(1).toLowerCase())) violations.push(`person ${m} is not in the supplied facts`);
  }
  for (const m of uniq(outText.match(/\b[A-Z][a-z]{1,20}\s[A-Z][a-z]{1,20}\b/g) ?? [])) {
    const words: string[] = m.split(/\s/);
    if (words.some((w) => NOT_A_NAME.has(w.toLowerCase()))) continue;
    if (words.every((w) => !new RegExp(`\\b${w}\\b`, "i").test(facts))) violations.push(`person "${m}" is not in the supplied facts`);
  }

  return { ok: violations.length === 0, violations };
}
