"use client";

import Link from "next/link";
import { useCommandCenter } from "./use-command-center";
import { computeFreshness, FRESHNESS_LABEL } from "@/lib/command-center/freshness";
import { JIRA_ERROR_HELP } from "@/lib/command-center/jira/error-help";

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

const SOURCE_LABEL: Record<string, string> = { demo: "Demo", "local-import": "Local Import", jira: "Jira" };

/** V1.3 §15 — always visible, unobtrusive. Never lets stale data look live (§14). */
function DataSourceBadge() {
  const { state } = useCommandCenter();
  if (!state.loaded) return null;

  const label = SOURCE_LABEL[state.dataSource] ?? state.dataSource;
  if (state.dataSource !== "jira") {
    return <span className="rounded border border-border px-2 py-0.5 text-[11px] text-text3">Data source: {label}</span>;
  }

  const freshness = computeFreshness(state.jiraSync.lastSyncCompletedAt);
  const time = state.jiraSync.lastSyncCompletedAt
    ? new Date(state.jiraSync.lastSyncCompletedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : "never";
  const statusLabel = state.jiraSync.lastSyncStatus === "success" ? "Connected" : state.jiraSync.lastSyncStatus === "failed" ? "Sync failed" : "Not synced";
  return (
    <span className="flex items-center gap-2 rounded border border-border px-2 py-0.5 text-[11px] text-text3">
      <span>Data source: {label}</span>
      <span>·</span>
      <span>Last synced: {time}</span>
      <span>·</span>
      <span>Status: {statusLabel}</span>
      <span>{FRESHNESS_LABEL[freshness]}</span>
    </span>
  );
}

/** Exported so the offline test suite can verify this arithmetic directly (Header itself
 *  can't be rendered there — its state comes from useSyncExternalStore's server snapshot, a
 *  Node/no-DOM environment always takes the SSR branch — see scripts/command-center-test.mts's
 *  V2.16 section). */
export function daysStale(lastSyncCompletedAtIso: string | undefined, nowMs: number = Date.now()): number | undefined {
  if (!lastSyncCompletedAtIso) return undefined;
  const ms = nowMs - new Date(lastSyncCompletedAtIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return Math.floor(ms / 86_400_000);
}

/** V2.16 — a Jira sync failure previously only showed as a small, easy-to-miss word in the
 *  unobtrusive header badge above, and the main dashboard's "Before You Trust This Data" panel
 *  actually DISAPPEARED on a failed sync (gated on lastSyncStatus === "success") instead of
 *  escalating — the exact opposite of what should happen when data quality is in doubt. A real
 *  incident traced through this: CRON_SECRET was configured on the deployment with no
 *  APP_STATE_SECRET to pair a browser against, so every in-app "Sync Now" (and any
 *  auto-sync-on-load) had been failing for a full week straight while the header quietly said
 *  "Sync failed" — nothing surfaced that this was a *standing*, self-reinforcing failure rather
 *  than a one-off blip, so two real tickets (among everything else updated that week) never
 *  appeared on My Day, Priorities, or the Attention Queue, no error, no warning.
 *
 *  This banner renders on every page (it lives in the root layout via Header, not one page) for
 *  as long as `lastSyncStatus === "failed"` — it cannot silently stop appearing just because a
 *  future failure has a different cause than this one; ANY sync failure kind produces it,
 *  reusing the same JIRA_ERROR_HELP explanations Data & Settings already shows. */
function SyncFailedBanner() {
  const { state } = useCommandCenter();
  if (!state.loaded || state.dataSource !== "jira" || state.jiraSync.lastSyncStatus !== "failed") return null;

  const stale = daysStale(state.jiraSync.lastSyncCompletedAt);
  const staleLabel =
    stale === undefined ? "Jira has never synced successfully on this device." : stale === 0 ? "Your last successful sync was earlier today." : `Your data has not refreshed from Jira in ${stale} day${stale === 1 ? "" : "s"}.`;

  return (
    <div className="mx-6 mb-4 rounded-md border border-red/40 bg-red/10 px-4 py-3 text-sm text-text" role="alert">
      <p className="font-semibold text-red">⚠ Jira sync is failing — what you see may be missing recent tickets.</p>
      <p className="mt-1 text-text2">
        {staleLabel} {state.jiraSync.lastSyncError ?? "The last sync attempt failed."}{" "}
        {state.jiraSync.lastSyncErrorKind && JIRA_ERROR_HELP[state.jiraSync.lastSyncErrorKind]}
      </p>
      <p className="mt-1">
        <Link href="/data-settings" className="text-accent2 underline">
          Fix this in Data &amp; Settings
        </Link>
      </p>
    </div>
  );
}

export function Header() {
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  return (
    <>
      <header className="flex flex-wrap items-baseline justify-between gap-2 px-6 pb-4 pt-6">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight text-text">BA/PO/PM COMMAND CENTER</h1>
          <p className="text-sm text-text3">{today}</p>
        </div>
        <div className="flex items-center gap-3">
          <DataSourceBadge />
          <p className="text-sm text-text2">{greeting()}. Here&apos;s what matters today.</p>
        </div>
      </header>
      <SyncFailedBanner />
    </>
  );
}
