"use client";

import { deriveDontForget } from "@/lib/command-center/personal-focus";
import { reviewStatusFor } from "@/lib/command-center/decision-radar";
import { getTodayIso } from "@/lib/command-center/store";
import type { ProactiveIntelligence } from "@/lib/command-center/proactive";
import type { CommandCenterData, DataSourceType, HealthTrend, PersonalFocusResult } from "@/lib/command-center/types";
import { DecisionReviewStatusBadge, Panel, TrustLabel } from "./ui";

/**
 * V1.1 §8 — the first thing the user sees. Must answer "what should I care about today?"
 * in about 10 seconds. V1.3 §39 — with a live source, states what data it's based on and
 * when. V1.4 §18 — upgraded into a proactive brief. V1.5 §30 — upgraded again into
 * "TODAY'S DELIVERY CONTROL": worse/better split out, decisions needed, actions not
 * working, stalled loops, who needs to act, first 30 minutes, expected outcomes. V2.0 §6 —
 * restructured into an explicit TODAY -> WATCH -> DON'T FORGET flow (reusing Personal
 * Focus + Attention Queue + Gap Detection; no new scoring). Still purely template-based —
 * no new AI call.
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
  const topAttention = proactive?.attentionQueue.filter((a) => a.lifecycle !== "SNOOZED" && a.lifecycle !== "RESOLVED").slice(0, 3) ?? [];
  const topComm = proactive?.communicationPriority.find((c) => c.priority === "URGENT" || c.priority === "IMPORTANT");
  const topStakeholder = proactive?.stakeholderAttention[0];
  const top3 = personalFocus?.top3 ?? [];
  const watch = personalFocus?.byCategory.WATCH.slice(0, 3) ?? [];
  const thirtyMin = personalFocus?.thirtyMinutePlan ?? [];
  const first30 = proactive?.first30Minutes.slice(0, 3) ?? [];
  const decisionsNeeded = proactive?.decisionRadar.slice(0, 3) ?? [];
  const actionsNotWorking = proactive?.actionEffectiveness.filter((r) => r.classification === "INEFFECTIVE").slice(0, 3) ?? [];
  const stalledLoops = proactive?.deliveryLoops.filter((l) => l.health === "STALLED" || l.health === "AT_RISK").slice(0, 3) ?? [];
  const expectedOutcomes = data.decisions.filter((d) => d.expectedOutcome && (d.status === "IMPLEMENTING" || d.status === "VALIDATING" || d.status === "DECIDED")).slice(0, 3);
  const dontForget = personalFocus ? deriveDontForget(personalFocus) : [];
  const today = getTodayIso();
  const upcomingReviews = data.decisions
    .map((d) => ({ decision: d, status: reviewStatusFor(d, today) }))
    .filter((r) => r.status === "REVIEW_DUE" || r.status === "REVIEW_SOON" || r.status === "REVIEW_OVERDUE")
    .slice(0, 3);

  return (
    <Panel className="p-5">
      <div className="mb-2 flex items-center gap-2">
        <TrustLabel kind="calculated" />
        <span className="text-xs uppercase tracking-wide text-text3">Your delivery morning</span>
      </div>
      {dataSource === "jira" && (
        <p className="mb-3 text-xs text-text3">
          Based on Jira data synced at {lastSyncedAt ? new Date(lastSyncedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "an earlier sync"}.
        </p>
      )}

      <div className="space-y-4">
        <p className="font-display text-sm text-text">TODAY</p>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-text3">Your top 3</p>
          {top3.length > 0 ? (
            <ol className="mt-1 space-y-0.5 text-sm text-text2">
              {top3.map((c, i) => (
                <li key={c.id}>
                  {i + 1}. {c.title}{c.projectName ? ` (${c.projectName})` : ""} — {c.nowWhat} (~{c.estimatedMinutes}m)
                </li>
              ))}
            </ol>
          ) : topAttention.length > 0 ? (
            <ol className="mt-1 space-y-0.5 text-sm text-text2">
              {topAttention.map((a, i) => (
                <li key={a.id}>
                  {i + 1}. {a.what} — {a.why}
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-1 text-sm text-text3">Nothing urgent — everything is within expected range.</p>
          )}
        </div>

        {top3.length > 0 && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-text3">Why these matter</p>
            <ul className="mt-1 space-y-0.5 text-sm text-text2">
              {top3.map((c) => (
                <li key={c.id}>{c.title}: {c.why}</li>
              ))}
            </ul>
          </div>
        )}

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

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-text3">Decisions needed</p>
          {decisionsNeeded.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-sm text-text2">
              {decisionsNeeded.map((d) => (
                <li key={d.decisionId}>
                  {d.decision.title} — {d.reviewUrgency === "URGENT_REVIEW" ? "urgent review" : "may need review"}.
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-text3">No decisions currently need review.</p>
          )}
          {upcomingReviews.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-sm text-text2">
              {upcomingReviews.map(({ decision, status }) => (
                <li key={decision.id} className="flex items-center gap-2">
                  <DecisionReviewStatusBadge status={status} /> {decision.title}
                </li>
              ))}
            </ul>
          )}
        </div>

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
          <p className="text-xs font-semibold uppercase tracking-wide text-text3">Stalled loops</p>
          {stalledLoops.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-sm text-text2">
              {stalledLoops.map((l) => (
                <li key={l.id}>{l.issue} — {l.why}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-text3">No stalled management loops.</p>
          )}
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-text3">Who needs to act</p>
          <p className="mt-1 text-sm text-text2">
            {topComm ? `${topComm.who} — ${topComm.why} (${topComm.when})` : topStakeholder ? topStakeholder.reason : openComms.length > 0 ? `${openComms[0].who} (${openComms[0].audience})` : "No one currently needs to be contacted."}
          </p>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-text3">If you only have 30 minutes</p>
          {thirtyMin.length > 0 ? (
            <ol className="mt-1 space-y-0.5 text-sm text-text2">
              {thirtyMin.map((c, i) => (
                <li key={c.id}>
                  {i + 1}. {c.title} — {c.estimatedMinutes}m
                </li>
              ))}
            </ol>
          ) : first30.length > 0 ? (
            <ol className="mt-1 space-y-0.5 text-sm text-text2">
              {first30.map((f, i) => (
                <li key={i}>
                  {i + 1}. {f.text}
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-1 text-sm text-text3">No priority items fit the next 30 minutes.</p>
          )}
        </div>

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
    </Panel>
  );
}
