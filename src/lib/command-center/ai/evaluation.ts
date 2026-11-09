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
export const CAUSAL_LANGUAGE_PATTERNS = [/\bcaused\b/i, /\bled to\b/i, /\bresulted in\b/i, /\bbecause of (the|this) decision\b/i, /\bdue to (the|this) decision\b/i, /\btherefore\b.*\bdecision\b/i];

// §13, §28 — role/hierarchy words that would indicate an inferred organizational position
// rather than an explicit, supplied fact.
export const OWNERSHIP_INFERENCE_PATTERNS = [/\bas the (ba|po|pm|business analyst|product owner|project manager)\b/i, /\bsince you are\b/i, /\byour manager\b/i, /\byou should delegate\b/i, /\byour management style\b/i];

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

// ===== V2.36 H5 / D2 — Grounding guard ================================================
// Every AI output that references a ticket key, a person, a number or a date must match the
// facts it was given. Deterministic, run server-side on every model answer (server-runner.ts):
// a violation → one retry with the violations listed → still violating → rejected, and the
// browser falls back to the deterministic text. "Supplied facts" = the exact text the model
// was shown (the server-built prompt), so anything the model could legitimately have read is
// allowed and anything else is invented.
//
// D2 (v2): dates are PARSED (ISO, d/m, d/m/yyyy, d-m, "ngày d tháng m", "tháng m", "Month d", "d Month",
// "27th of October") in BOTH facts and output, compared by month-day (and year when both carry one; d/m vs m/d
// is accepted when either reading matches), then removed from the number scan. List markers ("Step 1", "Bước 2",
// "1)", "(2)", "#3") are formatting. Per-task policy "counts" accepts "n tickets/blockers/…" when n <= 12 and
// n <= the number of ticket keys (or listed items) in the prompt. People are flagged only in a naming context.

export type GroundingViolationKind = "key" | "date" | "number" | "person";
/** "strict": every number must be in the facts (reports, rewrites, locked facts). "counts": narrative tasks may state derived counts. */
export type GroundingPolicy = "strict" | "counts";

export interface GroundingResult {
  ok: boolean;
  violations: string[];
  /** Same order as `violations` (telemetry: which rule fired). */
  kinds: GroundingViolationKind[];
}

const TICKET_KEY = /\b[A-Z][A-Z0-9_]{1,19}-\d{1,9}\b/g;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const ORD = "(?:st|nd|rd|th)?";
const WORDY_DATE = new RegExp(`\\b(?:(?:${MONTHS})\\.?\\s+\\d{1,2}${ORD}(?:,?\\s+\\d{4})?|\\d{1,2}${ORD}(?:\\s+of)?\\s+(?:${MONTHS})(?:,?\\s+\\d{4})?)\\b`, "gi");
// Vietnamese: "ngày 27 tháng 10 (năm 2026)", "27 tháng 10", "tháng 10" (month only)
const VN_DATE = /(?:ngày\s+)?\b(\d{1,2})\s+tháng\s+(\d{1,2})(?:\s+năm\s+(\d{4}))?|\btháng\s+(\d{1,2})\b(?!\s+(?:\d|trước|nay))/gi;
// d/m, d/m/yy(yy), d-m, d-m-yyyy, d.m.yyyy  — a unit right after (days, %, …) means it is not a date
const NUM_DATE = /(?<![\w./-])(\d{1,2})([/.-])(\d{1,2})(?:\2(\d{4}|\d{2}))?(?![\w/-]|\.\d|\s*(?:days?|ngày|hours?|giờ|weeks?|tuần|%|points?|pts?|h\b))/gi;
const MONTH_INDEX: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const PLACEHOLDER = /\[[A-Z_]+_\d+\]/g;
const uniq = <T,>(a: T[]): T[] => Array.from(new Set(a));
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

// ---- dates -------------------------------------------------------------------------------------------------
interface DateTok { raw: string; /** candidate [month, day] readings (d/m vs m/d ambiguity gives two) */ md: Array<[number, number]>; year?: number; monthOnly?: number }

