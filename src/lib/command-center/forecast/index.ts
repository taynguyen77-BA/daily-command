// P3.4 — the whole forecast layer in one pure, memoised call. Derived data only: nothing here is persisted.

/** Every fix version the item belongs to (same rule as release-health.ts; local so this module has no import cycle with the risk engine). */
function releaseVersionsOf(w: { fixVersion?: string; fixVersions?: string[] }): string[] {
  if (w.fixVersions && w.fixVersions.length > 0) return w.fixVersions;
  return w.fixVersion ? [w.fixVersion] : [];
}

import { agingFor, type AgingResult } from "./aging";
import { buildLeadTimeIndex, leadTimeSamples, type LeadTimeIndex } from "./lead-time";
import { forecastRelease, type ReleaseForecast } from "./release-forecast";
import { slipRiskFor, type SlipRisk } from "./slip-risk";
import { daysBetween } from "../score-core";
import type { CommandCenterData } from "../types";

export interface TicketForecast {
  aging?: AgingResult;
  slip?: SlipRisk;
}

export interface ForecastBundle {
  leadTime: LeadTimeIndex;
  byTicket: ReadonlyMap<string, TicketForecast>;
  releases: ReleaseForecast[];
  /** Resolved tickets the lead-time history is built from (last 90 days). */
  resolvedSamples: number;
}

const cache = new WeakMap<CommandCenterData, { today: string; value: ForecastBundle }[]>();

export function computeForecast(data: CommandCenterData, today: string): ForecastBundle {
  const hits = cache.get(data) ?? [];
  const hit = hits.find((h) => h.today === today);
  if (hit) return hit.value;
  const leadTime = buildLeadTimeIndex(leadTimeSamples(data.workItems, today));
  const byTicket = new Map<string, TicketForecast>();
  for (const w of data.workItems) {
    if (w.status === "Done") continue;
    const est = leadTime.estimateFor(w.projectId, String(w.type));
    const aging = agingFor(w, today, est);
    const slip = slipRiskFor(w, today, est);
    if (aging || slip) byTicket.set(w.key, { ...(aging ? { aging } : {}), ...(slip ? { slip } : {}) });
  }
  // Context for the right-censoring limitation: open peers that are already older than each ticket.
  const openAges = new Map<string, number[]>();
  for (const w of data.workItems) {
    if (w.status === "Done" || !w.createdDate) continue;
    const k = `${w.projectId}|${String(w.type)}`;
    const age = daysBetween(w.createdDate.slice(0, 10), today);
    if (Number.isFinite(age)) openAges.set(k, [...(openAges.get(k) ?? []), age]);
  }
  for (const w of data.workItems) {
    const f = byTicket.get(w.key);
    if (!f?.slip) continue;
    f.slip.openPeersOlder = (openAges.get(`${w.projectId}|${String(w.type)}`) ?? []).filter((a) => a > f.slip!.ageDays).length;
  }
  const versions = Array.from(new Set(data.workItems.flatMap(releaseVersionsOf))).sort();
  const releases = versions.map((v) => forecastRelease(data, v, data.workItems.filter((w) => releaseVersionsOf(w).includes(v)), today));
  const value: ForecastBundle = { leadTime, byTicket, releases, resolvedSamples: leadTime.total };
  cache.set(data, [...hits.slice(-3), { today, value }]);
  return value;
}

/** The one-line facts the quiet chip, the Weekly Review line and the risk rule all read. */
export function forecastFlags(f: TicketForecast | undefined): { agingFlag: boolean; slipHigh: boolean } {
  return { agingFlag: !!f?.aging?.olderThanP85, slipHigh: f?.slip?.level === "HIGH" };
}
