"use client";

// V2.37 I2 — Smart Triage in Morning Mode step 2: one batched AI call over the New items, shown
// grouped by category with a checkbox each. NOTHING changes until "Apply selected"; each ticked
// item then goes through setTicketStatus (surface "ai-triage", reason "AI-suggested: …").
// Low-confidence suggestions start unticked. Projects outside the AI allow-list are triaged
// from metadata only (no comment text is sent).

import { useState } from "react";
import { getAIProvider } from "@/lib/command-center/ai";
import { commandCenterStore } from "@/lib/command-center/store";
import { applyTriageSelection, buildTriageInput, defaultChecked, groupByCategory, normalizeTriage, type TriageCandidate, type TriageSuggestion } from "@/lib/command-center/ai/smart-triage";
import { TrustLabel } from "./ui";

const ACTION_LABEL: Record<TriageSuggestion["action"]["kind"], string> = { keep: "Keep for today", done: "Done", defer: "Defer", block: "Block", skip: "Skip" };

function actionText(s: TriageSuggestion): string {
  const a = s.action;
  return `${ACTION_LABEL[a.kind]}${a.kind === "defer" && a.until ? ` until ${a.until}` : ""}${(a.kind === "block" || a.kind === "skip") && a.reason ? ` — ${a.reason}` : ""}`;
}

export function SmartTriagePanel({ candidates, today, onApplied }: { candidates: TriageCandidate[]; today: string; onApplied: (applied: { key: string; kind: TriageSuggestion["action"]["kind"] }[]) => void }) {
  const [suggestions, setSuggestions] = useState<TriageSuggestion[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [metadataOnly, setMetadataOnly] = useState<string[]>([]);
  if (candidates.length === 0) return null;

  const suggest = async () => {
    setBusy(true);
    const { input, session, metadataOnlyKeys } = buildTriageInput(candidates, commandCenterStore.getSnapshot().aiDataProtection, today);
    const provider = getAIProvider();
    const raw = await provider.triageNewItems(input);
    const list = normalizeTriage(input.items.map((i) => i.key), raw, session);
    setSuggestions(list);
    setSelected(new Set(list.filter(defaultChecked).map((s) => s.key)));
    setMetadataOnly(metadataOnlyKeys);
    setNote(provider.mode === "claude" ? null : "AI unavailable — showing cautious suggestions from metadata (all unticked).");
    setBusy(false);
  };

  const apply = () => {
    if (!suggestions) return;
    const { applied } = applyTriageSelection(commandCenterStore, suggestions, selected, today);
    onApplied(applied.map((key) => ({ key, kind: suggestions.find((s) => s.key === key)!.action.kind })));
    setNote(`Applied ${applied.length} suggestion(s).`);
    setSuggestions(suggestions.filter((s) => !applied.includes(s.key)));
    setSelected(new Set());
  };

  return (
    <div data-smart-triage className="mb-4 rounded-md border border-border bg-surface2 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <TrustLabel kind="ai-recommendation" />
        <span className="font-semibold text-text">Smart triage</span>
        {!suggestions && (
          <button onClick={() => void suggest()} disabled={busy} className="btn btn-sm btn-secondary">
            {busy ? "Thinking…" : `Suggest for ${candidates.length} item(s)`}
          </button>
        )}
        {note && <span className="text-xs text-text3">{note}</span>}
      </div>
      {suggestions && suggestions.length > 0 && (
        <>
          {groupByCategory(suggestions).map((g) => (
            <div key={g.category} className="mt-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-text3">
                {g.category} ({g.items.length})
              </p>
              <ul>
                {g.items.map((s) => (
                  <li key={s.key} data-triage-row={s.key} className="flex items-start gap-2 py-1">
                    <input
                      type="checkbox"
                      aria-label={`Apply suggestion for ${s.key}`}
                      checked={selected.has(s.key)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(s.key);
                        else next.delete(s.key);
                        setSelected(next);
                      }}
                      className="mt-1"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="font-mono text-xs text-text">{s.key}</span> <span className="text-text">{actionText(s)}</span>{" "}
                      <span className={`text-xs ${s.confidence < 0.6 ? "text-orange" : "text-text3"}`}>({Math.round(s.confidence * 100)}%)</span>
                      {metadataOnly.includes(s.key) && <span className="ml-1 text-[10px] text-text3">metadata only</span>}
                      <span className="block text-xs text-text3">{s.rationale}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="mt-2 flex gap-2">
            <button onClick={apply} disabled={selected.size === 0} className="btn btn-sm btn-primary disabled:opacity-50">
              Apply selected ({selected.size})
            </button>
            <button onClick={() => setSuggestions(null)} className="btn btn-sm btn-ghost">
              Dismiss
            </button>
          </div>
        </>
      )}
    </div>
  );
}
