// C3 — the wall-clock budget files, run on their own so they start with a clean heap.
// `npm run test:perf` runs just these; `npm test` (run.mts) runs every functional file first and then
// spawns THIS file in a child process and counts its checks. The last line is a machine-readable summary.

import { counts } from "./harness.mts";

export const PERF_FILES = ["./25-performance-budget.test.mts", "./30-perf-interaction-events.test.mts"];

for (const file of PERF_FILES) await import(file);

const { passed, failures, skipped, total } = counts();
console.log(`PERF_SUMMARY ${JSON.stringify({ passed, failures, skipped, total, files: PERF_FILES.length })}`);
process.exit(failures === 0 ? 0 : 1);
