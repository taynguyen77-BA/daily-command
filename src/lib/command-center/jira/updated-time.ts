// K2 — comparing Jira `updated` stamps. WorkItem.lastUpdated keeps only the DAY (every report
// reads it that way); WorkItem.updatedAt keeps Jira's full datetime, so a same-day edit after
// a fetch or a brief is still noticed. Items synced before updatedAt existed fall back to the
// day comparison.

/** Jira sends offsets as "+0700"; make them "+07:00" so every engine parses them. */
function parseInstant(s: string): number {
  return Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
}

/** < 0 when `a` is older than `b`, 0 when the same, > 0 when newer. Two full datetimes compare
 *  as instants; when either side is only a date (or unparseable), both compare by date. */
export function compareJiraUpdated(a: string, b: string): number {
  if (a.length > 10 && b.length > 10) {
    const ta = parseInstant(a);
    const tb = parseInstant(b);
    if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
  }
  return a.slice(0, 10).localeCompare(b.slice(0, 10));
}

/** The most precise "last changed in Jira" a work item carries. */
export function workItemUpdatedStamp(w: { updatedAt?: string; lastUpdated: string }): string {
  return w.updatedAt ?? w.lastUpdated;
}
