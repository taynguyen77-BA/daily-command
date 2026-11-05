// W3 — Blast radius & critical path: "if this slips, what else slips?" Computed from the synced issue links ("is blocked by", kept with the
// blocker's key since V2.48) plus fix-version membership. Pure, deterministic, cycle-safe, bounded. Output is CALCULATED, and FORECAST when the
// slip comes from the forecast layer (P85 - P50). It says what the synced data supports and says UNKNOWN when there is no link data at all —
// never an empty claim of "no impact".

import { daysBetween } from "./score-core";
import type { Dependency, WorkItem } from "./types";

export const BLAST_MAX_DEPTH = 6;
export const BLAST_MAX_NODES = 500;
export const DEFAULT_SLIP_DAYS = 3;

type Node = Pick<WorkItem, "key" | "title" | "projectId" | "status" | "dueDate" | "fixVersion" | "fixVersions">;

export interface BlastGraph {
  nodes: Map<string, Node>;
  /** blocker key -> keys it blocks (downstream). */
  downstream: Map<string, string[]>;
  /** Links whose other end is outside the synced scope. */
  external: Map<string, string[]>;
  linkCount: number;
}

const BLOCKER_IN_TEXT = /^Blocked by ([A-Z][A-Z0-9_]*-\d+)/;
/** The blocker's key: the additive `blockerKey`, else parsed from the description of data synced before it existed. */
export const blockerKeyOf = (d: Pick<Dependency, "blockerKey" | "description">): string | undefined => d.blockerKey ?? BLOCKER_IN_TEXT.exec(d.description)?.[1];

/** Only the configured link types create edges (default: any "block" type, as normalize.ts keeps). Self-links and duplicates are ignored. */
export function buildBlastGraph(workItems: readonly Node[], dependencies: readonly (Pick<Dependency, "workItemId" | "blockerKey" | "description" | "linkType"> & { id?: string })[], opts: { linkTypes?: RegExp } = {}): BlastGraph {
  const nodes = new Map(workItems.map((w) => [w.key, w]));
  const byId = new Map(workItems.map((w) => [`jira-${w.key}`, w.key]));
  const downstream = new Map<string, string[]>();
  const external = new Map<string, string[]>();
  const seen = new Set<string>();
  let linkCount = 0;
  const linkTypes = opts.linkTypes ?? /block/i;
  for (const d of dependencies) {
    if (d.linkType && !linkTypes.test(d.linkType)) continue;
    const blocker = blockerKeyOf(d);
    const dependent = byId.get(d.workItemId) ?? workItems.find((w) => w.key === d.workItemId)?.key;
    if (!blocker || !dependent || blocker === dependent) continue;
    const id = `${blocker}>${dependent}`;
    if (seen.has(id)) continue;
    seen.add(id);
    linkCount += 1;
    if (!nodes.has(blocker)) { external.set(dependent, [...(external.get(dependent) ?? []), blocker]); continue; }
    downstream.set(blocker, [...(downstream.get(blocker) ?? []), dependent]);
  }
  return { nodes, downstream, external, linkCount };
}

export interface DownstreamNode { key: string; title: string; depth: number; /** The ticket it hangs under (the one that blocks it on the shortest path). */ from: string; dueDate?: string; /** Days between the blocker's due date and this ticket's (the room it has). null = a date is missing. */ slackDays: number | null; /** The slip exceeds the room it has (or its due date is unknown -> null). */ atRisk: boolean | null }
export interface ReleaseImpact { fixVersion: string; targetDate: string; newDate: string; exceeded: boolean }
export interface BlastRadius {
  status: "OK" | "UNKNOWN";
  basis: "CALCULATED" | "FORECAST";
  key: string;
  slipDays: number;
  downstream: DownstreamNode[];
  projects: string[];
  releases: ReleaseImpact[];
  /** Longest dependency chain starting at the ticket (ties: earlier due date), with per-node slack. */
  criticalPath: { key: string; slackDays: number | null }[];
  /** Blockers outside the synced scope that this ticket depends on. */
  external: string[];
  truncated: boolean;
  /** Why the answer is UNKNOWN (or a caveat). */
  note?: string;
}

const addDaysIso = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const versionsOf = (n: Node): string[] => (n.fixVersions && n.fixVersions.length ? n.fixVersions : n.fixVersion ? [n.fixVersion] : []);

