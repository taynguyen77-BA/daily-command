"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useCommandCenter } from "@/components/command-center/use-command-center";
import { EmptyState, Panel, RiskBadge, SectionHeading } from "@/components/command-center/ui";
import { KpiStrip } from "@/components/command-center/KpiStrip";
import { PriorityCard } from "@/components/command-center/PriorityCard";
import { ChangeItem } from "@/components/command-center/ChangeItem";
import { CommunicationCard } from "@/components/command-center/CommunicationCard";
import { TakeActionPanel } from "@/components/command-center/TakeActionPanel";
import { CloseDayModal } from "@/components/command-center/CloseDayModal";
import { MorningBrief } from "@/components/command-center/MorningBrief";
import { GapsPanel } from "@/components/command-center/GapsPanel";
import { ExecutiveView } from "@/components/command-center/ExecutiveView";
import { HealthTrend } from "@/components/command-center/HealthTrend";
import { GettingBetterWorse } from "@/components/command-center/GettingBetterWorse";
import { ReleaseHealthPanel } from "@/components/command-center/ReleaseHealthPanel";
import { FilterBar } from "@/components/command-center/FilterBar";
import { CommandBar } from "@/components/command-center/CommandBar";
import { ControlTower } from "@/components/command-center/ControlTower";
import { YourDeliveryFocus } from "@/components/command-center/YourDeliveryFocus";
import { MyAssignedWork } from "@/components/command-center/MyAssignedWork";
import { RecentlyMentioned } from "@/components/command-center/RecentlyMentioned";
import { WaitingFor } from "@/components/command-center/WaitingFor";
import { AttentionQueuePanel } from "@/components/command-center/AttentionQueuePanel";
import { ClientAttentionMap } from "@/components/command-center/ClientAttentionMap";
import { BeforeYouTrustThisData } from "@/components/command-center/BeforeYouTrustThisData";
import { itemForScore } from "@/lib/command-center/selectors";
import { buildSnapshotMetrics, compareSnapshots } from "@/lib/command-center/memory";
import { computeFreshness } from "@/lib/command-center/freshness";
import { computeDataHealth } from "@/lib/command-center/data-health";
import { buildBeforeYouTrustSummary } from "@/lib/command-center/trust-diagnostic";
import { USAGE_KEYS } from "@/lib/command-center/usage";
import { AttentionSeverityBadge, FocusCategoryBadge, HeatBadge, LoopHealthBadge } from "@/components/command-center/ui";
import type { PriorityScoreResult, WorkItem } from "@/lib/command-center/types";

type ViewMode = "operations" | "executive";

