"use client";

import { useMemo, useState } from "react";
import { getAIProvider } from "@/lib/command-center/ai";
import { answerFromRoute, classifyQuery, familyForIntent, isArtifactIntent, type QueryIntent } from "@/lib/command-center/query-router";
import { buildPersonalDeliveryReviewFacts } from "@/lib/command-center/personal-patterns";
import { buildDecisionBriefDraft, buildReleaseUpdateDraft, buildStakeholderUpdateDraft, buildStatusUpdateDraft, buildTodaysUpdateDraft } from "@/lib/command-center/communicate";
import { computeReleaseHealth } from "@/lib/command-center/release-health";
import { commandCenterStore } from "@/lib/command-center/store";
import { commandUsageKey, USAGE_KEYS } from "@/lib/command-center/usage";
import type { ArtifactDraft, QueryAnswer } from "@/lib/command-center/types";
import { useCommandCenter } from "./use-command-center";
import { ArtifactEditor } from "./ArtifactEditor";
import { ConfidenceTag, Panel, TrustLabel } from "./ui";

const EXAMPLES = [
  "What should I focus on today?",
  "What can I finish in 30 minutes?",
  "Am I overloaded?",
  "What did I skip?",
  "What's blocking JPMC?",
  "What changed today?",
  "Which client needs attention?",
  "Why is delivery drifting?",
];

/** V1.3 §26 — NOT a generic chatbot. Every query is routed deterministically
 *  (query-router.ts) to a known intent; Claude only narrates the retrieved facts. */