const validMd = (m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= 31;
const fullYear = (y: string | undefined) => (y === undefined ? undefined : y.length === 2 ? 2000 + Number(y) : Number(y));

function wordyDate(m: string): DateTok | null {
  const parts = m.toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1").match(/[a-z]+|\d+/g) ?? [];
  const month = parts.find((p) => /[a-z]/.test(p) && p !== "of");
  const nums = parts.filter((p) => /^\d+$/.test(p));
  const day = nums.find((p) => p.length <= 2);
  const year = nums.find((p) => p.length === 4);
  if (!month || !day) return null;
  const mi = MONTH_INDEX[month.slice(0, 3)];
  return mi && validMd(mi, Number(day)) ? { raw: m, md: [[mi, Number(day)]], ...(year ? { year: Number(year) } : {}) } : null;
}

/** Parses every date-like token in `text`; returns them and the text with those tokens blanked (for the number scan). */
export function extractDates(text: string): { dates: DateTok[]; rest: string } {
  const dates: DateTok[] = [];
  let rest = text.replace(ISO_DATE, (raw) => {
    const [y, m, d] = raw.split("-").map(Number);
    if (validMd(m, d)) dates.push({ raw, md: [[m, d]], year: y });
    return " ";
  });
  rest = rest.replace(WORDY_DATE, (raw) => { const t = wordyDate(raw); if (t) dates.push(t); return " "; });
  rest = rest.replace(VN_DATE, (raw, d, m, y, mo) => {
    if (mo !== undefined) { const mm = Number(mo); if (mm >= 1 && mm <= 12) dates.push({ raw, md: [], monthOnly: mm }); return " "; }
    if (validMd(Number(m), Number(d))) dates.push({ raw, md: [[Number(m), Number(d)]], ...(y ? { year: Number(y) } : {}) });
    return " ";
  });
  rest = rest.replace(NUM_DATE, (raw, a, _sep, b, y) => {
    const A = Number(a), B = Number(b);
    const md: Array<[number, number]> = [];
    if (validMd(B, A)) md.push([B, A]); // d/m (Vietnamese and European order)
    if (A !== B && validMd(A, B)) md.push([A, B]); // m/d reading
    if (md.length === 0) return raw; // not a date (e.g. 45/50) — leave for the number scan
    dates.push({ raw, md, ...(y ? { year: fullYear(y) } : {}) });
    return " ";
  });
  return { dates, rest };
}

function dateInFacts(tok: DateTok, facts: DateTok[], factNumbers: ReadonlySet<string>): boolean {
  if (tok.monthOnly !== undefined) return facts.some((f) => f.md.some(([m]) => m === tok.monthOnly) || f.monthOnly === tok.monthOnly);
  for (const f of facts) {
    if (f.md.length === 0) continue;
    const mdMatch = tok.md.some(([m, d]) => f.md.some(([fm, fd]) => fm === m && fd === d));
    if (!mdMatch) continue;
    if (tok.year !== undefined && f.year !== undefined && tok.year !== f.year) continue;
    return true;
  }
  // "3/5" read as a fraction: both numbers are themselves in the facts.
  if (tok.year === undefined && /^\d{1,2}[/.-]\d{1,2}$/.test(tok.raw)) {
    const [a, b] = tok.raw.split(/[/.-]/).map(normalizeNumber);
    if (factNumbers.has(a) && factNumbers.has(b)) return true;
  }
  return false;
}

function normalizeNumber(n: string): string {
  const v = Number(n.replace(/,/g, ""));
  return Number.isFinite(v) ? String(v) : n;
}

// ---- markers, counts, people -----------------------------------------------------------------------------
const LIST_MARKERS = /\b(?:step|bước|buoc)\s+\d{1,2}\b|(?:^|[\s(])\(\d{1,2}\)(?=\s)|(?<=^|\s)\d{1,2}\)(?=\s)|(?<![\w&])#\d{1,3}\b/gim;
const COUNT_NOUN = /\b(\d{1,2})\s+(?:open\s+|new\s+|unresolved\s+|linked\s+)?(?:tickets?|items?|blockers?|comments?|mentions?|questions?|issues?|risks?|dependencies)\b/gi;
const NAME_BEFORE = /(?:\b(?:by|from|to|cc|ask|ping|owner|assigned to|assignee|reporter|with)\s+)$/i;
const NAME_AFTER = /^\s+(?:said|replied|commented|approved|confirmed|asked|owns|wrote|mentioned)\b/i;

export function checkGrounding(output: unknown, suppliedText: string, policy: GroundingPolicy = "strict"): GroundingResult {
  const violations: string[] = [];
  const kinds: GroundingViolationKind[] = [];
  const add = (kind: GroundingViolationKind, msg: string) => { kinds.push(kind); violations.push(msg); };
  const outText = collectStrings(output).join("\n");
  const facts = suppliedText;

  // 1. Ticket keys
  const factKeysList = facts.match(TICKET_KEY) ?? [];
  const factKeys = new Set(factKeysList);
  for (const k of uniq(outText.match(TICKET_KEY) ?? [])) {
    if (!factKeys.has(k)) add("key", `ticket key ${k} is not in the supplied facts`);
  }

  // 2. Dates — parsed in both, compared by month-day (+ year when both carry one).
  const factDates = extractDates(facts);
  const outDates = extractDates(outText);
  const numbersIn = (t: string) => (t.match(/(?<![\w.])\d[\d,]*(?:\.\d+)?/g) ?? []).map(normalizeNumber);
  const strip = (t: string) => t.replace(TICKET_KEY, " ").replace(PLACEHOLDER, " ").replace(LIST_MARKERS, " ");
  const factNumbers = new Set(numbersIn(strip(factDates.rest)));
  const seenDates = new Set<string>();
  for (const t of outDates.dates) {
    const id = t.raw.toLowerCase();
    if (seenDates.has(id)) continue;
    seenDates.add(id);
    if (!dateInFacts(t, factDates.dates, factNumbers)) add("date", `date "${t.raw.trim()}" is not in the supplied facts`);
  }

  // 3. Numbers — after removing keys, dates, placeholders and list markers.
  let outForNumbers = strip(outDates.rest).replace(/^\s*\d+[.)]\s/gm, " ");
  if (policy === "counts") {
    const bullets = (facts.match(/^\s*(?:[-*•]|\d+[.)])\s+\S/gm) ?? []).length;
    const allowed = Math.max(new Set(factKeysList).size, bullets);
    outForNumbers = outForNumbers.replace(COUNT_NOUN, (m, n) => (Number(n) <= 12 && Number(n) <= allowed ? " " : m));
  }
  for (const n of uniq(numbersIn(outForNumbers))) {
    if (!factNumbers.has(n)) add("number", `number ${n} is not in the supplied facts`);
  }

  // 4. People — "@Name", and capitalized "First Last" pairs in a naming context (by/from/to/cc/assigned to/ask/ping/owner … or
  //    followed by said/replied/…) where neither word appears anywhere in the facts. "Go Live", "Slack Channel" are not people.
  const factsLower = facts.toLowerCase();
  for (const m of uniq(outText.match(/@[A-Za-z][\w.-]{1,40}/g) ?? [])) {
    if (!factsLower.includes(m.slice(1).toLowerCase())) add("person", `person ${m} is not in the supplied facts`);
  }
  const pair = /\b[A-Z][a-z]{1,20}\s[A-Z][a-z]{1,20}\b/g;
  const flaggedPeople = new Set<string>();
  for (let mm = pair.exec(outText); mm; mm = pair.exec(outText)) {
    const name = mm[0];
    pair.lastIndex = mm.index + 1; // overlapping scan: "Ask Marcus Wright" must still reach "Marcus Wright"
    if (flaggedPeople.has(name)) continue;
    const words: string[] = name.split(/\s/);
    if (words.some((w) => NOT_A_NAME.has(w.toLowerCase()))) continue;
    const before = outText.slice(Math.max(0, mm.index - 16), mm.index);
    const after = outText.slice(mm.index + name.length, mm.index + name.length + 14);
    if (!NAME_BEFORE.test(before) && !NAME_AFTER.test(after)) continue;
    if (words.every((w) => !new RegExp(`\\b${w}\\b`, "i").test(facts))) { flaggedPeople.add(name); add("person", `person "${name}" is not in the supplied facts`); }
  }

  return { ok: violations.length === 0, violations, kinds };
}
