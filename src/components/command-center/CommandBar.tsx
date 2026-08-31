"use client";

import { useMemo, useState } from "react";
import { getAIProvider } from "@/lib/command-center/ai";
import { answerFromRoute, classifyQuery, familyForIntent, isArtifactIntent, type QueryIntent } from "@/lib/command-center/query-router";
import { detectExplicitProjectMention, knownJiraProjects } from "@/lib/command-center/jira/project-scope";
import { buildPersonalDeliveryReviewFacts } from "@/lib/command-center/personal-patterns";
import { buildDecisionBriefDraft, buildReleaseUpdateDraft, buildStakeholderUpdateDraft, buildStatusUpdateDraft, buildTodaysUpdateDraft } from "@/lib/command-center/communicate";
import { computeReleaseHealth } from "@/lib/command-center/release-health";
import { commandCenterStore } from "@/lib/command-center/store";
import { commandUsageKey, USAGE_KEYS } from "@/lib/command-center/usage";
import type { WorkRelevanceIndex } from "@/lib/command-center/jira/work-relevance";
import type { ArtifactDraft, CommandCenterData, JiraProjectSummary, PersonalDeliveryReviewFacts, PersonalFocusResult, QueryAnswer } from "@/lib/command-center/types";
import { useCommandCenter, buildProjectOverrideView } from "./use-command-center";
import type { DerivedData } from "@/lib/command-center/selectors";
import type { ProactiveIntelligence } from "@/lib/command-center/proactive";
import { ArtifactEditor } from "./ArtifactEditor";
import { ConfidenceTag, Panel, TrustLabel } from "./ui";

/** V2.4 §19-20, §22 — the data one Command Bar query actually answers against: either the
 *  current global scope (the default) or a one-time explicit-project override built by
 *  buildProjectOverrideView. Kept as one bundle so classifyQuery/answerFromRoute/artifact
 *  builders never have to know which case they're in. */
interface CommandView {
  filteredData: CommandCenterData;
  derived: DerivedData;
  proactive: ProactiveIntelligence | null;
  personalFocus: PersonalFocusResult | null;
  personalReview: PersonalDeliveryReviewFacts | undefined;
  workRelevanceIndex: WorkRelevanceIndex;
}

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
  const { state, today, filteredData, derived, proactive, personalFocus, workRelevanceIndex } = useCommandCenter();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QueryAnswer | null>(null);
  const [lastQuery, setLastQuery] = useState("");
  const [intent, setIntent] = useState<QueryIntent | null>(null);
  const [artifactDraft, setArtifactDraft] = useState<ArtifactDraft | null>(null);
  const [artifactNote, setArtifactNote] = useState<string | null>(null);
  // V2.4 §20 — set only while the LAST run() answered under a temporary explicit-project
  // override; never written to the store, so the global scope is unaffected either way.
  const [overrideProject, setOverrideProject] = useState<JiraProjectSummary | null>(null);

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
    setOverrideProject(null);
    commandCenterStore.bumpUsage(USAGE_KEYS.COMMAND_BAR_USED);

    // V2.4 §19-21 — an explicit project mention always wins, checked against every Jira
    // project this browser knows about (not just the currently-focused ones), so a query
    // naming a project OUTSIDE the current scope is answered directly instead of rejected.
    // Two/more known projects matching the same query is reported as ambiguous, never
    // guessed (§21). This is a per-query override only — it never calls
    // store.setJiraProjectScope, so the global scope is unchanged once run() returns (§20).
    const mention = detectExplicitProjectMention(q, knownJiraProjects(state.data));
    if (mention && "ambiguous" in mention) {
      setResult({
        answer: `I found multiple projects matching "${q}": ${mention.ambiguous.map((p) => `${p.name} (${p.key})`).join(", ")}. Please name one specifically — e.g. by its Jira key.`,
        evidence: [],
        recommendedAction: "Name a single project.",
        confidence: 1,
      });
      setLoading(false);
      return;
    }

    let view: CommandView = { filteredData, derived, proactive, personalFocus, personalReview, workRelevanceIndex };
    if (mention) {
      const override = buildProjectOverrideView(state, today, mention.match.key);
      view = {
        ...override,
        personalReview:
          override.proactive && override.personalFocus
            ? buildPersonalDeliveryReviewFacts(state.personalPlan, override.personalFocus.candidates, override.proactive.actionEffectiveness, override.filteredData, 7, today)
            : undefined,
      };
      setOverrideProject(mention.match);
    }

    const route = classifyQuery(q, view.filteredData);
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
      await runArtifactIntent(route.intent, route.target, view, mention ? mention.match : undefined);
      setLoading(false);
      return;
    }

    const { facts, evidence, recommendedAction } = answerFromRoute(
      route,
      view.filteredData,
      view.derived,
      today,
      state.isDemo ? "demo" : "manual",
      view.proactive ?? undefined,
      view.personalFocus ?? undefined,
      view.personalReview,
      view.workRelevanceIndex
    );
    const answer = await getAIProvider().answerQuery(q, facts, evidence, recommendedAction);
    setResult(answer);
    setLoading(false);
  }

  // V2.2 §10 — a distinct, non-narrated outcome: builds the artifact directly from
  // communicate.ts (no answerQuery/AI narration) and opens the Artifact Editor.
  // V2.4 §22 — `view` is either the global scope or a one-time project override (see run()
  // above); every attention/decision item this pulls from `view.proactive` is therefore
  // already the named project's own evidence, not whichever project happened to sort first
  // globally.
  async function runArtifactIntent(artifactIntent: QueryIntent, target: string | undefined, view: CommandView, overrideProjectForLabel: JiraProjectSummary | undefined) {
    const { filteredData: viewData, derived: viewDerived, proactive, personalFocus: viewPersonalFocus } = view;
    if (!proactive) {
      setArtifactNote("Proactive intelligence is not available yet.");
      return;
    }
    const sourceContext = overrideProjectForLabel ? `Command Bar: ${overrideProjectForLabel.name}` : target ? `Command Bar: draft update for ${target}` : "Command Bar";
    if (artifactIntent === "create-status-update") {
      setArtifactDraft(buildStatusUpdateDraft(viewData, viewDerived, proactive, viewPersonalFocus ?? null, today, sourceContext));
      return;
    }
    if (artifactIntent === "summarize-today") {
      setArtifactDraft(buildTodaysUpdateDraft(viewData, proactive, viewPersonalFocus ?? null, today));
      return;
    }
    if (artifactIntent === "create-stakeholder-update") {
      const item = proactive.attentionQueue[0];
      if (!item) {
        setArtifactNote("Nothing currently needs attention to draft a stakeholder update from.");
        return;
      }
      setArtifactDraft(buildStakeholderUpdateDraft({ kind: "attention", item }, sourceContext));
      return;
    }
    if (artifactIntent === "create-release-update") {
      const version = target ?? viewData.workItems.find((w) => w.fixVersion)?.fixVersion;
      if (!version) {
        setArtifactNote("No release/fix version found in the current data.");
        return;
      }
      setArtifactDraft(buildReleaseUpdateDraft(computeReleaseHealth(viewData, version, today), viewData, sourceContext));
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
      setArtifactDraft(buildDecisionBriefDraft(attentionItem, options, sourceContext));
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

      {overrideProject && (result || artifactDraft || artifactNote) && (
        <p className="mt-3 text-xs text-accent2">
          Showing: {overrideProject.name} ({overrideProject.key}) only — one-time override for this query. Your current focus scope is unchanged.
        </p>
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
