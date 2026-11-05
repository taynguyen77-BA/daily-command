// W3 — Blast radius & critical path: graph, slip propagation, releases, cycles, caps, UNKNOWN, additive link data (offline, pure).
import fs from "node:fs";
import { ok } from "./harness.mts";
import { BLAST_MAX_DEPTH, BLAST_MAX_NODES, blastChip, blastRadius, blockerKeyOf, buildBlastGraph, defaultSlipDays } from "../../src/lib/command-center/blast-radius";
import { normalizeIssue } from "../../src/lib/command-center/jira/normalize";

type W = { key: string; title: string; projectId: string; status: string; dueDate?: string; fixVersion?: string; fixVersions?: string[] };
const w = (key: string, due: string | undefined, over: Partial<W> = {}): W => ({ key, title: `t ${key}`, projectId: `jira-project-${key.split("-")[0]}`, status: "In Progress", ...(due ? { dueDate: due } : {}), ...over });
const dep = (blocker: string, dependent: string, extra: Record<string, unknown> = {}) => ({ id: `${blocker}>${dependent}`, workItemId: `jira-${dependent}`, blockerKey: blocker, linkType: "Blocks", description: `Blocked by ${blocker}`, ...extra });

{
  const group = "W3 chain A -> B -> C";
  const items = [w("A-1", "2026-11-10", { fixVersion: "R2.4" }), w("B-1", "2026-11-12", { fixVersion: "R2.4" }), w("C-1", "2026-11-20", { fixVersion: "R2.4" })];
  const g = buildBlastGraph(items, [dep("A-1", "B-1"), dep("B-1", "C-1")]);
  const r = blastRadius(g, "A-1", 3);
  ok(group, r.status === "OK" && r.downstream.map((d) => d.key).join() === "B-1,C-1" && r.projects.join() === "jira-project-B,jira-project-C", "slipping A by 3 days reports B and C and the projects they belong to");
  ok(group, r.downstream[0].slackDays === 2 && r.downstream[0].atRisk === true && r.downstream[1].slackDays === 8 && r.downstream[1].atRisk === false, "per-node slack: B has 2 days of room (3 > 2: at risk), C has 8 (holds)");
  ok(group, r.criticalPath.map((c) => c.key).join() === "A-1,B-1,C-1" && r.criticalPath[1].slackDays === 2, "the critical path is the chain with per-node slack");
  ok(group, r.releases.length === 1 && r.releases[0].fixVersion === "R2.4" && r.releases[0].targetDate === "2026-11-20" && r.releases[0].newDate === "2026-11-23" && r.releases[0].exceeded, "the release they belong to would move 2026-11-20 -> 2026-11-23");
  ok(group, blastChip(r) === "blocks 2 · 2 projects" && blastChip(blastRadius(g, "C-1", 3)) === null, "chip: 'blocks 2 · 2 projects'; a leaf has none");
  ok(group, r.basis === "CALCULATED" && blastRadius(g, "A-1", 3, { forecast: true }).basis === "FORECAST", "labelled CALCULATED, FORECAST when the slip comes from the forecast");
  const zero = blastRadius(g, "A-1", 0);
  ok(group, zero.downstream.every((d) => d.atRisk === false) && zero.releases[0].exceeded === false, "a zero-day slip moves nothing");
}

{
  const group = "W3 validation";
  const items = [w("A-1", "2026-11-10"), w("B-1", "2026-11-12", { status: "Done" }), w("C-1", "2026-11-13"), w("D-1", "2026-11-14")];
  const g = buildBlastGraph(items, [dep("A-1", "B-1"), dep("A-1", "C-1"), dep("A-1", "C-1"), dep("A-1", "A-1"), dep("A-1", "D-1", { linkType: "Relates" }), dep("A-1", "D-1", { linkType: "Blocks" })]);
  const r = blastRadius(g, "A-1", 5);
  ok(group, r.downstream.map((d) => d.key).join() === "C-1,D-1" && !r.downstream.some((d) => d.key === "B-1"), "Done tickets are not downstream-at-risk; duplicate links count once; self-links are ignored");
  const only = buildBlastGraph(items, [dep("A-1", "D-1", { linkType: "Relates" })], {});
  ok(group, only.linkCount === 0, "only the configured link types create edges");
  const custom = buildBlastGraph(items, [dep("A-1", "D-1", { linkType: "Relates" })], { linkTypes: /relat/i });
  ok(group, blastRadius(custom, "A-1", 3).downstream.length === 1, "…and the map is configurable");
  ok(group, blockerKeyOf({ description: "Blocked by X-9: summary" }) === "X-9" && blockerKeyOf({ blockerKey: "Y-1", description: "" }) === "Y-1", "data synced before V2.48 still works (the key is read from the description)");
}

