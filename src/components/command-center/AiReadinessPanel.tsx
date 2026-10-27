"use client";

// P3.7 — Data & Settings: which AI feature is blocked by which gate, and the next step — one matrix — plus two
// presets (Recommended / All off) that only flip feature toggles, show a diff first, and can be undone. The
// project allow-list is never touched by a preset.

import { useState } from "react";
import { AI_FEATURES, AI_PRESETS, aiReadinessMatrix, presetDiff, type AiPreset, type PresetChange } from "@/lib/command-center/ai/readiness";
import { Panel, SectionHeading } from "./ui";
import { useAiReadinessFacts } from "./use-ai-readiness";
import { useCommandCenter } from "./use-command-center";

const STATE_STYLE: Record<string, string> = { READY: "text-green", OFF: "text-text3", NEEDS_KEY: "text-yellow", NEEDS_ALLOWLIST: "text-yellow", SERVER_POLICY_BLOCKED: "text-red", CAP_REACHED: "text-red" };

export function AiReadinessPanel() {
  const { state, store } = useCommandCenter();
  const facts = useAiReadinessFacts();
  const [pending, setPending] = useState<{ preset: AiPreset; changes: PresetChange[] } | null>(null);
  const [applied, setApplied] = useState<PresetChange[] | null>(null);

  const rows = aiReadinessMatrix({
    features: state.features,
    ai: facts?.ai ? { available: facts.ai.available, ...("aiAllowedProjectKeys" in facts.ai ? { aiAllowedProjectKeys: facts.ai.aiAllowedProjectKeys } : {}) } : null,
    usage: facts?.usage ?? null,
    allowedProjectKeys: state.aiDataProtection.allowedProjectKeys,
    projectKeys: state.data.projects.map((p) => p.sourceId ?? "").filter(Boolean),
  });

  const confirm = () => {
    if (!pending) return;
    for (const c of pending.changes) store.setFeatureToggle(c.feature, c.to);
    setApplied(pending.changes);
    setPending(null);
  };
  const undo = () => {
    if (!applied) return;
    for (const c of applied) store.setFeatureToggle(c.feature, c.from);
    setApplied(null);
  };

  return (
    <Panel className="p-5" data-ai-readiness>
      <SectionHeading title="AI readiness" subtitle="Each AI feature needs up to three things: its switch, the server's API key, and an allowed project. This shows which one is missing." />
      <div className="overflow-x-auto">
        <table className="mt-2 w-full text-left text-xs text-text2">
          <thead>
            <tr className="text-text3">
              <th className="py-1 pr-3 font-medium">Feature</th>
              <th className="py-1 pr-3 font-medium">State</th>
              <th className="py-1 pr-3 font-medium">Projects</th>
              <th className="py-1 font-medium">Next step</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.feature} className="border-t border-border align-top" data-ai-readiness-row={r.feature}>
                <td className="py-1.5 pr-3 text-text">{AI_FEATURES.find((f) => f.id === r.feature)!.label}</td>
                <td className={`py-1.5 pr-3 font-mono ${STATE_STYLE[r.state]}`}>{r.state}</td>
                <td className="py-1.5 pr-3 tabular">{r.projects.allowed}/{r.projects.total}</td>
                <td className="py-1.5">{r.nextStep}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 border-t border-border pt-3 text-sm text-text2">
        <p className="text-text">Presets</p>
        <p className="text-xs text-text3">A preset only flips feature switches. It never changes which projects are allowed, and you see exactly what changes before it is applied.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {(Object.keys(AI_PRESETS) as AiPreset[]).map((p) => (
            <button key={p} onClick={() => { setApplied(null); setPending({ preset: p, changes: presetDiff(state.features, p) }); }} className="btn btn-sm btn-secondary" data-ai-preset={p}>
              {AI_PRESETS[p].label}
            </button>
          ))}
          {applied && (
            <button onClick={undo} className="btn btn-sm btn-secondary" data-ai-preset-undo>Undo last preset</button>
          )}
        </div>
        {pending && (
          <div className="mt-3 rounded border border-border bg-surface2 p-3 text-xs" data-ai-preset-diff>
            {pending.changes.length === 0 ? (
              <p>“{AI_PRESETS[pending.preset].label}” changes nothing: those switches are already set.</p>
            ) : (
              <ul className="list-inside list-disc">
                {pending.changes.map((c) => (
                  <li key={c.feature}>{AI_FEATURES.find((f) => f.id === c.feature)!.label}: {c.from ? "on" : "off"} → <span className="text-text">{c.to ? "on" : "off"}</span></li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex gap-2">
              {pending.changes.length > 0 && <button onClick={confirm} className="btn btn-sm btn-primary">Apply</button>}
              <button onClick={() => setPending(null)} className="btn btn-sm btn-secondary">Cancel</button>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}
