"use client";

// V2.2 — Artifact Editor. One dialog shell (same shell discipline as DecisionAssistant.tsx:
// fixed overlay, role="dialog", Escape-to-close, focus-on-open) reused for every artifact
// type. Preview/edit/regenerate/copy/save/discard — no rich-text dependency, a plain
// <textarea> is the editable body (§7). AI_DRAFT wording is generated strictly on-demand
// through the entity cache and is never merged into the CALCULATED/EVIDENCE sections
// automatically — the user explicitly inserts it (§5 "never merge these silently").

import { useEffect, useRef, useState } from "react";
import { getAIProvider } from "@/lib/command-center/ai";
import { withAICache } from "@/lib/command-center/ai/ai-cache";
import { evaluateAiResponse } from "@/lib/command-center/ai/evaluation";
import { renderArtifactText, summarizeArtifactTrust } from "@/lib/command-center/communicate";
import { commandCenterStore } from "@/lib/command-center/store";
import { artifactUsageKey } from "@/lib/command-center/usage";
import type { AiEvaluationResult, ArtifactDraft, ArtifactSegmentKind } from "@/lib/command-center/types";
import { AiProviderIndicator, ConfidenceTag, Panel, TrustLabel } from "./ui";

const SEGMENT_KIND_TO_TRUST_LABEL: Record<ArtifactSegmentKind, "calculated" | "evidence" | "ai-draft" | "user-input" | "unknown"> = {
  CALCULATED: "calculated",
  EVIDENCE: "evidence",
  AI_DRAFT: "ai-draft",
  USER_INPUT: "user-input",
  UNKNOWN: "unknown",
};

interface StalenessInfo {
  status: "fresh" | "stale" | "unavailable";
  onRefresh?: () => void;
}

interface AiDraftState {
  text: string;
  confidence: number;
  insufficientEvidence?: boolean;
  mode: "mock" | "claude";
  cacheState: "cached" | "refreshed";
  evaluation: AiEvaluationResult;
}

