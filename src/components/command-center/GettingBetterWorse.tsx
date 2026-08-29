"use client";

import type { HealthTrend } from "@/lib/command-center/types";
import { Panel, SectionHeading, TrustLabel } from "./ui";

/**
 * V1.2 §12-13. Facts here are exactly trend.gettingBetter/gettingWorse — the same
 * deterministic deltas already computed for Health Trend, just filtered and re-labeled.
 * The interpretive "why it matters / recommended intervention" narrative already lives in
 * the Health Trend AI interpretation above this section — deliberately not duplicating
 * that Claude call here (§22: "avoid duplicate requests").
 */
export function GettingBetterWorse({ trend }: { trend: HealthTrend }) {
  if (!trend.hasHistory) return null;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <section>
        <SectionHeading title="Getting Better" />
        <Panel className="p-4">
          <div className="mb-2 flex items-center gap-2">
            <TrustLabel kind="calculated" />
          </div>
          {trend.gettingBetter.length === 0 ? (
            <p className="text-sm text-text3">Nothing improved since the last snapshot.</p>
          ) : (
            <ul className="space-y-1 text-sm text-green">
              {trend.gettingBetter.map((f) => (
                <li key={f}>+ {f}</li>
              ))}
            </ul>
          )}
        </Panel>
      </section>
      <section>
        <SectionHeading title="Getting Worse" />
        <Panel className="p-4">
          <div className="mb-2 flex items-center gap-2">
            <TrustLabel kind="calculated" />
          </div>
          {trend.gettingWorse.length === 0 ? (
            <p className="text-sm text-text3">Nothing got worse since the last snapshot.</p>
          ) : (
            <ul className="space-y-1 text-sm text-red">
              {trend.gettingWorse.map((f) => (
                <li key={f}>- {f}</li>
              ))}
            </ul>
          )}
        </Panel>
      </section>
    </div>
  );
}
