// V2.53 fix 3 — focus / visibilitychange fire constantly (tab switches, alt-tab). A pull is only useful when another
// device pushed, so one per minute is plenty. Pure: the caller holds the last-pull timestamp.
export const PULL_MIN_INTERVAL_MS = 60_000;

export function shouldPullNow(lastPullAtMs: number | null, nowMs: number): boolean {
  if (lastPullAtMs === null) return true;
  if (nowMs < lastPullAtMs) return true; // clock moved backwards: never block
  return nowMs - lastPullAtMs >= PULL_MIN_INTERVAL_MS;
}
