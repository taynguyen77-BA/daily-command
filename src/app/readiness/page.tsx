"use client";

// W2 — Sprint Readiness Radar: the Definition-of-Ready checklist for the tickets entering the next sprint. Deterministic (no AI call here);
// ticket content is fetched on demand through the same cached issue-context path the Ticket Brief uses (bounded concurrency, cached by
// (key, updated)). The AI actions are per-ticket clicks on the existing BA requirement check, for allow-listed projects only.

import { useCallback, useMemo, useState } from "react";
import { Panel, SectionHeading, TrustLabel } from "@/components/command-center/ui";
import { BaRequirementCheck } from "@/components/command-center/BaRequirementCheck";
import { useCommandCenter } from "@/components/command-center/use-command-center";
import { commandCenterStore } from "@/lib/command-center/store";
import { loadIssueContext } from "@/lib/command-center/ai/ticket-ai-client";
import { DEFAULT_READY_STATUSES, READINESS_SCOPE_CAP, READY_THRESHOLD_PCT, evaluateTicket, gapSentence, readinessToCsv, readinessToMarkdown, selectReadinessScope, summarizeReadiness, type ReadinessTicketInput } from "@/lib/command-center/readiness-radar";

const BTN = "rounded-md border border-border px-2 py-1 text-xs text-text2 hover:bg-surface2";
const VERDICT_TONE = { PASS: "text-green", FAIL: "text-red", UNKNOWN: "text-yellow" } as const;

