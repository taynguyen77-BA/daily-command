"use client";

import { useCommandCenter } from "@/components/command-center/use-command-center";
import { ChangeItem } from "@/components/command-center/ChangeItem";
import { EmptyState, SectionHeading } from "@/components/command-center/ui";

export default function ChangesPage() {
  const { state, derived, previousSnapshot, store } = useCommandCenter();

  if (!state.loaded) {
    return (
      <EmptyState
        title="No data yet"
        description="Load the demo dataset, or import your own work items from Data & Settings."
        onLoadDemo={() => store.loadDemoData()}
      />
    );
  }

  return (
    <div className="space-y-4 pb-16">
      <SectionHeading
        title="What Changed?"
        subtitle={
          previousSnapshot
            ? `Comparing against the snapshot from ${previousSnapshot.date}.`
            : "No previous snapshot yet — changes will appear after your next import or Close My Day."
        }
      />
      {derived.changes.length === 0 ? (
        <p className="py-10 text-center text-sm text-text3">No meaningful changes detected.</p>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          {derived.changes.map((c) => (
            <ChangeItem key={c.id} change={c} />
          ))}
        </div>
      )}
    </div>
  );
}
