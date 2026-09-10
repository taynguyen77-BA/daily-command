// Pure derived-data selectors — combine the deterministic engines into what each screen needs.
// No AI calls happen here; screens call the AI provider separately for prose narration.

import { detectChanges } from "./change-detection";
import { detectRisks, riskFingerprint, RISK_LEVEL_ORDER } from "./risk-detection";
import { isOverdue, scoreAllWorkItems } from "./scoring";
import { isWorkItemOperationallyOpen, type WorkRelevanceIndex } from "./jira/work-relevance";
import type { CommandCenterData, ChangeEvent, DailySnapshot, PriorityScoreResult, Risk, WorkItem } from "./types";

export interface Kpis {
  needAttention: number;
  watching: number;
  onTrack: number;
  overdue: number;
}

export interface DerivedData {
  scores: PriorityScoreResult[]; // sorted desc, open items only
  scoreByItemId: Map<string, PriorityScoreResult>;
  risks: Risk[]; // manual + auto-detected, deduped by fingerprint, sorted by level
  changes: ChangeEvent[];
  kpis: Kpis;
}

/** V2.18 §7 — dedup key is riskFingerprint (rule + project + a stable natural key), not
 *  title. A title-only key silently collapsed two real, distinct risks whenever their titles
 *  happened to match (confirmed: R6/R7/R10 generate titles with no project/client token at
 *  all, e.g. two different projects both blocked on "Platform Team" for the same number of
 *  days produced byte-identical titles). */
export function dedupeRisks(manual: Risk[], auto: Risk[]): Risk[] {
  const openManual = manual.filter((r) => r.status === "open");
  const seen = new Set(openManual.map(riskFingerprint));
  const merged = [...openManual];
  for (const r of auto) {
    const fp = riskFingerprint(r);
    if (seen.has(fp)) continue;
    seen.add(fp);
    merged.push(r);
  }
  return merged.sort((a, b) => RISK_LEVEL_ORDER[a.level] - RISK_LEVEL_ORDER[b.level] || b.confidence - a.confidence);
}

/** V2.21 §3.2 — `workRelevanceIndex`/`dailyCommandCompletedWorkItemIds` are additive/optional
 *  trailing parameters: omitting them reproduces the pre-V2.21 raw-Jira-Done-only behavior
 *  exactly. Passing them (see use-command-center.ts) threads the canonical
 *  isWorkItemOperationallyOpen gate into the scores/risks/kpis every screen built on
 *  `derived` reads, so a Work-Relevance-COMPLETED/EXCLUDED or Daily-Command-completed item
 *  stops inflating Priorities/Risks/Home's own "needs attention"/"overdue" counts. */
export function deriveData(
  data: CommandCenterData,
  previous: DailySnapshot | null,
  today: string,
  workRelevanceIndex?: WorkRelevanceIndex,
  dailyCommandCompletedWorkItemIds?: ReadonlySet<string>
): DerivedData {
  const scores = scoreAllWorkItems(data, today, workRelevanceIndex, dailyCommandCompletedWorkItemIds);
  const scoreByItemId = new Map(scores.map((s) => [s.itemId, s]));

  const risks = dedupeRisks(data.risks, detectRisks(data, today, workRelevanceIndex, dailyCommandCompletedWorkItemIds));
  const changes = detectChanges(previous, data, today);

  const openItems = data.workItems.filter((w) => isWorkItemOperationallyOpen(w, workRelevanceIndex, dailyCommandCompletedWorkItemIds));
  const kpis: Kpis = {
    needAttention: scores.filter((s) => s.classification === "CRITICAL").length,
    watching: scores.filter((s) => s.classification === "HIGH").length,
    onTrack: scores.filter((s) => s.classification === "MEDIUM" || s.classification === "LOW").length,
    overdue: openItems.filter((w) => isOverdue(w, today, workRelevanceIndex, dailyCommandCompletedWorkItemIds)).length,
  };

  return { scores, scoreByItemId, risks, changes, kpis };
}

export function itemForScore(data: CommandCenterData, score: PriorityScoreResult): WorkItem | undefined {
  return data.workItems.find((w) => w.id === score.itemId);
}

export function clientName(data: CommandCenterData, clientId: string): string {
  return data.clients.find((c) => c.id === clientId)?.name ?? clientId;
}

export function projectName(data: CommandCenterData, projectId: string): string {
  return data.projects.find((p) => p.id === projectId)?.name ?? projectId;
}
