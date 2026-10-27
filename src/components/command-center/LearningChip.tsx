"use client";

// P3.3 — a quiet chip on a ticket row: shadow mode says what learning WOULD do ("Learning would move this +4"),
// on mode says what it did ("Learned +4"). Always with the sample size; the tooltip carries the evidence.

import { useCommandCenter } from "./use-command-center";
import { learnedAdjustmentsFor } from "@/lib/command-center/scoring-context";
import { asLearnedMode, learnedDeltaFor, signalKindForTicket } from "@/lib/command-center/learned-adjustments";
import { buildAwaitingMe } from "@/lib/command-center/awaiting-me";

export function LearningChip({ ticketKey }: { ticketKey: string }) {
  const { state, today, scopedMentionEvents } = useCommandCenter();
  const mode = asLearnedMode(state.learnedPriority);
  if (mode === "off" || (state.scoringModel ?? "v2") !== "v2") return null;
  const item = state.data.workItems.find((w) => w.key === ticketKey);
  if (!item) return null;
  const adjustments = learnedAdjustmentsFor(state, today);
  if (adjustments.length === 0) return null;
  const awaiting = buildAwaitingMe(scopedMentionEvents, state.mentionReplies, state.conversationByTicket);
  const look = learnedDeltaFor(item, signalKindForTicket(ticketKey, awaiting), adjustments, { today, awaitingMe: awaiting[ticketKey] });
  if (look.delta === 0 || !look.adjustment) return null;
  const sign = look.delta > 0 ? `+${look.delta}` : String(look.delta);
  return (
    <span data-learning-chip={mode} title={look.adjustment.evidence} className="mt-1 inline-flex w-fit items-center rounded-full border border-border px-2 py-0.5 text-[11px] text-text3">
      {mode === "on" ? `Learned ${sign}` : `Learning would move this ${sign}`} · n={look.adjustment.n}
    </span>
  );
}
