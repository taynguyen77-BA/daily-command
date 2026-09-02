"use client";

// V2.6 §6-7 — "Why isn't this on my work list?" A reusable, deterministic explanation
// surface for a Jira work item that is NOT present in Personal Work / Action Plan. Reuses
// the exact V2.5 explainWorkItemRelevance()/WORK_RELEVANCE_EXPLANATIONS text (§6 "Do not use
// AI for this explanation. Use deterministic wording.") and the WhyDrawer/TrustLabel
// expand-in-place pattern already used across the app — no new drawer architecture, no new
// navigation system (§7).

import { useState } from "react";
import Link from "next/link";
import { explainWorkItemRelevance, type WorkRelevanceIndex } from "@/lib/command-center/jira/work-relevance";
import type { WorkItem } from "@/lib/command-center/types";
import { TrustLabel } from "./ui";

export function WhyNotATaskDrawer({ item, workRelevanceIndex }: { item: WorkItem; workRelevanceIndex: WorkRelevanceIndex }) {
  const [open, setOpen] = useState(false);

  // §6 — this surface only makes sense for a Jira-sourced item; a non-Jira (demo/local
  // import) item has no Jira status identity for the policy to apply to (NOT_APPLICABLE).
  if (item.sourceType !== "jira") return null;

  const explanation = explainWorkItemRelevance(item, workRelevanceIndex);
  if (!explanation.isApplicable) return null;

  return (
    <div className="mt-2">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-xs font-medium text-accent2 hover:underline">
        {open ? "Hide" : "Why isn't this on my work list?"}
      </button>
      {open && (
        <div className="mt-2 space-y-2 rounded-md border border-border bg-surface2 p-3 text-xs">
          <div>
            <p className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide text-text3">
              <TrustLabel kind="calculated" /> Status
            </p>
            <p className="text-text2">{item.jiraStatusName ?? "—"}</p>
          </div>
          <div>
            <p className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide text-text3">
              <TrustLabel kind="calculated" /> Work relevance
            </p>
            <p className="text-text2">{explanation.relevance}</p>
          </div>
          <div>
            <p className="mb-1 font-semibold uppercase tracking-wide text-text3">Why</p>
            <p className="text-text2">{explanation.answer}</p>
          </div>
          <div className="border-t border-border pt-2">
            <Link href="/data-settings#jira-work-relevance-policy-panel" className="font-medium text-accent2 hover:underline">
              {explanation.relevance === "UNKNOWN" ? "Classify this status" : "Change status policy"}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
