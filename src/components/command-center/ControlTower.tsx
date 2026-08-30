"use client";

// Control Tower (V1.4 §20-21). The 30-second-scan surface — priority order matches §21:
// severe drift > critical/high risk > release threats > aging dependencies > decision
// conflicts > ineffective actions > important comms > everything else. Every tile is
// TrustLabel="calculated"; nothing here is AI-narrated.

import { useState } from "react";
import type { ProactiveIntelligence } from "@/lib/command-center/proactive";
import type { Freshness } from "@/lib/command-center/types";
import { FRESHNESS_LABEL } from "@/lib/command-center/freshness";
import { buildStatusUpdateDraft } from "@/lib/command-center/communicate";
import { formatScopeLabel } from "@/lib/command-center/jira/project-scope";
import { useCommandCenter } from "./use-command-center";
import { ArtifactEditor } from "./ArtifactEditor";
import { DriftBadge, HeatBadge, Panel, TrajectoryBadge, TrustLabel } from "./ui";

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-l border-border pl-3 first:border-l-0 first:pl-0">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-text3">{label}</span>
      {children}
    </div>
  );
}

export function ControlTower({
  proactive,
  deliveryConfidence,
  confidenceDelta,
  lastSyncedLabel,
  freshness,
}: {
  proactive: ProactiveIntelligence;
  deliveryConfidence: number;
  confidenceDelta?: number;
  lastSyncedLabel?: string;
  freshness?: Freshness;
}) {
  const topRisk = proactive.riskEscalations[0];
  const topDependency = proactive.dependencyRadar[0];
  const topDecision = proactive.decisionRadar[0];
  const topIneffectiveAction = proactive.attentionQueue.find((a) => a.category === "ACTION");
  const { state, filteredData, derived, personalFocus, today } = useCommandCenter();
  const [creatingUpdate, setCreatingUpdate] = useState(false);

  return (
    <Panel className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrustLabel kind="calculated" />
          <span className="text-xs text-text3">Control tower</span>
          {/* V2.4 §16 — the current Focus Project Scope is always visible on this surface,
              not just buried in the FilterBar, so a 30-second scan also answers "what am I
              even looking at?" */}
          <span className="rounded border border-border bg-surface2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text3">
            Scope: {formatScopeLabel(state.jiraProjectScope, state.data)}
          </span>
        </div>
        <button
          onClick={() => setCreatingUpdate(true)}
          className="rounded-md border border-border px-2 py-1 text-xs font-medium text-text2 hover:border-accent hover:text-text"
        >
          Create Status Update
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <Tile label="Delivery confidence">
          <span className="font-display text-2xl text-text">
            {deliveryConfidence}%{" "}
            {confidenceDelta !== undefined && confidenceDelta !== 0 && (
              <span className={confidenceDelta > 0 ? "text-green text-sm" : "text-red text-sm"}>
                {confidenceDelta > 0 ? "↑" : "↓"} {Math.abs(confidenceDelta)}
              </span>
            )}
          </span>
        </Tile>
        <Tile label="Trajectory">
          <TrajectoryBadge level={proactive.trajectory.level} />
        </Tile>
        <Tile label="Top risk">
          {topRisk ? <p className="text-sm text-text2">{topRisk.riskTitle}</p> : <p className="text-sm text-text3">None</p>}
        </Tile>
        <Tile label="Dependency">
          {topDependency ? (
            <p className="text-sm text-text2">
              {topDependency.dependsOnTeam} — {topDependency.ageDays}d <HeatBadge heat={topDependency.heat} />
            </p>
          ) : (
            <p className="text-sm text-text3">None</p>
          )}
        </Tile>
        <Tile label="Decision">
          {topDecision ? <p className="text-sm text-text2">{topDecision.decision.title}</p> : <p className="text-sm text-text3">None</p>}
        </Tile>
        <Tile label="Action">
          {topIneffectiveAction ? <p className="text-sm text-text2">{topIneffectiveAction.what}</p> : <p className="text-sm text-text3">All effective</p>}
        </Tile>
        <Tile label="Data confidence">
          <p className="text-sm text-text2">
            {freshness && <span className={freshness === "stale" ? "text-yellow" : freshness === "unknown" ? "text-text3" : "text-text2"}>{FRESHNESS_LABEL[freshness]}</span>}
            {lastSyncedLabel ? ` · ${lastSyncedLabel}` : freshness ? "" : "Live"}
          </p>
          {(freshness === "stale" || freshness === "aging") && <p className="text-[10px] text-text3">Delivery confidence above is a live calculation — this is about how fresh the underlying data is, not whether delivery is unhealthy.</p>}
        </Tile>
      </div>
      {(proactive.drift.level === "DRIFTING" || proactive.drift.level === "SEVERE") && (
        <div className="mt-3 flex items-center gap-2 border-t border-border pt-3 text-sm text-text2">
          <DriftBadge level={proactive.drift.level} />
          <span>{proactive.attentionQueue.find((a) => a.category === "DRIFT")?.why ?? "Delivery is drifting from its previous trajectory."}</span>
        </div>
      )}
      {creatingUpdate && (
        <ArtifactEditor
          draft={buildStatusUpdateDraft(filteredData, derived, proactive, personalFocus, today, "Control Tower")}
          onClose={() => setCreatingUpdate(false)}
        />
      )}
    </Panel>
  );
}
