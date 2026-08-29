// Recurring pattern detection (BUILD REQUEST V1.2 §11). Purely deterministic — scans
// historical snapshots (never live-only data) so a "pattern" always means "this showed up
// more than once over time," not "this looks bad right now." Minimum 2 occurrences before
// anything is labeled recurring (§11: "prefer at least 2-3 occurrences").

import { makeEvidence } from "./evidence";
import { detectRisks } from "./risk-detection";
import type { CommandCenterData, DailySnapshot, Evidence, EvidenceSourceType, RecurringPattern } from "./types";

let counter = 0;
function patternId(): string {
  counter += 1;
  return `pattern-${counter}`;
}

function confidenceForCount(count: number): number {
  if (count >= 4) return 0.85;
  if (count === 3) return 0.75;
  return 0.6; // exactly 2 — the minimum threshold
}

/** history should be ordered oldest→newest and NOT include the live/current state. */
export function detectRecurringPatterns(
  history: DailySnapshot[],
  current: CommandCenterData,
  today: string,
  sourceType: EvidenceSourceType
): RecurringPattern[] {
  const out: RecurringPattern[] = [];

  // Live risks count as "today's occurrence" alongside historical snapshot metrics.
  const liveRiskTitles = Array.from(
    new Set([...current.risks.filter((r) => r.status === "open").map((r) => r.title), ...detectRisks(current, today).map((r) => r.title)])
  );
  const liveDepTeams = Array.from(new Set(current.dependencies.filter((d) => d.status === "unresolved").map((d) => d.dependsOnTeam)));

  // ----- Recurring risks -----
  const riskOccurrences = new Map<string, { date: string }[]>();
  for (const snap of history) {
    for (const title of snap.metrics?.majorRiskTitles ?? []) {
      riskOccurrences.set(title, [...(riskOccurrences.get(title) ?? []), { date: snap.date }]);
    }
  }
  for (const title of liveRiskTitles) {
    riskOccurrences.set(title, [...(riskOccurrences.get(title) ?? []), { date: today }]);
  }
  riskOccurrences.forEach((occurrences, title) => {
    if (occurrences.length < 2) return;
    const evidence: Evidence[] = occurrences.map((o: { date: string }) => makeEvidence(`Present on ${o.date}`, sourceType));
    out.push({
      id: patternId(),
      kind: "risk",
      title: `"${title}" has appeared ${occurrences.length} time(s) in the available history`,
      occurrences: occurrences.length,
      evidence,
      confidence: confidenceForCount(occurrences.length),
    });
  });

  // ----- Recurring dependency teams -----
  const depOccurrences = new Map<string, { date: string }[]>();
  for (const snap of history) {
    for (const team of snap.metrics?.unresolvedDependencyTeams ?? []) {
      depOccurrences.set(team, [...(depOccurrences.get(team) ?? []), { date: snap.date }]);
    }
  }
  for (const team of liveDepTeams) {
    depOccurrences.set(team, [...(depOccurrences.get(team) ?? []), { date: today }]);
  }
  depOccurrences.forEach((occurrences, team) => {
    if (occurrences.length < 2) return;
    const evidence: Evidence[] = occurrences.map((o: { date: string }) => makeEvidence(`Unresolved dependency on ${team} present on ${o.date}`, sourceType));
    out.push({
      id: patternId(),
      kind: "dependency-team",
      title: `Dependencies on ${team} have recurred ${occurrences.length} time(s) in the available history`,
      occurrences: occurrences.length,
      evidence,
      confidence: confidenceForCount(occurrences.length),
    });
  });

  // ----- Recurring overdue work (portfolio-level trend) -----
  const overdueSnapshots = history.filter((s) => (s.metrics?.overdueCount ?? 0) > 0);
  const overdueOccurrenceDates = overdueSnapshots.map((s) => s.date);
  if (overdueOccurrenceDates.length >= 2) {
    const evidence: Evidence[] = overdueSnapshots.map((s) => makeEvidence(`${s.metrics?.overdueCount} overdue item(s) on ${s.date}`, sourceType));
    out.push({
      id: patternId(),
      kind: "overdue-trend",
      title: `Overdue work has appeared in ${overdueOccurrenceDates.length} of the last ${history.length} snapshot(s)`,
      occurrences: overdueOccurrenceDates.length,
      evidence,
      confidence: confidenceForCount(overdueOccurrenceDates.length),
    });
  }

  return out.sort((a, b) => b.confidence - a.confidence);
}