{
  const group = "W3 unknown and edge cases";
  const none = buildBlastGraph([w("A-1", "2026-11-10")], []);
  const u = blastRadius(none, "A-1", 3);
  ok(group, u.status === "UNKNOWN" && /No link data synced/.test(u.note ?? "") && u.downstream.length === 0, "no link data -> UNKNOWN 'no link data synced for this ticket', never an empty claim of no impact");
  ok(group, blastRadius(buildBlastGraph([w("A-1", "2026-11-10"), w("B-1", undefined)], [dep("A-1", "B-1")]), "ZZ-1", 3).status === "UNKNOWN", "a ticket outside the synced data -> UNKNOWN");
  ok(group, blastRadius(buildBlastGraph([w("A-1", "2026-11-10"), w("B-1", undefined)], [dep("A-1", "B-1")]), "A-1", NaN).status === "UNKNOWN" && blastRadius(buildBlastGraph([w("A-1", "2026-11-10"), w("B-1", undefined)], [dep("A-1", "B-1")]), "A-1", -2).status === "UNKNOWN", "an invalid slip -> UNKNOWN, never a number");
  const noDue = blastRadius(buildBlastGraph([w("A-1", "2026-11-10"), w("B-1", undefined)], [dep("A-1", "B-1")]), "A-1", 3);
  ok(group, noDue.downstream[0].slackDays === null && noDue.downstream[0].atRisk === null, "a missing due date -> room unknown, at-risk unknown (not guessed)");
  // cycle
  const cyc = buildBlastGraph([w("A-1", "2026-11-10"), w("B-1", "2026-11-11"), w("C-1", "2026-11-12")], [dep("A-1", "B-1"), dep("B-1", "C-1"), dep("C-1", "A-1")]);
  const rc = blastRadius(cyc, "A-1", 2);
  ok(group, rc.downstream.map((d) => d.key).join() === "B-1,C-1", "cycles are safe: each ticket appears once");
  // diamond
  const dia = buildBlastGraph([w("A-1", "2026-11-10"), w("B-1", "2026-11-11"), w("C-1", "2026-11-12"), w("D-1", "2026-11-15")], [dep("A-1", "B-1"), dep("A-1", "C-1"), dep("B-1", "D-1"), dep("C-1", "D-1")]);
  ok(group, blastRadius(dia, "A-1", 2).downstream.filter((d) => d.key === "D-1").length === 1 && blastRadius(dia, "A-1", 2).criticalPath.length === 3, "diamonds: the join is counted once; the critical path has 3 nodes");
  // depth cap
  const chain = Array.from({ length: 12 }, (_, i) => w(`K-${i}`, `2026-11-${String(10 + i).padStart(2, "0")}`));
  const dc = blastRadius(buildBlastGraph(chain, chain.slice(1).map((c, i) => dep(`K-${i}`, c.key))), "K-0", 3);
  ok(group, dc.downstream.length === BLAST_MAX_DEPTH && dc.truncated && dc.criticalPath.length === BLAST_MAX_DEPTH + 1, `the depth cap is ${BLAST_MAX_DEPTH}, and the answer says it was capped`);
  // node cap + performance (500 / 3,000 items)
  const wide = [w("R-0", "2026-11-10"), ...Array.from({ length: 800 }, (_, i) => w(`W-${i}`, "2026-12-01"))];
  const t0 = performance.now();
  const wr = blastRadius(buildBlastGraph(wide, wide.slice(1).map((x) => dep("R-0", x.key))), "R-0", 3);
  ok(group, wr.downstream.length < BLAST_MAX_NODES && wr.truncated, `the ${BLAST_MAX_NODES}-node cap holds (${wr.downstream.length} listed) and is reported`);
  const big = Array.from({ length: 3000 }, (_, i) => w(`B-${i}`, "2026-12-01"));
  const bigDeps = Array.from({ length: 2999 }, (_, i) => dep(`B-${i}`, `B-${i + 1}`));
  const t1 = performance.now();
  blastRadius(buildBlastGraph(big, bigDeps), "B-0", 3);
  const perfBudget = 300 * Number(process.env.PERF_BUDGET_FACTOR || 1);
  ok(group, performance.now() - t1 < perfBudget && t1 - t0 < perfBudget, `the 3,000-item graph builds and answers within the ${perfBudget} ms budget (${(performance.now() - t1).toFixed(1)} ms)`);
  // external
  const ext = buildBlastGraph([w("A-1", "2026-11-10")], [dep("OUT-5", "A-1"), dep("A-1", "A-2")]);
  ok(group, ext.external.get("A-1")?.join() === "OUT-5", "links to tickets outside the synced scope are kept as 'external'");
  ok(group, defaultSlipDays({ p50: 5, p85: 9 }).days === 4 && defaultSlipDays({ p50: 5, p85: 9 }).forecast && defaultSlipDays(null).days === 3 && !defaultSlipDays(null).forecast && defaultSlipDays({ p50: 9, p85: 9 }).days === 3, "default slip = forecast P85 - P50, else 3 days");
}

{
  const group = "W3 normalisation is additive";
  const issue = { key: "X-2", fields: { summary: "dependent", created: "2026-10-01T00:00:00.000Z", project: { key: "X" }, status: { name: "In Progress", statusCategory: { key: "indeterminate" } }, issuelinks: [{ type: { name: "Blocks" }, inwardIssue: { key: "X-1", fields: { summary: "the blocker", status: { statusCategory: { key: "new" } } } } }] } };
  const { dependencies } = normalizeIssue(issue as never, { today: "2026-11-05", projectToClient: {} } as never);
  ok(group, dependencies.length === 1 && dependencies[0].blockerKey === "X-1" && dependencies[0].linkType === "Blocks" && /Blocked by X-1/.test(dependencies[0].description), "normalize keeps the blocker's key and link type; the description is unchanged");
  const panel = fs.readFileSync("src/components/command-center/BlastRadiusPanel.tsx", "utf8");
  ok(group, /role="img"/.test(panel) && /tabIndex/.test(panel) && /aria-label/.test(panel) && !/from "d3|from "reactflow|cytoscape/.test(panel), "the graph is a small accessible SVG, no graph library");
  ok(group, /<BlastRadiusPanel \/>/.test(fs.readFileSync("src/app/dependencies/page.tsx", "utf8")), "the Impact panel is on the Dependencies page");
}