export function ArtifactEditor({
  draft,
  recordId,
  initialAiDraft,
  initialEditedText,
  staleness,
  onClose,
}: {
  draft: ArtifactDraft;
  recordId?: string; // present when editing an already-saved artifact (updates in place)
  initialAiDraft?: string;
  initialEditedText?: string;
  staleness?: StalenessInfo;
  onClose: () => void;
}) {
  const [editedText, setEditedText] = useState(initialEditedText ?? renderArtifactText(draft.sections, initialAiDraft));
  const [aiDraft, setAiDraft] = useState<AiDraftState | null>(
    initialAiDraft ? { text: initialAiDraft, confidence: 0.5, mode: "mock", cacheState: "cached", evaluation: evaluateAiResponse({ task: draft.type, response: { text: initialAiDraft }, schemaValid: true, narrativeText: initialAiDraft, inputFacts: [], inputEvidence: [], confidence: 0.5 }) } : null
  );
  const [aiLoading, setAiLoading] = useState(false);
  const [openEvidenceFor, setOpenEvidenceFor] = useState<string | null>(null);
  const [showAiQuality, setShowAiQuality] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trustSummary = summarizeArtifactTrust(draft.sections);
  const entityId = `${draft.type}:${draft.sourceContext}`;

  async function generateAiDraft() {
    if (aiLoading) return;
    setAiLoading(true);
    try {
      const facts = draft.sections.flatMap((s) => s.segments.map((sg) => sg.text));
      const evidenceStrings = draft.evidence.map((e) => e.content);
      const { value, cacheState } = await withAICache("generateCommunicationArtifact", entityId, facts, draft.evidence, () =>
        getAIProvider().generateCommunicationArtifact(draft.type, facts, evidenceStrings)
      );
      const evaluation = evaluateAiResponse({
        task: "generateCommunicationArtifact",
        response: value,
        schemaValid: true,
        narrativeText: value.text,
        inputFacts: facts,
        inputEvidence: evidenceStrings,
        confidence: value.confidence,
        insufficientEvidenceFlag: value.insufficientEvidence,
      });
      setAiDraft({ text: value.text, confidence: value.confidence, insufficientEvidence: value.insufficientEvidence, mode: getAIProvider().mode, cacheState, evaluation });
    } finally {
      setAiLoading(false);
    }
  }

  function regenerate() {
    commandCenterStore.bumpUsage("surface:artifact-regenerated");
    generateAiDraft();
  }

  function insertAiDraft() {
    if (!aiDraft) return;
    setEditedText((prev) => `${prev}\n\nSUGGESTED WORDING (AI DRAFT)\n${aiDraft.text}`);
  }

  async function copy() {
    await navigator.clipboard.writeText(editedText);
    commandCenterStore.bumpUsage("surface:artifact-copied");
    setCopied(true);
  }

  function save() {
    if (recordId) {
      commandCenterStore.updateArtifact(recordId, { editedText, aiDraftText: aiDraft?.text, aiDraftMode: aiDraft?.mode });
    } else {
      commandCenterStore.saveArtifact(draft, { editedText, aiDraftText: aiDraft?.text, aiDraftMode: aiDraft?.mode });
      commandCenterStore.bumpUsage(artifactUsageKey(draft.type));
    }
    setSaved(true);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="artifact-editor-title"
        tabIndex={-1}
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-surface p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center gap-2">
          <TrustLabel kind="calculated" />
          <span className="text-xs uppercase tracking-wide text-text3">{draft.type.replace(/_/g, " ")}</span>
        </div>
        <h2 id="artifact-editor-title" className="font-display text-lg text-text">
          {draft.sourceContext}
        </h2>

        {staleness?.status === "stale" && (
          <div className="mt-3 rounded-md border border-yellow/30 bg-yellow/10 p-3 text-xs text-yellow">
            <p className="font-medium">SOURCE DATA CHANGED</p>
            <p className="mt-1">This draft was created from an earlier evidence version.</p>
            {staleness.onRefresh && (
              <button onClick={staleness.onRefresh} className="mt-2 rounded border border-yellow/40 px-2 py-1 font-medium hover:bg-yellow/10">
                Refresh Draft
              </button>
            )}
          </div>
        )}
        {staleness?.status === "unavailable" && (
          <p className="mt-2 text-xs text-text3">Staleness check unavailable for this artifact type — evidence reflects the time of creation.</p>
        )}

        <div className="mt-4 space-y-3">
          {draft.sections.map((s) => {
            const evidenceIds = new Set(s.segments.flatMap((sg) => sg.evidenceIds ?? []));
            const sectionEvidence = draft.evidence.filter((e) => evidenceIds.has(e.id));
            return (
              <Panel key={s.heading} className="p-3">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text3">{s.heading}</p>
                <div className="space-y-1">
                  {s.segments.map((sg, i) => (
                    <p key={i} className="flex items-start gap-2 text-sm text-text2">
                      <TrustLabel kind={SEGMENT_KIND_TO_TRUST_LABEL[sg.kind]} />
                      <span>{sg.text}</span>
                    </p>
                  ))}
                </div>
                {sectionEvidence.length > 0 && (
                  <div className="mt-2">
                    <button
                      onClick={() => setOpenEvidenceFor(openEvidenceFor === s.heading ? null : s.heading)}
                      aria-expanded={openEvidenceFor === s.heading}
                      className="text-xs font-medium text-accent2 hover:underline"
                    >
                      {openEvidenceFor === s.heading ? "Hide" : "Why is this statement here?"}
                    </button>
                    {openEvidenceFor === s.heading && (
                      <ul className="mt-1 space-y-0.5 rounded-md border border-border bg-surface2 p-2 text-xs text-text2">
                        {sectionEvidence.map((e) => (
                          <li key={e.id}>- {e.content}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </Panel>
            );
          })}
        </div>

        <div className="mt-4 border-t border-border pt-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-text3">AI-drafted wording</p>
            <button onClick={aiDraft ? regenerate : generateAiDraft} disabled={aiLoading} className="rounded-md border border-border px-2 py-1 text-xs font-medium text-text2 hover:border-accent hover:text-text disabled:opacity-50">
              {aiLoading ? "Drafting…" : aiDraft ? "Regenerate" : "Generate AI wording"}
            </button>
          </div>
          {aiDraft && (
            <div className="rounded-md border border-border bg-surface2 p-3 text-xs">
              <p className="mb-1 flex items-center gap-1 font-semibold uppercase tracking-wide text-text3">
                <TrustLabel kind="ai-draft" />
                <AiProviderIndicator state={aiDraft.cacheState === "cached" ? "CACHED" : aiDraft.mode === "mock" ? "MOCK_FALLBACK" : "REAL_CLAUDE"} />
              </p>
              {aiDraft.insufficientEvidence && <p className="mb-1 text-yellow">Insufficient evidence — best-effort only.</p>}
              <p className="text-text2">{aiDraft.text}</p>
              <div className="mt-1 flex items-center justify-between">
                <ConfidenceTag confidence={aiDraft.confidence} />
                <button onClick={insertAiDraft} className="text-xs font-medium text-accent2 hover:underline">
                  Insert into draft text
                </button>
              </div>
              <button onClick={() => setShowAiQuality((s) => !s)} aria-expanded={showAiQuality} className="mt-2 text-xs font-medium text-text3 hover:underline">
                {showAiQuality ? "Hide" : "AI Draft Quality (dev)"}
              </button>
              {showAiQuality && (
                <ul className="mt-1 space-y-0.5 rounded border border-border bg-surface p-2 text-text3">
                  {aiDraft.evaluation.findings.map((f, i) => (
                    <li key={i}>
                      <span className={f.severity === "FAIL" ? "text-red" : f.severity === "WARN" ? "text-yellow" : "text-green"}>{f.severity}</span> {f.dimension} — {f.detail}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="mt-4 border-t border-border pt-4">
          <label htmlFor="artifact-editor-text" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-text3">
            Editable draft
          </label>
          <textarea
            id="artifact-editor-text"
            value={editedText}
            onChange={(e) => setEditedText(e.target.value)}
            className="h-48 w-full resize-none rounded-md border border-border bg-surface2 p-2 text-sm text-text2"
          />
        </div>

        <div className="mt-3 rounded-md border border-border bg-surface2 p-2 text-xs text-text3">
          Contains: {trustSummary.calculatedCount > 0 && "✓ Calculated delivery metrics "}
          {trustSummary.evidenceCount > 0 && "✓ Evidence "}
          {(aiDraft || trustSummary.aiDraftCount > 0) && "✓ AI-generated wording "}
          {(trustSummary.unknownCount > 0) && <span className="text-yellow">⚠ {trustSummary.unknownCount} unknown(s)</span>}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button onClick={copy} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent2">
            {copied ? "Copied ✓" : "Copy"}
          </button>
          <button onClick={save} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-text2 hover:border-accent hover:text-text">
            {saved ? "Saved ✓" : "Save to History"}
          </button>
          <button onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm text-text2 hover:text-text">
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}