export function blastRadius(graph: BlastGraph, key: string, slipDays: number = DEFAULT_SLIP_DAYS, opts: { forecast?: boolean; maxDepth?: number; maxNodes?: number } = {}): BlastRadius {
  const base: BlastRadius = { status: "OK", basis: opts.forecast ? "FORECAST" : "CALCULATED", key, slipDays, downstream: [], projects: [], releases: [], criticalPath: [{ key, slackDays: null }], external: graph.external.get(key) ?? [], truncated: false };
  if (!Number.isFinite(slipDays) || slipDays < 0) return { ...base, status: "UNKNOWN", note: "The slip must be a number of days, 0 or more." };
  const start = graph.nodes.get(key);
  if (!start) return { ...base, status: "UNKNOWN", note: "This ticket is not in the synced data." };
  if (graph.linkCount === 0) return { ...base, status: "UNKNOWN", note: "No link data synced for this ticket — sync Jira (issue links) before relying on an impact estimate." };

  const maxDepth = opts.maxDepth ?? BLAST_MAX_DEPTH;
  const maxNodes = opts.maxNodes ?? BLAST_MAX_NODES;
  const seen = new Set<string>([key]);
  const out: DownstreamNode[] = [];
  const parent = new Map<string, string>();
  let frontier = [key];
  let depth = 0;
  while (frontier.length && depth < maxDepth) {
    depth += 1;
    const next: string[] = [];
    for (const from of frontier) {
      for (const to of graph.downstream.get(from) ?? []) {
        if (seen.has(to)) continue; // cycles and diamonds: each ticket counted once, at its shortest depth
        const n = graph.nodes.get(to);
        if (!n) continue;
        if (seen.size >= maxNodes) { base.truncated = true; continue; }
        seen.add(to);
        parent.set(to, from);
        next.push(to);
        if (n.status === "Done") continue; // a finished ticket is not at risk (and does not carry the slip further)
        const blocker = graph.nodes.get(from)!;
        const slack = blocker.dueDate && n.dueDate ? daysBetween(blocker.dueDate.slice(0, 10), n.dueDate.slice(0, 10)) : null;
        out.push({ key: to, title: n.title, depth, from, ...(n.dueDate ? { dueDate: n.dueDate.slice(0, 10) } : {}), slackDays: slack, atRisk: slack === null ? null : slipDays > slack });
      }
    }
    frontier = next.filter((k) => graph.nodes.get(k)?.status !== "Done");
  }
  if (frontier.length && depth >= maxDepth && frontier.some((k) => (graph.downstream.get(k) ?? []).length)) base.truncated = true;

  const affected = new Set([key, ...out.map((o) => o.key)]);
  const projects = Array.from(new Set(out.map((o) => graph.nodes.get(o.key)!.projectId))).sort();

  // Releases: target = the latest due date among the members; the new date applies the slip to affected members.
  const members = new Map<string, Node[]>();
  for (const n of graph.nodes.values()) for (const v of versionsOf(n)) members.set(v, [...(members.get(v) ?? []), n]);
  const releases: ReleaseImpact[] = [];
  for (const [fixVersion, list] of members) {
    if (!list.some((m) => affected.has(m.key) && m.status !== "Done")) continue;
    const dated = list.filter((m) => m.dueDate);
    if (dated.length === 0) continue;
    const targetDate = dated.map((m) => m.dueDate!.slice(0, 10)).sort().at(-1)!;
    const newDate = dated.map((m) => (affected.has(m.key) && m.status !== "Done" ? addDaysIso(m.dueDate!.slice(0, 10), slipDays) : m.dueDate!.slice(0, 10))).sort().at(-1)!;
    releases.push({ fixVersion, targetDate, newDate, exceeded: newDate > targetDate });
  }
  releases.sort((a, b) => Number(b.exceeded) - Number(a.exceeded) || a.fixVersion.localeCompare(b.fixVersion));

  // Critical path: the longest chain from `key` (follow the deepest descendant back through its parents; ties: earliest due date).
  const deepest = out.slice().sort((a, b) => b.depth - a.depth || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || a.key.localeCompare(b.key))[0];
  const chain: { key: string; slackDays: number | null }[] = [{ key, slackDays: null }];
  if (deepest) {
    const rev: DownstreamNode[] = [];
    for (let k: string | undefined = deepest.key; k && k !== key; k = parent.get(k)) { const dn = out.find((o) => o.key === k); if (dn) rev.push(dn); }
    chain.push(...rev.reverse().map((d) => ({ key: d.key, slackDays: d.slackDays })));
  }

  return { ...base, downstream: out.sort((a, b) => a.depth - b.depth || a.key.localeCompare(b.key)), projects, releases, criticalPath: chain };
}

/** The chip on a task row: "blocks 4 · 2 projects" (null when it blocks nothing in the synced data). */
export function blastChip(r: BlastRadius): string | null {
  if (r.status !== "OK" || r.downstream.length === 0) return null;
  return `blocks ${r.downstream.length} · ${r.projects.length} project${r.projects.length === 1 ? "" : "s"}`;
}

/** Default slip when the forecast supplies one: P85 - P50 of comparable lead times, else 3 days. */
export function defaultSlipDays(estimate: { p50: number; p85: number } | null | undefined): { days: number; forecast: boolean } {
  const d = estimate ? Math.round(estimate.p85 - estimate.p50) : NaN;
  return Number.isFinite(d) && d > 0 ? { days: d, forecast: true } : { days: DEFAULT_SLIP_DAYS, forecast: false };
}
