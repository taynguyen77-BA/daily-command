"use client";

// V2.36 H — the first task-level AI feature: "Check requirements" on one Jira ticket.
//   1. Feature off → renders nothing.
//   2. Project not in the AI allow-list → "AI disabled for this project"; nothing is fetched
//      for the model and nothing is sent.
//   3. Load the ticket's content (cached per issue) → build the redacted input
//      (data-protection.ts) → on the first use per project, show "What will be sent" and wait
//      for the user to confirm.
//   4. The answer is display-only: aliases restored, clearly labeled, never wired to a Jira
//      write or any other action. If AI is unavailable, over budget, or the answer isn't
//      grounded, the deterministic checklist is shown instead — never an error.

import { useState, useSyncExternalStore } from "react";
import { commandCenterStore } from "@/lib/command-center/store";
import { getAIProvider } from "@/lib/command-center/ai";
import { AI_DISABLED_FOR_PROJECT, describeTicketPayload, isProjectAiAllowed, projectKeyOf, runRequirementCheckFlow } from "@/lib/command-center/ai/data-protection";
import { loadIssueContext } from "@/lib/command-center/ai/ticket-ai-client";
import { getRecentAiTrace } from "@/lib/command-center/ai/trace";
import type { RequirementCheckResult } from "@/lib/command-center/ai/provider";
import type { TicketContextInput } from "@/lib/command-center/ai/task-registry";
import type { RedactionSession } from "@/lib/command-center/ai/redaction";
import type { WorkItem } from "@/lib/command-center/types";
import { workItemUpdatedStamp } from "@/lib/command-center/jira/updated-time";
import { AiProviderIndicator, TrustLabel } from "./ui";

type Phase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "preview"; input: TicketContextInput; session: RedactionSession; redactions: number }
  | { kind: "running" }
  | { kind: "done"; result: RequirementCheckResult; mode: "mock" | "claude"; providerState?: string }
  | { kind: "error"; message: string };

function ResultList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-text3">{title}</p>
      <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
        {items.map((g, i) => (
          <li key={i}>{g}</li>
        ))}
      </ul>
    </div>
  );
}

export function TicketAiPanel({ item }: { item: WorkItem }) {
  const state = useSyncExternalStore(commandCenterStore.subscribe, commandCenterStore.getSnapshot, commandCenterStore.getServerSnapshot);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  if (!state.features.ticketAi || item.sourceType !== "jira") return null;
  const projectKey = projectKeyOf(item.key);
  const settings = state.aiDataProtection;

  if (!isProjectAiAllowed(settings, projectKey)) {
    return (
      <p data-ticket-ai-disabled className="mt-2 text-xs text-text3">
        {AI_DISABLED_FOR_PROJECT} ({projectKey}) — allow it in Data &amp; Settings → AI data protection.
      </p>
    );
  }

  const finish = (result: RequirementCheckResult, mode: "mock" | "claude") => {
    const last = getRecentAiTrace().find((t) => t.task === "checkRequirements");
    setPhase({ kind: "done", result, mode, providerState: last?.providerState });
  };

  const send = async (input: TicketContextInput, session: RedactionSession) => {
    setPhase({ kind: "running" });
    const provider = getAIProvider();
    // Aliases → real terms again, for display only.
    finish(session.restoreDeep(await provider.checkRequirements(input)), provider.mode);
  };

  const start = async (force = false) => {
    setPhase({ kind: "loading" });
    const loaded = await loadIssueContext(commandCenterStore, item.key, { workItemUpdated: workItemUpdatedStamp(item), force });
    if (!loaded.ok) {
      setPhase({ kind: "error", message: loaded.error });
      return;
    }
    setPhase({ kind: "running" });
    const provider = getAIProvider();
    const flow = await runRequirementCheckFlow(loaded.context, commandCenterStore.getSnapshot().aiDataProtection, provider);
    if (flow.kind === "disabled") setPhase({ kind: "error", message: flow.reason });
    else if (flow.kind === "needs-preview") setPhase({ kind: "preview", input: flow.input, session: flow.session, redactions: flow.redactions });
    else finish(flow.result, provider.mode);
  };

  return (
    <div data-ticket-ai className="mt-2 rounded-md border border-border bg-surface2 p-3 text-xs text-text2">
      <div className="flex flex-wrap items-center gap-2">
        <TrustLabel kind="ai-assessment" />
        <span className="font-semibold text-text">Requirement check</span>
        {(phase.kind === "idle" || phase.kind === "error" || phase.kind === "done") && (
          <button onClick={() => void start(phase.kind === "done")} className="btn btn-sm btn-secondary">
            {phase.kind === "done" ? "Refresh" : "Check requirements"}
          </button>
        )}
        {phase.kind === "loading" && <span>Loading ticket…</span>}
        {phase.kind === "running" && <span>Checking…</span>}
      </div>

      {phase.kind === "error" && <p className="mt-2 text-orange">{phase.message}</p>}

      {phase.kind === "preview" && (
        <div data-ai-send-preview className="mt-2">
          <p className="text-text">
            First AI use for {projectKey}: this is exactly what will be sent ({phase.redactions} value(s) redacted). Nothing has been sent yet.
          </p>
          <details className="mt-1">
            <summary className="cursor-pointer text-accent2">What will be sent</summary>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-border bg-surface p-2 font-mono text-[11px]">{describeTicketPayload(phase.input)}</pre>
          </details>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => {
                commandCenterStore.acknowledgeAiSendPreview(projectKey);
                void send(phase.input, phase.session);
              }}
              className="btn btn-sm btn-primary"
            >
              Send
            </button>
            <button onClick={() => setPhase({ kind: "idle" })} className="btn btn-sm btn-ghost">
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase.kind === "done" && (
        <div className="mt-2">
          <p className="flex flex-wrap items-center gap-2">
            {phase.mode === "claude" ? "AI draft — review before acting on it." : "Deterministic checklist (AI not used for this answer)."}
            {phase.providerState && <AiProviderIndicator state={phase.providerState as Parameters<typeof AiProviderIndicator>[0]["state"]} />}
          </p>
          <p className="mt-1 text-text">{phase.result.summary}</p>
          <ResultList title="Gaps" items={phase.result.gaps} />
          <ResultList title="Questions to ask" items={phase.result.questions} />
          <ResultList title="Risks" items={phase.result.risks} />
          {phase.result.insufficientEvidence && <p className="mt-2 text-text3">The ticket has too little text for a real review.</p>}
        </div>
      )}
    </div>
  );
}
