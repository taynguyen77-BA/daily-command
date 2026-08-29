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
