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

export function counts() {
  return { passed, failures, skipped, total: passed + failures };
}
