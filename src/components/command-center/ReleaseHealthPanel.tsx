"use client";

import { computeAllReleaseHealth } from "@/lib/command-center/release-health";
import type { CommandCenterData } from "@/lib/command-center/types";
import { Panel, SectionHeading, TrustLabel } from "./ui";

const READINESS_STYLE: Record<string, string> = {
  READY: "bg-green/15 text-green border-green/30",
  AT_RISK: "bg-orange/15 text-orange border-orange/30",
  NOT_READY: "bg-red/15 text-red border-red/30",
};

export function ReleaseHealthPanel({ data, today }: { data: CommandCenterData; today: string }) {
  const releases = computeAllReleaseHealth(data, today);
  if (releases.length === 0) return null;

  return (
    <section>
      <SectionHeading title="Release Health" subtitle="Grouped by Jira Fix Version — a rollup, not a release-management clone." />
      <div className="grid gap-3 md:grid-cols-2">
        {releases.map((r) => (
          <Panel key={r.fixVersion} className="p-4">
            <div className="mb-2 flex items-center gap-2">
              <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold tracking-wide ${READINESS_STYLE[r.readiness]}`}>
                {r.readiness.replace("_", " ")}
              </span>
              <TrustLabel kind="calculated" />
            </div>
            <p className="font-display text-sm text-text">{r.fixVersion}</p>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-text2 sm:grid-cols-3">
              <span>Completion: {r.completionPct}%</span>
              <span>Blocked: {r.blockedCount}</span>
              <span>Overdue: {r.overdueCount}</span>
              <span>Unresolved deps: {r.unresolvedDependenciesCount}</span>
              <span>High-pri incomplete: {r.highPriorityIncompleteCount}</span>
              <span>Confidence: {r.deliveryConfidence}%</span>
            </div>
            {r.topRiskTitle && <p className="mt-2 text-xs text-text2">Top risk: {r.topRiskTitle}</p>}
          </Panel>
        ))}
      </div>
    </section>
  );
}
