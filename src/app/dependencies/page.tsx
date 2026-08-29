"use client";

// Dependency Radar (V1.4 §10-11) — full list. No dedicated dependencies page existed
// before V1.4; dependencies were only ever shown inline on work items.

import { useCommandCenter } from "@/components/command-center/use-command-center";
import { EmptyState, HeatBadge, Panel, SectionHeading, TrustLabel } from "@/components/command-center/ui";

export default function DependenciesPage() {
  const { state, proactive, store } = useCommandCenter();

  if (!state.loaded) {
    return <EmptyState title="No data yet" description="Load the demo dataset to see the Dependency Radar in action." onLoadDemo={() => store.loadDemoData()} />;
  }

  const items = proactive?.dependencyRadar ?? [];

  return (
    <div className="space-y-6 pb-16">
      <SectionHeading title="Dependency Radar" subtitle="Age, blocked work, release proximity, and linked risk — never an invented target date." />

      {items.length === 0 ? (
        <Panel className="p-6 text-sm text-text3">No unresolved dependencies right now.</Panel>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {items.map((d) => (
            <Panel key={d.dependencyId} className="p-4">
              <div className="mb-1 flex items-center gap-2">
                <HeatBadge heat={d.heat} />
                <TrustLabel kind="calculated" />
              </div>
              <p className="font-display text-sm text-text">Dependency on {d.dependsOnTeam}</p>
              <p className="mt-1 text-xs text-text2">{d.description}</p>
              <dl className="mt-2 grid grid-cols-2 gap-1 text-xs text-text2">
                <div>
                  <dt className="text-text3">Age</dt>
                  <dd>{d.ageDays} day(s)</dd>
                </div>
                <div>
                  <dt className="text-text3">Blocks</dt>
                  <dd>
                    {d.blockedItemCount} item(s){d.blockedHighPriorityCount > 0 ? `, ${d.blockedHighPriorityCount} high-priority` : ""}
                  </dd>
                </div>
                {d.releaseProximity && (
                  <div>
                    <dt className="text-text3">Release</dt>
                    <dd>
                      {d.releaseProximity.fixVersion} in {d.releaseProximity.daysToRelease}d
                    </dd>
                  </div>
                )}
                {d.linkedRiskLevel && (
                  <div>
                    <dt className="text-text3">Linked risk</dt>
                    <dd>{d.linkedRiskLevel}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-text3">Owner</dt>
                  <dd>{d.ownerId ?? "Unassigned"}</dd>
                </div>
              </dl>
              <p className="mt-2 text-xs font-medium text-accent2">Recommended: {d.recommended}</p>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
