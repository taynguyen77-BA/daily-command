// Risk Escalation Engine (V1.4 §8-9). Reconstructs each open risk's severity/evidence
// history from snapshotHistory (matched by title — auto-detected risk ids are regenerated
// on every recompute, title is the stable identity, same convention selectors.ts already
// uses for dedup). Deterministic: escalation is only ever declared from an observed
// sequence of snapshots, never from a single day.

import { RISK_LEVEL_ORDER } from "./risk-detection";
import type { DailySnapshot, Risk, RiskEscalation } from "./types";

export function computeRiskEscalations(risks: Risk[], history: DailySnapshot[], today: string): RiskEscalation[] {
  void today;
  return risks
    .filter((r) => r.status === "open")
    .map((risk) => {
      // Presence of a same-titled risk on each historical day, oldest -> newest, then "today".
      const presence = history.map((day) => day.risks.some((r) => r.title === risk.title));
      presence.push(true); // the risk is open today by definition (we're mapping open risks)

      let daysOpen = 0;
      for (let i = presence.length - 1; i >= 0; i--) {
        if (presence[i]) daysOpen++;
        else break;
      }
      const runStart = presence.length - daysOpen;
      const reopened = presence.slice(0, runStart).some(Boolean);

      let previousSeverity: Risk["level"] | undefined;
      let previousEvidenceCount: number | undefined;
      for (let i = history.length - 1; i >= 0; i--) {
        const match = history[i].risks.find((r) => r.title === risk.title);
        if (match) {
          previousSeverity = match.level;
          previousEvidenceCount = match.evidence.length;
          break;
        }
      }

      const evidenceCount = risk.evidence.length;
      let trend: RiskEscalation["trend"] = "stable";
      let escalationReason: string | undefined;

      if (previousSeverity && RISK_LEVEL_ORDER[risk.level] < RISK_LEVEL_ORDER[previousSeverity]) {
        trend = "worsening";
        escalationReason = `Severity increased from ${previousSeverity} to ${risk.level}.`;
      } else if (previousSeverity && RISK_LEVEL_ORDER[risk.level] > RISK_LEVEL_ORDER[previousSeverity]) {
        trend = "improving";
      } else if (previousEvidenceCount !== undefined && evidenceCount > previousEvidenceCount && daysOpen >= 2) {
        trend = "worsening";
        escalationReason = `Unresolved for ${daysOpen} day(s) with growing supporting evidence (${previousEvidenceCount} → ${evidenceCount} item(s)).`;
      } else if (daysOpen >= 4 && risk.level !== "LOW") {
        trend = "worsening";
        escalationReason = `Remained ${risk.level} and unresolved across ${daysOpen} daily snapshot(s).`;
      }

      if (reopened && !escalationReason) {
        escalationReason = "This risk was previously resolved but has reappeared.";
      }

      return {
        riskId: risk.id,
        riskTitle: risk.title,
        currentSeverity: risk.level,
        previousSeverity,
        daysOpen,
        evidenceCount,
        trend,
        escalationReason,
        reopened,
      };
    })
    .sort((a, b) => RISK_LEVEL_ORDER[a.currentSeverity] - RISK_LEVEL_ORDER[b.currentSeverity] || b.daysOpen - a.daysOpen);
}