export function CommandBar() {
  const { state, today, filteredData, derived, proactive, personalFocus } = useCommandCenter();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QueryAnswer | null>(null);
  const [lastQuery, setLastQuery] = useState("");
  const [intent, setIntent] = useState<QueryIntent | null>(null);
  const [artifactDraft, setArtifactDraft] = useState<ArtifactDraft | null>(null);
  const [artifactNote, setArtifactNote] = useState<string | null>(null);

  const personalReview = useMemo(
    () => (proactive && personalFocus ? buildPersonalDeliveryReviewFacts(state.personalPlan, personalFocus.candidates, proactive.actionEffectiveness, filteredData, 7, today) : undefined),
    [state.personalPlan, personalFocus, proactive, filteredData, today]
  );

  async function run(q: string) {
    if (!q.trim()) return;
    setLoading(true);
    setLastQuery(q);
    setResult(null);
    setArtifactDraft(null);
    setArtifactNote(null);
    commandCenterStore.bumpUsage(USAGE_KEYS.COMMAND_BAR_USED);
    const route = classifyQuery(q, filteredData);
    setIntent(route.intent);
    if (route.intent === "unrecognized") {
      // V1.7 §36 — never silently route to a random intent; say so explicitly.
      setResult({
        answer: "I don't have a deterministic command for that yet — try one of the examples below.",
        evidence: [],
        recommendedAction: "",
        confidence: 0.5,
        insufficientEvidence: true,
      });
      setLoading(false);
      return;
    }

    if (isArtifactIntent(route.intent)) {
      commandCenterStore.bumpUsage(commandUsageKey(route.intent));
      await runArtifactIntent(route.intent, route.target);
      setLoading(false);
      return;
    }

    const { facts, evidence, recommendedAction } = answerFromRoute(
      route,
      filteredData,
      derived,
      today,
      state.isDemo ? "demo" : "manual",
      proactive ?? undefined,
      personalFocus ?? undefined,
      personalReview
    );
    const answer = await getAIProvider().answerQuery(q, facts, evidence, recommendedAction);
    setResult(answer);
    setLoading(false);
  }

  // V2.2 §10 — a distinct, non-narrated outcome: builds the artifact directly from
  // communicate.ts (no answerQuery/AI narration) and opens the Artifact Editor.
  async function runArtifactIntent(artifactIntent: QueryIntent, target: string | undefined) {
    if (!proactive) {
      setArtifactNote("Proactive intelligence is not available yet.");
      return;
    }
    if (artifactIntent === "create-status-update") {
      setArtifactDraft(buildStatusUpdateDraft(filteredData, derived, proactive, personalFocus ?? null, today, "Command Bar"));
      return;
    }
    if (artifactIntent === "summarize-today") {
      setArtifactDraft(buildTodaysUpdateDraft(filteredData, proactive, personalFocus ?? null, today));
      return;
    }
    if (artifactIntent === "create-stakeholder-update") {
      const item = proactive.attentionQueue[0];
      if (!item) {
        setArtifactNote("Nothing currently needs attention to draft a stakeholder update from.");
        return;
      }
      setArtifactDraft(buildStakeholderUpdateDraft({ kind: "attention", item }, target ? `Command Bar: draft update for ${target}` : "Command Bar"));
      return;
    }
    if (artifactIntent === "create-release-update") {
      const version = target ?? filteredData.workItems.find((w) => w.fixVersion)?.fixVersion;
      if (!version) {
        setArtifactNote("No release/fix version found in the current data.");
        return;
      }
      setArtifactDraft(buildReleaseUpdateDraft(computeReleaseHealth(filteredData, version, today), filteredData, "Command Bar"));
      return;
    }
    if (artifactIntent === "create-decision-brief") {
      const item = proactive.decisionRadar[0];
      if (!item) {
        setArtifactNote("No decision currently needs review to draft a brief from.");
        return;
      }
      const attentionItem = proactive.attentionQueue.find((a) => a.sourceRef?.type === "decision" && a.sourceRef.id === item.decisionId);
      if (!attentionItem) {
        setArtifactNote("No matching attention item found for this decision.");
        return;
      }
      const options = await getAIProvider().generateDecisionOptions(attentionItem.what, [attentionItem.why, attentionItem.impact], attentionItem.evidence);
      setArtifactDraft(buildDecisionBriefDraft(attentionItem, options, "Command Bar"));
    }
  }

  return (
    <Panel className="p-4">
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") run(query);
          }}
          placeholder="Ask a focused project question…"
          className="flex-1 rounded-md border border-border bg-surface2 px-3 py-2 text-sm text-text placeholder:text-text3"
        />
        <button
          onClick={() => run(query)}
          disabled={loading || !query.trim()}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent2 disabled:opacity-50"
        >
          {loading ? "…" : "Ask"}
        </button>
      </div>

      {!result && (
        <div className="mt-2 flex flex-wrap gap-1">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => {
                setQuery(ex);
                run(ex);
              }}
              className="rounded border border-border px-2 py-1 text-xs text-text3 hover:border-accent hover:text-text2"
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {artifactNote && <p className="mt-3 border-t border-border pt-3 text-sm text-text3">{artifactNote}</p>}

      {result && (
        <div className="mt-3 space-y-2 border-t border-border pt-3 text-sm">
          <p className="text-xs text-text3">
            &quot;{lastQuery}&quot;
            {intent && intent !== "unrecognized" && (
              <>
                <span className="ml-2 rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent2">{familyForIntent(intent)}</span>
                <span className="ml-1 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text3">{intent.replace(/-/g, " ")}</span>
              </>
            )}
          </p>
          {result.insufficientEvidence ? (
            <p className="text-text3">{result.answer}</p>
          ) : (
            <>
              <p>
                <TrustLabel kind="ai-assessment" /> <span className="text-text2">{result.answer}</span>
              </p>
              {result.recommendedAction && (
                <p>
                  <TrustLabel kind="ai-recommendation" /> <span className="text-text2">{result.recommendedAction}</span>
                </p>
              )}
              {result.evidence.length > 0 && (
                <div>
                  <p className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-text3">
                    <TrustLabel kind="evidence" /> Evidence
                  </p>
                  <ul className="space-y-0.5 text-xs text-text2">
                    {result.evidence.slice(0, 6).map((e) => (
                      <li key={e.id}>- {e.content}</li>
                    ))}
                  </ul>
                </div>
              )}
              <ConfidenceTag confidence={result.confidence} />
            </>
          )}
        </div>
      )}

      {artifactDraft && <ArtifactEditor draft={artifactDraft} onClose={() => setArtifactDraft(null)} />}
    </Panel>
  );
}
