// D3 — the AI self-test orchestrator. Runs the synthetic fixtures sequentially through handleAiRequest (the SAME path real calls take:
// schema, grounding guard, repair, ledger) with an injected callModel, and grades each answer with a rubric. Pure apart from the injected
// model/ledger, so it is tested offline with a fake model and used unchanged by the route and by scripts/ai-smoke.mts.

import { handleAiRequest, ResponseCache, type AiServerDeps, type ModelCallParams, type ModelCallResult } from "./server-runner";
import { collectStrings } from "./evaluation";
import { resolveAiModel } from "./model-config";
import { SELFTEST_FIXTURES, quickFixtures, type SelfTestFixture } from "./selftest-fixtures";
import { estimateSelfTestTokens, formatSelfTestTable, type RubricItem, type SelfTestOutcome, type SelfTestReport, type SelfTestRow } from "./selftest-shared";

export { estimateSelfTestTokens, formatSelfTestTable };
export type { RubricItem, SelfTestOutcome, SelfTestReport, SelfTestRow };

export const DEFAULT_SELFTEST_MAX_TOKENS = 60_000;

/** USD per million tokens (base input / output), from Anthropic's pricing page. An ESTIMATE: cache pricing and prompts over 100k tokens are not modelled. */
export const PRICE_PER_MTOK = {
  verifiedOn: "2026-11-05",
  source: "https://platform.claude.com/docs/en/about-claude/pricing",
  models: {
    "claude-haiku-5-5": { in: 0.1, out: 0.5 },
    "claude-sonnet-5-5": { in: 2, out: 10 },
    "claude-opus-5-5": { in: 4, out: 20 },
    "claude-fable-5-1": { in: 10, out: 50 },
  } as Record<string, { in: number; out: number }>,
};
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = PRICE_PER_MTOK.models[model];
  return p ? Math.round(((inputTokens * p.in + outputTokens * p.out) / 1_000_000) * 1e6) / 1e6 : null;
}

