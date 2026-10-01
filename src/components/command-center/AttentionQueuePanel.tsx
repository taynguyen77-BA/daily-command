"use client";

// Attention Queue (V1.4 §22-26, §38-40). Condensed top items for the main dashboard —
// full list with filters lives at /attention. Every item shows WHAT/WHY NOW/IMPACT/NOW
// WHAT/EVIDENCE and supports the Acknowledge/Snooze/Resolve lifecycle actions.

import { useMemo, useState } from "react";
import Link from "next/link";
import type { AttentionItem } from "@/lib/command-center/types";
import { AttentionSeverityBadge, CategoryBadge, LifecycleBadge, MetaPill, Panel, RelationBadge, SectionHeading } from "./ui";
import { commandCenterStore } from "@/lib/command-center/store";
import { DecisionAssistant } from "./DecisionAssistant";
import { AskClaudeAbout } from "./AskClaudeAbout";
import { ArtifactEditor } from "./ArtifactEditor";
import { makeEvidence } from "@/lib/command-center/evidence";
import { buildStakeholderUpdateDraft } from "@/lib/command-center/communicate";
import { ReactivatedBadge, TaskRow } from "./TaskReferenceRow";
import { groupMentionItems, mentionGroupLabel } from "@/lib/command-center/mention-grouping";

/** V2.17 §1a point 4 — folds several still-visible MENTION items on the same ticket into one
 *  card (see mention-grouping.ts's own top comment for the full "why"). Purely a display
 *  concern: grouping happens on whatever list is about to be rendered, never on the queue
 *  itself, so lifecycle actions (Acknowledge/Snooze/Resolve) below still operate on the real,
 *  individual underlying AttentionItem the representative card was built from. */
export function groupMentionAttentionItems(items: AttentionItem[]): AttentionItem[] {
  return groupMentionItems(items, {
    isMention: (item) => item.category === "MENTION",
    // sourceRef (set directly by attention-queue.ts) rather than ticketKey (only populated
    // later, by proactive.ts's enrichment pass) — grouping must work even against the raw
    // queue output, not just the fully-enriched one.
    groupKey: (item) => (item.sourceRef?.type === "workItem" ? item.sourceRef.id : item.ticketKey),
    recency: (item) => item.lastSeenDate,
    relabel: (mostRecent, count) => ({ ...mostRecent, what: mentionGroupLabel(count) }),
  });
}

