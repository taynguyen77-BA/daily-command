"use client";

// W3 — "If this slips, what else slips?": the tickets that block the most work, each with a chip ("blocks 4 · 2 projects"), the slip
// you can change (default: forecast P85 - P50, else 3 days), the downstream tickets with the room each has, the releases whose date would
// be exceeded, and a compact keyboard-accessible SVG graph of the chain. CALCULATED from synced issue links (FORECAST when the slip is).

import { useMemo, useState } from "react";
import { blastChip, blastRadius, buildBlastGraph, defaultSlipDays, DEFAULT_SLIP_DAYS, type BlastRadius } from "@/lib/command-center/blast-radius";
import { Panel, SectionHeading, TrustLabel } from "./ui";
import { TicketLink } from "./TicketLink";
import { useCommandCenter } from "./use-command-center";

function ChainGraph({ r, urlOf }: { r: BlastRadius; urlOf: (k: string) => string | undefined }) {
  const nodes = [r.key, ...r.downstream.map((d) => d.key)].slice(0, 24);
  const byDepth = new Map<number, string[]>();
  byDepth.set(0, [r.key]);
  for (const d of r.downstream.slice(0, 23)) byDepth.set(d.depth, [...(byDepth.get(d.depth) ?? []), d.key]);
  const pos = new Map<string, { x: number; y: number }>();
  const cols = Math.max(...byDepth.keys()) + 1;
  for (const [depth, keys] of byDepth) keys.forEach((k, i) => pos.set(k, { x: 60 + depth * 120, y: 28 + i * 40 }));
  const height = 28 + Math.max(...Array.from(byDepth.values()).map((v) => v.length)) * 40;
  const onPath = new Set(r.criticalPath.map((c) => c.key));
  return (
    <svg role="img" aria-label={`Impact graph for ${r.key}: ${r.downstream.length} downstream tickets`} width={Math.max(220, 60 + cols * 120)} height={height} className="max-w-full overflow-visible">
      {r.downstream.slice(0, 23).map((d) => {
        const to = pos.get(d.key);
        const fromKey = d.from;
        const from = pos.get(fromKey);
        return to && from ? <line key={`${fromKey}>${d.key}`} x1={from.x + 38} y1={from.y} x2={to.x - 38} y2={to.y} stroke="currentColor" strokeOpacity={onPath.has(d.key) ? 0.9 : 0.3} strokeWidth={onPath.has(d.key) ? 2 : 1} /> : null;
      })}
      {nodes.map((k) => {
        const p = pos.get(k)!;
        const d = r.downstream.find((x) => x.key === k);
        const url = urlOf(k);
        const fill = k === r.key ? "var(--accent, #6366f1)" : d?.atRisk ? "#ef4444" : d?.atRisk === null ? "#eab308" : "#22c55e";
        const node = (
          <g tabIndex={url ? 0 : -1} role="link" aria-label={`${k}${d ? `, ${d.atRisk ? "at risk" : d.atRisk === null ? "date unknown" : "has room"}` : ", the slipping ticket"}`}>
            <rect x={p.x - 38} y={p.y - 12} width={76} height={24} rx={6} fill={fill} fillOpacity={0.18} stroke={fill} />
            <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize={11} fill="currentColor">{k}</text>
          </g>
        );
        return url ? <a key={k} href={url} target="_blank" rel="noopener noreferrer">{node}</a> : <g key={k}>{node}</g>;
      })}
    </svg>
  );
}

