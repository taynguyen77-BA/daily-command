import fs from "node:fs";
import path from "node:path";

// Shared check harness for the split test suite (see run.mts).
// ok() logs one check; skip() logs an environment capability gap (never counted as passed).

let passed = 0;
let failures = 0;
let skipped = 0;

export function ok(group: string, cond: boolean, msg: string) {
  console.log(`${cond ? "✅" : "❌"} [${group}] ${msg}`);
  if (cond) passed++;
  else failures++;
}
/** An environment capability gap, not a failure: logged visibly, never counted as passed. */
export function skip(group: string, msg: string) {
  console.log(`⏭️  [${group}] SKIPPED — ${msg}`);
  skipped++;
}

/** C3 — fold in the checks of a child process (the perf files). */
export function addCounts(p: number, f: number, s: number) {
  passed += p;
  failures += f;
  skipped += s;
}

export function counts() {
  return { passed, failures, skipped, total: passed + failures };
}

/** Scales a timing budget for slow machines/CI: PERF_BUDGET_FACTOR (default 1; NaN and <= 0 are ignored). */
export function perfBudget(ms: number): number {
  const factor = Number(process.env.PERF_BUDGET_FACTOR || 1);
  return ms * (Number.isFinite(factor) && factor > 0 ? factor : 1);
}

/** C3 — median of the samples (the budget applies to the median, not to a single GC-prone sample). */
export function median(samples: readonly number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/** C3 — one discarded warm-up run (JIT), then the median of `runs` timed runs. Returns the last result too. */
export function measureMedianMs<T>(fn: () => T, runs = 5): { ms: number; samples: number[]; result: T } {
  let result = fn(); // warm-up, discarded
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    result = fn();
    samples.push(performance.now() - t0);
  }
  return { ms: median(samples), samples, result };
}

/** C3 — the documentation set: README.md (entry point) plus docs/CONFIG.md and docs/RELEASE-NOTES.md (moved verbatim from the
 *  old README). Doc-content assertions read this so they still assert the same facts after the split. */
export function readDocs(): string {
  return ["README.md", "docs/CONFIG.md", "docs/RELEASE-NOTES.md"].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8")).join("\n");
}
