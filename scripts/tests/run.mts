// BA/PO/PM Command Center — deterministic-engine test suite (BUILD REQUEST §26).
// Run: npm test
//
// One runner over the per-domain files in this folder. Files run one after another, in this
// order, in ONE process — several share the commandCenterStore singleton, exactly as they did
// when this suite was a single file, so the order is part of the contract. No AI provider
// calls — everything under test is deterministic.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { addCounts, counts } from "./harness.mts";

const FILES = [
  "./01-core-engines.test.mts",
  "./02-ai-intelligence.test.mts",
  "./03-memory-decisions.test.mts",
  "./04-jira-ingestion.test.mts",
  "./05-proactive-intelligence.test.mts",
  "./06-decision-action.test.mts",
  "./07-personal-copilot.test.mts",
  "./08-hardening-ai-ops.test.mts",
  "./09-artifacts.test.mts",
  "./10-project-scope-focus.test.mts",
  "./11-work-relevance.test.mts",
  "./12-relations-sync-security.test.mts",
  "./13-personal-work-reporting.test.mts",
  "./14-sync-reports-helpers.test.mts",
  "./15-ticket-work-state.test.mts",
  "./16-data-durability.test.mts",
  "./17-focus-session-outcomes.test.mts",
  "./18-server-daily-reports.test.mts",
  "./19-security-and-docs.test.mts",
  "./20-morning-mode.test.mts",
  "./21-blocker-followup.test.mts",
  "./22-mention-reply-detection.test.mts",
  "./23-jira-write-back.test.mts",
  "./24-report-summaries.test.mts",
  "./26-action-plan-one-vocabulary.test.mts",
  "./27-jira-write-gate.test.mts",
  "./28-snapshot-timing.test.mts",
  "./29-backup-encryption.test.mts",
  "./31-ai-foundation.test.mts",
  "./32-ai-task-features.test.mts",
  "./33-ai-ba-features.test.mts",
  "./34-review-fixes-v239.test.mts",
  "./34-multi-user-auth.test.mts",
  "./35-notify-correctness.test.mts",
  "./36-priority-signal.test.mts",
  "./37-jira-resilience.test.mts",
  "./38-cron-health.test.mts",
  "./39-fair-cron.test.mts",
  "./40-kv-seam.test.mts",
  "./41-jira-smoke.test.mts",
  "./42-lint-cleanup.test.mts",
  "./43-score-v2.test.mts",
  "./44-conversation.test.mts",
  "./45-learning.test.mts",
  "./46-forecast.test.mts",
  "./47-smart-notify.test.mts",
  "./48-next-best-action.test.mts",
  "./49-ai-readiness.test.mts",
  "./50-delivery-and-cursor.test.mts",
  "./51-delivery-guarantees.test.mts",
  "./52-consistency-exposure.test.mts",
];

for (const file of FILES) await import(file);

// C3 — the wall-clock budget files (25, 30) run in a CHILD process so they start with a clean heap: in this shared
// process they would be measured after ~48 files of heap churn and fail on a normal laptop while passing standalone.
// Their output is relayed and their checks are added to the totals. PERF_BUDGET_FACTOR is inherited.
const perf = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./run-perf.mts", import.meta.url))], { encoding: "utf8", env: process.env, maxBuffer: 64 * 1024 * 1024 });
process.stdout.write((perf.stdout ?? "").replace(/^PERF_SUMMARY .*\n?/m, ""));
if (perf.stderr) process.stderr.write(perf.stderr);
const perfLine = /^PERF_SUMMARY (.*)$/m.exec(perf.stdout ?? "");
let perfFiles = 0;
if (perfLine) {
  const s = JSON.parse(perfLine[1]) as { passed: number; failures: number; skipped: number; files: number };
  addCounts(s.passed, s.failures, s.skipped);
  perfFiles = s.files;
} else {
  console.log("❌ [C3 perf child] the perf child process did not report a summary (crashed?)");
  addCounts(0, 1, 0);
}

const { passed, failures, skipped, total } = counts();
if (skipped > 0) console.log(`\n⏭️  ${skipped} check group(s) skipped for missing runtime capabilities (see SKIPPED lines above).`);
console.log(`\nChecks: ${total} (${passed} passed, ${failures} failed, ${skipped} skipped) across ${FILES.length + perfFiles} files.`);
console.log(failures === 0 ? `✅ All checks passed.` : `❌ ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
