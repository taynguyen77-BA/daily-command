"use client";

// V2.26 — extracted from loops/page.tsx so the card (and its TaskReferenceRow tickets) is
// renderable on its own. `relatedWorkItems` comes from the loop's explicit links only — its
// Decision's relatedWorkItemIds and its Action's relatedWorkItemId (task-execution.ts's
// relatedWorkItemIdsForLoop). `children` carries the page's own follow-up-action UI.

import React, { useMemo } from "react";
import type { DeliveryLoop, WorkItem } from "@/lib/command-center/types";
import { LoopHealthBadge, Panel } from "./ui";
import { RelatedTickets } from "./TaskReferenceRow";
import { WhyShouldICareDrawer } from "./WhyShouldICareDrawer";
import { projectLoopImpact } from "@/lib/command-center/impact-projection";
import { buildWhyShouldICare } from "@/lib/command-center/why-should-i-care";

export function DeliveryLoopCard({ loop, relatedWorkItems, children }: { loop: DeliveryLoop; relatedWorkItems?: WorkItem[]; children?: React.ReactNode }) {
  // C1 — "If nothing changes", same block Risk/Decision cards use (impact-projection.ts).
  const impactContent = useMemo(() => {
    const impact = projectLoopImpact(loop);
    return buildWhyShouldICare({
      fact: [`Health: ${loop.health}`, `Decision: ${loop.decision?.title ?? "none"}`, `Action: ${loop.action?.title ?? "pending"}`, `Outcome: ${loop.outcomeStatus ?? "unknown"}`],
      signal: loop.why,
      impact,
      unknown: loop.outcomeStatus ? [] : ["No outcome has been recorded yet."],
      nextMove: loop.nowWhat,
      evidence: impact.evidence,
    });
  }, [loop]);
  return (
    <Panel className="p-4">
      <div className="mb-1 flex items-center gap-2">
        <LoopHealthBadge health={loop.health} />
      </div>
      <p className="font-display text-sm text-text">{loop.issue}</p>
      <dl className="mt-2 space-y-1 text-xs text-text2">
        <div>
          <dt className="inline text-text3">Decision: </dt>
          <dd className="inline">{loop.decision?.title ?? "—"} {loop.decision ? `(${loop.decision.status})` : ""}</dd>
        </div>
        <div>
          <dt className="inline text-text3">Action: </dt>
          <dd className="inline">{loop.action ? `${loop.action.title} (${loop.action.status})` : "Pending"}</dd>
        </div>
        <div>
          <dt className="inline text-text3">Outcome: </dt>
          <dd className="inline">{loop.outcomeStatus ?? "Unknown"}</dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-text2">{loop.why}</p>
      <p className="mt-1 text-xs font-medium text-accent2">Now what: {loop.nowWhat}</p>
      <RelatedTickets workItems={relatedWorkItems} />
      <WhyShouldICareDrawer content={impactContent} triggerLabel="If nothing changes" />
      {children}
    </Panel>
  );
}
