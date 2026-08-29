// Pure derived-data selectors — combine the deterministic engines into what each screen needs.
// No AI calls happen here; screens call the AI provider separately for prose narration.

import { detectChanges } from "./change-detection";
import { detectRisks, RISK_LEVEL_ORDER } from "./risk-detection";
import { isOverdue, scoreAllWorkItems } from "./scoring";
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
  risks: Risk[]; // manual + auto-detected, deduped by title, sorted by level
  changes: ChangeEvent[];
  kpis: Kpis;
}

export function dedupeRisks(manual: Risk[], auto: Risk[]): Risk[] {
  const seen = new Set(manual.filter((r) => r.status === "open").map((r) => r.title));
  const merged = [...manual.filter((r) => r.status === "open")];
  for (const r of auto) {
    if (seen.has(r.title)) continue;
    seen.add(r.title);
    merged.push(r);
  }
  return merged.sort((a, b) => RISK_LEVEL_ORDER[a.level] - RISK_LEVEL_ORDER[b.level] || b.confidence - a.confidence);
}

export function deriveData(data: CommandCenterData, previous: DailySnapshot | null, today: string): DerivedData {
  const scores = scoreAllWorkItems(data, today);
  const scoreByItemId = new Map(scores.map((s) => [s.itemId, s]));

  const risks = dedupeRisks(data.risks, detectRisks(data, today));
  const changes = detectChanges(previous, data, today);

  const openItems = data.workItems.filter((w) => w.status !== "Done");
  const kpis: Kpis = {
    needAttention: scores.filter((s) => s.classification === "CRITICAL").length,
    watching: scores.filter((s) => s.classification === "HIGH").length,
    onTrack: scores.filter((s) => s.classification === "MEDIUM" || s.classification === "LOW").length,
    overdue: openItems.filter((w) => isOverdue(w, today)).length,
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
