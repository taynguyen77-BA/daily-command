"use client";

import { useEffect, useState } from "react";
import { getAIProvider } from "@/lib/command-center/ai";
import { evidenceForScore, factsForWorkItem } from "@/lib/command-center/evidence";
import type { CommandCenterData, PriorityScoreResult, ReasoningTrace, WorkItem } from "@/lib/command-center/types";
import { clientName } from "@/lib/command-center/selectors";
import type { WorkRelevanceIndex } from "@/lib/command-center/jira/work-relevance";
import type { ProactiveIntelligence } from "@/lib/command-center/proactive";
import type { PersonalFocusResult } from "@/lib/command-center/types";
import { ConfidenceTag, ReasoningTraceBlock, SeverityBadge, TrustLabel } from "./ui";
import { WhyNotATaskDrawer } from "./WhyNotATaskDrawer";
import { ExecutionPathTrace } from "./ExecutionPathTrace";
import { TicketLink } from "./TicketLink";

function recommendedAction(item: WorkItem): string {
  if (item.blocked) return `Escalate the blocker: ${item.blockerReason ?? "unblock dependency"}.`;
  if (!item.owner) return "Assign an owner today.";
  if (item.dueDate) return "Confirm remaining scope with the team before the due date.";
  return "Review status with the owner.";
}

export function PriorityCard({
  item,
  result,
  data,
  isDemo,
  onTakeAction,
  workRelevanceIndex,
  today,
  proactive,
  personalFocus,
}: {
  item: WorkItem;
  result: PriorityScoreResult;
  data: CommandCenterData;
  isDemo: boolean;
  onTakeAction: () => void;
  // V2.6 §7 — optional: Priorities is one of the few entry points wired to "Why isn't this
  // on my work list?" (§7 "smallest number of useful entry points"). Undefined is a no-op,
  // not a crash — any other PriorityCard caller keeps working unchanged.
  workRelevanceIndex?: WorkRelevanceIndex;
  // V2.8 §9 — optional, same no-op-when-absent contract: the Execution Path trace only
  // renders when the caller supplies today + proactive + personalFocus alongside the index.
  today?: string;
  proactive?: ProactiveIntelligence | null;
  personalFocus?: PersonalFocusResult | null;
}) {
  const [trace, setTrace] = useState<ReasoningTrace | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || trace) return;
    const facts = factsForWorkItem(item, data);
    const evidence = evidenceForScore(item, result, isDemo ? "demo" : "manual");
    getAIProvider().analyzePriorities(item, result, facts, evidence).then(setTrace);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-2 flex items-center gap-2">
        <SeverityBadge level={result.classification} />
        <TrustLabel kind="calculated" />
        <TicketLink ticketKey={item.key} url={item.sourceUrl} className="text-xs text-text3" />
        <span className="text-xs text-text3">·</span>
        <span className="text-xs text-text3">{clientName(data, item.clientId)}</span>
        {item.sourceType === "jira" && item.sourceUrl && (
          <>
            <TrustLabel kind="source" />
            <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="text-xs text-accent2 hover:underline">
              Open in Jira
            </a>
          </>
        )}
        <span className="ml-auto text-xs font-mono text-text3">{result.score}/100</span>
      </div>
      <h3 className="font-display text-base text-text">{item.title}</h3>
      <p className="mt-1 text-sm text-text2">{result.reasoning}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-text3">
        <span>Status: {item.status}</span>
        {item.owner && <span>Owner: {item.owner}</span>}
        {item.dueDate && <span>Due: {item.dueDate}</span>}
        <ConfidenceTag confidence={result.confidence} />
      </div>

      <div className="mt-3 rounded-md border border-border bg-surface2 p-3">
        {/* V2.2.1 — recommendedAction() below is a plain deterministic template (blocked?
            no owner?), never an AI call; labeling it "calculated" (not "ai-recommendation")
            matches what it actually is. */}
        <p className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-text3">
          <TrustLabel kind="calculated" /> Recommended action
        </p>
        <p className="mt-1 text-sm text-text2">{recommendedAction(item)}</p>
      </div>

      <div className="mt-2">
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-xs font-medium text-accent2 hover:underline">
          {open ? "Hide" : "Why am I seeing this?"}
        </button>
        {open && (
          <div className="mt-2 rounded-md border border-border bg-surface2 p-3 text-xs">
            {trace ? <ReasoningTraceBlock trace={trace} /> : <p className="text-text3">Loading reasoning trace…</p>}
          </div>
        )}
      </div>

      {workRelevanceIndex && <WhyNotATaskDrawer item={item} workRelevanceIndex={workRelevanceIndex} />}

      {workRelevanceIndex && today && (
        <ExecutionPathTrace item={item} data={data} today={today} workRelevanceIndex={workRelevanceIndex} proactive={proactive ?? null} personalFocus={personalFocus ?? null} />
      )}

      <button
        onClick={onTakeAction}
        className="mt-3 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent2"
      >
        Take Action
      </button>
    </div>
  );
}
