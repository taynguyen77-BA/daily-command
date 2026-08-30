"use client";

// V2.2 §12 — Meeting Mode. Not another dashboard: six deterministic questions, each
// answer sourced from an existing engine (see buildMeetingModeBrief in communicate.ts),
// with evidence inline and a compact "Copy meeting summary" action. No autonomous
// communication — nothing here is ever sent anywhere on its own.

import { useState } from "react";
import { buildMeetingModeBrief, buildStakeholderUpdateDraft, renderMeetingModeText } from "@/lib/command-center/communicate";
import { commandCenterStore } from "@/lib/command-center/store";
import { formatScopeLabel, knownJiraProjects } from "@/lib/command-center/jira/project-scope";
import { USAGE_KEYS } from "@/lib/command-center/usage";
import { useCommandCenter, buildProjectOverrideView } from "./use-command-center";
import { ArtifactEditor } from "./ArtifactEditor";
import { EmptyState, Panel, SectionHeading } from "./ui";

export function MeetingModePanel() {
  const { state, today, derived, proactive, filteredData, store } = useCommandCenter();
  const [copied, setCopied] = useState(false);
  const [editingArtifact, setEditingArtifact] = useState(false);
  // V2.4 §23 — a session-only project scope for THIS meeting, distinct from (and never
  // writing to) the global Focus Project Scope in Data & Settings. "" means "use the
  // current global scope", matching every other surface.
  const [sessionProjectKey, setSessionProjectKey] = useState("");

  if (!state.loaded) {
    return <EmptyState title="No data yet" description="Load the demo dataset to see Meeting Mode in action." onLoadDemo={() => store.loadDemoData()} />;
  }

  const knownProjects = knownJiraProjects(state.data);
  const override = sessionProjectKey ? buildProjectOverrideView(state, today, sessionProjectKey) : null;
  const meetingProactive = override ? override.proactive : proactive;
  const meetingFilteredData = override ? override.filteredData : filteredData;
  const meetingDerived = override ? override.derived : derived;
  const scopeLabel = sessionProjectKey
    ? `${knownProjects.find((p) => p.key === sessionProjectKey)?.name ?? sessionProjectKey} (this meeting only)`
    : formatScopeLabel(state.jiraProjectScope, state.data);

  if (!meetingProactive) {
    return <Panel className="p-6 text-sm text-text3">Proactive intelligence is not available yet.</Panel>;
  }

  const brief = buildMeetingModeBrief(meetingFilteredData, meetingDerived, meetingProactive, today);

  async function copySummary() {
    await navigator.clipboard.writeText(renderMeetingModeText(brief));
    setCopied(true);
  }

  const stakeholderDraft = meetingProactive.attentionQueue[0]
    ? buildStakeholderUpdateDraft({ kind: "attention", item: meetingProactive.attentionQueue[0] }, "Meeting Mode")
    : null;

  return (
    <div className="space-y-4 pb-16">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionHeading title="Meeting Mode" subtitle="Before a stand-up or status meeting — six questions, each backed by evidence you can inspect." />
        <label className="flex items-center gap-1.5 text-xs text-text3">
          Meeting scope
          <select
            value={sessionProjectKey}
            onChange={(e) => setSessionProjectKey(e.target.value)}
            aria-label="Meeting scope"
            className="rounded border border-border bg-surface2 px-2 py-1 text-xs text-text2"
          >
            <option value="">Current focus ({formatScopeLabel(state.jiraProjectScope, state.data)})</option>
            {knownProjects.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name} ({p.key})
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-xs text-text3">Scope: {scopeLabel}</p>
      <div className="space-y-3">
        {brief.questions.map((q, i) => (
          <Panel key={q.question} className="p-4">
            <p className="font-display text-sm text-text">
              {i + 1}. {q.question}
            </p>
            <ul className="mt-2 space-y-0.5 text-sm text-text2">
              {q.items.map((item, j) => (
                <li key={j}>- {item}</li>
              ))}
            </ul>
          </Panel>
        ))}
        <Panel className="p-4">
          <p className="font-display text-sm text-text">6. What should I say?</p>
          <p className="mt-2 text-sm text-text2">{brief.whatShouldISay}</p>
        </Panel>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        <button onClick={copySummary} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent2">
          {copied ? "Copied ✓" : "Copy meeting summary"}
        </button>
        {stakeholderDraft && (
          <button
            onClick={() => setEditingArtifact(true)}
            className="rounded-md border border-border px-4 py-2 text-sm font-medium text-text2 hover:border-accent hover:text-text"
          >
            Create stakeholder update
          </button>
        )}
      </div>

      {editingArtifact && stakeholderDraft && (
        <ArtifactEditor draft={stakeholderDraft} onClose={() => setEditingArtifact(false)} />
      )}
    </div>
  );
}

export function trackMeetingModeOpened() {
  commandCenterStore.bumpUsage(USAGE_KEYS.MEETING_MODE_OPENED);
}
