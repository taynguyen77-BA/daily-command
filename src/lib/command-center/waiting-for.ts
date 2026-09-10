// V2.21 §8 — "Waiting For". Answers "what am I waiting on someone else for?" by COMPOSING
// the existing Dependency Radar (dependency-radar.ts) rather than introducing a second
// tracking engine: every Dependency already carries WHO (dependsOnTeam) and SINCE
// (raisedDate) explicitly, and computeDependencyRadar already derives a deterministic NEXT
// MOVE (`recommended`) from real signal (ownership, release proximity). This module only
// reshapes that existing evidence into the WHO/WHAT/SINCE/EXPECTED BY/NEXT MOVE view — it
// never invents an owner, a target date, or a new waiting state.
//
// EXPECTED BY is intentionally honest about a real data-model gap: Dependency has no target/
// expected-resolution-date field at all (see gap-detection.ts's own comment on this same
// fact), so `expectedBy` is always undefined today — the UI must render "Not tracked", never
// a fabricated date. If a target-date field is ever added to Dependency, this module starts
// reporting it with no other change required.
//
// Scope: deliberately limited to unresolved Dependencies — the one place in this data model
// with an unambiguous "who is this waiting on" fact. A WorkItem classified WAITING by the
// Work Relevance Policy is a related but distinct concept (the TICKET's current status, not
// a specific party being waited on) and is surfaced elsewhere (Work Relevance Policy /
// Command Bar's "what is waiting?"); folding it in here would mean guessing a "who" from the
// ticket's own assignee, which is often the person DOING the work, not who it's waiting on —
// exactly the ownership-inference this feature must never do.

import { projectName as lookupProjectName } from "./selectors";
import type { CommandCenterData, DependencyHeat, DependencyRadarItem } from "./types";

export interface WaitingForItem {
  dependencyId: string;
  who: string;
  what: string;
  since: string; // ISO date — Dependency.raisedDate, never invented
  ageDays: number;
  expectedBy?: string; // always undefined until Dependency gains a target-date field — never fabricated
  nextMove: string; // reuses DependencyRadarItem.recommended verbatim
  heat: DependencyHeat;
  blockedItemCount: number;
  projectNames: string[];
}

/** Pure reshape over an already-computed dependencyRadar (proactive.ts) + the same raw
 *  `data.dependencies` it was built from — no new detection, no new scoring. Order matches
 *  dependencyRadar's own (heat, then age) since that's already the right "most urgent first"
 *  ordering for a waiting list. */
export function buildWaitingFor(data: CommandCenterData, dependencyRadar: DependencyRadarItem[]): WaitingForItem[] {
  const depById = new Map(data.dependencies.map((d) => [d.id, d]));
  const out: WaitingForItem[] = [];

  for (const radarItem of dependencyRadar) {
    const dep = depById.get(radarItem.dependencyId);
    if (!dep) continue; // defensive — radar is always derived from data.dependencies, never out of sync

    const blockedItems = data.workItems.filter((w) => w.dependencyIds.includes(dep.id) && w.status !== "Done");
    const projectNames = Array.from(new Set(blockedItems.map((w) => lookupProjectName(data, w.projectId))));

    out.push({
      dependencyId: dep.id,
      who: radarItem.dependsOnTeam,
      what: radarItem.description,
      since: dep.raisedDate,
      ageDays: radarItem.ageDays,
      expectedBy: undefined,
      nextMove: radarItem.recommended,
      heat: radarItem.heat,
      blockedItemCount: radarItem.blockedItemCount,
      projectNames,
    });
  }

  return out;
}
