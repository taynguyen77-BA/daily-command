// Why Should I Care? (V2.0 §4) — the shared shape behind the upgraded evidence/Why
// drawer. FACT/SIGNAL/IMPACT/UNKNOWN/NEXT MOVE are all assembled here purely from data
// the caller already has (evidence, why/reason strings, impact-projection.ts output,
// known gaps) — nothing here calls an AI provider or invents a fact. This is deliberately
// a thin typed assembly, not a new reasoning engine: each call site composes its own
// content from its own domain fields (Risk, Decision, PersonalFocusCandidate, ...) and
// hands it to WhyShouldICareDrawer.tsx, which renders it plus an optional, explicitly
// gated "Ask Claude" recommendation on top.

import type { ImpactProjection } from "./impact-projection";
import type { Evidence } from "./types";

export interface WhyShouldICareContent {
  fact: string[];
  signal: string;
  impact: ImpactProjection;
  unknown: string[];
  nextMove: string;
  evidence: Evidence[];
}

export function buildWhyShouldICare(content: WhyShouldICareContent): WhyShouldICareContent {
  return content;
}
