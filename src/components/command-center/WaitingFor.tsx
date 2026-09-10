"use client";

// V2.21 §8 — "WAITING FOR": what am I waiting on someone else for? Composed entirely from
// the existing Dependency Radar (see waiting-for.ts's own top comment) — no new tracking
// engine, no invented owner, no invented target date.

import type { ProactiveIntelligence } from "@/lib/command-center/proactive";
import { buildWaitingFor } from "@/lib/command-center/waiting-for";
import type { CommandCenterData, DependencyHeat } from "@/lib/command-center/types";
import { HeatBadge, Panel, SectionHeading, TrustLabel } from "./ui";

const HEAT_ORDER: Record<DependencyHeat, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

export function WaitingFor({ data, proactive }: { data: CommandCenterData; proactive: ProactiveIntelligence | null }) {
  const items = proactive ? buildWaitingFor(data, proactive.dependencyRadar) : [];

  return (
    <section>
      <SectionHeading title="Waiting For" subtitle="Unresolved dependencies — who this is waiting on, since when, and the next move." />
      <div className="mb-2 flex items-center gap-2">
        <TrustLabel kind="calculated" />
      </div>
      {items.length === 0 ? (
        <Panel className="p-4 text-sm text-text3">Nothing currently waiting on someone else.</Panel>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          {[...items].sort((a, b) => HEAT_ORDER[a.heat] - HEAT_ORDER[b.heat]).map((item) => (
            <Panel key={item.dependencyId} className="p-4">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="font-display text-sm text-text">Waiting for: {item.who}</span>
                <HeatBadge heat={item.heat} />
              </div>
              <p className="text-xs text-text2">{item.what}</p>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-text3">
                <dt>Since</dt>
                <dd className="text-text2">{item.since} ({item.ageDays} day{item.ageDays === 1 ? "" : "s"} ago)</dd>
                <dt>Expected by</dt>
                <dd className="text-text2">{item.expectedBy ?? "Not tracked"}</dd>
                <dt>Next move</dt>
                <dd className="text-text2">{item.nextMove}</dd>
                {item.projectNames.length > 0 && (
                  <>
                    <dt>Blocking</dt>
                    <dd className="text-text2">
                      {item.blockedItemCount} item{item.blockedItemCount === 1 ? "" : "s"} — {item.projectNames.join(", ")}
                    </dd>
                  </>
                )}
              </dl>
            </Panel>
          ))}
        </div>
      )}
    </section>
  );
}
