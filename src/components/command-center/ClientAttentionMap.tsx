"use client";

// Client Attention Map (V1.4 §35). A prioritization view, not portfolio management —
// shown only when there's more than one client.

import type { ClientAttentionRow } from "@/lib/command-center/types";
import { Panel, SectionHeading, TrustLabel } from "./ui";

function TrendArrow({ trend }: { trend: ClientAttentionRow["trend"] }) {
  if (trend === "improving") return <span className="text-green">↑</span>;
  if (trend === "deteriorating") return <span className="text-red">↓</span>;
  return <span className="text-text3">→</span>;
}

export function ClientAttentionMap({ rows }: { rows: ClientAttentionRow[] }) {
  if (rows.length < 2) return null;

  return (
    <section>
      <SectionHeading title="Client Attention Map" subtitle="Which client needs you first." />
      <Panel className="overflow-x-auto p-0">
        <table className="w-full min-w-[560px] text-sm">
          <caption className="sr-only">Client Attention Map — confidence, trend, top risk, open decisions, and critical dependencies per client.</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text3">
              <th scope="col" className="px-4 py-2">Client</th>
              <th scope="col" className="px-4 py-2">Confidence</th>
              <th scope="col" className="px-4 py-2">Trend</th>
              <th scope="col" className="px-4 py-2">Top risk</th>
              <th scope="col" className="px-4 py-2">Open decisions</th>
              <th scope="col" className="px-4 py-2">Critical dependencies</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.clientId} className="border-b border-border last:border-0">
                <td className="px-4 py-2 font-medium text-text">{r.clientName}</td>
                <td className="px-4 py-2 text-text2">
                  {r.deliveryConfidence}% <TrendArrow trend={r.trend} />
                </td>
                <td className="px-4 py-2 text-text2 capitalize">{r.trend}</td>
                <td className="px-4 py-2 text-text2">{r.topRiskTitle ?? "—"}</td>
                <td className="px-4 py-2 text-text2">{r.openDecisionsCount}</td>
                <td className="px-4 py-2 text-text2">{r.criticalDependenciesCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex items-center gap-2 border-t border-border px-4 py-2">
          <TrustLabel kind="calculated" />
        </div>
      </Panel>
    </section>
  );
}
