"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { commandCenterStore, getTodayIso, previousSnapshotOf, type StoreState } from "@/lib/command-center/store";
import { deriveData } from "@/lib/command-center/selectors";
import { applyFilters } from "@/lib/command-center/filters";
import { applyProjectScope } from "@/lib/command-center/jira/project-scope";
import { computeProactiveIntelligence } from "@/lib/command-center/proactive";
import { computePersonalFocus } from "@/lib/command-center/personal-focus";

export function useCommandCenter() {
  const state = useSyncExternalStore(
    commandCenterStore.subscribe,
    commandCenterStore.getSnapshot,
    commandCenterStore.getServerSnapshot
  );
  const today = getTodayIso();
  const previousSnapshot = previousSnapshotOf(state);

  // V2.3 §11 — Focus Project Scope is enforced at this same data boundary, BEFORE the
  // existing Client/Project/Release/Time-range filter runs — a distinct concept (which Jira
  // projects enter the Command Center at all) from that filter (which already-ingested
  // projects are currently displayed). Every screen built on `derived`/`filteredData` below
  // inherits scope automatically, with no per-engine `if focusedProject` checks (§11).
  const scopedData = useMemo(
    () => applyProjectScope(state.data, state.jiraProjectScope),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.data, state.jiraProjectScope]
  );

  // V1.3 §9 — the global filter is applied once here; every screen built on `derived`
  // (and `filteredData`, for anything that needs the raw filtered records) automatically
  // inherits it without configuring its own filter UI.
  const filteredData = useMemo(
    () => applyFilters(scopedData, state.filters, today),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopedData, state.filters, today]
  );

  const derived = useMemo(
    () => deriveData(filteredData, previousSnapshot, today),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredData, previousSnapshot, today]
  );

  // V1.4 — one composed bundle for every proactive engine, mirroring `derived` above.
  const sourceType = state.isDemo ? "demo" : state.dataSource === "jira" ? "jira" : "manual";
  const proactive = useMemo(
    () => (state.loaded ? computeProactiveIntelligence(filteredData, derived, state.snapshotHistory, previousSnapshot, state.attentionState, sourceType, today) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredData, derived, state.snapshotHistory, previousSnapshot, state.attentionState, sourceType, today, state.loaded]
  );

  // Persist attention-lifecycle transitions (NEW->ACTIVE, auto-RESOLVED, REOPENED,
  // RE_ESCALATED, etc) computed above — a no-op when nothing changed (commitAttentionState
  // diffs internally). `attentionQueue` is passed too so a RE_ESCALATED transition can log
  // a readable memory event.
  useEffect(() => {
    if (proactive) commandCenterStore.commitAttentionState(proactive.nextAttentionState, proactive.attentionQueue);
  }, [proactive]);

  // V1.6 — deterministic Personal Focus Engine, composed the same way `proactive` is
  // composed above. No AI calls; recomputed fresh every render from live project state.
  const personalFocus = useMemo(
    () => (proactive ? computePersonalFocus(filteredData, proactive, state.ownerName, today) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredData, proactive, state.ownerName, today]
  );

  return { state, today, derived, proactive, personalFocus, previousSnapshot, filteredData, store: commandCenterStore };
}

/** V2.4 §19-20, §23 — Command Bar / Meeting Mode explicit project override. Runs the exact
 *  same pipeline useCommandCenter() runs above (applyProjectScope -> applyFilters ->
 *  deriveData -> computeProactiveIntelligence -> computePersonalFocus) for ONE explicit
 *  project key instead of the persisted `state.jiraProjectScope` — so a query/meeting
 *  session can be temporarily scoped to a project outside (or narrower than) the current
 *  global focus without ever calling store.setJiraProjectScope (§20 "the global application
 *  selection does NOT change"). No new intelligence — every function called here is the
 *  same one the hook above already uses. */
export function buildProjectOverrideView(state: StoreState, today: string, projectKey: string) {
  const scopedData = applyProjectScope(state.data, { mode: "FOCUSED", projectKeys: [projectKey] });
  const filteredData = applyFilters(scopedData, state.filters, today);
  const previousSnapshot = previousSnapshotOf(state);
  const derived = deriveData(filteredData, previousSnapshot, today);
  const sourceType = state.isDemo ? "demo" : state.dataSource === "jira" ? "jira" : "manual";
  const proactive = state.loaded ? computeProactiveIntelligence(filteredData, derived, state.snapshotHistory, previousSnapshot, state.attentionState, sourceType, today) : null;
  const personalFocus = proactive ? computePersonalFocus(filteredData, proactive, state.ownerName, today) : null;
  return { filteredData, derived, proactive, personalFocus };
}
