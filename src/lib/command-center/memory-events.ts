// Memory Events (V1.4 §41-42). Turns proactive-engine output into a small number of
// meaningful, human-readable Project Memory entries — never every recomputed UI value,
// only transitions worth remembering. Called once per closeDay()/sync in store.ts.

import type { DeliveryDrift, DependencyRadarItem, MemoryEvent, ReleaseDrift, RiskEscalation } from "./types";

let counter = 0;
function eventId(kind: string) {
  counter += 1;
  return `memory-event-${kind}-${counter}`;
}

export function deriveMemoryEvents(
  previousDrift: DeliveryDrift | null,
  currentDrift: DeliveryDrift,
  riskEscalations: RiskEscalation[],
  dependencyRadar: DependencyRadarItem[],
  releaseDrift: ReleaseDrift[],
  today: string
): MemoryEvent[] {
  const events: MemoryEvent[] = [];

  if (previousDrift && previousDrift.level !== currentDrift.level) {
    events.push({
      id: eventId("drift"),
      date: today,
      kind: "drift-transition",
      title: `Delivery drift moved from ${previousDrift.level} to ${currentDrift.level}`,
      impact: currentDrift.evidence[0] ?? "Delivery trajectory changed.",
      evidence: currentDrift.evidence,
    });
  }

  for (const r of riskEscalations) {
    if (r.reopened) {
      events.push({
        id: eventId("reopened"),
        date: today,
        kind: "reopened",
        title: `Risk reopened: ${r.riskTitle}`,
        impact: "A previously resolved risk has reappeared.",
        evidence: [r.escalationReason ?? `${r.riskTitle} is open again after being absent.`],
      });
    } else if (r.previousSeverity && r.currentSeverity !== r.previousSeverity && r.trend === "worsening") {
      events.push({
        id: eventId("risk-escalation"),
        date: today,
        kind: "risk-escalation",
        title: `Risk escalated: ${r.riskTitle} (${r.previousSeverity} → ${r.currentSeverity})`,
        impact: r.escalationReason ?? `Severity increased to ${r.currentSeverity}.`,
        evidence: [`${r.previousSeverity} → ${r.currentSeverity}`, `Open ${r.daysOpen} day(s)`],
      });
    }
  }

  for (const d of dependencyRadar) {
    if (d.heat === "HIGH" || d.heat === "CRITICAL") {
      events.push({
        id: eventId("dependency"),
        date: today,
        kind: "dependency-escalation",
        title: `Dependency on ${d.dependsOnTeam} reached ${d.heat} heat`,
        impact: d.recommended,
        evidence: d.evidence,
      });
    }
  }

  for (const r of releaseDrift) {
    if (r.level === "DRIFTING" || r.level === "SEVERE") {
      events.push({
        id: eventId("release"),
        date: today,
        kind: "release-drift",
        title: `Release ${r.fixVersion} is ${r.level.toLowerCase()}`,
        impact: r.drivers.join("; ") || "Release health worsened since the previous snapshot.",
        evidence: r.drivers,
      });
    }
  }

  return events;
}