export default function CommandCenterPage() {
  const { state, today, derived, proactive, personalFocus, previousSnapshot, filteredData, workRelevanceIndex, dailyCommandCompletedWorkItemIds, store } = useCommandCenter();
  const [selected, setSelected] = useState<{ item: WorkItem; result: PriorityScoreResult } | null>(null);
  const [closingDay, setClosingDay] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("operations");

  useEffect(() => {
    if (state.loaded) store.bumpUsage(USAGE_KEYS.MORNING_BRIEF_OPENED);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.loaded]);

  if (!state.loaded) {
    return (
      <EmptyState
        title="No data yet"
        description="Load the demo dataset to see the Command Center in action, or bring in your own work items via Data & Settings."
        onLoadDemo={() => store.loadDemoData()}
      />
    );
  }

  const topPriorities = derived.scores.slice(0, 4);
  const topChanges = derived.changes.slice(0, 5);
  const topRisks = derived.risks.slice(0, 4);
  const openComms = filteredData.communications.filter((c) => c.status === "open").slice(0, 4);

  const currentMetrics = buildSnapshotMetrics(filteredData, today, derived.changes.length);
  const trend = compareSnapshots(currentMetrics, previousSnapshot?.metrics);
  const confidenceDelta = trend.deltas.find((d) => d.label === "Delivery confidence")?.delta;
  const escalatingRisks = proactive?.riskEscalations.filter((r) => r.trend === "worsening" || r.reopened).slice(0, 4) ?? [];
  const agingDependencies = proactive?.dependencyRadar.filter((d) => d.heat !== "LOW").slice(0, 4) ?? [];
  const reEscalations = proactive?.attentionQueue.filter((a) => a.lifecycle === "RE_ESCALATED") ?? [];
  const stalledLoops = proactive?.deliveryLoops.filter((l) => l.health === "STALLED" || l.health === "AT_RISK").slice(0, 4) ?? [];
  const decisionsNeedingReview = proactive?.decisionRadar.slice(0, 4) ?? [];

  return (
    <div className="space-y-8 pb-16">
      {state.isDemo && (
        <div className="rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-accent2">
          DEMO DATA — fictional clients, for demonstration only. Import your own data anytime from Data & Settings.
        </div>
      )}

      <FilterBar />
      <CommandBar />

      {/* V2.1 §10 — data quality visible BEFORE strong personal recommendations, only once
          a real Jira sync has actually completed (demo/local-import data doesn't need this).
          V2.4 §24 — under a FOCUSED scope, Global and Current Scope data health can genuinely
          differ (e.g. one out-of-scope project dragging down global ownership coverage), so
          both are shown, each explicitly labeled; under ALL scope they're identical, so only
          one is shown to avoid a redundant duplicate panel. */}
      {state.dataSource === "jira" && state.jiraSync.lastSyncStatus === "success" && (
        <>
          <BeforeYouTrustThisData
            summary={buildBeforeYouTrustSummary(
              computeDataHealth(
                state.data,
                state.dataSource,
                state.jiraSync.lastSyncCompletedAt,
                undefined,
                workRelevanceIndex,
                // V2.22 §13 — this Global panel deliberately reads UNSCOPED state.data (it can
                // include a project outside the current Focus Project Scope), so its own
                // completion-id set is resolved against that same unscoped population rather
                // than reusing the hook's scoped one.
                new Set(state.data.workItems.filter((w) => Object.prototype.hasOwnProperty.call(state.dailyCommandCompletions ?? {}, w.key)).map((w) => w.id))
              )
            )}
            label={state.jiraProjectScope.mode === "FOCUSED" ? "Global" : undefined}
          />
          {state.jiraProjectScope.mode === "FOCUSED" && (
            <BeforeYouTrustThisData
              summary={buildBeforeYouTrustSummary(computeDataHealth(filteredData, state.dataSource, state.jiraSync.lastSyncCompletedAt, undefined, workRelevanceIndex, dailyCommandCompletedWorkItemIds))}
              label="Current Scope"
            />
          )}
        </>
      )}

      {proactive && (
        <ControlTower
          proactive={proactive}
          deliveryConfidence={currentMetrics.deliveryConfidence}
          confidenceDelta={confidenceDelta}
          lastSyncedLabel={state.dataSource === "jira" && state.jiraSync.lastSyncCompletedAt ? `Synced ${new Date(state.jiraSync.lastSyncCompletedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : undefined}
          freshness={state.dataSource === "jira" ? computeFreshness(state.jiraSync.lastSyncCompletedAt) : undefined}
        />
      )}

      {/* V1.6 §43 — the personal layer sits on top of project intelligence, never hiding it. */}
      {personalFocus && <YourDeliveryFocus personalFocus={personalFocus} compact />}

      {/* V2.19 — WHAT AM I RESPONSIBLE FOR? / WHAT RECENTLY INVOLVED ME? Both distinct from
          Your Delivery Focus above (curated) — see the hardening spec's own IA guidance. */}
      <div className="grid gap-6 md:grid-cols-2">
        <MyAssignedWork />
        <RecentlyMentioned />
      </div>

      <div className="flex items-center justify-between">
        <MorningBriefHeading />
        <div role="tablist" aria-label="View mode" className="flex gap-1 rounded-md border border-border p-0.5">
          {(["operations", "executive"] as ViewMode[]).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={viewMode === m}
              onClick={() => setViewMode(m)}
              className={`rounded px-3 py-1 text-xs font-medium capitalize ${
                viewMode === m ? "bg-surface2 text-text" : "text-text3 hover:text-text2"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      <MorningBrief data={filteredData} proactive={proactive} personalFocus={personalFocus} trend={trend} dataSource={state.dataSource} lastSyncedAt={state.jiraSync.lastSyncCompletedAt} />

      {proactive && <AttentionQueuePanel items={proactive.attentionQueue} />}
      {proactive && <ClientAttentionMap rows={proactive.clientAttentionMap} />}

      {viewMode === "executive" ? (
        <ExecutiveView data={filteredData} derived={derived} proactive={proactive} personalFocus={personalFocus} memoryEvents={state.memoryEvents} />
      ) : (
        <>
          <KpiStrip kpis={derived.kpis} />

          <HealthTrend trend={trend} currentConfidence={currentMetrics.deliveryConfidence} />
          <GettingBetterWorse trend={trend} />
          <ReleaseHealthPanel data={filteredData} today={today} />

          {reEscalations.length > 0 && (
            <section>
              <SectionHeading title="Re-escalations" subtitle="V1.5 §22 — items you'd acknowledged or snoozed whose severity has since increased." />
              <div className="grid gap-2 md:grid-cols-2">
                {reEscalations.map((a) => (
                  <Panel key={a.id} className="border-red/30 p-4">
                    <AttentionSeverityBadge severity={a.severity} />
                    <p className="mt-1 font-display text-sm text-text">{a.what}</p>
                    <p className="mt-1 text-xs text-text2">{a.why}</p>
                  </Panel>
                ))}
              </div>
            </section>
          )}

          <section>
            <SectionHeading title="Decisions" subtitle="Decision Radar — needs review or urgent review, never changed automatically." action={<Link href="/decisions" className="text-xs font-medium text-accent2 hover:underline">Decision Log →</Link>} />
            {decisionsNeedingReview.length === 0 ? (
              <Panel className="p-6 text-sm text-text3">No decisions currently need review.</Panel>
            ) : (
              <div className="grid gap-2 md:grid-cols-2">
                {decisionsNeedingReview.map((d) => (
                  <Panel key={d.decisionId} className="p-4">
                    <div className="mb-1 flex items-center gap-2">
                      <AttentionSeverityBadge severity={d.reviewUrgency === "URGENT_REVIEW" ? "HIGH" : "MEDIUM"} />
                    </div>
                    <p className="font-display text-sm text-text">{d.decision.title}</p>
                    <p className="mt-1 text-xs text-text2">{d.whyReview[0] ?? `Stale for ${d.stalenessDays}d`}</p>
                  </Panel>
                ))}
              </div>
            )}
          </section>

          {stalledLoops.length > 0 && (
            <section>
              <SectionHeading title="Stalled Loops" subtitle="Decision -> Action -> Outcome loops that need a nudge." action={<Link href="/loops" className="text-xs font-medium text-accent2 hover:underline">All loops →</Link>} />
              <div className="grid gap-2 md:grid-cols-2">
                {stalledLoops.map((l) => (
                  <Panel key={l.id} className="p-4">
                    <LoopHealthBadge health={l.health} />
                    <p className="mt-1 font-display text-sm text-text">{l.issue}</p>
                    <p className="mt-1 text-xs text-text2">{l.why}</p>
                  </Panel>
                ))}
              </div>
            </section>
          )}

          {/* V2.21 §9.3, §10 — the standalone "My Next Actions" section (DO_NOW/DO_TODAY) was
              removed here: it was a pure subset of what Your Delivery Focus (rendered once,
              near the top of this page) already shows — the same candidates, the same
              recommendation, rendered a second time. There is now exactly ONE primary "what
              should I do next" surface on this page; Your Delivery Focus is it. */}
          {personalFocus && personalFocus.byCategory.BLOCKED.length > 0 && (
            <section>
              <SectionHeading title="Blocked Focus" subtitle="Personal focus items that cannot progress right now." />
              <div className="grid gap-2 md:grid-cols-2">
                {personalFocus.byCategory.BLOCKED.slice(0, 4).map((c) => (
                  <Panel key={c.id} className="p-4">
                    <FocusCategoryBadge category={c.category} />
                    <p className="mt-1 font-display text-sm text-text">{c.title}</p>
                    <p className="mt-1 text-xs text-text2">{c.why}</p>
                  </Panel>
                ))}
              </div>
            </section>
          )}

          <section>
            <SectionHeading title="Escalating Risks" subtitle="Worsening severity, growing evidence, or reopened after being resolved." />
            {escalatingRisks.length === 0 ? (
              <Panel className="p-6 text-sm text-text3">No risks are currently escalating.</Panel>
            ) : (
              <div className="grid gap-2 md:grid-cols-2">
                {escalatingRisks.map((r) => (
                  <Panel key={r.riskId} className="p-4">
                    <div className="mb-1 flex items-center gap-2">
                      <AttentionSeverityBadge severity={r.currentSeverity === "HIGH" ? "HIGH" : "MEDIUM"} />
                      {r.reopened && <span className="text-xs text-red">Reopened</span>}
                    </div>
                    <p className="font-display text-sm text-text">{r.riskTitle}</p>
                    <p className="mt-1 text-xs text-text2">{r.escalationReason ?? `Open ${r.daysOpen} day(s).`}</p>
                  </Panel>
                ))}
              </div>
            )}
          </section>

          <section>
            <SectionHeading title="Aging Dependencies" subtitle="Deterministic Dependency Radar — age, blocked work, release proximity, linked risk." />
            {agingDependencies.length === 0 ? (
              <Panel className="p-6 text-sm text-text3">No dependencies currently need escalation.</Panel>
            ) : (
              <div className="grid gap-2 md:grid-cols-2">
                {agingDependencies.map((d) => (
                  <Panel key={d.dependencyId} className="p-4">
                    <div className="mb-1 flex items-center gap-2">
                      <HeatBadge heat={d.heat} />
                    </div>
                    <p className="font-display text-sm text-text">Dependency on {d.dependsOnTeam}</p>
                    <p className="mt-1 text-xs text-text2">{d.recommended}</p>
                  </Panel>
                ))}
              </div>
            )}
          </section>

          <section>
            <SectionHeading title="Top Priorities" subtitle="Ranked by the deterministic priority model — see Priorities for the full list." />
            {topPriorities.length === 0 ? (
              <Panel className="p-6 text-sm text-text3">Nothing urgent right now.</Panel>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {topPriorities.map((result) => {
                  const item = itemForScore(filteredData, result);
                  if (!item) return null;
                  return (
                    <PriorityCard
                      key={item.id}
                      item={item}
                      result={result}
                      data={filteredData}
                      isDemo={state.isDemo}
                      onTakeAction={() => setSelected({ item, result })}
                    />
                  );
                })}
              </div>
            )}
          </section>

          <section>
            <SectionHeading
              title="What Changed?"
              subtitle="Since the last snapshot."
              action={
                <Link href="/changes" className="text-xs font-medium text-accent2 hover:underline">
                  Full change log →
                </Link>
              }
            />
            {topChanges.length === 0 ? (
              <Panel className="p-6 text-sm text-text3">No meaningful changes detected.</Panel>
            ) : (
              <div className="grid gap-2 md:grid-cols-2">
                {topChanges.map((c) => (
                  <ChangeItem key={c.id} change={c} />
                ))}
              </div>
            )}
          </section>

          <WaitingFor data={filteredData} proactive={proactive} />

          <section>
            <SectionHeading
              title="What Might Go Wrong?"
              subtitle="Deterministically detected from combinations of data."
              action={
                <Link href="/risks" className="text-xs font-medium text-accent2 hover:underline">
                  All risks →
                </Link>
              }
            />
            {topRisks.length === 0 ? (
              <Panel className="p-6 text-sm text-text3">No emerging risks detected.</Panel>
            ) : (
              <div className="grid gap-2 md:grid-cols-2">
                {topRisks.map((r) => (
                  <Panel key={r.id} className="p-4">
                    <div className="mb-1 flex items-center gap-2">
                      <RiskBadge level={r.level} />
                    </div>
                    <p className="font-display text-sm text-text">{r.title}</p>
                    <p className="mt-1 text-xs text-text2">{r.reason}</p>
                  </Panel>
                ))}
              </div>
            )}
          </section>

          {/* V2.21 §9.3, §10 — the standalone "First 30 Minutes" section was removed here: it
              answered the exact same question ("what can I do right now?") as Your Delivery
              Focus's own "If you only have 30 minutes" list, rendered near the top of this
              page, just from a slightly different underlying computation. One canonical
              Next Up surface, not two. The full Action Plan remains one click away via the
              primary nav. */}

          <section>
            <SectionHeading title="Who Should I Communicate With?" subtitle="Detected from blockers, deadlines, and unresolved decisions." />
            {openComms.length === 0 ? (
              <Panel className="p-6 text-sm text-text3">No pending communications.</Panel>
            ) : (
              <div className="grid gap-2 md:grid-cols-2">
                {openComms.map((c) => (
                  <CommunicationCard key={c.id} comm={c} />
                ))}
              </div>
            )}
          </section>

          <GapsPanel />

          <div className="flex justify-end border-t border-border pt-6">
            <button
              onClick={() => setClosingDay(true)}
              className="rounded-md border border-border px-4 py-2 text-sm font-medium text-text2 hover:border-accent hover:text-text"
            >
              Close My Day
            </button>
          </div>
        </>
      )}

      <TakeActionPanel item={selected?.item ?? null} result={selected?.result ?? null} onClose={() => setSelected(null)} />
      {closingDay && <CloseDayModal onClose={() => setClosingDay(false)} />}
    </div>
  );
}

function MorningBriefHeading() {
  return <h2 className="font-display text-sm uppercase tracking-wide text-text3">Good morning</h2>;
}
