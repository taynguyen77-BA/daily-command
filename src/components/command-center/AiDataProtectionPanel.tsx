"use client";

// V2.36 H2/H4 — Data & Settings: what ticket content may reach the AI, and what AI costs.
//   - per-project AI allow-list (default: none), custom redaction terms, acceptance-criteria
//     field id, the AI context cache (and whether backups include it)
//   - today / 7-day token usage from the server's usage ledger, the daily cap, what remains

import { useEffect, useState } from "react";
import { formatCustomTerms, parseCustomTermsText } from "@/lib/command-center/ai/redaction";
import { contextCacheStats } from "@/lib/command-center/ai/context-cache";
import { fetchAiUsage } from "@/lib/command-center/ai/ticket-ai-client";
import { knownJiraProjects } from "@/lib/command-center/jira/project-scope";
import type { AiUsageSummary, AiUsageTotals } from "@/lib/command-center/ai/usage-ledger";
import { Panel, SectionHeading } from "./ui";
import { useCommandCenter } from "./use-command-center";

const fmt = (n: number) => n.toLocaleString("en-US");

function TotalsRow({ label, t }: { label: string; t: AiUsageTotals }) {
  return (
    <tr className="border-t border-border">
      <td className="py-1 pr-3 text-text">{label}</td>
      <td className="py-1 pr-3 font-mono">{fmt(t.calls)}{t.cachedCalls ? ` (${fmt(t.cachedCalls)} cached)` : ""}</td>
      <td className="py-1 pr-3 font-mono">{fmt(t.inputTokens)}</td>
      <td className="py-1 pr-3 font-mono">{fmt(t.outputTokens)}</td>
      <td className="py-1 pr-3 font-mono">{fmt(t.cacheReadTokens + t.cacheWriteTokens)}</td>
      <td className="py-1 font-mono text-text">{fmt(t.totalTokens)}</td>
    </tr>
  );
}

