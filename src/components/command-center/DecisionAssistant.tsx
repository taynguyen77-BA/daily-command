"use client";

// "What Should I Do?" (V1.5 §51, §8-11) — the signature V1.5 interaction. From any
// important Attention item: CONTEXT -> AI-generated OPTIONS -> DECISION MATRIX -> a
// clearly-labeled AI RECOMMENDATION -> the human selects one -> a confirmation screen ->
// only on [CONFIRM DECISION] is anything persisted. Claude never selects an option itself.

import { useEffect, useMemo, useRef, useState } from "react";
import { getAIProvider } from "@/lib/command-center/ai";
import { commandCenterStore } from "@/lib/command-center/store";
import { useCommandCenter } from "./use-command-center";
import type { AttentionItem, CommandCenterData, DecisionOption, DecisionOptionsResult } from "@/lib/command-center/types";
import { ConfidenceTag, Panel, TrustLabel } from "./ui";

interface ResolvedEntity {
  projectId: string;
  clientId?: string;
  relatedWorkItemIds: string[];
  relatedRiskIds: string[];
  relatedDependencyIds: string[];
  existingDecisionId?: string;
}

function resolveEntity(item: AttentionItem, data: CommandCenterData): ResolvedEntity {
  const fallback: ResolvedEntity = { projectId: data.projects[0]?.id ?? "", clientId: data.clients[0]?.id, relatedWorkItemIds: [], relatedRiskIds: [], relatedDependencyIds: [] };
  const ref = item.sourceRef;
  if (!ref) return fallback;

  if (ref.type === "decision") {
    const decision = data.decisions.find((d) => d.id === ref.id);
    if (!decision) return fallback;
    return { projectId: decision.projectId, clientId: decision.clientId, relatedWorkItemIds: decision.relatedWorkItemIds ?? [], relatedRiskIds: [], relatedDependencyIds: [], existingDecisionId: decision.id };
  }
  if (ref.type === "risk") {
    const risk = data.risks.find((r) => r.title === ref.id);
    const related = risk ? data.workItems.filter((w) => risk.sourceWorkItemIds.includes(w.id)) : [];
    const first = related[0];
    return { projectId: first?.projectId ?? fallback.projectId, clientId: first?.clientId, relatedWorkItemIds: related.map((w) => w.id), relatedRiskIds: risk ? [risk.id] : [], relatedDependencyIds: [] };
  }
  if (ref.type === "dependency") {
    const dep = data.dependencies.find((d) => d.id === ref.id);
    const workItem = dep ? data.workItems.find((w) => w.id === dep.workItemId) : undefined;
    return { projectId: workItem?.projectId ?? fallback.projectId, clientId: workItem?.clientId, relatedWorkItemIds: workItem ? [workItem.id] : [], relatedRiskIds: [], relatedDependencyIds: dep ? [dep.id] : [] };
  }
  if (ref.type === "action") {
    const action = data.actions.find((a) => a.id === ref.id);
    const workItem = action?.relatedWorkItemId ? data.workItems.find((w) => w.id === action.relatedWorkItemId) : undefined;
    return { projectId: workItem?.projectId ?? fallback.projectId, clientId: workItem?.clientId, relatedWorkItemIds: workItem ? [workItem.id] : [], relatedRiskIds: [], relatedDependencyIds: [] };
  }
  if (ref.type === "release") {
    const items = data.workItems.filter((w) => w.fixVersion === ref.id);
    const first = items[0];
    return { projectId: first?.projectId ?? fallback.projectId, clientId: first?.clientId, relatedWorkItemIds: items.map((w) => w.id), relatedRiskIds: [], relatedDependencyIds: [] };
  }
  return fallback;
}

