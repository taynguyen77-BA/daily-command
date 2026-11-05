// Perf — long lists render progressively (a 3,000-ticket install used to mount ~50-70k DOM nodes on Priorities / Risks / Attention and froze
// the page and every menu link for tens of seconds), and the attention queue never contains two items with the same id.
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ok } from "./harness.mts";
import { ProgressiveGrid, PROGRESSIVE_PAGE } from "../../src/components/command-center/progressive-list";
import { buildPerfFixture } from "./perf-fixture.mts";
import { buildWorkRelevanceIndex } from "../../src/lib/command-center/jira/work-relevance";
import { deriveData } from "../../src/lib/command-center/selectors";
import { computeProactiveIntelligence } from "../../src/lib/command-center/proactive";

const Grid = ProgressiveGrid<number>;
const item = (n: number) => React.createElement("div", { key: n, "data-item": n }, n);

{
  const group = "Perf: progressive lists";
  const items = Array.from({ length: 500 }, (_, i) => i);
  const html = renderToStaticMarkup(React.createElement(Grid, { items, render: item }));
  const mounted = (html.match(/data-item=/g) ?? []).length;
  ok(group, mounted === PROGRESSIVE_PAGE && /Showing 30 of 500/.test(html) && /Show 30 more/.test(html) && /Show all 500/.test(html), `only the first ${PROGRESSIVE_PAGE} of 500 items are mounted, with Show more / Show all (${mounted})`);
  const small = renderToStaticMarkup(React.createElement(Grid, { items: [1, 2, 3], render: item }));
  ok(group, (small.match(/data-item=/g) ?? []).length === 3 && !/Show .* more/.test(small), "a short list renders in full with no footer");
  ok(group, renderToStaticMarkup(React.createElement(Grid, { items: [], render: item })) === '<div class="grid gap-3 md:grid-cols-2"></div>', "an empty list renders an empty grid");
  for (const file of ["src/app/priorities/page.tsx", "src/app/risks/page.tsx", "src/app/attention/page.tsx", "src/app/my-work/page.tsx", "src/app/reminders/page.tsx"])
    ok(group, fs.readFileSync(file, "utf8").includes("ProgressiveGrid"), `${file} windows its list`);
  ok(group, !/filtered\.map\(\(result\)/.test(fs.readFileSync("src/app/priorities/page.tsx", "utf8")) && !/derived\.risks\.map/.test(fs.readFileSync("src/app/risks/page.tsx", "utf8")), "the unbounded .map() over every ticket is gone");
  ok(group, /turbopackFileSystemCacheForDev/.test(fs.readFileSync("next.config.mjs", "utf8")), "dev compile cache is on disk (restarting `npm run dev` does not recompile every route)");
}

{
  const group = "Perf: attention ids are unique";
  const env = await buildPerfFixture();
  const s = env.store.getSnapshot();
  const idx = buildWorkRelevanceIndex(s.jiraWorkRelevancePolicy);
  const derived = deriveData(s.data, null, env.today, idx);
  const pro = computeProactiveIntelligence(s.data, derived, s.snapshotHistory, null, s.attentionState, "jira", env.today, idx, env.mentions, "acc-tay", "Tay");
  const ids = pro.attentionQueue.map((i) => i.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  ok(group, ids.length > 0 && dup.length === 0, `no duplicate attention ids over the 3,000-ticket fixture (${ids.length} items; duplicated: ${Array.from(new Set(dup)).slice(0, 3).join(", ") || "none"})`);
}
