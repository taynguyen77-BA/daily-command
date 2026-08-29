"use client";

import { useState } from "react";
import { computeAllReleaseHealth } from "@/lib/command-center/release-health";
import { buildReleaseUpdateDraft } from "@/lib/command-center/communicate";
import type { CommandCenterData, ReleaseHealth } from "@/lib/command-center/types";
import { ArtifactEditor } from "./ArtifactEditor";
import { Panel, SectionHeading, TrustLabel } from "./ui";

const READINESS_STYLE: Record<string, string> = {
  READY: "bg-green/15 text-green border-green/30",
  AT_RISK: "bg-orange/15 text-orange border-orange/30",
  NOT_READY: "bg-red/15 text-red border-red/30",
};

function ReleaseCard({ release, data }: { release: ReleaseHealth; data: CommandCenterData }) {
  const [creatingUpdate, setCreatingUpdate] = useState(false);
  return (
    <Panel className="p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold tracking-wide ${READINESS_STYLE[release.readiness]}`}>
            {release.readiness.replace("_", " ")}
          </span>
          <TrustLabel kind="calculated" />
        </div>
        <button onClick={() => setCreatingUpdate(true)} className="rounded-md border border-border px-2 py-1 text-xs font-medium text-text2 hover:border-accent hover:text-text">
          Create Release Update
        </button>
      </div>
      <p className="font-display text-sm text-text">{release.fixVersion}</p>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-text2 sm:grid-cols-3">
        <span>Completion: {release.completionPct}%</span>
        <span>Blocked: {release.blockedCount}</span>
        <span>Overdue: {release.overdueCount}</span>
        <span>Unresolved deps: {release.unresolvedDependenciesCount}</span>
        <span>High-pri incomplete: {release.highPriorityIncompleteCount}</span>
        <span>Confidence: {release.deliveryConfidence}%</span>
      </div>
      {release.topRiskTitle && <p className="mt-2 text-xs text-text2">Top risk: {release.topRiskTitle}</p>}
      {creatingUpdate && <ArtifactEditor draft={buildReleaseUpdateDraft(release, data)} onClose={() => setCreatingUpdate(false)} />}
    </Panel>
  );
}

export function ReleaseHealthPanel({ data, today }: { data: CommandCenterData; today: string }) {
  const releases = computeAllReleaseHealth(data, today);
  if (releases.length === 0) return null;

  return (
    <section>
      <SectionHeading title="Release Health" subtitle="Grouped by Jira Fix Version — a rollup, not a release-management clone." />
      <div className="grid gap-3 md:grid-cols-2">
        {releases.map((r) => (
          <ReleaseCard key={r.fixVersion} release={r} data={data} />
        ))}
      </div>
    </section>
  );
}
