"use client";

// V2.26 — extracted from dependencies/page.tsx so the card (and its blocked-ticket
// TaskReferenceRow) is renderable on its own; the page supplies `relatedWorkItems` resolved
// from the underlying Dependency.workItemId (task-execution.ts's workItemIdForDependency).

import React from "react";
import type { DependencyRadarItem, WorkItem } from "@/lib/command-center/types";
import { HeatBadge, Panel, TrustLabel } from "./ui";
import { RelatedTickets } from "./TaskReferenceRow";

export function DependencyRadarCard({ item, relatedWorkItems }: { item: DependencyRadarItem; relatedWorkItems?: WorkItem[] }) {
  return (
    <Panel className="p-4">
      <div className="mb-1 flex items-center gap-2">
        <HeatBadge heat={item.heat} />
        <TrustLabel kind="calculated" />
      </div>
      <p className="font-display text-sm text-text">Dependency on {item.dependsOnTeam}</p>
      <p className="mt-1 text-xs text-text2">{item.description}</p>
      <dl className="mt-2 grid grid-cols-2 gap-1 text-xs text-text2">
        <div>
          <dt className="text-text3">Age</dt>
          <dd>{item.ageDays} day(s)</dd>
        </div>
        <div>
          <dt className="text-text3">Blocks</dt>
          <dd>
            {item.blockedItemCount} item(s){item.blockedHighPriorityCount > 0 ? `, ${item.blockedHighPriorityCount} high-priority` : ""}
          </dd>
        </div>
        {item.releaseProximity && (
          <div>
            <dt className="text-text3">Release</dt>
            <dd>
              {item.releaseProximity.fixVersion} in {item.releaseProximity.daysToRelease}d
            </dd>
          </div>
        )}
        {item.linkedRiskLevel && (
          <div>
            <dt className="text-text3">Linked risk</dt>
            <dd>{item.linkedRiskLevel}</dd>
          </div>
        )}
        <div>
          <dt className="text-text3">Owner</dt>
          <dd>{item.ownerId ?? "Unassigned"}</dd>
        </div>
      </dl>
      <p className="mt-2 text-xs font-medium text-accent2">Recommended: {item.recommended}</p>
      <RelatedTickets workItems={relatedWorkItems} label="Blocked ticket" />
    </Panel>
  );
}
