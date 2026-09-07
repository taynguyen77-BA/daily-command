// New-assignment detection (V2.10 §2). Same deterministic diff-against-the-previous-
// DailySnapshot pattern change-detection.ts already uses for its "Owner" field change event
// — narrowed here to one question: did this work item's ownerId become the configured
// identity's accountId since the last snapshot? No accountId configured, or no previous
// snapshot to compare against (first-ever sync), means nothing can honestly be said either
// way — this never guesses "new" from a single snapshot, matching §28's "ownership is never
// inferred" applying just as much to a NEW assignment as to an existing one.

import type { CommandCenterData, DailySnapshot } from "./types";

export interface NewAssignmentEvent {
  workItemId: string;
  issueKey: string;
  title: string;
  projectId: string;
}

export function detectNewAssignments(data: CommandCenterData, previousSnapshot: DailySnapshot | null, ownerId: string | undefined): NewAssignmentEvent[] {
  if (!ownerId || !previousSnapshot) return [];
  const prevById = new Map(previousSnapshot.workItems.map((w) => [w.id, w]));
  const out: NewAssignmentEvent[] = [];
  for (const item of data.workItems) {
    if (item.ownerId !== ownerId) continue;
    const prev = prevById.get(item.id);
    if (prev?.ownerId === ownerId) continue; // already assigned as of the last snapshot — not new
    out.push({ workItemId: item.id, issueKey: item.key, title: item.title, projectId: item.projectId });
  }
  return out;
}
