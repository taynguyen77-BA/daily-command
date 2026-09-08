"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { commandCenterStore, getTodayIso, previousSnapshotOf, type StoreState } from "@/lib/command-center/store";
import { deriveData } from "@/lib/command-center/selectors";
import { applyFilters } from "@/lib/command-center/filters";
import { applyProjectScope } from "@/lib/command-center/jira/project-scope";
import { buildWorkRelevanceIndex } from "@/lib/command-center/jira/work-relevance";
import { computeProactiveIntelligence } from "@/lib/command-center/proactive";
import { computePersonalFocus } from "@/lib/command-center/personal-focus";
import { buildSlackNotifyPayloads, computeNewPersonalSignals } from "@/lib/command-center/notify";
import { getServerSideNotifyActiveCached } from "@/lib/command-center/notify-client";
import type { AttentionItem, AttentionItemState, CommandCenterData } from "@/lib/command-center/types";

const NOTIFY_ENDPOINT = "/api/command-center/notify";

/** V2.10 §3 — fire-and-forget: a Slack delivery failure (or SLACK_WEBHOOK_URL simply not
 *  being configured, the common case) must never surface as an app error or block the UI. */
function sendSlackNotifications(data: CommandCenterData, previousAttentionState: Record<string, AttentionItemState>, attentionQueue: AttentionItem[]) {
  const signals = computeNewPersonalSignals(previousAttentionState, attentionQueue);
  if (signals.length === 0) return;
  const payloads = buildSlackNotifyPayloads(signals, data);
  fetch(NOTIFY_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signals: payloads }) }).catch(() => {
    // best-effort — never surfaces as an app error
  });
}

