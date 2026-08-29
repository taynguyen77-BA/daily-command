// V2.2 §22-23 — "Your Usage". A pure read of the bounded local counter map maintained by
// store.ts's bumpUsage(). No analytics backend, no significance claims — just "what did
// you actually use", so V2.3 can be scoped from real local usage instead of guessing.

export const USAGE_KEYS = {
  MORNING_BRIEF_OPENED: "surface:morning-brief-opened",
  FOCUS_STARTED: "surface:focus-started",
  DECISION_CONFIRMED: "surface:decision-confirmed",
  ACTION_COMPLETED: "surface:action-completed",
  OUTCOME_CAPTURED: "surface:outcome-captured",
  ARTIFACT_COPIED: "surface:artifact-copied",
  ARTIFACT_REGENERATED: "surface:artifact-regenerated",
  MEETING_MODE_OPENED: "surface:meeting-mode-opened",
  COMMAND_BAR_USED: "surface:command-bar-used",
} as const;

const SURFACE_LABELS: Record<string, string> = {
  "surface:morning-brief-opened": "Morning Brief",
  "surface:focus-started": "Focus Session",
  "surface:decision-confirmed": "Decision confirmed",
  "surface:action-completed": "Action completed",
  "surface:outcome-captured": "Outcome captured",
  "surface:artifact-copied": "Artifact copied",
  "surface:artifact-regenerated": "Artifact regenerated",
  "surface:meeting-mode-opened": "Meeting Mode",
  "surface:command-bar-used": "Command Bar",
};

export function artifactUsageKey(type: string): string {
  return `artifact-type:${type}`;
}
export function commandUsageKey(intent: string): string {
  return `command-intent:${intent}`;
}

export interface UsageSummary {
  mostUsedSurface?: { label: string; count: number };
  mostUsedArtifactType?: { label: string; count: number };
  mostUsedCommand?: { label: string; count: number };
  unusedSurfaces: string[];
}

function titleCase(s: string): string {
  return s
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function topEntry(counters: Record<string, number>, prefix: string): { label: string; count: number } | undefined {
  const entries = Object.entries(counters).filter(([k, v]) => k.startsWith(prefix) && v > 0);
  if (entries.length === 0) return undefined;
  const [key, count] = entries.sort((a, b) => b[1] - a[1])[0];
  const rawLabel = prefix === "surface:" ? (SURFACE_LABELS[key] ?? key) : titleCase(key.slice(prefix.length).replace(/_/g, " ").replace(/-/g, " "));
  return { label: rawLabel, count };
}

export function computeUsageSummary(counters: Record<string, number>): UsageSummary {
  const mostUsedSurface = topEntry(counters, "surface:");
  const mostUsedArtifactType = topEntry(counters, "artifact-type:");
  const mostUsedCommand = topEntry(counters, "command-intent:");
  const unusedSurfaces = Object.entries(SURFACE_LABELS)
    .filter(([key]) => !counters[key])
    .map(([, label]) => label);
  return { mostUsedSurface, mostUsedArtifactType, mostUsedCommand, unusedSurfaces };
}