export function AttentionItemCard({ item, showViewLink = false }: { item: AttentionItem; showViewLink?: boolean }) {
  const [open, setOpen] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const [assisting, setAssisting] = useState(false);
  const [creatingUpdate, setCreatingUpdate] = useState(false);
  const facts = useMemo(() => [item.what, item.why, item.impact, item.nowWhat], [item]);
  const evidence = useMemo(() => item.evidence.map((e) => makeEvidence(e, "manual", item.id)), [item]);

  function snooze(days: number) {
    const until = new Date();
    until.setDate(until.getDate() + days);
    commandCenterStore.snoozeAttentionItem(item.id, until.toISOString().slice(0, 10));
    setSnoozing(false);
  }

  return (
    <Panel className="flex flex-col p-4">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {/* V2.17 Task 3 §2 — relation ("is this mine?") leads, then category/severity; the
            ticket link and lifecycle recede into the quieter tail of the row. */}
        <RelationBadge relation={item.relation} />
        <CategoryBadge category={item.category} />
        <AttentionSeverityBadge severity={item.severity} />
        {item.relatedDecisionId && <MetaPill variant="accent">Decision needed</MetaPill>}
        {item.lifecycle === "REOPENED" && <span className="text-xs text-red">Reopened — previously resolved</span>}
        {item.lifecycle === "RE_ESCALATED" && <span className="text-xs text-red">Re-escalated — severity increased</span>}
        {item.reactivation && <ReactivatedBadge reactivation={item.reactivation} />}
        {/* The ticket key/link lives in the ticket row below (no duplicate up here). */}
        <span className="ml-auto">
          <LifecycleBadge lifecycle={item.lifecycle} />
        </span>
      </div>
      <p className="font-display text-[15px] font-semibold leading-snug text-text">{item.what}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-text2">
        <span className="font-medium text-text3">Why now: </span>
        {item.why}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-text2">
        <span className="font-medium text-text3">Impact: </span>
        {item.impact}
      </p>
      {item.lifecycle !== "RESOLVED" && (
        // V2.0 §5/§12 — deterministic impact projection, not predictive AI: this is the
        // fixed, non-causal continuation of the item's own already-computed impact above.
        <p className="mt-1 text-xs text-text3">If no intervention occurs, this condition is expected to remain unresolved.</p>
      )}
      <p className="mt-1.5 rounded-md bg-surface2/70 px-2.5 py-1.5 text-xs leading-relaxed text-text">
        <span className="font-semibold text-accent2">Now what: </span>
        {item.nowWhat}
      </p>

      {/* A signal about a ticket shows that ticket's status (one TicketWorkState for every list)
          and the full ticket action set; "Done" there resolves this and every other open signal
          on the ticket. Resolve below only dismisses this one signal. */}
      {item.ticketKey && (
        <div className="mt-3 rounded-lg border border-border bg-surface2/60 px-3">
          <TaskRow stacked as="div" ticketKey={item.ticketKey} url={item.ticketUrl} showTitle={false} surface="attention" />
        </div>
      )}

      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="link mt-3 self-start text-xs">
        {open ? "Hide evidence" : `Evidence (${item.evidence.length})`}
      </button>
      {open && (
        <ul className="mt-2 space-y-0.5 rounded-lg border border-border bg-surface2 p-3 text-xs text-text2">
          {item.evidence.map((e, i) => (
            <li key={i}>- {e}</li>
          ))}
        </ul>
      )}

      <AskClaudeAbout subject={item.what} entityId={item.id} facts={facts} evidence={evidence} />

      {/* Primary moves on the left; the signal's lifecycle (acknowledge / snooze / resolve) on
          the right, quieter — every action is still one click. */}
      <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
        <button onClick={() => setAssisting(true)} className="btn btn-sm btn-primary">
          What should I do?
        </button>
        <button onClick={() => setCreatingUpdate(true)} className="btn btn-sm btn-secondary">
          Create Stakeholder Update
        </button>
        <span className="flex flex-wrap items-center gap-1 sm:ml-auto">
        {item.lifecycle !== "ACKNOWLEDGED" && item.lifecycle !== "SNOOZED" && (
          <button onClick={() => commandCenterStore.acknowledgeAttentionItem(item.id)} className="btn btn-sm btn-ghost">
            Acknowledge
          </button>
        )}
        {item.lifecycle !== "SNOOZED" && (
          <div className="relative">
            <button onClick={() => setSnoozing((s) => !s)} aria-expanded={snoozing} className="btn btn-sm btn-ghost">
              Snooze
            </button>
            {snoozing && (
              <div className="absolute right-0 top-full z-10 mt-1 flex gap-1 rounded-lg border border-border2 bg-surface p-1 shadow-pop">
                {[1, 3, 7].map((d) => (
                  <button key={d} onClick={() => snooze(d)} className="btn btn-sm btn-ghost">
                    {d}d
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button onClick={() => commandCenterStore.resolveAttentionItem(item.id)} className="btn btn-sm btn-ghost">
          Resolve
        </button>
        </span>
        {showViewLink && (
          <Link href="/attention" className="link ml-auto text-xs">
            View all →
          </Link>
        )}
      </div>
      {assisting && <DecisionAssistant item={item} onClose={() => setAssisting(false)} />}
      {creatingUpdate && (
        <ArtifactEditor draft={buildStakeholderUpdateDraft({ kind: "attention", item }, "Attention Queue")} onClose={() => setCreatingUpdate(false)} />
      )}
    </Panel>
  );
}

export function AttentionQueuePanel({ items, limit = 6 }: { items: AttentionItem[]; limit?: number }) {
  const visible = groupMentionAttentionItems(items.filter((i) => i.lifecycle !== "SNOOZED" && i.lifecycle !== "RESOLVED")).slice(0, limit);

  return (
    <section>
      <SectionHeading
        title="Attention Queue"
        subtitle="Consolidated, deduplicated, evidence-backed — every item explains why it needs you now."
        action={
          <Link href="/attention" className="link text-xs">
            View all →
          </Link>
        }
      />
      {visible.length === 0 ? (
        <Panel className="p-6 text-sm text-text3">Nothing needs attention right now.</Panel>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {visible.map((item) => (
            <AttentionItemCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}
