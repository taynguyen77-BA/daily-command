// C1 — which timezone the server uses for Jira date cursors and the daily report, and where it came from.
// Resolution order (same as formatJqlSince): IANA zone -> fixed offset -> safe day-level fallback.
// Pure; the routes gather the inputs.

export type TimeZoneSource = "JIRA_TIMEZONE" | "member-profile" | "jira" | "JIRA_TIMEZONE_OFFSET_MINUTES" | "fallback";

export interface TimeZoneInUse {
  source: TimeZoneSource;
  zone?: string;
  offsetMinutes?: number;
}

export function resolveTimeZoneInUse(input: { envZone?: string; memberZone?: string; learnedZone?: string; envOffsetMinutes?: number }): TimeZoneInUse {
  if (input.envZone) return { source: "JIRA_TIMEZONE", zone: input.envZone };
  if (input.memberZone) return { source: "member-profile", zone: input.memberZone };
  if (input.learnedZone) return { source: "jira", zone: input.learnedZone };
  if (input.envOffsetMinutes !== undefined && Number.isFinite(input.envOffsetMinutes)) return { source: "JIRA_TIMEZONE_OFFSET_MINUTES", offsetMinutes: input.envOffsetMinutes };
  return { source: "fallback" };
}

const WHERE: Record<TimeZoneSource, string> = {
  JIRA_TIMEZONE: "from JIRA_TIMEZONE",
  "member-profile": "from the member's Jira profile",
  jira: "learned from Jira (/myself)",
  JIRA_TIMEZONE_OFFSET_MINUTES: "from JIRA_TIMEZONE_OFFSET_MINUTES (a fixed offset, not DST-aware)",
  fallback: "none known yet — using a safe day-level cursor; set JIRA_TIMEZONE or let the next server check learn it from Jira",
};

/** One short phrase for Setup Health, e.g. "Asia/Ho_Chi_Minh, learned from Jira (/myself)". */
export function describeTimeZoneInUse(tz: TimeZoneInUse): string {
  const label = tz.zone ?? (tz.offsetMinutes !== undefined ? `UTC${tz.offsetMinutes >= 0 ? "+" : "-"}${Math.abs(tz.offsetMinutes) / 60}` : "unknown timezone");
  return `${label}, ${WHERE[tz.source]}`;
}