export function BlastRadiusPanel() {
  const { state, forecast, filteredData } = useCommandCenter();
  const graph = useMemo(() => buildBlastGraph(filteredData.workItems, filteredData.dependencies), [filteredData.workItems, filteredData.dependencies]);
  const [open, setOpen] = useState<string | null>(null);
  const [slip, setSlip] = useState<number | null>(null);
  const urlOf = (k: string) => state.data.workItems.find((w) => w.key === k)?.sourceUrl;

  const ranked = useMemo(() => {
    const keys = Array.from(graph.downstream.keys());
    return keys
      .map((k) => {
        const w = graph.nodes.get(k)!;
        const est = forecast.leadTime.estimateFor(w.projectId, String(filteredData.workItems.find((x) => x.key === k)?.type ?? "task"));
        const def = defaultSlipDays(est.status === "OK" ? { p50: est.p50, p85: est.p85 } : null);
        return { key: k, def, radius: blastRadius(graph, k, def.days, { forecast: def.forecast }) };
      })
      .filter((x) => x.radius.status === "OK" && x.radius.downstream.length > 0 && graph.nodes.get(x.key)?.status !== "Done")
      .sort((a, b) => b.radius.downstream.length - a.radius.downstream.length || a.key.localeCompare(b.key))
      .slice(0, 10);
  }, [graph, forecast, filteredData.workItems]);

  if (graph.linkCount === 0) {
    return (
      <Panel className="p-4 text-sm text-text3" data-blast-radius>
        <SectionHeading title="Blast radius" subtitle="If this slips, what else slips?" />
        No link data synced yet — sync Jira (issue links) and the tickets that block the most work will be listed here. (UNKNOWN is not “no impact”.)
      </Panel>
    );
  }
  return (
    <Panel className="space-y-3 p-4" data-blast-radius>
      <SectionHeading title="Blast radius" subtitle="The tickets that block the most work, and what slips with them." />
      <p className="text-xs text-text3"><TrustLabel kind="calculated" /> From synced “is blocked by” links and fix versions. The slip defaults to the forecast spread (P85 − P50) when there is enough history, else {DEFAULT_SLIP_DAYS} days — you can change it.</p>
      {ranked.length === 0 && <p className="text-sm text-text3">No open ticket blocks other open work in the synced data.</p>}
      <ul className="space-y-2">
        {ranked.map(({ key, def }) => {
          const days = slip ?? def.days;
          const r = open === key ? blastRadius(graph, key, days, { forecast: slip === null && def.forecast }) : null;
          const chip = blastChip(blastRadius(graph, key, def.days));
          return (
            <li key={key} className="rounded-md border border-border p-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <TicketLink ticketKey={key} url={urlOf(key)} />
                <span className="truncate text-text2">{graph.nodes.get(key)?.title}</span>
                {chip && <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-text2" data-blast-chip>{chip}</span>}
                <button type="button" className="ml-auto rounded-md border border-border px-2 py-0.5 text-xs text-text2 hover:bg-surface2" aria-expanded={open === key} onClick={() => { setOpen(open === key ? null : key); setSlip(null); }}>{open === key ? "Hide impact" : "Impact"}</button>
              </div>
              {r && (
                <div className="mt-2 space-y-2 text-xs text-text2">
                  <label className="flex items-center gap-2">If it slips by
                    <input type="number" min={0} max={60} value={days} onChange={(e) => setSlip(Math.max(0, Math.min(60, Number(e.target.value) || 0)))} className="w-16 rounded border border-border bg-surface px-1.5 py-0.5" aria-label="Slip in days" /> days
                    <TrustLabel kind={r.basis === "FORECAST" ? "forecast" : "calculated"} />
                  </label>
                  <ul className="list-disc pl-5">
                    {r.downstream.map((d) => <li key={d.key}><span className="font-mono text-text">{d.key}</span> {d.title}{d.dueDate ? ` · due ${d.dueDate}` : " · no due date"} · {d.slackDays === null ? "room unknown" : `${d.slackDays} day(s) of room`} · <span className={d.atRisk ? "text-red" : d.atRisk === null ? "text-yellow" : "text-green"}>{d.atRisk ? "at risk" : d.atRisk === null ? "unknown" : "holds"}</span></li>)}
                  </ul>
                  {r.releases.length > 0 && <p>Releases: {r.releases.map((x) => `${x.fixVersion} ${x.exceeded ? `would move ${x.targetDate} → ${x.newDate}` : "holds"}`).join(" · ")}</p>}
                  <p>Critical path: {r.criticalPath.map((c) => `${c.key}${c.slackDays === null ? "" : ` (${c.slackDays}d)`}`).join(" → ")}{r.truncated ? " · (capped: more downstream work exists)" : ""}</p>
                  <ChainGraph r={r} urlOf={urlOf} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
