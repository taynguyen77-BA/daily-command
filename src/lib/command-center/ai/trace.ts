// V1.7 §27-28 — AI Response Trace. An in-memory, bounded, non-persisted log of recent AI
// calls — never a telemetry platform (§27), never written to localStorage, never includes
// the raw prompt or any credential. Purely for the local "AI Trust" diagnostic (§28).

import type { AiCallTrace } from "../types";

const MAX_TRACE_ENTRIES = 50;
let trace: AiCallTrace[] = [];
let counter = 0;

export function recordAiCall(entry: Omit<AiCallTrace, "id" | "timestamp">): void {
  counter += 1;
  trace = [{ id: `ai-trace-${counter}`, timestamp: new Date().toISOString(), ...entry }, ...trace].slice(0, MAX_TRACE_ENTRIES);
}

export function getRecentAiTrace(): AiCallTrace[] {
  return trace;
}

/** Test-only reset so the trace doesn't leak between test cases. */
export function clearAiTrace(): void {
  trace = [];
}

// V2.1 §13-14 — a pure aggregation over the existing bounded trace, not a new monitoring
// system. "Today" is judged from each entry's own ISO timestamp against the caller-supplied
// `today` (an ISO date, e.g. from getTodayIso()) so this stays deterministic and testable
// rather than depending on wall-clock Date.now() inside the module.
export interface AiTraceSummary {
  callsToday: number;
  byProviderState: Partial<Record<import("../types").AiProviderState, number>>;
  failedValidationCount: number;
}

export function getAiTraceSummary(today: string): AiTraceSummary {
  const byProviderState: AiTraceSummary["byProviderState"] = {};
  let callsToday = 0;
  let failedValidationCount = 0;
  for (const entry of trace) {
    const isToday = entry.timestamp.slice(0, 10) === today;
    if (!isToday) continue;
    callsToday++;
    if (entry.providerState) {
      byProviderState[entry.providerState] = (byProviderState[entry.providerState] ?? 0) + 1;
    }
    if (entry.providerState === "VALIDATION_FAILED") failedValidationCount++;
  }
  return { callsToday, byProviderState, failedValidationCount };
}
