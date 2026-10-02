// G3 — reading the snapshot schedule. Pure (tested offline).

/** The UTC hours the sync route is scheduled at, from vercel.json's crons ("M H * * *"). */
export function cronHoursUtc(config: { crons?: { path?: string; schedule?: string }[] }): number[] {
  const hours: number[] = [];
  for (const c of config.crons ?? []) {
    if (c.path !== "/api/command-center/jira/sync") continue;
    const m = /^\s*\d{1,2}\s+(\d{1,2})\s+\*\s+\*\s+\*\s*$/.exec(c.schedule ?? "");
    if (m && Number(m[1]) <= 23) hours.push(Number(m[1]));
  }
  return hours.sort((a, b) => a - b);
}

/** The local hour (0–23) a UTC hour falls on, given Jira's offset in minutes. */
export function localHourOf(hourUtc: number, offsetMinutes: number): number {
  const minutes = (((hourUtc * 60 + offsetMinutes) % 1440) + 1440) % 1440;
  return Math.floor(minutes / 60);
}

/** The latest local hour any scheduled run happens at — the one that writes the snapshot. */
export function latestSnapshotRunLocal(hoursUtc: number[], offsetMinutes: number): number | undefined {
  if (hoursUtc.length === 0) return undefined;
  return Math.max(...hoursUtc.map((h) => localHourOf(h, offsetMinutes)));
}
