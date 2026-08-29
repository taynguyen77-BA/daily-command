// AI Context Builder (BUILD REQUEST V1.3 §23). The one place that assembles what Claude is
// allowed to see. Deliberately compact — top-N slices, never the full dataset, never a raw
// Jira payload, never credentials — so every AI call built on top of this stays cheap and
// every fact in it is already deterministic (§34 "minimize token usage").

import type { DerivedData } from "./selectors";
import type { ProactiveIntelligence } from "./proactive";
import type { AIContext, CommandCenterData, DailySnapshot, DataSourceType } from "./types";
import { buildSnapshotMetrics } from "./memory";

export interface AIContextOptions {
  clientFilter?: string;
  projectFilter?: string;
  dataSourceType: DataSourceType;
  lastSyncedAt?: string;
  baseUrlHost?: string;
  // V1.4 §27-28 — optional; when provided, small top-N slices are attached to the context.
  proactive?: ProactiveIntelligence;
}

export function buildAIContext(
  data: CommandCenterData,
  derived: DerivedData,
  previousSnapshot: DailySnapshot | null,
  today: string,
  options: AIContextOptions
): AIContext {
  const currentMetrics = buildSnapshotMetrics(data, today, derived.changes.length);
  const p = options.proactive;

  return {
    clientFilter: options.clientFilter,
    projectFilter: options.projectFilter,
    currentMetrics,
    previousMetrics: previousSnapshot?.metrics,
    topScores: derived.scores.slice(0, 8).map((s) => {
      const item = data.workItems.find((w) => w.id === s.itemId);
      return { key: item?.key ?? s.itemId, title: item?.title ?? "", score: s.score, classification: s.classification };
    }),
    topRisks: derived.risks.slice(0, 8).map((r) => ({ title: r.title, level: r.level, reason: r.reason })),
    meaningfulChanges: derived.changes.slice(0, 8).map((c) => ({ entityLabel: c.entityLabel, field: c.field, before: c.before, after: c.after })),
    activeDecisions: data.decisions
      .filter((d) => d.status === "pending" || d.status === "ACTIVE" || d.status === "AT_RISK" || d.status === "REVISIT_REQUIRED")
      .slice(0, 8)
      .map((d) => ({ title: d.title, status: d.status })),
    recentActionOutcomes: data.actions
      .filter((a) => a.outcome)
      .slice(-5)
      .map((a) => ({ title: a.title, outcome: a.outcome! })),
    source: { type: options.dataSourceType, lastSyncedAt: options.lastSyncedAt, baseUrlHost: options.baseUrlHost },
    drift: p ? { level: p.drift.level, score: p.drift.score, trendQuality: p.drift.trendQuality } : undefined,
    topRiskEscalations: p?.riskEscalations.slice(0, 3).map((r) => ({ title: r.riskTitle, severity: r.currentSeverity, trend: r.trend, daysOpen: r.daysOpen })),
    topDependencyRadar: p?.dependencyRadar.slice(0, 3).map((d) => ({ description: d.description, team: d.dependsOnTeam, heat: d.heat })),
    topAttentionItems: p?.attentionQueue.slice(0, 5).map((a) => ({ category: a.category, severity: a.severity, what: a.what, why: a.why })),
  };
}
