"use client";

// Attention Queue (V1.4 §22-26, §38-40). Condensed top items for the main dashboard —
// full list with filters lives at /attention. Every item shows WHAT/WHY NOW/IMPACT/NOW
// WHAT/EVIDENCE and supports the Acknowledge/Snooze/Resolve lifecycle actions.

import { useMemo, useState } from "react";
import Link from "next/link";
import type { AttentionItem } from "@/lib/command-center/types";
import { AttentionSeverityBadge, CategoryBadge, LifecycleBadge, Panel, SectionHeading } from "./ui";
import { commandCenterStore } from "@/lib/command-center/store";
import { DecisionAssistant } from "./DecisionAssistant";
import { AskClaudeAbout } from "./AskClaudeAbout";
import { makeEvidence } from "@/lib/command-center/evidence";

export function AttentionItemCard({ item, showViewLink = false }: { item: AttentionItem; showViewLink?: boolean }) {
  const [open, setOpen] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const [assisting, setAssisting] = useState(false);
  const facts = useMemo(() => [item.what, item.why, item.impact, item.nowWhat], [item]);
  const evidence = useMemo(() => item.evidence.map((e) => makeEvidence(e, "manual", item.id)), [item]);

  function snooze(days: number) {
    const until = new Date();
    until.setDate(until.getDate() + days);
    commandCenterStore.snoozeAttentionItem(item.id, until.toISOString().slice(0, 10));
    setSnoozing(false);
  }

  return (
    <Panel className="p-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <CategoryBadge category={item.category} />
        <AttentionSeverityBadge severity={item.severity} />
        <LifecycleBadge lifecycle={item.lifecycle} />
        {item.lifecycle === "REOPENED" && <span className="text-xs text-red">Reopened — previously resolved</span>}
        {item.lifecycle === "RE_ESCALATED" && <span className="text-xs text-red">Re-escalated — severity increased</span>}
        {item.relatedDecisionId && <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent2">Decision needed</span>}
      </div>
      <p className="font-display text-sm text-text">{item.what}</p>
      <p className="mt-1 text-xs text-text2">
        <span className="font-medium text-text3">Why now: </span>
        {item.why}
      </p>
      <p className="mt-1 text-xs text-text2">
        <span className="font-medium text-text3">Impact: </span>
        {item.impact}
      </p>
      {item.lifecycle !== "RESOLVED" && (
        // V2.0 §5/§12 — deterministic impact projection, not predictive AI: this is the
        // fixed, non-causal continuation of the item's own already-computed impact above.
        <p className="mt-1 text-xs text-text3">If no intervention occurs, this condition is expected to remain unresolved.</p>
      )}
      <p className="mt-1 text-xs text-text2">
        <span className="font-medium text-text3">Now what: </span>
        {item.nowWhat}
      </p>

      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="mt-2 text-xs font-medium text-accent2 hover:underline">
        {open ? "Hide evidence" : `Evidence (${item.evidence.length})`}
      </button>
      {open && (
        <ul className="mt-2 space-y-0.5 rounded-md border border-border bg-surface2 p-2 text-xs text-text2">
          {item.evidence.map((e, i) => (
            <li key={i}>- {e}</li>
          ))}
        </ul>
      )}

      <AskClaudeAbout subject={item.what} entityId={item.id} facts={facts} evidence={evidence} />

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <button onClick={() => setAssisting(true)} className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-white hover:bg-accent2">
          What should I do?
        </button>
        {item.lifecycle !== "ACKNOWLEDGED" && item.lifecycle !== "SNOOZED" && (
          <button onClick={() => commandCenterStore.acknowledgeAttentionItem(item.id)} className="rounded-md border border-border px-2 py-1 text-xs font-medium text-text2 hover:border-accent hover:text-text">
            Acknowledge
          </button>
        )}
        {item.lifecycle !== "SNOOZED" && (
          <div className="relative">
            <button onClick={() => setSnoozing((s) => !s)} aria-expanded={snoozing} className="rounded-md border border-border px-2 py-1 text-xs font-medium text-text2 hover:border-accent hover:text-text">
              Snooze
            </button>
            {snoozing && (
              <div className="absolute left-0 top-full z-10 mt-1 flex gap-1 rounded-md border border-border bg-surface p-1 shadow-lg">
                {[1, 3, 7].map((d) => (
                  <button key={d} onClick={() => snooze(d)} className="rounded px-2 py-1 text-xs text-text2 hover:bg-surface2">
                    {d}d
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button onClick={() => commandCenterStore.resolveAttentionItem(item.id)} className="rounded-md border border-border px-2 py-1 text-xs font-medium text-text2 hover:border-accent hover:text-text">
          Resolve
        </button>
        {showViewLink && (
          <Link href="/attention" className="ml-auto text-xs font-medium text-accent2 hover:underline">
            View all →
          </Link>
        )}
      </div>
      {assisting && <DecisionAssistant item={item} onClose={() => setAssisting(false)} />}
    </Panel>
  );
}

export function AttentionQueuePanel({ items, limit = 6 }: { items: AttentionItem[]; limit?: number }) {
  const visible = items.filter((i) => i.lifecycle !== "SNOOZED" && i.lifecycle !== "RESOLVED").slice(0, limit);

  return (
    <section>
      <SectionHeading
        title="Attention Queue"
        subtitle="Consolidated, deduplicated, evidence-backed — every item explains why it needs you now."
        action={
          <Link href="/attention" className="text-xs font-medium text-accent2 hover:underline">
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