export function DecisionAssistant({ item, onClose }: { item: AttentionItem; onClose: () => void }) {
  const { filteredData } = useCommandCenter();
  const [step, setStep] = useState<"loading" | "options" | "confirm" | "done">("loading");
  const [result, setResult] = useState<DecisionOptionsResult | null>(null);
  const [selected, setSelected] = useState<DecisionOption | null>(null);
  const [expectedOutcome, setExpectedOutcome] = useState("");
  const [showEvidence, setShowEvidence] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const entity = useMemo(() => resolveEntity(item, filteredData), [item, filteredData]);

  useEffect(() => {
    dialogRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    getAIProvider()
      .generateDecisionOptions(item.what, [item.why, item.impact], item.evidence)
      .then((r) => {
        if (cancelled) return;
        setResult(r);
        setStep("options");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  function selectOption(opt: DecisionOption) {
    setSelected(opt);
    setExpectedOutcome(opt.upside);
    setStep("confirm");
  }

  function confirm() {
    if (!result || !selected) return;
    commandCenterStore.confirmDecisionFromOptions({
      existingDecisionId: entity.existingDecisionId,
      projectId: entity.projectId,
      clientId: entity.clientId,
      title: item.what,
      context: item.why,
      options: result.options,
      selectedOptionId: selected.id,
      expectedOutcome,
      relatedWorkItemIds: entity.relatedWorkItemIds,
      relatedRiskIds: entity.relatedRiskIds,
      relatedDependencyIds: entity.relatedDependencyIds,
    });
    setStep("done");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="decision-assistant-title"
        tabIndex={-1}
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-surface p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center gap-2">
          <TrustLabel kind="ai-recommendation" />
          <span className="text-xs uppercase tracking-wide text-text3">What should I do?</span>
        </div>
        <h2 id="decision-assistant-title" className="font-display text-lg text-text">{item.what}</h2>
        <p className="mt-1 text-sm text-text2">
          <span className="text-text3">Context: </span>
          {item.why}
        </p>

        {step === "loading" && <p className="mt-6 text-sm text-text3">Generating options…</p>}

        {step === "options" && result && (
          <div className="mt-4 space-y-4">
            {result.insufficientEvidence && (
              <p className="rounded border border-yellow/30 bg-yellow/10 px-2 py-1 text-xs text-yellow">Insufficient evidence — these options are a best-effort read, not a confident recommendation.</p>
            )}
            <p className="text-sm text-text2">{result.summary}</p>

            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text3">Options</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {result.options.map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => selectOption(opt)}
                    className={`rounded-lg border p-3 text-left hover:border-accent ${opt.id === result.recommendedOptionId ? "border-accent/50 bg-accent/5" : "border-border bg-surface2"}`}
                  >
                    <div className="mb-1 flex items-center gap-2">
                      <span className="font-display text-sm text-text">
                        {opt.id}. {opt.label}
                      </span>
                      {opt.id === result.recommendedOptionId && <TrustLabel kind="ai-recommendation" />}
                    </div>
                    <p className="text-xs text-text2">{opt.rationale}</p>
                    <p className="mt-1 text-xs text-green">+ {opt.upside}</p>
                    <p className="text-xs text-red">- {opt.downside}</p>
                    <div className="mt-2">
                      <ConfidenceTag confidence={opt.confidence} />
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text3">Decision matrix</p>
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full min-w-[500px] text-xs">
                  <thead>
                    <tr className="border-b border-border bg-surface2 text-left text-text3">
                      <th scope="col" className="px-3 py-2">Option</th>
                      <th scope="col" className="px-3 py-2">Delivery impact</th>
                      <th scope="col" className="px-3 py-2">Risk</th>
                      <th scope="col" className="px-3 py-2">Dependency impact</th>
                      <th scope="col" className="px-3 py-2">Trade-off</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.options.map((opt) => (
                      <tr key={opt.id} className="border-b border-border last:border-0">
                        <td className="px-3 py-2 font-medium text-text">{opt.label}</td>
                        <td className="px-3 py-2 text-text2">{opt.upside}</td>
                        <td className="px-3 py-2 text-text2">{opt.risks.join(", ") || "—"}</td>
                        <td className="px-3 py-2 text-text2">{opt.dependencies.join(", ") || "—"}</td>
                        <td className="px-3 py-2 text-text2">{opt.downside}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="text-xs text-text3">
              <span className="font-medium">Key trade-off: </span>
              {result.tradeoffs}
            </p>

            <button onClick={() => setShowEvidence((s) => !s)} aria-expanded={showEvidence} className="text-xs font-medium text-accent2 hover:underline">
              {showEvidence ? "Hide evidence" : "Show evidence"}
            </button>
            {showEvidence && (
              <ul className="space-y-0.5 rounded-md border border-border bg-surface2 p-2 text-xs text-text2">
                {item.evidence.map((e, i) => (
                  <li key={i}>- {e}</li>
                ))}
              </ul>
            )}
            <div>
              <ConfidenceTag confidence={result.confidence} />
            </div>
          </div>
        )}

        {step === "confirm" && selected && (
          <div className="mt-4 space-y-3">
            <Panel className="p-4">
              <p className="text-xs text-text3">Decision</p>
              <p className="text-sm text-text">{item.what}</p>
              <p className="mt-3 text-xs text-text3">Selected option</p>
              <p className="text-sm text-text">
                {selected.id}. {selected.label}
              </p>
              <p className="mt-3 text-xs text-text3">Expected outcome</p>
              <textarea
                value={expectedOutcome}
                onChange={(e) => setExpectedOutcome(e.target.value)}
                className="mt-1 h-20 w-full resize-none rounded-md border border-border bg-surface2 p-2 text-sm text-text2"
              />
              {entity.relatedRiskIds.length > 0 && <p className="mt-3 text-xs text-text3">Related risks: {entity.relatedRiskIds.length}</p>}
              {entity.relatedDependencyIds.length > 0 && <p className="text-xs text-text3">Related dependencies: {entity.relatedDependencyIds.length}</p>}
              {entity.relatedWorkItemIds.length > 0 && <p className="text-xs text-text3">Related work items: {entity.relatedWorkItemIds.length}</p>}
            </Panel>
            <div className="flex gap-2">
              <button onClick={confirm} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent2">
                Confirm decision
              </button>
              <button onClick={() => setStep("options")} className="rounded-md border border-border px-4 py-2 text-sm text-text2 hover:text-text">
                Go back
              </button>
            </div>
          </div>
        )}

        {step === "done" && <p className="mt-6 text-sm text-green">Decision confirmed and saved to the Decision Log.</p>}

        <button onClick={onClose} className="mt-6 w-full rounded-md border border-border px-4 py-2 text-sm text-text2 hover:text-text">
          Close
        </button>
      </div>
    </div>
  );
}
