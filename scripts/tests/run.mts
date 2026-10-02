// BA/PO/PM Command Center — deterministic-engine test suite (BUILD REQUEST §26).
// Run: npm test
//
// One runner over the per-domain files in this folder. Files run one after another, in this
// order, in ONE process — several share the commandCenterStore singleton, exactly as they did
// when this suite was a single file, so the order is part of the contract. No AI provider
// calls — everything under test is deterministic.

import { counts } from "./harness.mts";

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
];

for (const file of FILES) await import(file);

const { passed, failures, skipped, total } = counts();
if (skipped > 0) console.log(`\n⏭️  ${skipped} check group(s) skipped for missing runtime capabilities (see SKIPPED lines above).`);
console.log(`\nChecks: ${total} (${passed} passed, ${failures} failed, ${skipped} skipped) across ${FILES.length} files.`);
console.log(failures === 0 ? `✅ All checks passed.` : `❌ ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