export function AiDataProtectionPanel() {
  const { state, store } = useCommandCenter();
  const settings = state.aiDataProtection;
  const on = state.features.ticketAi;
  const [termsDraft, setTermsDraft] = useState(() => formatCustomTerms(settings.customTerms));
  const [acDraft, setAcDraft] = useState(settings.acceptanceCriteriaFieldId ?? "");
  const [acError, setAcError] = useState(false);
  const [usage, setUsage] = useState<AiUsageSummary | null | undefined>(undefined);
  const projects = knownJiraProjects(state.data);
  const cache = contextCacheStats(state.aiContextCache);
  const refreshUsage = () => {
    setUsage(undefined);
    void fetchAiUsage().then(setUsage);
  };
  useEffect(refreshUsage, []);

  return (
    <Panel className="p-5" data-ai-data-protection>
      <SectionHeading
        title="AI data protection & usage"
        subtitle={
          on
            ? "Ticket AI is on. Only the projects ticked below ever have a ticket's description or comments sent to the model, after redaction."
            : "Ticket AI is off (Features above): no ticket description or comment is ever sent to the model. These settings are kept for when you turn it on."
        }
      />
      <div className="space-y-4 text-sm text-text2">
        <div data-ai-allow-list>
          <p className="text-xs font-semibold uppercase tracking-wide text-text3">Projects allowed to use AI on ticket content</p>
          {projects.length === 0 ? (
            <p className="mt-1 text-xs text-text3">No Jira projects synced yet.</p>
          ) : (
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {projects.map((p) => (
                <li key={p.key}>
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={settings.allowedProjectKeys.includes(p.key)} onChange={(e) => store.setAiProjectAllowed(p.key, e.target.checked)} />
                    <span className="font-mono text-text">{p.key}</span>
                    {p.name && <span className="text-xs text-text3">{p.name}</span>}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-xs text-text3">Default: none. A ticket in any other project shows &ldquo;AI disabled for this project&rdquo; and nothing from it is sent.</p>
        </div>

        <div data-ai-redaction>
          <p className="text-xs font-semibold uppercase tracking-wide text-text3">Redaction</p>
          <p className="mt-1 text-xs text-text3">
            Always replaced before sending: email addresses, phone numbers, URLs carrying tokens, Jira account ids, card- and IBAN-like numbers. Add client names or other terms below — one per line,
            optionally <span className="font-mono">Term =&gt; Alias</span>. The model sees the alias; you see the real name again in the answer.
          </p>
          <textarea value={termsDraft} onChange={(e) => setTermsDraft(e.target.value)} rows={3} placeholder={"Acme Bank => Client A\nProject Falcon"} aria-label="Custom redaction terms" className="mt-1 w-full max-w-lg rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs" />
          <div className="mt-1 flex items-center gap-2">
            <button onClick={() => store.setAiCustomTerms(parseCustomTermsText(termsDraft))} disabled={termsDraft === formatCustomTerms(settings.customTerms)} className="btn btn-sm btn-secondary disabled:opacity-50">
              Save terms
            </button>
            <span className="text-xs text-text3">{settings.customTerms.length} term(s) saved</span>
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-text3">Acceptance-criteria field</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <input value={acDraft} onChange={(e) => { setAcDraft(e.target.value); setAcError(false); }} placeholder="customfield_10050 (optional)" aria-label="Acceptance-criteria custom field id" className="w-56 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs" />
            <button onClick={() => setAcError(!store.setAiAcceptanceCriteriaFieldId(acDraft))} className="btn btn-sm btn-secondary">
              Save
            </button>
            {acError && <span className="text-xs text-orange">Use Jira&apos;s customfield_&lt;digits&gt; form.</span>}
          </div>
          <p className="mt-1 text-xs text-text3">Without one, the requirement check looks for criteria inside the description.</p>
        </div>

        <div data-ai-context-cache>
          <p className="text-xs font-semibold uppercase tracking-wide text-text3">Ticket context cache</p>
          <p className="mt-1 text-xs">
            {cache.entries} ticket(s), {fmt(Math.round(cache.bytes / 1024))} KB on this device. A ticket is fetched again once Jira shows it changed.{" "}
            {cache.entries > 0 && (
              <button onClick={() => store.clearAiContextCache()} className="link text-xs">
                Clear
              </button>
            )}
          </p>
          <label className="mt-1 flex items-center gap-2 text-xs">
            <input type="checkbox" checked={settings.includeContextCacheInBackup} onChange={(e) => store.setAiIncludeContextCacheInBackup(e.target.checked)} />
            Include AI context cache in backups (off: backups never contain fetched descriptions or comments)
          </label>
        </div>

        <div data-ai-usage>
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-text3">AI usage</p>
            <button onClick={refreshUsage} className="link text-xs">
              Refresh
            </button>
          </div>
          {usage === undefined ? (
            <p className="mt-1 text-xs text-text3">Loading…</p>
          ) : usage === null ? (
            <p className="mt-1 text-xs text-text3">Couldn&apos;t read usage from the server (pair this device to see it).</p>
          ) : (
            <>
              <p className={`mt-1 text-xs ${usage.remainingToday === 0 ? "text-orange" : ""}`}>
                Remaining today: <span className="font-mono text-text">{fmt(usage.remainingToday)}</span> of {fmt(usage.cap)} tokens (AI_DAILY_TOKEN_CAP, resets at midnight UTC).
                {usage.remainingToday === 0 && " The cap is reached — AI features show deterministic text until then."}
              </p>
              <table className="mt-2 text-xs">
                <thead>
                  <tr className="text-left text-text3">
                    <th className="pr-3 font-normal" />
                    <th className="pr-3 font-normal">Calls</th>
                    <th className="pr-3 font-normal">Input</th>
                    <th className="pr-3 font-normal">Output</th>
                    <th className="pr-3 font-normal">Cache r/w</th>
                    <th className="font-normal">Total</th>
                  </tr>
                </thead>
                <tbody>
                  <TotalsRow label="Today" t={usage.today} />
                  <TotalsRow label="Last 7 days" t={usage.last7Days} />
                </tbody>
              </table>
              <p className="mt-1 text-xs text-text3">
                {usage.storage === "kv" ? "Logged in Vercel KV — shared by every server instance." : "Logged in this server instance's memory (no KV configured) — totals reset when the instance restarts."} Counts only; prompts and answers are never logged.
              </p>
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}
