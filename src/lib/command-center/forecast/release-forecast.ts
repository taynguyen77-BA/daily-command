// P3.4 — when will this release's remaining work be done, and will it land by the target date? A
// deterministic resample of the project's weekly throughput over the last 8 weeks (seeded PRNG,
// seed = hash(projects + version + today), so the same inputs always give the same dates).

import { addDays } from "../date-utils";
import { daysBetween } from "../score-core";
import type { CommandCenterData, WorkItem } from "../types";

export const THROUGHPUT_WEEKS = 8;
export const THROUGHPUT_MIN_RESOLVED = 8;
const TRIALS = 1000;
const MAX_WEEKS = 104;

export type ReleaseForecast =
  | { status: "DONE"; fixVersion: string }
  | {
      status: "OK";
      fixVersion: string;
      remaining: number;
      /** Resolved tickets in the sampled weeks. */
      n: number;
      weeklyThroughput: number;
      p50Date: string;
      p85Date: string;
      targetDate?: string;
      targetSource?: "release-date" | "latest-due-date";
      /** 0-1: share of simulated outcomes that finish on or before the target. */
      probabilityByTarget?: number;
    }
  | { status: "UNKNOWN"; fixVersion: string; remaining: number; n: number; reason: "insufficient history" };

/** FNV-1a 32-bit. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, deterministic. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Resolved-per-week counts for the given projects over the 8 weeks before `today` (oldest first). */
export function weeklyThroughput(workItems: readonly Pick<WorkItem, "status" | "resolvedAt" | "projectId">[], projectIds: ReadonlySet<string>, today: string): number[] {
  const weeks = new Array<number>(THROUGHPUT_WEEKS).fill(0);
  for (const w of workItems) {
    if (w.status !== "Done" || !w.resolvedAt || !projectIds.has(w.projectId)) continue;
    const age = daysBetween(w.resolvedAt.slice(0, 10), today);
    if (!Number.isFinite(age) || age < 0 || age >= THROUGHPUT_WEEKS * 7) continue;
    weeks[THROUGHPUT_WEEKS - 1 - Math.floor(age / 7)]++;
  }
  return weeks;
}

export function forecastRelease(
  data: Pick<CommandCenterData, "workItems" | "projects">,
  fixVersion: string,
  releaseItems: readonly WorkItem[],
  today: string
): ReleaseForecast {
  const open = releaseItems.filter((w) => w.status !== "Done");
  if (open.length === 0) return { status: "DONE", fixVersion };
  const projectIds = new Set(releaseItems.map((w) => w.projectId));
  const weeks = weeklyThroughput(data.workItems, projectIds, today);
  const n = weeks.reduce((s, x) => s + x, 0);
  if (n < THROUGHPUT_MIN_RESOLVED || weeks.every((x) => x === 0)) return { status: "UNKNOWN", fixVersion, remaining: open.length, n, reason: "insufficient history" };

  const rnd = seededRandom(hashSeed(`${Array.from(projectIds).sort().join(",")}|${fixVersion}|${today}`));
  const days: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    let done = 0;
    let w = 0;
    let finishDays = MAX_WEEKS * 7;
    while (w < MAX_WEEKS) {
      const sample = weeks[Math.floor(rnd() * weeks.length)];
      if (sample > 0 && done + sample >= open.length) {
        finishDays = Math.ceil((w + (open.length - done) / sample) * 7);
        break;
      }
      done += sample;
      w++;
    }
    days.push(finishDays);
  }
  days.sort((a, b) => a - b);
  const at = (q: number) => days[Math.min(days.length - 1, Math.max(0, Math.ceil(q * days.length) - 1))];

  // Target: the user-entered release date of a project in this release, else the latest due date among its items.
  const entered = data.projects.filter((p) => projectIds.has(p.id) && p.releaseDate).map((p) => p.releaseDate!.slice(0, 10)).sort().pop();
  const latestDue = releaseItems.filter((w) => w.dueDate).map((w) => w.dueDate!.slice(0, 10)).sort().pop();
  const targetDate = entered ?? latestDue;
  const result: Extract<ReleaseForecast, { status: "OK" }> = {
    status: "OK",
    fixVersion,
    remaining: open.length,
    n,
    weeklyThroughput: Math.round((n / THROUGHPUT_WEEKS) * 10) / 10,
    p50Date: addDays(today, at(0.5)),
    p85Date: addDays(today, at(0.85)),
  };
  if (targetDate) {
    const budget = daysBetween(today, targetDate);
    result.targetDate = targetDate;
    result.targetSource = entered ? "release-date" : "latest-due-date";
    result.probabilityByTarget = Math.round((days.filter((d) => d <= budget).length / days.length) * 100) / 100;
  }
  return result;
}