/** Share of letters carrying a Vietnamese-specific diacritic. */
export function vietnameseRatio(text: string): number {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 0;
  const vi = text.match(/[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/gi) ?? [];
  return vi.length / letters.length;
}

const PLACEHOLDER_LEAK = /\[[A-Z_]+_\d+\]|\b(?:CLIENT|PERSON|EMAIL)_\d+\b/g;

export function gradeAnswer(f: SelfTestFixture, data: unknown, model: string, expectedModel: string): RubricItem[] {
  const strings = collectStrings(data);
  const text = strings.join("\n");
  const rubric: RubricItem[] = [];
  const ratio = vietnameseRatio(text);
  if (f.expect.language === "vi") rubric.push({ name: "language", pass: ratio >= 0.04, detail: ratio >= 0.04 ? "Vietnamese" : `expected Vietnamese, diacritic ratio ${(ratio * 100).toFixed(1)}%` });
  else if (f.expect.language === "en") rubric.push({ name: "language", pass: ratio < 0.02, detail: ratio < 0.02 ? "English" : `expected English, found Vietnamese (${(ratio * 100).toFixed(1)}%)` });
  const leaks = text.match(PLACEHOLDER_LEAK) ?? [];
  rubric.push({ name: "no placeholder leak", pass: leaks.length === 0, detail: leaks.length === 0 ? "none" : `leaked ${leaks[0]}` });
  for (const key of f.expect.mustMention ?? []) rubric.push({ name: `mentions ${key}`, pass: text.includes(key), detail: text.includes(key) ? "found" : "missing from the answer" });
  for (const bad of f.expect.mustNotContain ?? []) {
    if (typeof bad !== "string" && bad.source.includes("A-Z_")) continue; // the placeholder pattern is graded above
    const hit = typeof bad === "string" ? text.includes(bad) : bad.test(text);
    rubric.push({ name: `avoids ${String(bad)}`, pass: !hit, detail: hit ? "found" : "absent" });
  }
  if (f.expect.maxChars) {
    const longest = Math.max(0, ...strings.map((s) => s.length));
    rubric.push({ name: "length limit", pass: longest <= f.expect.maxChars, detail: `longest field ${longest} / ${f.expect.maxChars}` });
  }
  rubric.push({ name: "tier model", pass: model === expectedModel, detail: model === expectedModel ? model : `used ${model}, expected ${expectedModel}` });
  return rubric;
}

export interface RunSelfTestArgs {
  mode: "quick" | "full";
  deps: Omit<AiServerDeps, "cache" | "selftest">;
  fixtures?: SelfTestFixture[];
  maxTokens?: number;
  /** Called after each row (the UI / script prints progress). */
  onRow?: (row: SelfTestRow) => void;
}

export async function runSelfTest(args: RunSelfTestArgs): Promise<SelfTestReport> {
  const fixtures = args.fixtures ?? (args.mode === "quick" ? quickFixtures() : SELFTEST_FIXTURES);
  const ceiling = args.maxTokens ?? DEFAULT_SELFTEST_MAX_TOKENS;
  const rows: SelfTestRow[] = [];
  let total = 0;
  let ceilingReached = false;
  for (const f of fixtures) {
    const resolved = resolveAiModel(f.task, args.deps.env);
    const base = { id: f.id, task: f.task, label: f.label, model: resolved.model, tier: resolved.tier };
    if (total >= ceiling) {
      ceilingReached = true;
      const row: SelfTestRow = { ...base, ms: 0, inputTokens: 0, outputTokens: 0, outcome: "SKIPPED", schemaOk: false, groundingOk: false, repaired: false, retried: false, rubric: [], estCostUsd: null, note: `Skipped: the run's token ceiling (${ceiling.toLocaleString("en-US")}) was reached` };
      rows.push(row);
      args.onRow?.(row);
      continue;
    }
    let calls = 0;
    let inTok = 0;
    let outTok = 0;
    let usedModel = resolved.model;
    const callModel = async (p: ModelCallParams): Promise<ModelCallResult> => {
      calls += 1;
      usedModel = p.model;
      const r = await args.deps.callModel(p);
      inTok += r.usage.inputTokens + r.usage.cacheReadTokens + r.usage.cacheWriteTokens;
      outTok += r.usage.outputTokens;
      return r;
    };
    const t0 = args.deps.now().getTime();
    // A fresh cache per fixture: the dedupe cache must never answer a self-test from an earlier run.
    const res = await handleAiRequest({ task: f.task, input: f.input }, { ...args.deps, callModel, cache: new ResponseCache(), selftest: true });
    const ms = Math.max(0, args.deps.now().getTime() - t0);
    total += inTok + outTok;
    const errorKind = typeof res.body.errorKind === "string" ? res.body.errorKind : undefined;
    const ok = res.status === 200;
    const rubric = ok ? gradeAnswer(f, res.body.data, usedModel, resolved.model) : [];
    const failedRubric = rubric.filter((r) => !r.pass);
    const row: SelfTestRow = {
      ...base,
      model: usedModel,
      ms,
      inputTokens: inTok,
      outputTokens: outTok,
      outcome: !ok ? "FAIL" : failedRubric.length === 0 ? "PASS" : "WARN",
      ...(errorKind ? { errorKind } : {}),
      ...(!ok ? { httpStatus: res.status } : {}),
      schemaOk: ok || errorKind !== "invalid-output",
      groundingOk: ok || errorKind !== "grounding-rejected",
      repaired: calls > 1 && ok,
      retried: calls > 1,
      rubric,
      estCostUsd: estimateCostUsd(usedModel, inTok, outTok),
      ...(!ok ? { note: String(res.body.error ?? "") } : failedRubric.length ? { note: `${failedRubric[0].name}: ${failedRubric[0].detail}` } : {}),
    };
    rows.push(row);
    args.onRow?.(row);
  }
  return { mode: args.mode, rows, totalTokens: total, ceilingReached, estCostUsd: Math.round(rows.reduce((s, r) => s + (r.estCostUsd ?? 0), 0) * 1e6) / 1e6, priceVerifiedOn: PRICE_PER_MTOK.verifiedOn };
}

