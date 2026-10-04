"use client";

// V2.38 J1 — "Requirement check" on a Story/Task row (deep tier, allow-listed projects only).
// Acceptance criteria as checklist items with their source (or "assumption"), questions by
// stakeholder, missing information, risks. Copy as Markdown, download a CSV for Excel, or post
// as a Jira comment through the write-back dialog (preview + confirm + server gate).

import { useState, useSyncExternalStore } from "react";
import { commandCenterStore } from "@/lib/command-center/store";
import { getAIProvider } from "@/lib/command-center/ai";
import { loadIssueContext } from "@/lib/command-center/ai/ticket-ai-client";
import { baCheckToCsv, baCheckToMarkdown, runBaRequirementCheck } from "@/lib/command-center/ai/ba-requirements";
import { projectKeyOf } from "@/lib/command-center/ai/data-protection";
import type { BaRequirementCheckResponse } from "@/lib/command-center/ai/schemas";
import { TrustLabel } from "./ui";

type Phase = { kind: "closed" } | { kind: "loading" } | { kind: "preview"; preview: string } | { kind: "done"; result: BaRequirementCheckResponse; mode: "mock" | "claude" } | { kind: "message"; text: string };

const CATEGORY: Record<BaRequirementCheckResponse["acceptanceCriteria"][number]["category"], string> = { "happy-path": "Happy path", validation: "Validation", error: "Errors", "edge-case": "Edge cases" };

export function BaRequirementCheck({ ticketKey, workItemUpdated }: { ticketKey: string; workItemUpdated?: string }) {
  const state = useSyncExternalStore(commandCenterStore.subscribe, commandCenterStore.getSnapshot, commandCenterStore.getServerSnapshot);
  const [phase, setPhase] = useState<Phase>({ kind: "closed" });
  const [status, setStatus] = useState<string | null>(null);
  if (!state.features.baRequirementCheck) return null;

  const run = async (previewConfirmed = false) => {
    setPhase({ kind: "loading" });
    setStatus(null);
    const loaded = await loadIssueContext(commandCenterStore, ticketKey, { workItemUpdated });
    if (!loaded.ok) return setPhase({ kind: "message", text: loaded.error });
    if (previewConfirmed) commandCenterStore.acknowledgeAiSendPreview(projectKeyOf(ticketKey));
    const r = await runBaRequirementCheck(loaded.context, commandCenterStore.getSnapshot().aiDataProtection, getAIProvider(), { previewConfirmed });
    if (r.kind === "disabled") setPhase({ kind: "message", text: `${r.reason} — allow it in Data & Settings → AI data protection.` });
    else if (r.kind === "needs-preview") setPhase({ kind: "preview", preview: r.preview });
    else setPhase({ kind: "done", result: r.result, mode: r.mode });
  };

  if (phase.kind === "closed") {
    return (
      <button onClick={() => void run()} data-ba-check-open={ticketKey} className="mt-1 ml-3 text-xs text-accent2 hover:underline">
        Requirement check
      </button>
    );
  }

  return (
    <div data-ba-check={ticketKey} className="mt-1 rounded-md border border-border bg-surface2 p-2 text-xs text-text2">
      <div className="flex flex-wrap items-center gap-2">
        <TrustLabel kind="ai-assessment" />
        <span className="font-semibold text-text">Requirement check</span>
        {phase.kind === "done" && <span className="text-text3">{phase.mode === "claude" ? "AI (deep)" : "Deterministic (AI not used)"}</span>}
        <button onClick={() => setPhase({ kind: "closed" })} className="ml-auto text-text3 hover:text-text" aria-label="Close requirement check">
          ✕
        </button>
      </div>
      {phase.kind === "loading" && <p className="mt-1">Checking…</p>}
      {phase.kind === "message" && <p className="mt-1 text-orange">{phase.text}</p>}
      {phase.kind === "preview" && (
        <div className="mt-1">
          <p className="text-text">First AI use for this project — this is exactly what will be sent. Nothing has been sent yet.</p>
          <details className="mt-1">
            <summary className="cursor-pointer text-accent2">What will be sent</summary>
            <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded border border-border bg-surface p-2 font-mono text-[11px]">{phase.preview}</pre>
          </details>
          <button onClick={() => void run(true)} className="btn btn-sm btn-primary mt-1">
            Send
          </button>
        </div>
      )}
      {phase.kind === "done" && (
        <div className="mt-1 space-y-2">
          <div>
            <p className="font-semibold text-text3">Acceptance criteria</p>
            {(Object.keys(CATEGORY) as (keyof typeof CATEGORY)[]).map((cat) => {
              const items = phase.result.acceptanceCriteria.filter((a) => a.category === cat);
              if (!items.length) return null;
              return (
                <div key={cat} className="mt-1">
                  <p className="text-text3">{CATEGORY[cat]}</p>
                  <ul className="space-y-0.5">
                    {items.map((a, i) => (
                      <li key={i} data-ac-source={a.source.kind} className="flex gap-1.5">
                        <span aria-hidden="true">☐</span>
                        <span>
                          {a.text}{" "}
                          {a.source.kind === "assumption" ? (
                            <span className="rounded bg-orange/15 px-1 text-[10px] text-orange">assumption</span>
                          ) : (
                            <span className="text-[10px] text-text3" title={a.source.quote}>
                              ({a.source.kind})
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
          {phase.result.questionsByStakeholder.length > 0 && (
            <div>
              <p className="font-semibold text-text3">Clarification questions</p>
              {phase.result.questionsByStakeholder.map((g) => (
                <div key={g.stakeholder} className="mt-0.5">
                  <p className="text-text">{g.stakeholder}</p>
                  <ul className="list-disc pl-4">
                    {g.questions.map((q, i) => (
                      <li key={i}>{q}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
          {phase.result.missingInformation.length > 0 && (
            <div>
              <p className="font-semibold text-text3">Missing information</p>
              <ul className="list-disc pl-4">{phase.result.missingInformation.map((m, i) => <li key={i}>{m}</li>)}</ul>
            </div>
          )}
          {phase.result.risks.length > 0 && (
            <div>
              <p className="font-semibold text-text3">Risks</p>
              <ul className="list-disc pl-4">{phase.result.risks.map((m, i) => <li key={i}>{m}</li>)}</ul>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(baCheckToMarkdown(ticketKey, phase.result));
                  setStatus("Markdown copied.");
                } catch {
                  setStatus("Couldn't copy.");
                }
              }}
              className="btn btn-sm btn-secondary"
            >
              Copy Markdown
            </button>
            <button
              onClick={() => {
                const blob = new Blob([baCheckToCsv(ticketKey, phase.result)], { type: "text/csv;charset=utf-8" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${ticketKey}-requirement-check.csv`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
              className="btn btn-sm btn-secondary"
            >
              Download CSV
            </button>
            <button
              onClick={() => setStatus(commandCenterStore.proposeJiraComment(ticketKey, baCheckToMarkdown(ticketKey, phase.result)) ? "Review it in the dialog — nothing is posted until you confirm." : "Jira write-back isn't on for this project — copy it instead.")}
              className="btn btn-sm btn-secondary"
            >
              Post as Jira comment…
            </button>
            {status && <span className="text-text3">{status}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
