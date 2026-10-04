// H2 — redaction pass before anything ticket-derived reaches the model. Pure and deterministic
// so the same rules run in the browser (before the request leaves) and again on the server
// (belt-and-braces over whatever the server receives).
//
//   - emails, phone numbers, URLs carrying tokens, Jira account ids, card- and IBAN-like numbers
//     → numbered placeholders ([EMAIL_1] …). The same value gets the same placeholder within one
//     session, so the model can still say "the same person replied twice". Placeholders are NOT
//     restored in the output — the original never reached the model and isn't needed there.
//   - an optional custom terms list (e.g. client names) → the user's alias (or CLIENT_n), and the
//     alias IS restored in the output, so the reader sees the real name again.

export interface CustomTerm {
  term: string;
  alias?: string;
}

export type RedactionKind = "URL_WITH_TOKEN" | "EMAIL" | "IBAN" | "CARD" | "ACCOUNT_ID" | "PHONE";

const TOKEN_QUERY = /[?&#](?:[\w-]*(?:token|key|sig|signature|secret|auth|password|passwd|pwd|session|code|credential)[\w-]*)=/i;
const LONG_OPAQUE_SEGMENT = /\/[A-Za-z0-9_\-]{32,}(?:[/?#]|$)/;

// Order matters: URLs first (they can contain emails/ids), account ids before cards/phones.
const PATTERNS: { kind: RedactionKind; re: RegExp; accept?: (m: string) => boolean }[] = [
  { kind: "URL_WITH_TOKEN", re: /\bhttps?:\/\/[^\s<>"')\]]+/gi, accept: (m) => TOKEN_QUERY.test(m) || LONG_OPAQUE_SEGMENT.test(m) },
  { kind: "EMAIL", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: "ACCOUNT_ID", re: /\b\d{5,6}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  // Classic Jira Cloud account ids: 24 lowercase alphanumerics mixing letters and digits.
  { kind: "ACCOUNT_ID", re: /\b(?=[0-9a-z]*[a-z])(?=[0-9a-z]*\d)[0-9a-z]{24}\b/g },
  { kind: "IBAN", re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g },
  { kind: "CARD", re: /\b\d(?:[ -]?\d){12,18}\b/g },
  { kind: "PHONE", re: /(?<![\w-])\+\d[\d\s().-]{7,17}\d\b/g },
  { kind: "PHONE", re: /(?<![\w-])(?:\(\d{2,4}\)\s?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}(?![\w-])/g },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class RedactionSession {
  private byValue = new Map<string, string>();
  private counters: Partial<Record<RedactionKind, number>> = {};
  readonly counts: Record<RedactionKind | "CUSTOM_TERM", number> = { URL_WITH_TOKEN: 0, EMAIL: 0, IBAN: 0, CARD: 0, ACCOUNT_ID: 0, PHONE: 0, CUSTOM_TERM: 0 };
  private readonly terms: { re: RegExp; term: string; alias: string }[];

  constructor(customTerms: CustomTerm[] = []) {
    const clean = customTerms
      .map((t) => ({ term: t.term.trim(), alias: t.alias?.trim() }))
      .filter((t) => t.term.length >= 2)
      // longest first, so "Acme Bank" wins over "Acme"
      .sort((a, b) => b.term.length - a.term.length);
    this.terms = clean.map((t, i) => ({
      term: t.term,
      alias: t.alias || `CLIENT_${i + 1}`,
      re: new RegExp(`(?<![\\w])${escapeRe(t.term)}(?![\\w])`, "gi"),
    }));
  }

  private placeholder(kind: RedactionKind, value: string): string {
    const key = `${kind}:${value.toLowerCase()}`;
    const existing = this.byValue.get(key);
    if (existing) return existing;
    const n = (this.counters[kind] ?? 0) + 1;
    this.counters[kind] = n;
    const ph = `[${kind}_${n}]`;
    this.byValue.set(key, ph);
    return ph;
  }

  /** Pattern-based redaction only (no custom terms) — what the server re-runs. */
  redactPatterns(text: string): string {
    let out = text;
    for (const { kind, re, accept } of PATTERNS) {
      out = out.replace(re, (m) => {
        if (accept && !accept(m)) return m;
        this.counts[kind]++;
        return this.placeholder(kind, m);
      });
    }
    return out;
  }

  redact(text: string): string {
    let out = this.redactPatterns(text);
    for (const t of this.terms) {
      out = out.replace(t.re, () => {
        this.counts.CUSTOM_TERM++;
        return t.alias;
      });
    }
    return out;
  }

  /** Aliases → the real terms again, for display. Placeholders stay as they are. */
  restore(text: string): string {
    let out = text;
    for (const t of this.terms) {
      out = out.replace(new RegExp(`(?<![\\w])${escapeRe(t.alias)}(?![\\w])`, "g"), t.term);
    }
    return out;
  }

  /** Restores aliases in every string of a JSON-like value. */
  restoreDeep<T>(value: T): T {
    return mapStrings(value, (s) => this.restore(s));
  }

  get totalRedactions(): number {
    return Object.values(this.counts).reduce((a, b) => a + b, 0);
  }
}

export function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === "string") return fn(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = mapStrings(v, fn);
    return out as T;
  }
  return value;
}

/** Server-side belt-and-braces: pattern redaction over every string of a request input. */
export function redactPatternsDeep<T>(value: T): T {
  const session = new RedactionSession();
  return mapStrings(value, (s) => session.redactPatterns(s));
}

/** Data & Settings text box ↔ list. One term per line, optional alias after "=>". */
export function parseCustomTermsText(text: string): CustomTerm[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 100)
    .map((line) => {
      const [term, alias] = line.split("=>").map((s) => s.trim());
      return alias ? { term, alias } : { term };
    })
    .filter((t) => t.term.length >= 2 && t.term.length <= 100);
}

export function formatCustomTerms(terms: CustomTerm[]): string {
  return terms.map((t) => (t.alias ? `${t.term} => ${t.alias}` : t.term)).join("\n");
}
