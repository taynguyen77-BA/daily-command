// D3 — the client-safe half of the self-test (types, the up-front token estimate, the printed table). No server imports, so the
// Data & Settings component can use it; selftest.ts (the orchestrator) re-exports everything here.

import type { AiModelTier } from "./model-config";
import type { AiFailureReason } from "./outcome";
import { SELFTEST_FIXTURES, quickFixtures, type SelfTestFixture } from "./selftest-fixtures";

export type SelfTestOutcome = "PASS" | "WARN" | "FAIL" | "SKIPPED";
export interface RubricItem { name: string; pass: boolean; detail: string }
export interface SelfTestRow {
  id: string;
  task: string;
  label: string;
  model: string;
  tier: AiModelTier;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  outcome: SelfTestOutcome;
  errorKind?: string;
  httpStatus?: number;
  schemaOk: boolean;
  groundingOk: boolean;
  repaired: boolean;
  retried: boolean;
  /** V2.52 A4 — a call of this row stopped at max_tokens (even if the retry then succeeded). */
  truncated?: boolean;
  /** V2.52 A4 — the plain failure reason (explainAiFailure) when the row failed. */
  reason?: AiFailureReason;
  rubric: RubricItem[];
  estCostUsd: number | null;
  note?: string;
}
export interface SelfTestReport {
  mode: "quick" | "full";
  rows: SelfTestRow[];
  totalTokens: number;
  ceilingReached: boolean;
  estCostUsd: number;
  priceVerifiedOn: string;
}

export const estimateSelfTestTokens = (mode: "quick" | "full", fixtures: SelfTestFixture[] = mode === "quick" ? quickFixtures() : SELFTEST_FIXTURES): number => fixtures.reduce((n, f) => n + f.estTokens, 0);

/** The table the script prints and the UI's "Copy report" produces. */
export function formatSelfTestTable(report: SelfTestReport): string {
  const head = `AI self-test (${report.mode}) — ${report.totalTokens.toLocaleString("en-US")} tokens, est. $${report.estCostUsd.toFixed(4)} (estimate; prices verified ${report.priceVerifiedOn})`;
  const lines = report.rows.map((r) => `${r.outcome.padEnd(7)} ${r.label.padEnd(34)} ${r.model.padEnd(18)} ${String(r.ms).padStart(6)} ms  ${String(r.inputTokens + r.outputTokens).padStart(6)} tok  ${r.note ?? ""}`);
  return [head, ...lines, ...(report.ceilingReached ? ["(token ceiling reached — remaining rows skipped)"] : [])].join("\n");
}