export function useCommandCenter() {
  const state = useSyncExternalStore(
    commandCenterStore.subscribe,
    commandCenterStore.getSnapshot,
    commandCenterStore.getServerSnapshot
  );
  const today = getTodayIso();
  const previousSnapshot = previousSnapshotOf(state);

  // V2.13 §3 — fetched once per session (a ref, not state, so learning the real value after
  // the initial render never re-triggers the notify effect below by itself — only a genuine
  // `[proactive]` recompute does). Defaults to false (send client-side, today's behavior)
  // until the real status resolves, so the very first render of a session never silently
  // skips a signal it should have sent.
  const serverSideNotifyActiveRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    getServerSideNotifyActiveCached().then((active) => {
      if (!cancelled) serverSideNotifyActiveRef.current = active;
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  // V2.5 — Work Relevance Policy index, built once per render from the persisted per-project
  // status maps. Threaded into computeProactiveIntelligence (which uses it for First 30
  // Minutes' action-plan fallback) and exposed directly for surfaces that classify a raw
  // WorkItem themselves (Command Bar, action-plan page, Data & Settings).
  const workRelevanceIndex = useMemo(
    () => buildWorkRelevanceIndex(state.jiraWorkRelevancePolicy),
    [state.jiraWorkRelevancePolicy]
  );

  // V1.4 — one composed bundle for every proactive engine, mirroring `derived` above.
  const sourceType = state.isDemo ? "demo" : state.dataSource === "jira" ? "jira" : "manual";
  const proactive = useMemo(
    () =>
      state.loaded
        ? computeProactiveIntelligence(
            filteredData,
            derived,
            state.snapshotHistory,
            previousSnapshot,
            state.attentionState,
            sourceType,
            today,
            workRelevanceIndex,
            state.mentionEvents,
            state.personalIdentity?.accountId,
            state.ownerName
          )
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredData, derived, state.snapshotHistory, previousSnapshot, state.attentionState, sourceType, today, state.loaded, workRelevanceIndex, state.mentionEvents, state.personalIdentity?.accountId, state.ownerName]
  );

  // Persist attention-lifecycle transitions (NEW->ACTIVE, auto-RESOLVED, REOPENED,
  // RE_ESCALATED, etc) computed above — a no-op when nothing changed (commitAttentionState
  // diffs internally). `attentionQueue` is passed too so a RE_ESCALATED transition can log
  // a readable memory event.
  //
  // V2.10 §3 — real-time delivery is wired HERE, not at the end of the (stateless)
  // jira/sync/route.ts the dev prompt named: attentionState/attentionQueue only ever exist
  // client-side in this architecture (the sync route returns raw normalized data and
  // explicitly never persists anything — see its own top comment), so this is the one place
  // "previous attentionState" (still `state.attentionState`, not yet committed) and "the
  // freshly computed attentionQueue" are both available together, exactly matching
  // computeNewPersonalSignals' signature. `state.attentionState` is read from the render
  // closure that produced `proactive`, i.e. genuinely pre-commit.
  //
  // V2.10.1 — firing on every `[proactive]` recompute, including a pure filter/scope change
  // with no real Jira sync behind it, is intentionally tolerated: computeNewPersonalSignals
  // is cold-start-safe per-id (not per-computation), so a filter change that merely reveals a
  // previously-out-of-scope-but-already-tracked item produces zero signals (its id is already
  // in `previousAttentionState`), and a filter change that reveals a project never tracked
  // before is covered by the same "no prior MENTION:/ASSIGNMENT: id at all" cold-start guard
  // as a fresh install (see notify.ts). If this stops holding, that's a distinct bug — surface
  // it, don't silently patch around it here.
  //
  // V2.13 §3 — once a cron-driven server-side notify check is active for this install (see
  // cron-notify.ts, wired into jira/sync/route.ts's GET handler), it becomes the sole sender
  // of real Slack messages for personal signals; this client-side path still runs
  // computeNewPersonalSignals (harmless — its result is simply discarded) so every other
  // client-side effect of this recompute (commitAttentionState, lifecycle badges, etc.) stays
  // completely unaffected, but the actual `fetch(NOTIFY_ENDPOINT, ...)` POST is skipped,
  // preventing the exact double-notification the two independent tracking systems (server KV
  // vs. browser localStorage) would otherwise cause for the same mention/assignment.
  useEffect(() => {
    if (!proactive) return;
    commandCenterStore.commitAttentionState(proactive.nextAttentionState, proactive.attentionQueue);
    if (!serverSideNotifyActiveRef.current) sendSlackNotifications(filteredData, state.attentionState, proactive.attentionQueue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proactive]);

  // V1.6 — deterministic Personal Focus Engine, composed the same way `proactive` is
  // composed above. No AI calls; recomputed fresh every render from live project state.
  const personalFocus = useMemo(
    () => (proactive ? computePersonalFocus(filteredData, proactive, state.ownerName, today, state.personalIdentity?.accountId, workRelevanceIndex, derived.risks, state.mentionEvents) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredData, proactive, state.ownerName, today, state.personalIdentity?.accountId, workRelevanceIndex, derived.risks, state.mentionEvents]
  );

  // V2.9 §F-02 fix — exposed so any UI populating a "which client/project can I pick"
  // control (FilterBar) reads the scope-enforced set, not raw `state.data`. `filteredData`
  // can't serve that purpose: it also has the CURRENT client/project filter selection
  // already applied, which would hide every other in-scope option from its own picker.
  return { state, today, derived, proactive, personalFocus, previousSnapshot, filteredData, scopedData, workRelevanceIndex, store: commandCenterStore };
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
  const workRelevanceIndex = buildWorkRelevanceIndex(state.jiraWorkRelevancePolicy);
  const proactive = state.loaded
    ? computeProactiveIntelligence(
        filteredData,
        derived,
        state.snapshotHistory,
        previousSnapshot,
        state.attentionState,
        sourceType,
        today,
        workRelevanceIndex,
        state.mentionEvents,
        state.personalIdentity?.accountId,
        state.ownerName
      )
    : null;
  const personalFocus = proactive ? computePersonalFocus(filteredData, proactive, state.ownerName, today, state.personalIdentity?.accountId, workRelevanceIndex, derived.risks, state.mentionEvents) : null;
  return { filteredData, derived, proactive, personalFocus, workRelevanceIndex };
}
