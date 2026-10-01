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
          <Link href="/my-work?view=today" className="link text-xs">
            Open My Work →
          </Link>
        }
      />
      <div className="mb-2">
        <TrustLabel kind="calculated" />
      </div>
      <div className="mb-3 grid grid-cols-3 gap-2">
        {MY_WORK_VIEWS.map((v) => (
          <Link
            key={v.id}
            href={`/my-work?view=${v.id}`}
            data-my-work-count={v.id}
            className="group rounded-lg border border-border bg-surface px-3 py-2 transition-colors hover:border-accent/60 hover:bg-surface2"
          >
            <span className="block truncate text-[11px] font-medium text-text3 group-hover:text-text2">{v.label}</span>
            <span className={`tabular block text-lg font-semibold leading-6 ${work.counts[v.id] > 0 ? "text-text" : "text-text3"}`}>{work.counts[v.id]}</span>
          </Link>
        ))}
      </div>
      {top.length === 0 ? (
        <Panel className="p-4 text-sm text-text3">Nothing open for you today.</Panel>
      ) : (
        <Panel className="p-4">
          <ul>
            {top.map((r) => (
              <TaskRow stacked key={r.ticketKey} ticketKey={r.ticketKey} workItem={r.workItem} signals={r.view.signals} reactivation={r.view.reactivation} surface="command-center" />
            ))}
          </ul>
        </Panel>
      )}
    </section>
  );
}
