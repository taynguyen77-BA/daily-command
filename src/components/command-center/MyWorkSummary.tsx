"use client";

// Command Center's compact view of My Work: the count per view and the top Today items, each a
// TaskRow (same status, same actions as everywhere). Replaces the separate Your Delivery Focus
// and My Assigned Work blocks this page used to carry — both live in My Work now.

import Link from "next/link";
import { MY_WORK_VIEWS } from "@/lib/command-center/my-work";
import { useMyWork } from "./use-my-work";
import { Panel, SectionHeading, TrustLabel } from "./ui";
import { TaskRow } from "./TaskReferenceRow";

export function MyWorkSummary({ topN = 3 }: { topN?: number }) {
  const { work } = useMyWork();
  const top = work.views.today.slice(0, topN);
  return (
    <section data-my-work-summary>
      <SectionHeading
        title="My Work"
        subtitle="Your tickets, one status each — the same on every page."
        action={
          <Link href="/my-work?view=today" className="text-xs font-medium text-accent2 hover:underline">
            Open My Work →
          </Link>
        }
      />
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <TrustLabel kind="calculated" />
        {MY_WORK_VIEWS.map((v) => (
          <Link key={v.id} href={`/my-work?view=${v.id}`} data-my-work-count={v.id} className="rounded-md border border-border px-2 py-1 text-xs text-text2 hover:border-accent hover:text-text">
            {v.label}: <span className="font-semibold text-text">{work.counts[v.id]}</span>
          </Link>
        ))}
      </div>
      {top.length === 0 ? (
        <Panel className="p-4 text-sm text-text3">Nothing open for you today.</Panel>
      ) : (
        <Panel className="p-4">
          <ul>
            {top.map((r) => (
              <TaskRow key={r.ticketKey} ticketKey={r.ticketKey} workItem={r.workItem} signals={r.view.signals} reactivation={r.view.reactivation} surface="command-center" />
            ))}
          </ul>
        </Panel>
      )}
    </section>
  );
}
