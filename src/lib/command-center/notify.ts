// V2.10 §3 — real-time delivery: which brand-new personal signals (MENTION/ASSIGNMENT) does
// this sync's attention queue carry that genuinely weren't there before? Pure function over
// data already computed by attention-queue.ts — no I/O, no fetch, no Slack logic here (that
// stays in the API-route layer — see app/api/command-center/notify/route.ts and the sync
// route that calls it).
//
// Non-negotiable boundary (§3): this NEVER returns a DRIFT/RISK/DEPENDENCY/DECISION/ACTION/
// COMMUNICATION item, even one that happened to carry `ownershipExplicit: true` — those six
// categories are team-wide signals by design (see the Ground Rule in DEV_PROMPT_V2.10), and
// `ownershipExplicit` is never actually set on them by attention-queue.ts in the first place
// (only MENTION/ASSIGNMENT items ever carry it). The category check below is the primary,
// intentional gate; the ownershipExplicit check is the second, redundant one.

import type { AttentionItem, AttentionItemState, CommandCenterData } from "./types";

export function computeNewPersonalSignals(previousAttentionState: Record<string, AttentionItemState>, currentAttentionQueue: AttentionItem[]): AttentionItem[] {
  return currentAttentionQueue.filter(
    (item) =>
      (item.category === "MENTION" || item.category === "ASSIGNMENT") &&
      item.ownershipExplicit === true &&
      // "New" is decided entirely by the attention queue's own lifecycle field (§3 — "do not
      // invent a second 'is this new' concept"); checking there was no prior recorded state
      // for this exact id is a redundant, belt-and-suspenders confirmation of the same fact,
      // never a second source of truth.
      item.lifecycle === "NEW" &&
      !previousAttentionState[item.id]
  );
}

/** One Slack message's worth of plain data — never a rendered Slack message itself (that
 *  stays in the notify API route, next to the webhook secret it requires). Pure/no I/O: only
 *  resolves each signal's real WorkItem (for its Jira key/link) from already-loaded data. */
export interface SlackSignalPayload {
  issueKey: string;
  summary: string;
  url?: string;
  kind: "MENTION" | "ASSIGNMENT";
  detail: string;
}

export function buildSlackNotifyPayloads(signals: AttentionItem[], data: CommandCenterData): SlackSignalPayload[] {
  return signals
    .filter((item): item is AttentionItem & { category: "MENTION" | "ASSIGNMENT" } => item.category === "MENTION" || item.category === "ASSIGNMENT")
    .map((item) => {
      const workItem = item.sourceRef?.type === "workItem" ? data.workItems.find((w) => w.id === item.sourceRef!.id) : undefined;
      return {
        issueKey: workItem?.key ?? item.id,
        summary: item.what,
        url: workItem?.sourceUrl,
        kind: item.category,
        // MENTION's evidence is already the formatted `Author: "excerpt"` string (see
        // attention-queue.ts); ASSIGNMENT has no excerpt, so `why` carries the detail instead.
        detail: item.category === "MENTION" ? item.evidence[0] ?? item.why : item.why,
      };
    });
}