export default function ReadinessPage() {
  const { state } = useCommandCenter();
  const [statusText, setStatusText] = useState(DEFAULT_READY_STATUSES.join(", "));
  const [sprint, setSprint] = useState("");
  const [project, setProject] = useState("");
  const [assignee, setAssignee] = useState("");
  const [contents, setContents] = useState<Record<string, ReadinessTicketInput["content"]>>({});
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const scope = useMemo(() => selectReadinessScope(state.data.workItems, { statuses: statusText.split(",").map((s) => s.trim()), sprint, cap: READINESS_SCOPE_CAP }), [state.data.workItems, statusText, sprint]);
  const byKey = useMemo(() => new Map(state.data.workItems.map((w) => [w.key, w])), [state.data.workItems]);

  const rows = useMemo(() => {
    return scope.keys.map((k) => {
      const w = byKey.get(k)!;
      const unresolved = state.data.dependencies.filter((d) => w.dependencyIds.includes(d.id) && d.status === "unresolved").length;
      const base = contents[k];
      const content = base === undefined || base === null ? base : { ...base, links: [...base.links, ...(unresolved > 0 ? [{ relation: "is blocked by", status: "To Do", key: `${unresolved} unresolved dependency` }] : [])] };
      const input: ReadinessTicketInput = { key: k, title: w.title, status: w.jiraStatusName ?? w.status, ...(w.owner ? { owner: w.owner } : {}), labels: w.labels ?? [], ...(w.sprint ? { sprint: w.sprint } : {}), content };
      return evaluateTicket(input);
    });
  }, [scope.keys, byKey, contents, state.data.dependencies]);

  const projects = Array.from(new Set(rows.map((r) => r.key.split("-")[0]))).sort();
  const assignees = Array.from(new Set(rows.map((r) => r.owner).filter((o): o is string => !!o))).sort();
  const visible = rows.filter((r) => (!project || r.key.startsWith(`${project}-`)) && (!assignee || r.owner === assignee));
  const summary = summarizeReadiness(visible, READY_THRESHOLD_PCT);

  // Fetch contents with bounded concurrency; a failed fetch leaves that row UNKNOWN (with Retry) and never blocks the table.
  const load = useCallback(async (keys: string[], force = false) => {
    setLoading(true);
    const queue = [...keys];
    const worker = async () => {
      for (let k = queue.shift(); k; k = queue.shift()) {
        const res = await loadIssueContext(commandCenterStore, k, { workItemUpdated: byKey.get(k)?.lastUpdated, force });
        setContents((prev) => ({ ...prev, [k]: res.ok ? { description: res.context.description, acceptanceCriteria: res.context.acceptanceCriteria, links: res.context.links.map((l) => ({ relation: l.relation, status: l.status, key: l.key })) } : null }));
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    setLoading(false);
  }, [byKey]);

  const download = () => {
    const blob = new Blob([readinessToCsv(visible)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "sprint-readiness.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="space-y-4">
      <SectionHeading title="Sprint readiness" subtitle="Is each ticket entering the next sprint ready to build — and what is missing? Checked before planning day." />
      <p className="text-xs text-text3"><TrustLabel kind="calculated" /> A deterministic checklist per ticket; “unknown” means the data is not available (never counted as a gap). No AI runs here unless you click it on a ticket.</p>
      <Panel className="space-y-3 p-4">
        <div className="flex flex-wrap items-end gap-3 text-xs text-text2">
          <label className="block">Statuses that count as “next sprint” (comma separated)
            <input value={statusText} onChange={(e) => setStatusText(e.target.value)} className="mt-1 block w-64 rounded border border-border bg-surface px-2 py-1 text-sm" aria-label="Ready statuses" />
          </label>
          <label className="block">…or the sprint name
            <input value={sprint} onChange={(e) => setSprint(e.target.value)} placeholder="e.g. Sprint 24" className="mt-1 block w-40 rounded border border-border bg-surface px-2 py-1 text-sm" aria-label="Next sprint name" />
          </label>
          <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Filter by project" className="rounded border border-border bg-surface px-2 py-1"><option value="">All projects</option>{projects.map((p) => <option key={p}>{p}</option>)}</select>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Filter by assignee" className="rounded border border-border bg-surface px-2 py-1"><option value="">All assignees</option>{assignees.map((a) => <option key={a}>{a}</option>)}</select>
          <button className={BTN} disabled={loading || scope.keys.length === 0} onClick={() => void load(scope.keys.filter((k) => contents[k] === undefined))}>{loading ? "Loading…" : "Load ticket content"}</button>
        </div>
        <p className="text-sm text-text" data-readiness-summary>
          {summary.readyPct === null ? "No ticket scored yet — press “Load ticket content”." : `${summary.readyPct}% ready (${summary.ready} of ${summary.total - summary.unscored} scored tickets at ${summary.threshold}%+)`}
          {scope.truncated ? ` · showing the first ${READINESS_SCOPE_CAP} tickets` : ""}
        </p>
        {summary.topGaps.length > 0 && <ul className="list-disc pl-5 text-xs text-text2">{summary.topGaps.slice(0, 4).map((g) => <li key={g.id}>{gapSentence(g)}</li>)}</ul>}
        <div className="flex gap-2">
          <button className={BTN} disabled={visible.length === 0} onClick={download}>Export CSV</button>
          <button className={BTN} disabled={visible.length === 0} onClick={() => { void navigator.clipboard?.writeText(readinessToMarkdown(visible, summary)).then(() => setCopied(true)); }}>{copied ? "Copied" : "Copy Markdown for planning"}</button>
        </div>
      </Panel>
      <Panel className="p-4">
        {visible.length === 0 ? (
          <p className="text-sm text-text3">No tickets match. Set the statuses (e.g. “Ready for Dev”) or the sprint name above — tickets in those statuses appear here.</p>
        ) : (
          <table className="w-full text-left text-sm" data-readiness-table>
            <thead className="text-xs text-text3"><tr><th>Ticket</th><th>Score</th><th>Missing</th><th /></tr></thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.key} className="border-t border-border align-top">
                  <td className="py-2 pr-3"><span className="font-mono text-xs text-text">{r.key}</span><div className="text-xs text-text2">{r.title}</div></td>
                  <td className="py-2 pr-3 text-text">{r.score === null ? "—" : `${r.score}%`}</td>
                  <td className="py-2 pr-3 text-xs">
                    {r.items.filter((i) => i.verdict !== "PASS").map((i) => <span key={i.id} title={`${i.evidence}${i.hint ? ` — ${i.hint}` : ""}`} className={`mr-1 inline-block rounded-full border border-border px-2 py-0.5 ${VERDICT_TONE[i.verdict]}`}>{i.label}{i.verdict === "UNKNOWN" ? " ?" : ""}</span>)}
                    {r.missing.length === 0 && r.unknown.length === 0 && <span className="text-green">Ready</span>}
                  </td>
                  <td className="py-2 text-right">
                    {contents[r.key] === null && <button className={BTN} onClick={() => void load([r.key], true)}>Retry</button>}{" "}
                    <button className={BTN} onClick={() => setOpen(open === r.key ? null : r.key)}>{open === r.key ? "Hide" : "Check (AI)"}</button>
                    {open === r.key && <div className="mt-2 text-left"><BaRequirementCheck ticketKey={r.key} workItemUpdated={byKey.get(r.key)?.lastUpdated} /></div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
