// Data source abstraction (BUILD REQUEST V1.3 §3). Every source normalizes into the same
// CommandCenterData — no source-specific fields leak past this boundary into the rest of
// the app. The store only ever talks to a DataSourceProvider, never to Jira or the import
// pipeline directly.

import type { CommandCenterData, DataSourceType, JiraErrorKind, JiraProjectScopeMode } from "../types";

export interface DataSourceSyncResult {
  ok: boolean;
  data?: CommandCenterData;
  recordsFetched?: number;
  error?: string;
  errorKind?: JiraErrorKind;
  syncedAt?: string;
  // V1.7 §8-9 — sync diagnostics, additive/optional so non-Jira sources are unaffected.
  durationMs?: number;
  scopeChangesDetected?: number;
  projectsDiscovered?: number;
  warnings?: string[];
  // V1.8 §17 — additive sync diagnostics.
  pages?: number;
  changelogRequests?: number;
  // V2.3 §9, §20 — Focus Project Scope diagnostics, additive/optional.
  scopeMode?: JiraProjectScopeMode;
  focusedProjectCount?: number;
  focusedProjects?: string[];
}

export interface DataSourceProvider {
  readonly type: DataSourceType;
  sync(options?: { sinceIso?: string; scopeMode?: JiraProjectScopeMode; projectKeys?: string[] }): Promise<DataSourceSyncResult>;
}
