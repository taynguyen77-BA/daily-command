"use client";

import React, { useMemo } from "react";
import { useSyncExternalStore } from "react";
import { commandCenterStore } from "@/lib/command-center/store";
import { evidenceForChange } from "@/lib/command-center/evidence";

import type { ChangeEvent, WorkItem } from "@/lib/command-center/types";
import { MetaPill } from "./ui";
import { RelatedTickets } from "./TaskReferenceRow";

/** V2.26 — `workItem` is set by the caller only for a WorkItem-entity change whose entityId
 *  resolves in the current data; it then renders as a TaskReferenceRow. */
export function ChangeItem({ change, workItem }: { change: ChangeEvent; workItem?: WorkItem }) {
  // C1 — evidence drawer like the other cards (evidence.ts's evidenceForChange).
  const isDemo = useSyncExternalStore(commandCenterStore.subscribe, () => commandCenterStore.getSnapshot().isDemo, () => commandCenterStore.getServerSnapshot().isDemo);
  const evidence = useMemo(() => evidenceForChange(change, isDemo ? "demo" : workItem?.sourceType === "jira" ? "jira" : "manual"), [change, isDemo, workItem]);
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-1 flex items-center gap-2 text-xs text-text3">
        <MetaPill>{change.entityType}</MetaPill>
        <span>{change.field}</span>
      </div>
      <p className="font-display text-sm text-text">{change.entityLabel}</p>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-text3 line-through decoration-text3/50">{change.before}</span>
        <span className="text-text3">→</span>
        <span className="font-medium text-text">{change.after}</span>
      </p>
      <p className="mt-2 text-xs text-text2">Impact: {change.impact}</p>
      <RelatedTickets workItems={workItem ? [workItem] : undefined} label="Ticket" />
      <details className="mt-2" data-change-evidence>
        <summary className="cursor-pointer text-xs text-text3 hover:text-text2">Evidence ({evidence.length})</summary>
        <ul className="mt-1 space-y-1">
          {evidence.map((e) => (
            <li key={e.id} className="text-xs text-text2">
              <span className="mr-1 rounded bg-surface2 px-1 py-0.5 text-[10px] uppercase text-text3">{e.sourceType}</span>
              {e.content}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
