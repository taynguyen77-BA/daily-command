"use client";

// F1 — Morning Mode: the guided 5-step start of the day (see morning-mode.ts for the steps and
// the key map). Every action goes through the same store methods as TaskRow, so a ticket
// handled here shows the same status everywhere. Finishing records "Triage done in Xm" for
// the day; leaving early records nothing (the flow is offered again next time today).

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useMyWork } from "./use-my-work";
import { Panel, SectionHeading } from "./ui";
import { addDays } from "@/lib/command-center/date-utils";
import { TIME_BUDGET_LABELS, type TimeBudget } from "@/lib/command-center/action-plan";
import {
  MORNING_KEYS,
  MORNING_STEPS,
  dueRechecks,
  morningKeyCommand,
  nextMorningStep,
  planAgainstBudget,
  reorderIds,
  triageDoneLabel,
  type DueRecheck,
  type MorningStep,
} from "@/lib/command-center/morning-mode";

const BUDGETS: TimeBudget[] = [15, 30, 60, 120, 480];
const DEFAULT_BUDGET: TimeBudget = 30; // same default as the Action Plan page

type Handled = "done" | "block" | "skip" | "defer" | "keep";
const HANDLED_LABEL: Record<Handled, string> = { done: "Done", block: "Blocked", skip: "Skipped", defer: "Deferred to tomorrow", keep: "Kept for today" };

