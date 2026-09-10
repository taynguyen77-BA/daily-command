"use client";

import { useState } from "react";
import { deriveDontForget } from "@/lib/command-center/personal-focus";
import { getTodayIso } from "@/lib/command-center/store";
import { buildTodaysUpdateDraft } from "@/lib/command-center/communicate";
import type { ProactiveIntelligence } from "@/lib/command-center/proactive";
import type { CommandCenterData, DataSourceType, HealthTrend, PersonalFocusResult } from "@/lib/command-center/types";
import { ArtifactEditor } from "./ArtifactEditor";
import { Panel, TrustLabel } from "./ui";

/**
 * V1.1 §8 — the first thing the user sees. V2.0 §6 — an explicit TODAY -> WATCH -> DON'T
 * FORGET flow (reusing Personal Focus + Attention Queue + Gap Detection; no new scoring).
 * V2.21 §9, §10 — trimmed to the content genuinely unique to this brief (trend, ineffective
 * actions, who most needs contact, the watch list, don't-forget, expected outcomes): top3,
 * decisions-needing-review, stalled loops, and the 30-minute plan all now render exactly
 * once each, on their own dedicated surfaces elsewhere on this page, rather than being
 * duplicated here too. Still purely template-based — no new AI call.
 */
export function MorningBrief({
  data,
  proactive,
  personalFocus,
  trend,
  dataSource,
  lastSyncedAt,
}: {
  data: CommandCenterData;
  proactive: ProactiveIntelligence | null;
  personalFocus?: PersonalFocusResult | null;
  trend: HealthTrend;
  dataSource?: DataSourceType;
  lastSyncedAt?: string;
}) {
  const openComms = data.communications.filter((c) => c.status === "open");
  const topComm = proactive?.communicationPriority.find((c) => c.priority === "URGENT" || c.priority === "IMPORTANT");
  const topStakeholder = proactive?.stakeholderAttention[0];
  const watch = personalFocus?.byCategory.WATCH.slice(0, 3) ?? [];
  const actionsNotWorking = proactive?.actionEffectiveness.filter((r) => r.classification === "INEFFECTIVE").slice(0, 3) ?? [];
  const expectedOutcomes = data.decisions.filter((d) => d.expectedOutcome && (d.status === "IMPLEMENTING" || d.status === "VALIDATING" || d.status === "DECIDED")).slice(0, 3);
  const dontForget = personalFocus ? deriveDontForget(personalFocus) : [];
  const today = getTodayIso();
  const [creatingUpdate, setCreatingUpdate] = useState(false);

  return (
    <Panel className="p-5">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrustLabel kind="calculated" />
          <span className="text-xs uppercase tracking-wide text-text3">Your delivery morning</span>
        </div>
        {proactive && (
          <button
            onClick={() => setCreatingUpdate(true)}
            className="rounded-md border border-border px-2 py-1 text-xs font-medium text-text2 hover:border-accent hover:text-text"
          >
            Create Today&apos;s Update
          </button>
        )}
      </div>
      {dataSource === "jira" && (
        <p className="mb-3 text-xs text-text3">
          Based on Jira data synced at {lastSyncedAt ? new Date(lastSyncedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "an earlier sync"}.
        </p>
      )}

      <div className="space-y-4">
        <p className="font-display text-sm text-text">TODAY</p>
        {/* V2.21 §9.3, §10 — "Your top 3"/"Why these matter" were removed here: Your Delivery
            Focus (rendered above this brief, compact) is now the one canonical surface for
            top3 + why — this brief no longer repeats it in plain-text form immediately
            after. */}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-text3">What got worse</p>
            {trend.gettingWorse.length > 0 ? (
              <>
                <ul className="mt-1 space-y-0.5 text-sm text-text2">
                  {trend.gettingWorse.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-text3">If no intervention occurs, these conditions are expected to remain unresolved.</p>
              </>
            ) : (
              <p className="mt-1 text-sm text-text3">Nothing worsened since the last snapshot.</p>
            )}
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-text3">What got better</p>
            {trend.gettingBetter.length > 0 ? (
              <ul className="mt-1 space-y-0.5 text-sm text-text2">
                {trend.gettingBetter.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-text3">No improvement since the last snapshot.</p>
            )}
          </div>
        </div>

        {/* V2.21 §9.4, §10 — the "Decisions needed" and "Stalled loops" blocks that used to
            live here were removed: the main dashboard already renders a full "Decisions"
            section and a full "Stalled Loops" section (with badges and evidence) directly
            below this brief — the condensed versions here added no information a reader
            wouldn't already see a few seconds later, just the same recommendation twice. */}

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-text3">Actions not working</p>
          {actionsNotWorking.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-sm text-text2">
              {actionsNotWorking.map((r) => (
                <li key={r.actionId}>{r.actionTitle} — did not resolve the underlying issue.</li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-text3">No ineffective actions detected.</p>
          )}
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-text3">Who needs to act</p>
          <p className="mt-1 text-sm text-text2">
            {topComm ? `${topComm.who} — ${topComm.why} (${topComm.when})` : topStakeholder ? topStakeholder.reason : openComms.length > 0 ? `${openComms[0].who} (${openComms[0].audience})` : "No one currently needs to be contacted."}
          </p>
        </div>

        {/* V2.21 §9.3, §10 — "If you only have 30 minutes" was removed here: Your Delivery
            Focus (above) already owns this exact list, with Start-focus buttons this
            plain-text copy never had anyway. */}

        <p className="border-t border-border pt-4 font-display text-sm text-text">WATCH</p>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-text3">Items that don&apos;t need immediate action</p>
          {watch.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-sm text-text2">
              {watch.map((c) => (
                <li key={c.id}>{c.title} — {c.why}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-text3">Nothing currently sitting on the watch list.</p>
          )}
        </div>

        <p className="border-t border-border pt-4 font-display text-sm text-text">DON&apos;T FORGET</p>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-text3">Important, unresolved, not in today&apos;s top 3</p>
          {dontForget.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-sm text-text2">
              {dontForget.map((c) => (
                <li key={c.id}>{c.title}{c.projectName ? ` (${c.projectName})` : ""} — {c.why}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-text3">Nothing important is being left behind today.</p>
          )}
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-text3">Expected outcomes</p>
          {expectedOutcomes.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-sm text-text2">
              {expectedOutcomes.map((d) => (
                <li key={d.id}>
                  {d.title}: {d.expectedOutcome}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-text3">No decisions currently awaiting a measured outcome.</p>
          )}
        </div>
      </div>
      {creatingUpdate && proactive && (
        <ArtifactEditor draft={buildTodaysUpdateDraft(data, proactive, personalFocus ?? null, today)} onClose={() => setCreatingUpdate(false)} />
      )}
    </Panel>
  );
}
