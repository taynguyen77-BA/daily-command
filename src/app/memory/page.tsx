"use client";

import { useCommandCenter } from "@/components/command-center/use-command-center";
import { SectionHeading } from "@/components/command-center/ui";
import { ProjectMemoryContent } from "@/components/command-center/ProjectMemoryContent";

// V2.13 §2 — this route is kept working for direct links/bookmarks, but is no longer listed
// in the primary Nav.tsx — see ProjectMemoryContent.tsx for the rationale (it's now also
// embedded as a collapsible "Activity Log" section inside Data & Settings).
export default function ProjectMemoryPage() {
  const { state, store } = useCommandCenter();

  return (
    <div className="space-y-6 pb-16">
      <SectionHeading
        title="Project Memory"
        subtitle="Every daily snapshot, close-of-day summary, decision, and action this app has stored — nothing hidden, all of it deletable."
      />
      <ProjectMemoryContent state={state} store={store} />
    </div>
  );
}
