"use client";

import { useCommandCenter } from "./use-command-center";
import { computeFreshness, FRESHNESS_LABEL } from "@/lib/command-center/freshness";

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

export function Header() {
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  return (
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
  );
}
