// F6 — performance budget: the selectors behind My Work, Daily Review, Priorities and the reports,
// on a synthetic 3,000-work-item / 1,500-mention dataset, must each finish within the budget (in
// Node, worst of 3 warm runs). F6 memoized the id lookups in personal-focus.ts / proactive.ts —
// checked here to give exactly the same answers as the linear scans they replaced.
// Run through scripts/tests/run.mts (npm test).

import { buildPerfFixture, PERF_MENTIONS, PERF_WORK_ITEMS, timeSelectors } from "./perf-fixture.mts";
import { deriveData } from "../../src/lib/command-center/selectors";
import { computeProactiveIntelligence } from "../../src/lib/command-center/proactive";
import { resolveAttentionEntity, workItemByIdIn } from "../../src/lib/command-center/personal-focus";
import { buildWorkRelevanceIndex } from "../../src/lib/command-center/jira/work-relevance";
import type { AttentionItem, CommandCenterData, Risk } from "../../src/lib/command-center/types";
import { ok } from "./harness.mts";

export const SELECTOR_BUDGET_MS = 200;

const env = await buildPerfFixture();
const s = env.store.getSnapshot();

{
  const group = "F6 Performance budget";
  ok(group, s.data.workItems.length === PERF_WORK_ITEMS && env.mentions.length === PERF_MENTIONS, `synthetic dataset: ${s.data.workItems.length} work items, ${env.mentions.length} mention events (all fed to the selectors; the store itself keeps ${s.mentionEvents.length})`);
  const times = await timeSelectors(env);
  ok(group, Object.keys(times).length >= 8, `covers My Work, Daily Review, Priorities, focus, attention queue and the reports (${Object.keys(times).join(", ")})`);
  for (const [name, ms] of Object.entries(times)) ok(group, ms <= SELECTOR_BUDGET_MS, `${name}: ${ms.toFixed(1)} ms ≤ ${SELECTOR_BUDGET_MS} ms`);
}

{
  const group = "F6 Memoized lookups";
  const idx = buildWorkRelevanceIndex(s.jiraWorkRelevancePolicy);
  const derived = deriveData(s.data, null, env.today, idx);
  const queue = computeProactiveIntelligence(s.data, derived, s.snapshotHistory, null, s.attentionState, "jira", env.today, idx, env.mentions, "acc-tay", "Tay").attentionQueue;
  // The linear-scan version the cached indexes replaced (the original code, verbatim in spirit).
  const naive = (item: AttentionItem, data: CommandCenterData, risks: Risk[]) => {
    const ref = item.sourceRef;
    if (!ref) return { workItemIds: [] as string[] };
    if (ref.type === "risk") {
      const r = risks.find((x) => x.title === ref.id);
      const related = r ? data.workItems.filter((w) => r.sourceWorkItemIds.includes(w.id)) : [];
      return { projectId: related[0]?.projectId, workItemIds: related.map((w) => w.id) };
    }
    if (ref.type === "workItem") {
      const w = data.workItems.find((x) => x.id === ref.id);
      return { projectId: w?.projectId, workItemIds: w ? [w.id] : [], dueDate: w?.dueDate };
    }
    if (ref.type === "dependency") {
      const d = data.dependencies.find((x) => x.id === ref.id);
      const w = d ? data.workItems.find((x) => x.id === d.workItemId) : undefined;
      return { projectId: w?.projectId, workItemIds: w ? [w.id] : [] };
    }
    if (ref.type === "release") {
      const items = data.workItems.filter((w) => w.fixVersion === ref.id);
      return { projectId: items[0]?.projectId, workItemIds: items.map((w) => w.id) };
    }
    return null;
  };
  let compared = 0;
  let same = 0;
  for (const item of queue) {
    const expected = naive(item, s.data, derived.risks);
    if (!expected) continue;
    compared++;
    const got = resolveAttentionEntity(item, s.data, derived.risks);
    if (JSON.stringify({ projectId: got.projectId, workItemIds: got.workItemIds, ...(got.dueDate !== undefined || "dueDate" in expected ? { dueDate: got.dueDate } : {}) }) === JSON.stringify(expected)) same++;
  }
  ok(group, compared > 1000 && same === compared, `cached lookups resolve every attention item exactly like the linear scans (${same}/${compared})`);
  const copy = { ...s.data, workItems: s.data.workItems.map((w, i) => (i === 0 ? { ...w, dueDate: "2099-01-01" } : w)) };
  ok(group, workItemByIdIn(copy, s.data.workItems[0].id)?.dueDate === "2099-01-01" && workItemByIdIn(s.data, s.data.workItems[0].id)?.dueDate !== "2099-01-01", "a new dataset object gets fresh indexes (never a stale cached answer)");
}
