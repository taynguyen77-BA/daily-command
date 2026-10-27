"use client";

// P3.6 — "do this next, and here is why": up to three cards from next-best-action.ts, with Why?, the
// primary action (existing flows: Start focus / Draft reply / Nudge / Defer) and "Useful" / "Not now".
// Deterministic; an optional one-call-a-day AI narration can phrase the summary when its flag is on.

import { useEffect, useMemo, useState } from "react";
import { nextBestActions, nbaDeferUntil, type NbaCard } from "@/lib/command-center/next-best-action";
import { nbaInputFrom } from "@/lib/command-center/nba-inputs";
import { deterministicNarration, narrateNextBestActions, type NarrationStorage } from "@/lib/command-center/nba-narration";
import { getAIProvider } from "@/lib/command-center/ai";
import { checkAiModelStatus } from "@/lib/command-center/ai/claude-provider";
import type { WhyShouldICareContent } from "@/lib/command-center/why-should-i-care";
import { Panel, SectionHeading, TrustLabel } from "./ui";
import { WhyShouldICareDrawer } from "./WhyShouldICareDrawer";
import { MentionReplyDrafter } from "./MentionReplyDrafter";
import { AskFollowUp } from "./AskFollowUp";
import { TicketLink } from "./TicketLink";
import { useCommandCenter } from "./use-command-center";

function whyContent(card: NbaCard): WhyShouldICareContent {
  return {
    fact: card.why.map((w) => w.content),
    signal: `Next Best Action rank ${card.rank}: ${card.kind}`,
    impact: { currentCondition: card.headline, unresolvedSignal: card.why[0]?.content ?? "", affectedEntities: [card.ticketKey], evidence: card.why, confidence: 1, insufficientEvidence: false },
    unknown: [],
    nextMove: card.primary.label,
    evidence: card.why,
  };
}

const browserStorage: NarrationStorage = {
  get: (k) => {
    try {
      return window.localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      window.localStorage.setItem(k, v);
    } catch {
      /* unavailable */
    }
  },
};

export function NextBestActions({ compact = false }: { compact?: boolean }) {
  const { state, store, today, derived, forecast, scoring, filteredData } = useCommandCenter();
  const { input, followUpRowsFor } = useMemo(
    () => nbaInputFrom({ today, data: filteredData, scores: derived.scores, awaitingMeByKey: scoring.awaitingMeByKey, ticketWorkStates: state.ticketWorkStates, forecast, blockerSlaBusinessDays: state.blockerSlaBusinessDays, memoryEvents: state.memoryEvents }),
    [today, filteredData, derived.scores, scoring.awaitingMeByKey, state.ticketWorkStates, forecast, state.blockerSlaBusinessDays, state.memoryEvents]
  );
  const cards = useMemo(() => nextBestActions(input), [input]);
  const [answered, setAnswered] = useState<Record<string, "useful" | "not-now">>({});
  const [narration, setNarration] = useState<{ text: string; source: "ai" | "deterministic" } | null>(null);
  const flagOn = state.features.nextBestActionAi;

  useEffect(() => {
    let cancelled = false;
    if (!flagOn || cards.length === 0) return;
    void (async () => {
      const aiAvailable = (await checkAiModelStatus())?.available === true;
      const r = await narrateNextBestActions({
        cards,
        today,
        flagOn,
        aiAvailable,
        storage: browserStorage,
        callAi: async (facts) => {
          const provider = getAIProvider();
          if (provider.mode !== "claude") return null;
          const g = await provider.generateDailyGuidance(facts.headlines, [], [], [], facts.evidence);
          return g.insufficientEvidence ? null : g.summary;
        },
      });
      if (!cancelled) setNarration(r);
    })();
    return () => {
      cancelled = true;
    };
  }, [flagOn, cards, today]);

  if (!state.loaded) return null;
  const answer = (card: NbaCard, accepted: boolean) => {
    store.recordNbaFeedback(card, accepted);
    setAnswered((a) => ({ ...a, [card.id]: accepted ? "useful" : "not-now" }));
  };
  const mentionFor = (key: string) => {
    const open = state.mentionEvents.filter((m) => m.issueKey === key && !state.mentionReplies[m.commentId]).sort((a, b) => a.mentionedAt.localeCompare(b.mentionedAt))[0];
    return open ? { issueKey: open.issueKey, commentId: open.commentId, author: open.commentAuthor, excerpt: open.excerpt, mentionedAt: open.mentionedAt } : null;
  };

  return (
    <section data-next-best-actions>
      <SectionHeading title="Next best action" subtitle={compact ? undefined : "Do this next, and here is why — ranked: waiting on your reply · overdue P1/P2 · forecast to slip · blocked with a nudge ready · re-check due · highest score."} action={<TrustLabel kind="calculated" />} />
      {cards.length === 0 ? (
        <Panel className="p-4 text-sm text-text3">Nothing needs you right now.</Panel>
      ) : (
        <Panel className="space-y-3 p-4">
          {(narration ?? { text: deterministicNarration(cards), source: "deterministic" as const }).text && !compact && (
            <p className="text-sm text-text2" data-nba-narration={narration?.source ?? "deterministic"}>
              {(narration ?? { text: deterministicNarration(cards) }).text}
              {narration?.source === "ai" && <span className="ml-2"><TrustLabel kind="ai-draft" /></span>}
            </p>
          )}
          <ul className="space-y-3">
            {cards.map((card) => {
              const rows = card.primary.intent === "nudge" ? followUpRowsFor(card.ticketKey) : [];
              const mention = card.primary.intent === "draft-reply" ? mentionFor(card.ticketKey) : null;
              const w = state.data.workItems.find((x) => x.key === card.ticketKey);
              return (
                <li key={card.id} data-nba-card={card.kind} data-nba-ticket={card.ticketKey} className="rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text3">#{card.rank} {card.kind}</span>
                    <TicketLink ticketKey={card.ticketKey} url={w?.sourceUrl} className="font-mono text-xs text-text3" />
                    <span className="text-text">{card.headline}</span>
                  </div>
                  <ul className="mt-1 list-inside list-disc text-xs text-text2">
                    {card.why.map((e) => (
                      <li key={e.id}>{e.content}</li>
                    ))}
                  </ul>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {card.primary.intent === "start-focus" && (
                      <button onClick={() => store.startTicket(card.ticketKey, "my-work")} className="btn btn-sm btn-secondary">{card.primary.label}</button>
                    )}
                    {card.primary.intent === "draft-reply" && (mention ? <MentionReplyDrafter mention={mention} /> : <span className="text-xs text-text3">Open the ticket to reply.</span>)}
                    {card.primary.intent === "nudge" && rows.length > 0 && <AskFollowUp rows={rows} label={card.primary.label} />}
                    <button onClick={() => store.deferTicket(card.ticketKey, nbaDeferUntil(today), "Next Best Action: not now", "my-work")} className="btn btn-sm btn-secondary">Defer</button>
                    <WhyShouldICareDrawer content={whyContent(card)} triggerLabel="Why?" />
                    {answered[card.id] ? (
                      <span className="text-xs text-text3" data-nba-answered={answered[card.id]}>{answered[card.id] === "useful" ? "Thanks — noted as useful." : "Okay — hidden for today."}</span>
                    ) : (
                      <>
                        <button onClick={() => answer(card, true)} className="text-xs text-text3 hover:text-text2" data-nba-useful>Useful</button>
                        <button onClick={() => answer(card, false)} className="text-xs text-text3 hover:text-text2" data-nba-not-now>Not now</button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
    </section>
  );
}
