"use client";

// Dependency Radar (V1.4 §10-11) — full list. No dedicated dependencies page existed
// before V1.4; dependencies were only ever shown inline on work items.

import { useCommandCenter } from "@/components/command-center/use-command-center";
import { EmptyState, Panel, SectionHeading } from "@/components/command-center/ui";
import { DependencyRadarCard } from "@/components/command-center/DependencyRadarCard";
import { workItemIdForDependency, workItemsForIds } from "@/lib/command-center/task-execution";

export default function DependenciesPage() {
  const { state, proactive, store, filteredData } = useCommandCenter();

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
            <DependencyRadarCard key={d.dependencyId} item={d} relatedWorkItems={workItemsForIds(filteredData.workItems, [workItemIdForDependency(d.dependencyId, filteredData.dependencies)])} />
          ))}
        </div>
      )}
    </div>
  );
}
