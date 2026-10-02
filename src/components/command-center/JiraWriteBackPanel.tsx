"use client";

// F4 — Data & Settings: Jira write-back settings and the history of every write. The feature
// itself is switched on in Features (off by default); this panel holds the per-project
// allow-list, the optional Flag, and which transition Done offers per project.

import { useState } from "react";
import { Panel, SectionHeading } from "./ui";
import { useCommandCenter } from "./use-command-center";

export function JiraWriteBackPanel() {
  const { state, store } = useCommandCenter();
  const settings = state.jiraWriteBack;
  const [projectDraft, setProjectDraft] = useState("");
  const [flagDraft, setFlagDraft] = useState(settings.flagFieldId ?? "");
  const on = state.features.jiraWriteBack;

  return (
    <Panel className="p-5" data-jira-write-back-settings>
      <SectionHeading
        title="Jira write-back"
        subtitle={
          on
            ? "On. Only the projects listed here are ever written to, every write is previewed and needs your confirmation, and every attempt is logged below."
            : "Off (Features above). Nothing is ever written to Jira while it is off — these settings are kept for when you turn it on."
        }
      />
      <div className="space-y-3 text-sm text-text2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-text3">Allowed projects</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {settings.projects.length === 0 && <span className="text-xs text-text3">None — no project can be written to.</span>}
            {settings.projects.map((p) => (
              <span key={p} className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 font-mono text-xs">
                {p}
                <button aria-label={`Remove ${p}`} onClick={() => store.setJiraWriteBackSettings({ projects: settings.projects.filter((x) => x !== p) })} className="text-text3 hover:text-red">
                  ×
                </button>
              </span>
            ))}
            <input
              value={projectDraft}
              onChange={(e) => setProjectDraft(e.target.value.toUpperCase())}
              placeholder="Project key, e.g. PAY"
              aria-label="Add allowed project key"
              className="w-40 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs"
            />
            <button
              onClick={() => {
                if (projectDraft.trim()) store.setJiraWriteBackSettings({ projects: [...settings.projects, projectDraft.trim()] });
                setProjectDraft("");
              }}
              className="btn btn-sm btn-secondary"
            >
              Allow
            </button>
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={settings.setFlag} onChange={(e) => store.setJiraWriteBackSettings({ setFlag: e.target.checked })} />
          On Block, also offer to set Jira&apos;s Flag
        </label>
        {settings.setFlag && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span>Flagged field id</span>
            <input value={flagDraft} onChange={(e) => setFlagDraft(e.target.value)} onBlur={() => store.setJiraWriteBackSettings({ flagFieldId: flagDraft.trim() || undefined })} placeholder="customfield_10021" className="w-44 rounded-md border border-border bg-surface px-2 py-1 font-mono" />
            {!settings.flagFieldId && <span className="text-orange">Needed to set the Flag (it differs per Jira instance).</span>}
          </div>
        )}

        {settings.projects.length > 0 && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-text3">Transition offered on Done</p>
            <ul className="mt-1 space-y-1 text-xs">
              {settings.projects.map((p) => (
                <li key={p} className="flex flex-wrap items-center gap-2">
                  <span className="w-16 font-mono">{p}</span>
                  <input
                    defaultValue={settings.doneTransitions[p] ?? ""}
                    onBlur={(e) => store.setJiraWriteBackSettings({ doneTransitions: { ...settings.doneTransitions, [p]: e.target.value } })}
                    placeholder="e.g. Done — or pick one in the confirmation"
                    className="w-64 rounded-md border border-border bg-surface px-2 py-1"
                  />
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-text3">The confirmation dialog loads the transitions actually available for the ticket; the name here is pre-selected when it matches.</p>
          </div>
        )}

        <details data-jira-write-log>
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-text3">Write history ({state.jiraWriteLog.length})</summary>
          {state.jiraWriteLog.length === 0 ? (
            <p className="mt-1 text-xs text-text3">Nothing has been written to Jira.</p>
          ) : (
            <ul className="mt-1 space-y-0.5 text-xs">
              {[...state.jiraWriteLog].reverse().map((e) => (
                <li key={e.id} className={e.ok ? "text-text2" : "text-red"}>
                  {new Date(e.at).toLocaleString()} · <span className="font-mono">{e.ticketKey}</span> · {e.kind} ({e.trigger}): {e.detail}
                  {e.ok ? " ✓" : ` — failed: ${e.error ?? "unknown error"}`}
                </li>
              ))}
            </ul>
          )}
        </details>
      </div>
    </Panel>
  );
}
