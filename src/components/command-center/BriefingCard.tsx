"use client";

// W1 — the Morning Briefing as the top card of the Command Center: the SAME content the 08:30 Slack message carries (built by
// briefing.ts from the same inputs), plus the mirror that keeps the server's compact snapshot fresh. The card also works with Slack off.

import { useEffect, useMemo } from "react";
import { buildBriefing, asBriefingPrefs, type BriefingRecord } from "@/lib/command-center/briefing";
import { briefingLinks, buildBriefingSnapshot, dueSoonFrom } from "@/lib/command-center/briefing-snapshot";
import { buildReminderIndex } from "@/lib/command-center/reminder-index";
import { asReminderPrefs } from "@/lib/command-center/reminder-schedule";
import { nextBestActions } from "@/lib/command-center/next-best-action";
import { nbaInputFrom } from "@/lib/command-center/nba-inputs";
import { pairedAuthHeader } from "@/lib/command-center/device-pairing";
import { Panel, SectionHeading } from "./ui";
import { useCommandCenter } from "./use-command-center";

export function BriefingCard() {
  const { state, today, derived, forecast, scoring, filteredData } = useCommandCenter();
  const prefs = asBriefingPrefs(state.briefingPrefs);
  const content = useMemo(() => {
    if (!state.loaded) return null;
    const { input } = nbaInputFrom({ today, data: filteredData, scores: derived.scores, awaitingMeByKey: scoring.awaitingMeByKey, ticketWorkStates: state.ticketWorkStates, forecast, blockerSlaBusinessDays: state.blockerSlaBusinessDays, memoryEvents: state.memoryEvents });
    const cards = nextBestActions(input);
    const slipHigh = new Map<string, { explanation: string }>();
    for (const [key, f] of forecast.byTicket) if (f.slip?.level === "HIGH") slipHigh.set(key, { explanation: f.slip.explanation });
    const nowIso = new Date().toISOString();
    const awaitingMeByKey = scoring.awaitingMeByKey ?? {};
    const snapshot = buildBriefingSnapshot({ nowIso, today, cards, slipHigh, awaitingMeByKey });
    const index = buildReminderIndex(state.ticketWorkStates, state.data.workItems, nowIso, asReminderPrefs(state.reminderPrefs));
    const record: BriefingRecord = { prefs, snapshot, links: briefingLinks([...cards.map((c) => c.ticketKey), ...slipHigh.keys(), ...Object.keys(awaitingMeByKey)], state.data.workItems) };
    return { snapshot, record, built: buildBriefing({ today, record, index, dueSoon: dueSoonFrom(state.data.workItems, today), now: new Date() }) };
  }, [state.loaded, state.ticketWorkStates, state.data.workItems, state.reminderPrefs, state.blockerSlaBusinessDays, state.memoryEvents, today, filteredData, derived.scores, scoring.awaitingMeByKey, forecast, prefs]);

  // Mirror the prefs + compact snapshot to the server (debounced, best effort) so the cron can send the briefing with the app closed.
  useEffect(() => {
    if (!content) return;
    const t = setTimeout(() => {
      void fetch("/api/command-center/briefing", { method: "POST", headers: { "Content-Type": "application/json", ...pairedAuthHeader() }, body: JSON.stringify({ prefs, snapshot: content.snapshot, links: content.record.links }) }).catch(() => undefined);
    }, 4000);
    return () => clearTimeout(t);
  }, [content, prefs]);

  if (!content) return null;
  return (
    <Panel className="p-4" data-briefing-card>
      <SectionHeading title="Morning briefing" subtitle={prefs.enabled ? `Sent to Slack on workdays at ${prefs.time} (when Slack and server reminders are set up).` : "Turn on the Slack briefing in Data & Settings → Reminders."} />
      <div className="space-y-0.5 text-sm text-text2">
        {content.built.lines.slice(1).map((l, i) => (
          <p key={i} className={l.startsWith("*") ? "mt-1 font-medium text-text" : ""}>{l.replace(/<[^|>]*\|([^>]*)>/g, "$1").replace(/\*/g, "").replace(/^_|_$/g, "")}</p>
        ))}
      </div>
    </Panel>
  );
}