export function MorningMode({ onExit }: { onExit: () => void }) {
  const { state, store, work, today, personalFocus, filteredData } = useMyWork();
  const [step, setStep] = useState<MorningStep>("sync");
  const startedAt = useRef(new Date().toISOString());
  const [handledCount, setHandledCount] = useState(0);
  const [finished, setFinished] = useState<string | null>(state.morningTriage[today] ? triageDoneLabel(state.morningTriage[today]) : null);

  // ----- Step 1: sync with progress -----
  const syncActivity = useSyncExternalStore(store.subscribe, store.getJiraSyncActivity, store.getServerJiraSyncActivity);
  const canSync = state.dataSource === "jira" && state.jiraSync.lastSyncStatus !== "never";
  const [syncResult, setSyncResult] = useState<string | null>(canSync ? null : "Not connected to Jira — nothing to sync.");
  const [syncSeconds, setSyncSeconds] = useState(0);
  const syncStarted = useRef(false);
  useEffect(() => {
    if (step !== "sync" || !canSync || syncStarted.current) return;
    syncStarted.current = true;
    const t0 = Date.now();
    const timer = setInterval(() => setSyncSeconds(Math.floor((Date.now() - t0) / 1000)), 500);
    void store.syncJira({ trigger: "auto" }).then((r) => {
      clearInterval(timer);
      setSyncResult(r.ok ? `Synced in ${Math.max(1, Math.round((Date.now() - t0) / 1000))}s.` : r.errorKind === "sync-in-progress" ? "A sync was already running — using its result." : `Sync failed: ${r.error ?? "unknown error"} — continuing with the last synced data.`);
    });
    return () => clearInterval(timer);
  }, [step, canSync, store]);

  // ----- Step 2: triage New (keys frozen at entry, so rows don't jump while acting) -----
  const [triageKeys, setTriageKeys] = useState<string[]>([]);
  const [handled, setHandled] = useState<Record<string, Handled>>({});
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    if (step === "triage") setTriageKeys(work.views.new.map((r) => r.ticketKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
  const titleOf = (key: string) => filteredData.workItems.find((w) => w.key === key)?.title;

  function act(kind: Handled, ticketKey: string) {
    if (kind === "done") store.completeTicketInDailyCommand(ticketKey, "my-work");
    else if (kind === "block") store.blockTicketInDailyCommand(ticketKey, undefined, undefined, undefined, "my-work");
    else if (kind === "skip") store.skipTicketInDailyCommand(ticketKey, undefined, undefined, "my-work");
    else if (kind === "defer") store.deferTicket(ticketKey, addDays(today, 1), undefined, "my-work");
    store.markDailyReviewSeen([ticketKey]); // handled → no longer "New"
    if (!handled[ticketKey]) setHandledCount((n) => n + 1);
    setHandled((h) => ({ ...h, [ticketKey]: kind }));
    const nextOpen = triageKeys.findIndex((k, i) => i > triageKeys.indexOf(ticketKey) && !handled[k] && k !== ticketKey);
    if (nextOpen >= 0) setSelected(nextOpen);
  }

  useEffect(() => {
    if (step !== "triage") return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inTextField = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      const cmd = morningKeyCommand(e.key, triageKeys, selected, { ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, inTextField });
      if (cmd.kind === "none") return;
      e.preventDefault();
      if (cmd.kind === "move") setSelected(cmd.index);
      else act(cmd.kind, cmd.ticketKey);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ----- Step 3: due re-checks (frozen at entry) -----
  const [rechecks, setRechecks] = useState<DueRecheck[]>([]);
  const [recheckDone, setRecheckDone] = useState<Record<string, string>>({});
  useEffect(() => {
    if (step === "rechecks") setRechecks(dueRechecks(state.ticketWorkStates, today));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
  function recheck(r: DueRecheck, kind: "reactivate" | "unblock" | "keep") {
    if (kind === "reactivate") store.reactivateSkippedTicket(r.ticketKey, "my-work");
    if (kind === "unblock") store.unblockTicketInDailyCommand(r.ticketKey, "my-work");
    if (!recheckDone[r.ticketKey]) setHandledCount((n) => n + 1);
    setRecheckDone((d) => ({ ...d, [r.ticketKey]: kind === "keep" ? `Still ${r.status.toLowerCase()}` : kind === "unblock" ? "Unblocked" : "Back to Today" }));
  }

  // ----- Step 4: today's plan against the Action Plan budget -----
  const budget = state.timeBudgetMinutes ?? DEFAULT_BUDGET;
  const plan = useMemo(
    () => state.personalPlan.filter((p) => p.plannedDate === today && p.status !== "completed" && p.status !== "skipped").sort((a, b) => a.position - b.position),
    [state.personalPlan, today]
  );
  const planBudget = planAgainstBudget(plan.map((p) => ({ id: p.id, estimatedMinutes: p.estimatedMinutes })), budget);
  const [dragId, setDragId] = useState<string | null>(null);
  const move = (id: string, to: number) => store.reorderPersonalPlan(today, reorderIds(plan.map((p) => p.id), id, to));
  const planLabel = (p: (typeof plan)[number]) => (p.ticketKey ? `${p.ticketKey}${titleOf(p.ticketKey) ? ` — ${titleOf(p.ticketKey)}` : ""}` : personalFocus?.candidates.find((c) => c.sourceId === p.sourceId)?.title ?? `${p.sourceType}: ${p.sourceId}`);

  function finish(startFirst: boolean) {
    const first = plan[0];
    if (startFirst && first) store.startFocusItem(first.id, today);
    const record = { day: today, startedAt: startedAt.current, finishedAt: new Date().toISOString(), handled: handledCount };
    store.recordMorningTriage(record);
    setFinished(triageDoneLabel(record));
  }

  if (finished) {
    return (
      <Panel className="p-5" data-morning-mode-done>
        <p className="text-sm font-medium text-green">✓ {finished}.</p>
        <p className="mt-1 text-sm text-text2">Your day is set. {plan[0] ? `Started: ${planLabel(plan[0])}.` : ""}</p>
        <button onClick={onExit} className="btn btn-primary mt-3">
          Go to My Work
        </button>
      </Panel>
    );
  }

  const stepIndex = MORNING_STEPS.findIndex((s) => s.id === step);
  const next = nextMorningStep(step);
  const syncing = step === "sync" && canSync && (syncActivity.inProgress || !syncResult);

  return (
    <div className="space-y-4" data-morning-mode data-morning-step={step}>
      <SectionHeading
        level="page"
        title="Good morning"
        subtitle="Five quick steps, then you're working."
        action={
          <button onClick={onExit} className="btn btn-sm btn-ghost">
            Skip Morning Mode today
          </button>
        }
      />
      <ol className="flex flex-wrap gap-2 text-xs" aria-label="Morning Mode steps">
        {MORNING_STEPS.map((s, i) => (
          <li key={s.id} aria-current={s.id === step ? "step" : undefined} className={`rounded-full border px-2.5 py-1 ${i < stepIndex ? "border-green/40 text-green" : s.id === step ? "border-accent text-text" : "border-border text-text3"}`}>
            {i + 1}. {s.label}
          </li>
        ))}
      </ol>

      <Panel className="p-5">
        {step === "sync" && (
          <div data-morning-sync>
            {syncing ? (
              <>
                <p className="text-sm text-text">Syncing Jira… {syncSeconds}s</p>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-surface2">
                  <div className="h-full w-1/3 animate-pulse rounded bg-accent" />
                </div>
              </>
            ) : (
              <p className="text-sm text-text2">{syncResult ?? "Synced."}</p>
            )}
          </div>
        )}

        {step === "triage" && (
          <div data-morning-triage>
            <p className="mb-2 text-xs text-text3">
              {MORNING_KEYS.map((k, i) => (
                <span key={k.key}>
                  {i > 0 && " · "}
                  <kbd>{k.key}</kbd> {k.label}
                </span>
              ))}{" "}
              · <kbd>J</kbd>/<kbd>K</kbd> move
            </p>
            {triageKeys.length === 0 ? (
              <p className="text-sm text-text3">Nothing new since your last review.</p>
            ) : (
              <ul>
                {triageKeys.map((key, i) => (
                  <li key={key} data-morning-row={key} onClick={() => setSelected(i)} className={`flex flex-wrap items-center gap-2 border-b border-border py-2 last:border-b-0 ${i === selected ? "rounded ring-1 ring-accent" : ""}`}>
                    <span className="font-mono text-xs text-text">{key}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-text2">{titleOf(key) ?? ""}</span>
                    {handled[key] ? (
                      <span className="text-xs text-green">{HANDLED_LABEL[handled[key]]}</span>
                    ) : (
                      <span className="flex gap-1">
                        {(["done", "block", "skip", "defer", "keep"] as Handled[]).map((k) => (
                          <button key={k} onClick={() => act(k, key)} className="btn btn-sm btn-ghost">
                            {k === "keep" ? "Keep" : k[0].toUpperCase() + k.slice(1)}
                          </button>
                        ))}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {step === "rechecks" && (
          <div data-morning-rechecks>
            {rechecks.length === 0 ? (
              <p className="text-sm text-text3">No re-checks due today.</p>
            ) : (
              <ul>
                {rechecks.map((r) => (
                  <li key={r.ticketKey} className="flex flex-wrap items-center gap-2 border-b border-border py-2 last:border-b-0">
                    <span className="font-mono text-xs text-text">{r.ticketKey}</span>
                    <span className="text-xs text-text3">
                      {r.status.toLowerCase()} · due {r.until}
                      {r.reason ? ` · ${r.reason}` : ""}
                    </span>
                    <span className="ml-auto flex gap-1">
                      {recheckDone[r.ticketKey] ? (
                        <span className="text-xs text-green">{recheckDone[r.ticketKey]}</span>
                      ) : (
                        <>
                          {r.status === "BLOCKED" ? (
                            <button onClick={() => recheck(r, "unblock")} className="btn btn-sm btn-secondary">
                              Unblock
                            </button>
                          ) : (
                            <button onClick={() => recheck(r, "reactivate")} className="btn btn-sm btn-secondary">
                              Back to Today
                            </button>
                          )}
                          <button onClick={() => recheck(r, "keep")} className="btn btn-sm btn-ghost">
                            Keep {r.status.toLowerCase()}
                          </button>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {step === "plan" && (
          <div data-morning-plan>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-text2">
              Time budget
              <div className="seg">
                {BUDGETS.map((b) => (
                  <button key={b} onClick={() => store.setTimeBudget(b)} aria-pressed={budget === b} className={`seg-item ${budget === b ? "seg-item-active" : ""}`}>
                    {TIME_BUDGET_LABELS[b]}
                  </button>
                ))}
              </div>
              <span className={planBudget.overByMinutes > 0 ? "text-orange" : "text-text3"} data-morning-budget>
                {planBudget.totalMinutes} min planned of {budget}
                {planBudget.overByMinutes > 0 ? ` — over by ${planBudget.overByMinutes} min` : ""}
              </span>
            </div>
            {plan.length === 0 ? (
              <div className="text-sm text-text3">
                No plan for today yet.{" "}
                {personalFocus && personalFocus.candidates.length > 0 && (
                  <button onClick={() => store.acceptSuggestedPlan(personalFocus.candidates.slice(0, 5), today)} className="btn btn-sm btn-secondary">
                    Use the suggested plan
                  </button>
                )}
              </div>
            ) : (
              <ol>
                {plan.map((p, i) => (
                  <li
                    key={p.id}
                    draggable
                    onDragStart={() => setDragId(p.id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (dragId) move(dragId, i);
                      setDragId(null);
                    }}
                    data-morning-plan-item={p.id}
                    className={`flex cursor-grab items-center gap-2 border-b border-border py-2 last:border-b-0 ${planBudget.fitIds.includes(p.id) ? "" : "opacity-60"}`}
                  >
                    <span aria-hidden="true" className="text-text3">⠿</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-text">
                      {i + 1}. {planLabel(p)}
                    </span>
                    <span className="text-xs text-text3">{p.estimatedMinutes} min</span>
                    <button aria-label="Move up" disabled={i === 0} onClick={() => move(p.id, i - 1)} className="btn btn-sm btn-ghost">
                      ↑
                    </button>
                    <button aria-label="Move down" disabled={i === plan.length - 1} onClick={() => move(p.id, i + 1)} className="btn btn-sm btn-ghost">
                      ↓
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}

        {step === "start" && (
          <div data-morning-start>
            {plan[0] ? (
              <>
                <p className="text-sm text-text2">First up:</p>
                <p className="mt-1 text-base font-medium text-text">{planLabel(plan[0])}</p>
                <div className="mt-3 flex gap-2">
                  <button onClick={() => finish(true)} className="btn btn-primary">
                    Start first task
                  </button>
                  <button onClick={() => finish(false)} className="btn btn-secondary">
                    Finish without starting
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-text3">Nothing planned — you can still finish the triage.</p>
                <button onClick={() => finish(false)} className="btn btn-primary mt-3">
                  Finish
                </button>
              </>
            )}
          </div>
        )}
      </Panel>

      {next && (
        <div className="flex justify-end">
          <button onClick={() => setStep(next)} disabled={syncing} className="btn btn-primary" data-morning-next>
            Next: {MORNING_STEPS.find((s) => s.id === next)!.label} →
          </button>
        </div>
      )}
    </div>
  );
}
