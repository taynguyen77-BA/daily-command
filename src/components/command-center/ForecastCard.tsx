"use client";

// P3.4 — FORECAST: release completion ranges (Executive view, Release Health), the quiet per-ticket chip and the
// Weekly Review line. Every number is shown with its sample size; with too little history the text says
// "insufficient history" — never zero, never a default. Statistical, from your own synced tickets only.

import { forecastFlags, type ForecastBundle } from "@/lib/command-center/forecast";
import type { ReleaseForecast } from "@/lib/command-center/forecast/release-forecast";
import { Panel, SectionHeading, TrustLabel } from "./ui";
import { useCommandCenter } from "./use-command-center";

export const FORECAST_CAVEAT = "Only tickets Daily Command has synced exist here (open tickets plus recently closed ones — the first sync is limited to the last 90 days), so these forecasts are based on that history.";

/** The one rendering of a release forecast, used by both the card and the per-release line. */
export function describeReleaseForecast(f: ReleaseForecast): string {
  if (f.status === "DONE") return `${f.fixVersion}: nothing left to finish.`;
  if (f.status === "UNKNOWN") return `${f.fixVersion}: ${f.remaining} remaining — insufficient history to forecast (n = ${f.n} resolved in the last 8 weeks).`;
  const target = f.targetDate ? ` ${Math.round((f.probabilityByTarget ?? 0) * 100)}% chance of landing by ${f.targetDate} (${f.targetSource === "release-date" ? "release date" : "latest due date"}).` : "";
  return `${f.fixVersion}: ${f.remaining} remaining — likely done between ${f.p50Date} (P50) and ${f.p85Date} (P85).${target} n = ${f.n} resolved in the last 8 weeks (${f.weeklyThroughput}/week).`;
}

export function ReleaseForecastLine({ fixVersion }: { fixVersion: string }) {
  const { forecast } = useCommandCenter();
  const f = forecast.releases.find((r) => r.fixVersion === fixVersion);
  if (!f) return null;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text2" data-release-forecast={fixVersion}>
      <TrustLabel kind="forecast" />
      <span>{describeReleaseForecast(f)}</span>
    </p>
  );
}

export function ForecastCard({ limit = 5 }: { limit?: number }) {
  const { forecast } = useCommandCenter();
  const open = forecast.releases.filter((r) => r.status !== "DONE");
  if (open.length === 0) return null;
  return (
    <section data-forecast-card>
      <SectionHeading title="Delivery forecast" subtitle="When each release's remaining work is likely to finish, from how fast this project actually resolved tickets recently." action={<TrustLabel kind="forecast" />} />
      <Panel className="space-y-2 p-4">
        {open.slice(0, limit).map((r) => (
          <p key={r.fixVersion} className="text-sm text-text2">{describeReleaseForecast(r)}</p>
        ))}
        <p className="text-xs text-text3">Lead-time history: n = {forecast.resolvedSamples} tickets resolved in the last 90 days. {FORECAST_CAVEAT}</p>
      </Panel>
    </section>
  );
}

/** A quiet chip on a ticket row — only when it is older than 85% of similar tickets, or its slip risk is HIGH. */
export function ForecastChip({ ticketKey }: { ticketKey: string }) {
  const { forecast } = useCommandCenter();
  const f = forecast.byTicket.get(ticketKey);
  const { agingFlag, slipHigh } = forecastFlags(f);
  if (!agingFlag && !slipHigh) return null;
  const parts = [agingFlag ? `older than ${f!.aging!.olderThanPct}% of similar` : null, slipHigh ? "likely to slip" : null].filter(Boolean).join(" · ");
  const title = [f?.aging?.olderThanP85 ? f.aging.explanation : null, f?.slip?.level === "HIGH" ? f.slip.explanation : null].filter(Boolean).join("\n");
  return (
    <span data-forecast-chip title={title} className="mt-1 inline-flex w-fit items-center rounded-full border border-border px-2 py-0.5 text-[11px] text-text3">
      Forecast: {parts} · n={f!.aging?.n ?? f!.slip?.n}
    </span>
  );
}

export function weeklyForecastLine(forecast: Pick<ForecastBundle, "byTicket" | "resolvedSamples" | "leadTime">): string {
  if (forecast.resolvedSamples < 8) return `Forecast: insufficient history (n = ${forecast.resolvedSamples} resolved tickets in the last 90 days; at least 8 are needed).`;
  let aging = 0;
  let slip = 0;
  for (const f of forecast.byTicket.values()) {
    const { agingFlag, slipHigh } = forecastFlags(f);
    if (agingFlag) aging++;
    if (slipHigh) slip++;
  }
  return `Forecast (n = ${forecast.resolvedSamples} resolved in 90 days): ${aging} open ticket(s) are older than 85% of similar ones; ${slip} with a due date are likely to slip.`;
}

export function WeeklyForecastLine() {
  const { forecast } = useCommandCenter();
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm text-text2" data-weekly-forecast>
      <TrustLabel kind="forecast" />
      {weeklyForecastLine(forecast)}
    </p>
  );
}
