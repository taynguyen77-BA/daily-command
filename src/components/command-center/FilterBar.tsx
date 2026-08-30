"use client";

import { availableFixVersions } from "@/lib/command-center/filters";
import type { GlobalFilters } from "@/lib/command-center/types";
import { useCommandCenter } from "./use-command-center";

const TIME_RANGES: { value: GlobalFilters["timeRangeDays"] | undefined; label: string }[] = [
  { value: undefined, label: "All time" },
  { value: 1, label: "Today" },
  { value: 7, label: "7 days" },
  { value: 14, label: "14 days" },
  { value: 30, label: "30 days" },
];

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-text3">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-border bg-surface2 px-2 py-1 text-xs text-text2"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** V1.3 §9 — the compact global context filter, applied once by useCommandCenter() and
 *  inherited automatically by every screen built on `derived`/`filteredData`. */
export function FilterBar() {
  const { state, store } = useCommandCenter();
  const { data, filters } = state;

  const clients = data.clients;
  const projects = filters.clientId ? data.projects.filter((p) => p.clientId === filters.clientId) : data.projects;
  const versions = availableFixVersions(data);

  if (clients.length === 0) return null;

  // V2.3 §13 — Jira Project Scope ("which Jira projects enter Daily Command Center") is a
  // distinct concept from this bar ("which already-ingested projects are currently
  // displayed"). Shown here read-only, purely so the distinction is visible side-by-side —
  // this never becomes a selectable filter; changing it happens only in Data & Settings.
  const scope = state.jiraProjectScope;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface px-3 py-2">
      {state.dataSource === "jira" && (
        <span className="rounded border border-border bg-surface2 px-2 py-1 text-xs text-text3">
          Jira Scope: {scope.mode === "FOCUSED" ? `${scope.projectKeys.length} focused project${scope.projectKeys.length === 1 ? "" : "s"}` : "All projects"}
        </span>
      )}
      <Select
        label="Client"
        value={filters.clientId ?? ""}
        onChange={(v) => store.setFilters({ clientId: v || undefined, projectId: undefined })}
        options={[{ value: "", label: "All" }, ...clients.map((c) => ({ value: c.id, label: c.name }))]}
      />
      <Select
        label="Project"
        value={filters.projectId ?? ""}
        onChange={(v) => store.setFilters({ projectId: v || undefined })}
        options={[{ value: "", label: "All" }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
      />
      {versions.length > 0 && (
        <Select
          label="Release"
          value={filters.fixVersion ?? ""}
          onChange={(v) => store.setFilters({ fixVersion: v || undefined })}
          options={[{ value: "", label: "All" }, ...versions.map((v) => ({ value: v, label: v }))]}
        />
      )}
      <Select
        label="Time range"
        value={filters.timeRangeDays ? String(filters.timeRangeDays) : ""}
        onChange={(v) => store.setFilters({ timeRangeDays: v ? (Number(v) as GlobalFilters["timeRangeDays"]) : undefined })}
        options={TIME_RANGES.map((t) => ({ value: t.value ? String(t.value) : "", label: t.label }))}
      />
      {(filters.clientId || filters.projectId || filters.fixVersion || filters.timeRangeDays) && (
        <button
          onClick={() => store.setFilters({ clientId: undefined, projectId: undefined, fixVersion: undefined, timeRangeDays: undefined })}
          className="ml-auto text-xs text-accent2 hover:underline"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
